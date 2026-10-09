import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PendingApproval, ToolExecutionResult } from "../../types";
import type { OperationInput } from "../../tools/OperationExecutor";
import { isMissingFile, withFileLock, writeJsonAtomically } from "../../utils/fileStore";
import { compileToolArgumentErrors, parseArgumentsJson, snapshotArguments } from "./schema";
import type { McpClientService, McpDiscoveredTool, McpServerPolicy } from "./types";

type Outcome = { result?: ToolExecutionResult; pendingApproval?: PendingApproval };
interface AvailableTool { id: string; bindingId: string; serverId: string; definition: Tool; fingerprint: string }
interface Invocation {
  id: string;
  agentRunId: string;
  identity: string;
  fingerprint: string;
  toolId: string;
  bindingId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: "waiting" | "approved" | "executing" | "completed" | "unknown";
  /** Once a call needed approval it keeps needing it, even if the server's mode changes meanwhile. */
  requiresApproval?: boolean;
  /** Approved by the server's approval mode, not asked. */
  autoApproved?: boolean;
  approval: PendingApproval;
  result?: ToolExecutionResult;
}

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** What a result keeps for the transcript, journal and chat history; images live in files beside it. */
const MAX_OUTPUT_CHARS = 64_000, MAX_STRUCTURED_CHARS = 16_000;
/** Folder (in the app's data) for images tools return; the newest MEDIA_KEPT are kept. */
export const MCP_MEDIA_DIR = "mcp-media";
const MEDIA_KEPT = 200;
const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
/** An image a tool returned: its file in MCP_MEDIA_DIR, for a model that can see images. */
export interface McpResultImage { file: string; mimeType: string; bytes: number }
const failure = (text: string): ToolExecutionResult => ({ tool: "mcp", ok: false, output: text });
/** Servers the user added. Plugin accounts share the connection pool but are reached only as plugins. */
const userBinding = (bindingId: string) => !bindingId.startsWith("plugin-");

/**
 * Presents configured outbound MCP tools to the agent loop. Every invocation is journaled and
 * never automatically replayed. It waits for the user's approval unless the server's approval
 * mode says otherwise (`McpApprovalMode`); a chat whose access mode is "ask" always asks.
 */
export class ExternalMcpExecutor {
  private readonly calls = new Map<string, Promise<void>>();

  constructor(private readonly baseDir: string, private readonly clients: McpClientService,
    private readonly policy: (serverId: string) => McpServerPolicy = () => ({ approval: "ask" })) {}

  private requiresApproval(tool: AvailableTool, input: Pick<OperationInput, "accessMode" | "requireApproval">): boolean {
    if (input.requireApproval || input.accessMode === "ask") return true;
    const mode = this.policy(tool.serverId).approval;
    return mode === "ask" || (mode === "read-only" && tool.definition.annotations?.readOnlyHint !== true);
  }

  /** MCP is offered while a server the user added is enabled, also one that dropped: a search tries it again. */
  async hasAvailable(): Promise<boolean> { return this.clients.list().some(status => status.enabled && userBinding(status.bindingId)); }

  /** Enabled servers that are not connected now, and why (the generic text; details stay in Settings). */
  private unavailable(): Array<Record<string, string>> {
    return this.clients.list().filter(status => status.enabled && userBinding(status.bindingId) && status.state !== "connected")
      .map(status => ({ serverId: status.serverId, state: status.state, ...(status.error ? { problem: status.error.message } : {}) }));
  }

  async search(query: string, input: Pick<OperationInput, "accessMode" | "requireApproval"> = { accessMode: "ask" }): Promise<Array<Record<string, unknown>>> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (await this.available())
      .map(tool => ({
        tool,
        score: words.reduce((score, word) => score +
          ((`${tool.id} ${tool.serverId} ${tool.definition.name} ${tool.definition.description ?? ""}`).toLowerCase().includes(word) ? 1 : 0), 0)
      }))
      .filter(item => !words.length || item.score > 0)
      .sort((left, right) => right.score - left.score || left.tool.id.localeCompare(right.tool.id))
      .slice(0, 12)
      .map(({ tool }) => ({ id: tool.id, serverId: tool.serverId, bindingId: tool.bindingId,
        name: tool.definition.name, description: tool.definition.description, inputSchema: tool.definition.inputSchema,
        ...(tool.definition.annotations?.readOnlyHint === true ? { readOnly: true } : {}),
        approvalRequired: this.requiresApproval(tool, input) }));
  }

  async execute(input: OperationInput): Promise<Outcome> {
    input.signal?.throwIfAborted();
    if (input.tool === "mcp.search") {
      // An editor opened after the app, or restarted: its server is tried again before answering.
      await this.clients.revive?.();
      const tools = await this.search(String(input.arguments.query ?? ""), input);
      const unavailable = this.unavailable();
      return { result: { tool: "mcp", ok: true, output: JSON.stringify(unavailable.length ? { tools, unavailableServers: unavailable } : tools) } };
    }
    if (input.tool !== "mcp.call") throw new Error("Unknown MCP operation.");
    if (input.readOnly) return { result: failure("This agent has read-only access and cannot invoke external MCP tools.") };

    const toolId = String(input.arguments.toolId);
    let args: Record<string, unknown>;
    try { args = snapshotArguments(parseArgumentsJson(String(input.arguments.argumentsJson))); }
    catch (error) {
      const reason = error instanceof SyntaxError ? ` (${error.message.slice(0, 160)})` : "";
      return { result: failure(`argumentsJson must be one serialized JSON object matching the tool's input schema${reason}.`) };
    }

    const file = path.join(this.baseDir, "mcp-operations", `${digest(input.id)}.json`);
    const identity = digest({ agentRunId: input.agentRunId, toolId, args, workspace: input.workspace });
    return withFileLock(file, async () => {
      let saved: Invocation | undefined;
      try { saved = JSON.parse(await fs.readFile(file, "utf8")) as Invocation; }
      catch (error) { if (!isMissingFile(error)) throw error; }
      if (saved && saved.identity !== identity) throw new Error("The saved MCP tool proposal changed. Start a new run.");
      if (saved?.status === "completed") return { result: saved.result };
      if (saved?.status === "executing" || saved?.status === "unknown") return { result: this.unknown(input.id) };

      let tool = (await this.available()).find(item => item.id === toolId);
      if (!tool) { await this.clients.revive?.(); tool = (await this.available()).find(item => item.id === toolId); }
      if (!tool) return { result: failure("This MCP tool is unavailable. Check that its server is enabled and connected.") };
      const problems = compileToolArgumentErrors(tool.definition.inputSchema)(args);
      if (problems.length) {
        return { result: failure(`Arguments do not match the tool's input schema. Correct them and call again:\n${problems.map(problem => `- ${problem}`).join("\n")}`) };
      }
      if (saved && saved.fingerprint !== tool.fingerprint) {
        return { result: { ...failure("The MCP tool changed after approval was requested. Start a new run."), metadata: { permissionRequired: true } } };
      }
      if (!saved) {
        saved = {
          id: input.id, agentRunId: input.agentRunId, identity, fingerprint: tool.fingerprint, toolId,
          bindingId: tool.bindingId, toolName: tool.definition.name, args, status: "waiting", requiresApproval: this.requiresApproval(tool, input),
          approval: {
            id: input.id, tool: "mcp", operation: tool.definition.name,
            summary: `${tool.serverId} · ${tool.definition.name}`,
            details: `External MCP server: ${tool.serverId}\nConnection: ${tool.bindingId}\n${JSON.stringify(args, null, 2)}`,
            requestedAt: new Date().toISOString()
          }
        };
        await writeJsonAtomically(file, saved);
      }

      if (saved.status !== "approved" && !saved.requiresApproval && !this.requiresApproval(tool, input)) {
        saved.status = "approved"; saved.autoApproved = true;
        await writeJsonAtomically(file, saved);
      }
      if (saved.status !== "approved") {
        if (!saved.requiresApproval) { saved.requiresApproval = true; await writeJsonAtomically(file, saved); }
        let decision: boolean;
        if (input.approval?.id === input.id) decision = input.approval.approved;
        else if (input.pauseForApproval) return { pendingApproval: saved.approval };
        else if (input.requestApproval) decision = await withFileLock(`approval:${input.agentRunId.split(":agent:")[0]}`,
          () => input.requestApproval!(saved!.approval));
        else return { result: { ...failure("Permission is required before using an external MCP tool."), metadata: { permissionRequired: true } } };
        input.signal?.throwIfAborted();
        if (!decision) {
          saved.status = "completed";
          saved.result = { ...failure("Permission denied. Nothing was sent to the external MCP server."), metadata: { cancelled: true, operationId: input.id } };
          await writeJsonAtomically(file, saved);
          return { result: saved.result };
        }
        saved.status = "approved";
        await writeJsonAtomically(file, saved);
      }

      const current = (await this.available()).find(item => item.id === toolId);
      if (!current || current.fingerprint !== saved.fingerprint) {
        return { result: { ...failure("MCP access changed while approval was pending. Nothing was sent."), metadata: { permissionRequired: true } } };
      }
      tool = current;
      let dispatched = false;
      try {
        const invocation = await this.serial(tool.bindingId, input.signal, async () => {
          const ready = (await this.available()).find(item => item.id === toolId);
          if (!ready || ready.fingerprint !== saved!.fingerprint) throw new Error("MCP access changed before dispatch.");
          saved!.status = "executing";
          await writeJsonAtomically(file, saved);
          dispatched = true;
          return this.clients.callTool({ bindingId: ready.bindingId, toolName: ready.definition.name, arguments: args,
            runId: input.agentRunId }, { signal: input.signal });
        });
        const { output, images } = await this.shape(invocation.result, input.id);
        saved.result = {
          tool: "mcp", ok: invocation.outcome === "success", output,
          metadata: { operationId: input.id, serverId: tool.serverId, bindingId: tool.bindingId, operation: tool.definition.name,
            ...(images.length ? { images } : {}) }
        };
        saved.status = "completed";
        await writeJsonAtomically(file, saved);
        return { result: saved.result };
      } catch (error) {
        // Once the call becomes executing, neither a transport error nor a cancellation
        // proves that the application on the other end did not act.
        if (!dispatched) throw error;
        saved.status = "unknown";
        saved.result = this.unknown(input.id);
        await writeJsonAtomically(file, saved).catch(() => undefined);
        return { result: saved.result };
      }
    });
  }

  /** A result as the agent keeps it: images (a viewport screenshot) and audio go to files and are
   * named in the text; other binary content is described; the rest is bounded. A multi-MB base64
   * string would otherwise fill the transcript, the run store, the journal and the chat history. */
  private async shape(result: CallToolResult, operationId: string): Promise<{ output: string; images: McpResultImage[] }> {
    const images: McpResultImage[] = [];
    const content: unknown[] = [];
    let index = 0;
    for (const item of result.content ?? []) {
      if (item.type === "image" || item.type === "audio") {
        const bytes = Buffer.from(item.data, "base64");
        const kept = item.type === "image" && extensions[item.mimeType];
        if (kept) {
          const file = `${digest(operationId).slice(0, 32)}-${index++}.${extensions[item.mimeType]}`;
          await fs.mkdir(path.join(this.baseDir, MCP_MEDIA_DIR), { recursive: true });
          await fs.writeFile(path.join(this.baseDir, MCP_MEDIA_DIR, file), bytes);
          images.push({ file, mimeType: item.mimeType, bytes: bytes.length });
        }
        content.push({ type: item.type, mimeType: item.mimeType, bytes: bytes.length, ...(kept ? { image: images.length } : {}) });
      } else if (item.type === "resource" && "blob" in item.resource) {
        content.push({ type: "resource", uri: item.resource.uri, mimeType: item.resource.mimeType, bytes: Buffer.byteLength(String(item.resource.blob), "base64") });
      } else content.push(item);
    }
    if (images.length) await this.pruneMedia();
    const structured = result.structuredContent === undefined ? undefined
      : JSON.stringify(result.structuredContent).length <= MAX_STRUCTURED_CHARS ? result.structuredContent : "[structured content omitted: too large]";
    const output = JSON.stringify({ content, ...(structured === undefined ? {} : { structuredContent: structured }), ...(result.isError ? { isError: true } : {}) });
    return { output: output.length > MAX_OUTPUT_CHARS ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n[OUTPUT TRUNCATED: the result was ${output.length} characters]` : output, images };
  }

  private async pruneMedia(): Promise<void> {
    const folder = path.join(this.baseDir, MCP_MEDIA_DIR);
    const files = await Promise.all((await fs.readdir(folder)).map(async name => ({ name, at: (await fs.stat(path.join(folder, name)).catch(() => undefined))?.mtimeMs ?? 0 })));
    for (const old of files.sort((a, b) => b.at - a.at).slice(MEDIA_KEPT)) await fs.rm(path.join(folder, old.name), { force: true });
  }

  private async available(): Promise<AvailableTool[]> {
    const statuses = new Map(this.clients.list().filter(status => status.enabled && status.state === "connected" && userBinding(status.bindingId))
      .map(status => [status.bindingId, status]));
    return this.clients.tools().flatMap((tool: McpDiscoveredTool) => {
      if (!statuses.has(tool.bindingId)) return [];
      // The server's tool filter (Settings, or imported from Codex): a tool left out is not offered.
      const { enabledTools, disabledTools } = this.policy(tool.serverId);
      if (enabledTools && !enabledTools.includes(tool.definition.name) || disabledTools?.includes(tool.definition.name)) return [];
      return [{ id: tool.id, bindingId: tool.bindingId, serverId: tool.serverId, definition: tool.definition,
        fingerprint: digest({ bindingId: tool.bindingId, serverId: tool.serverId, definition: tool.definition }) }];
    });
  }

  /** Unreal's MCP endpoint requires serial game-thread calls; serializing every binding is safe for all servers. */
  private async serial<T>(bindingId: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const previous = this.calls.get(bindingId) ?? Promise.resolve();
    let release!: () => void;
    const completed = new Promise<void>(resolve => { release = resolve; });
    const current = previous.catch(() => undefined).then(() => completed);
    this.calls.set(bindingId, current);
    await previous.catch(() => undefined);
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      release();
      void current.then(() => { if (this.calls.get(bindingId) === current) this.calls.delete(bindingId); });
    }
  }

  private unknown(id: string): ToolExecutionResult {
    return { ...failure("The external MCP operation's outcome is unknown after interruption. Inspect the target application before trying again; it was not repeated."),
      metadata: { unknown: true, operationId: id } };
  }
}
