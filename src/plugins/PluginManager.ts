import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { PendingApproval, ToolExecutionResult } from "../types";
import type { OperationInput } from "../tools/OperationExecutor";
import { compileToolArguments, parseArgumentsJson, snapshotArguments } from "../mcp/client/schema";
import { isMissingFile, withFileLock, writeJsonAtomically } from "../utils/fileStore";
import { catalogEntry, pluginCatalog } from "./catalog";
import { ConnectionSnapshot, IntegrationAdapter, PluginError, PluginInvocationError, ServiceConnection } from "./contracts";
import { PluginStore } from "./PluginStore";
import { parsePluginSelection } from "./PluginSelection";

type Outcome = { result?: ToolExecutionResult; pendingApproval?: PendingApproval };
interface DiscoveredTool { id: string; connection: ServiceConnection; definition: Tool; fingerprint: string; }
interface Invocation {
  id: string; agentRunId: string; identity: string; fingerprint: string; toolId: string;
  args: Record<string, unknown>; status: "waiting" | "approved" | "executing" | "completed" | "unknown";
  approval: PendingApproval; requiresApproval: boolean; result?: ToolExecutionResult;
}
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const failure = (text: string): ToolExecutionResult => ({ tool: "plugins", ok: false, output: text });

/** Application-lifetime integration owner. UI and agent consumers share this state. */
export class PluginManager {
  readonly store: PluginStore;
  private readonly live = new Map<string, ConnectionSnapshot>();
  private readonly active = new Map<string, Set<AbortController>>();
  private readonly activePlugins = new Map<string, string>();
  private readonly adapters = new Map<string, IntegrationAdapter>();
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly retiring = new Set<string>();
  private readonly changingPlugins = new Map<string, number>();
  private closed = false;
  constructor(private readonly baseDir: string, readonly ownerId: string, adapters: IntegrationAdapter[] = []) {
    this.store = new PluginStore(baseDir, ownerId);
    for (const adapter of adapters) this.adapters.set(adapter.id, adapter);
  }
  private adapter(id?: string): IntegrationAdapter {
    const adapter = id ? this.adapters.get(id) : this.adapters.values().next().value;
    if (!adapter) throw new PluginError("A connection provider has not been configured. Open connection settings.", 503);
    return adapter;
  }
  async snapshot() {
    const state = await this.store.read();
    const providers = await Promise.all([...this.adapters.values()].map(async adapter => ({ id: adapter.id, ...await adapter.ready() })));
    return {
      catalog: pluginCatalog.map(plugin => ({ ...plugin, installation: state.installations.find(item => item.pluginId === plugin.id) })),
      connections: state.connections.map(connection => ({ ...connection, accountRef: undefined,
        ...this.publicStatus(connection.id) })), providers
    };
  }
  private publicStatus(id: string) {
    const live = this.live.get(id);
    return { state: live?.state ?? "disconnected", message: live?.message,
      tools: (live?.tools ?? []).map(tool => ({ name: tool.name, description: tool.description, readOnly: tool.annotations?.readOnlyHint === true })) };
  }
  async install(pluginId: string) {
    const plugin = catalogEntry(pluginId);
    await this.store.update(state => {
      if (!state.installations.some(item => item.pluginId === pluginId)) state.installations.push({ pluginId, version: plugin.version,
        installedAt: new Date().toISOString(), enabled: false, permission: "none", revision: randomUUID() });
    });
    return this.snapshot();
  }
  async configure(pluginId: string, patch: { enabled?: boolean; permission?: "none" | "read" | "read-write"; connectionId?: string }) {
    catalogEntry(pluginId);
    this.beginPolicyChange(pluginId);
    try {
    await this.store.update(state => {
      const installation = state.installations.find(item => item.pluginId === pluginId);
      if (!installation) throw new PluginError("Install the plugin first.");
      if (patch.connectionId && !state.connections.some(connection => connection.id === patch.connectionId && connection.pluginId === pluginId)) throw new PluginError("This account does not belong to this plugin.");
      Object.assign(installation, patch);
      installation.revision = randomUUID();
      if (installation.enabled && (installation.permission === "none" || !installation.connectionId)) throw new PluginError("Connect an account and choose permissions before enabling this plugin.");
    });
    // Invalidate approved proposals as well as in-flight work when policy changes.
    const state = await this.store.read();
    for (const connection of state.connections.filter(item => item.pluginId === pluginId)) this.cancel(connection.id);
    return this.snapshot();
    } finally { this.endPolicyChange(pluginId); }
  }
  async connect(pluginId: string, adapterId?: string) {
    const plugin = catalogEntry(pluginId);
    if (!(await this.store.read()).installations.some(item => item.pluginId === pluginId)) throw new PluginError("Install the plugin first.");
    const adapter = this.adapter(adapterId), readiness = await adapter.ready();
    if (!readiness.ready) throw new PluginError(readiness.message ?? "Connection provider is not ready.", 503);
    const id = randomUUID();
    const attempt = await adapter.connect(plugin, this.ownerId, id);
    const url = new URL(attempt.authorizationUrl);
    if (url.protocol !== "https:" || url.username || url.password) throw new PluginError("Provider returned an invalid authorization address.");
    await this.store.update(state => {
      if (!state.installations.some(item => item.pluginId === pluginId)) throw new PluginError("Plugin was uninstalled during connection.");
      state.connections.push({ id, pluginId, ownerId: this.ownerId, adapter: adapter.id, accountRef: attempt.accountRef,
        label: `${plugin.name} · ${id.slice(0, 8)}`, createdAt: new Date().toISOString(), revision: randomUUID() });
    });
    this.live.set(id, { state: "connecting", tools: [] });
    return { connectionId: id, authorizationUrl: url.href, userCode: attempt.userCode };
  }
  async refresh(id: string): Promise<void> {
    if (this.refreshing.has(id)) return this.refreshing.get(id);
    const pending = this.refreshConnection(id).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, pending);
    return pending;
  }
  private async refreshConnection(id: string) {
    const connection = (await this.store.read()).connections.find(item => item.id === id);
    if (!connection || this.closed || this.retiring.has(id)) return;
    let snapshot: ConnectionSnapshot;
    try {
      snapshot = await this.adapter(connection.adapter).inspect(catalogEntry(connection.pluginId), connection);
      // Schemas become available only after successful discovery and validation.
      for (const tool of snapshot.tools) compileToolArguments(tool.inputSchema);
    } catch (error) {
      snapshot = { state: "error", tools: [], message: error instanceof PluginError ? error.message : "Could not check the connection. Try reconnecting." };
    }
    const current = await this.store.read();
    if (this.closed || this.retiring.has(id) || !current.connections.some(item => item.id === id && item.revision === connection.revision)) return;
    this.live.set(id, snapshot);
    if (snapshot.state !== "connected") this.cancel(id);
    if (snapshot.state === "connected") await this.store.update(state => {
      const saved = state.connections.find(item => item.id === id);
      if (!saved || saved.revision !== connection.revision) return;
      if (snapshot.label) saved.label = snapshot.label.slice(0, 500);
      const installation = state.installations.find(item => item.pluginId === saved.pluginId);
      if (installation && !installation.connectionId) installation.connectionId = id;
    });
  }
  async restore() {
    const connections = (await this.store.read()).connections;
    await Promise.allSettled(connections.map(connection => this.refresh(connection.id)));
  }
  async disconnect(id: string) {
    // Synchronous tombstone fences in-flight refresh before any disk/network await.
    this.retiring.add(id); this.cancel(id); this.live.set(id, { state: "disconnected", tools: [] });
    const connection = (await this.store.read()).connections.find(item => item.id === id);
    if (!connection) throw new PluginError("Connection was not found.", 404);
    // Disable locally before external revocation; an external failure cannot leave tools live.
    this.cancel(id); this.live.set(id, { state: "disconnected", tools: [] });
    await this.store.update(state => {
      const saved = state.connections.find(item => item.id === id);
      if (saved) saved.revision = randomUUID();
      for (const installation of state.installations) if (installation.connectionId === id) installation.enabled = false;
    });
    await this.store.update(state => {
      state.connections = state.connections.filter(item => item.id !== id);
      for (const installation of state.installations) if (installation.connectionId === id) delete installation.connectionId;
    });
    await this.adapter(connection.adapter).disconnect(catalogEntry(connection.pluginId), connection);
    return this.snapshot();
  }
  async uninstall(pluginId: string) {
    catalogEntry(pluginId);
    this.beginPolicyChange(pluginId);
    try {
    const state = await this.store.read();
    for (const connection of state.connections.filter(item => item.pluginId === pluginId)) this.cancel(connection.id);
    // Account authorizations have independent lifecycle and remain in Connections.
    await this.store.update(saved => { saved.installations = saved.installations.filter(item => item.pluginId !== pluginId); });
    return this.snapshot();
    } finally { this.endPolicyChange(pluginId); }
  }
  private beginPolicyChange(id: string) {
    this.changingPlugins.set(id, (this.changingPlugins.get(id) ?? 0) + 1);
    for (const [connectionId, pluginId] of this.activePlugins) if (pluginId === id) this.cancel(connectionId);
  }
  private endPolicyChange(id: string) { const count = (this.changingPlugins.get(id) ?? 1) - 1; if (count) this.changingPlugins.set(id, count); else this.changingPlugins.delete(id); }
  private cancel(id: string) { for (const controller of this.active.get(id) ?? []) controller.abort(); }
  async hasEnabled(): Promise<boolean> { return !this.closed && (await this.store.read()).installations.some(item => item.enabled); }
  async choices() {
    const tools = await this.available();
    return pluginCatalog.filter(plugin => tools.some(tool => tool.connection.pluginId === plugin.id)).map(plugin => ({
      id: plugin.id, name: plugin.name, description: plugin.description,
      icon: `/assets/plugin-icons/${plugin.id.startsWith("outlook-") ? "outlook" : plugin.id}.svg`
    }));
  }
  async validateSelection(ids: string[] | undefined) {
    const selected = parsePluginSelection(ids);
    if (!selected?.length) return;
    const available = await this.choices();
    const missing = selected.filter(id => !available.some(plugin => plugin.id === id));
    if (missing.length) throw new PluginError(`${missing.map(id => catalogEntry(id).name).join(", ")} is not available. Connect and enable it in Settings → Plugins, or remove it from this request.`, 409);
  }
  private async available(): Promise<DiscoveredTool[]> {
    if (this.closed) return [];
    const state = await this.store.read();
    return state.installations.filter(item => item.enabled && item.permission !== "none" && !this.changingPlugins.has(item.pluginId)).flatMap(installation => {
      const connection = state.connections.find(item => item.id === installation.connectionId && item.pluginId === installation.pluginId);
      const live = connection && this.live.get(connection.id);
      if (!connection || this.retiring.has(connection.id) || live?.state !== "connected") return [];
      const tools = this.adapter(connection.adapter).currentTools?.(connection) ?? live.tools;
      return tools.filter(tool => installation.permission === "read-write" || tool.annotations?.readOnlyHint === true).map(definition => ({
        id: `${installation.pluginId}:${connection.id}:${definition.name}`, connection, definition,
        fingerprint: digest({ connection, definition, permission: installation.permission, revision: installation.revision })
      }));
    });
  }
  async search(query: string, readOnly = false, pluginIds?: string[]) {
    const selected = parsePluginSelection(pluginIds);
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const available = (await this.available()).filter(tool => (selected === undefined || selected.includes(tool.connection.pluginId)) && (!readOnly || tool.definition.annotations?.readOnlyHint === true));
    return available.map(tool => ({ tool, score: words.reduce((score, word) => score + (`${tool.id} ${tool.definition.description ?? ""}`.toLowerCase().includes(word) ? 1 : 0), 0) }))
      .sort((a, b) => b.score - a.score || a.tool.id.localeCompare(b.tool.id)).filter(item => !words.length || item.score > 0).slice(0, 8)
      .map(({ tool }) => ({ id: tool.id, plugin: tool.connection.pluginId, account: tool.connection.label,
        description: tool.definition.description, inputSchema: tool.definition.inputSchema, readOnly: tool.definition.annotations?.readOnlyHint === true }));
  }
  async execute(input: OperationInput): Promise<Outcome> {
    input.signal?.throwIfAborted();
    const selected = parsePluginSelection(input.pluginIds);
    await this.validateSelection(selected);
    if (input.tool === "plugins.search") {
      return { result: { tool: "plugins", ok: true, output: JSON.stringify(await this.search(String(input.arguments.query ?? ""), input.readOnly, selected)) } };
    }
    if (input.tool !== "plugins.call") throw new PluginError("Unknown plugin operation.");
    const toolId = String(input.arguments.toolId);
    if (selected !== undefined && !selected.includes(toolId.split(":")[0])) return { result: failure("This plugin was not selected for this request. Use the selected plugins only.") };
    let args: Record<string, unknown>;
    try { args = snapshotArguments(parseArgumentsJson(String(input.arguments.argumentsJson))); }
    catch { throw new PluginError("Tool arguments must be a JSON object matching the discovered schema."); }
    const file = path.join(this.store.directory, "operations", `${digest(input.id)}.json`);
    const identity = digest({ agentRunId: input.agentRunId, toolId, args, workspace: input.workspace, pluginIds: selected });
    return withFileLock(file, async () => {
      let saved: Invocation | undefined;
      try { saved = JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (!isMissingFile(error)) throw error; }
      if (saved && saved.identity !== identity) throw new PluginError("The saved tool proposal changed. Start a new run.");
      if (saved?.status === "completed") return { result: saved.result };
      if (saved?.status === "executing" || saved?.status === "unknown") return { result: this.unknown(input.id) };
      let tool = (await this.available()).find(item => item.id === toolId);
      if (!tool) return { result: failure("This tool is unavailable. Check that the plugin is enabled and the selected account is connected.") };
      if (input.readOnly && tool.definition.annotations?.readOnlyHint !== true) return { result: failure("This agent has read-only access to plugins.") };
      if (!compileToolArguments(tool.definition.inputSchema)(args)) return { result: failure("Arguments do not match the discovered tool schema. Search tools to inspect the current schema.") };
      if (saved && saved.fingerprint !== tool.fingerprint) return { result: { ...failure("Plugin permissions, account or tool changed after approval was requested. Start a new run."), metadata: { permissionRequired: true } } };
      const requiresApproval = input.requireApproval === true || tool.definition.annotations?.readOnlyHint !== true || input.accessMode !== "full";
      if (!saved) {
        saved = { id: input.id, agentRunId: input.agentRunId, identity, fingerprint: tool.fingerprint, toolId, args,
          status: "waiting", requiresApproval,
          approval: { id: input.id, tool: "plugins", operation: tool.definition.name, summary: `${catalogEntry(tool.connection.pluginId).name} · ${tool.definition.name}`,
            details: `Account: ${tool.connection.label}\n${JSON.stringify(args, null, 2)}`, requestedAt: new Date().toISOString() } };
        await writeJsonAtomically(file, saved);
      }
      if ((saved.requiresApproval || requiresApproval) && saved.status !== "approved") {
        saved.requiresApproval = true;
        await writeJsonAtomically(file, saved);
        let decision: boolean;
        if (input.approval?.id === input.id) decision = input.approval.approved;
        else if (input.pauseForApproval) return { pendingApproval: saved.approval };
        else if (input.requestApproval) decision = await withFileLock(`approval:${input.agentRunId.split(":agent:")[0]}`, () => input.requestApproval!(saved!.approval));
        else return { result: { ...failure("Permission is required to use this external account."), metadata: { permissionRequired: true } } };
        input.signal?.throwIfAborted();
        if (!decision) {
          saved.status = "completed"; saved.result = { ...failure("Permission denied. Nothing was sent to the service."), metadata: { cancelled: true, operationId: input.id } };
          await writeJsonAtomically(file, saved); return { result: saved.result };
        }
        saved.status = "approved"; await writeJsonAtomically(file, saved);
      }
      const current = (await this.available()).find(item => item.id === toolId);
      if (!current || current.fingerprint !== saved.fingerprint) return { result: { ...failure("Plugin access changed while waiting for approval."), metadata: { permissionRequired: true } } };
      tool = current;
      input.signal?.throwIfAborted();
      const controller = new AbortController(), abort = () => controller.abort();
      input.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 60_000);
      const active = this.active.get(tool.connection.id) ?? new Set<AbortController>();
      active.add(controller); this.active.set(tool.connection.id, active);
      this.activePlugins.set(tool.connection.id, tool.connection.pluginId);
      let dispatched = false;
      try {
        controller.signal.throwIfAborted();
        saved.status = "executing"; await writeJsonAtomically(file, saved);
        controller.signal.throwIfAborted();
        const ready = (await this.available()).find(item => item.id === toolId);
        if (!ready || ready.fingerprint !== saved.fingerprint || this.closed || this.retiring.has(tool.connection.id) || this.changingPlugins.has(tool.connection.pluginId)) {
          saved.status = "completed"; saved.result = { ...failure("Plugin access changed before dispatch. Nothing was sent."), metadata: { permissionRequired: true } };
          await writeJsonAtomically(file, saved); return { result: saved.result };
        }
        controller.signal.throwIfAborted();
        dispatched = true;
        const result = await this.adapter(tool.connection.adapter).call(catalogEntry(tool.connection.pluginId), tool.connection, tool.definition, args, controller.signal);
        controller.signal.throwIfAborted();
        saved.result = { tool: tool.connection.pluginId, ok: !result.isError, output: JSON.stringify(result),
          metadata: { operationId: input.id, pluginId: tool.connection.pluginId, connectionId: tool.connection.id, operation: tool.definition.name } };
        saved.status = "completed"; await writeJsonAtomically(file, saved);
        return { result: saved.result };
      } catch (error) {
        if (!dispatched) throw error;
        if (error instanceof PluginInvocationError) {
          saved.status = "completed"; saved.result = { ...failure(error.message), metadata: { operationId: input.id, authenticationRequired: error.statusCode === 401 } };
          if (error.statusCode === 401) { this.live.set(tool.connection.id, { state: "authentication-required", tools: [], message: error.message }); this.cancel(tool.connection.id); }
          await writeJsonAtomically(file, saved);
          return { result: saved.result };
        }
        // Neither a timeout nor a transport failure proves an external write did not happen.
        saved.status = "unknown"; saved.result = this.unknown(input.id);
        await writeJsonAtomically(file, saved).catch(() => {});
        return { result: saved.result };
      } finally {
        clearTimeout(timer); input.signal?.removeEventListener("abort", abort); active.delete(controller);
        if (!active.size) { this.active.delete(tool.connection.id); this.activePlugins.delete(tool.connection.id); }
      }
    });
  }
  private unknown(id: string): ToolExecutionResult {
    return { ...failure("The external operation's outcome is unknown after interruption. Inspect the service before trying again; it was not repeated."), metadata: { unknown: true, operationId: id } };
  }
  async dispose() {
    this.closed = true;
    for (const id of this.active.keys()) this.cancel(id);
    await Promise.allSettled([...this.adapters.values()].map(adapter => adapter.dispose?.()));
    this.live.clear();
  }
}
