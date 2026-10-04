import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PendingApproval, ToolExecutionResult } from "../../types";
import type { OperationInput } from "../../tools/OperationExecutor";
import { isMissingFile, withFileLock, writeJsonAtomically } from "../../utils/fileStore";
import { compileToolArguments, snapshotArguments } from "./schema";
import type { McpClientService, McpDiscoveredTool } from "./types";

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
  approval: PendingApproval;
  result?: ToolExecutionResult;
}

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const failure = (text: string): ToolExecutionResult => ({ tool: "mcp", ok: false, output: text });

/**
 * Presents configured outbound MCP tools to the agent loop. Every invocation is
 * confirmed, journaled and never automatically replayed: a remote MCP schema
 * cannot reliably tell us whether a call is read-only.
 */
export class ExternalMcpExecutor {
  private readonly calls = new Map<string, Promise<void>>();

  constructor(private readonly baseDir: string, private readonly clients: McpClientService) {}

  async hasAvailable(): Promise<boolean> { return (await this.available()).length > 0; }

  async search(query: string): Promise<Array<Record<string, unknown>>> {
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
        approvalRequired: true }));
  }

  async execute(input: OperationInput): Promise<Outcome> {
    input.signal?.throwIfAborted();
    if (input.tool === "mcp.search") {
      return { result: { tool: "mcp", ok: true, output: JSON.stringify(await this.search(String(input.arguments.query ?? ""))) } };
    }
    if (input.tool !== "mcp.call") throw new Error("Unknown MCP operation.");
    if (input.readOnly) return { result: failure("This agent has read-only access and cannot invoke external MCP tools.") };

    const toolId = String(input.arguments.toolId);
    let args: Record<string, unknown>;
    try { args = snapshotArguments(JSON.parse(String(input.arguments.argumentsJson))); }
    catch { return { result: failure("Tool arguments must be a JSON object matching the discovered schema.") }; }

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
      if (!tool) return { result: failure("This MCP tool is unavailable. Check that its server is enabled and connected.") };
      if (!compileToolArguments(tool.definition.inputSchema)(args)) {
        return { result: failure("Arguments do not match the current MCP tool schema. Search tools again before calling it.") };
      }
      if (saved && saved.fingerprint !== tool.fingerprint) {
        return { result: { ...failure("The MCP tool changed after approval was requested. Start a new run."), metadata: { permissionRequired: true } } };
      }
      if (!saved) {
        saved = {
          id: input.id, agentRunId: input.agentRunId, identity, fingerprint: tool.fingerprint, toolId,
          bindingId: tool.bindingId, toolName: tool.definition.name, args, status: "waiting",
          approval: {
            id: input.id, tool: "mcp", operation: tool.definition.name,
            summary: `${tool.serverId} · ${tool.definition.name}`,
            details: `External MCP server: ${tool.serverId}\nConnection: ${tool.bindingId}\n${JSON.stringify(args, null, 2)}`,
            requestedAt: new Date().toISOString()
          }
        };
        await writeJsonAtomically(file, saved);
      }

      if (saved.status !== "approved") {
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
        saved.result = {
          tool: "mcp", ok: invocation.outcome === "success", output: JSON.stringify(invocation.result),
          metadata: { operationId: input.id, serverId: tool.serverId, bindingId: tool.bindingId, operation: tool.definition.name }
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

  private async available(): Promise<AvailableTool[]> {
    const statuses = new Map(this.clients.list().filter(status => status.enabled && status.state === "connected")
      .map(status => [status.bindingId, status]));
    return this.clients.tools().flatMap((tool: McpDiscoveredTool) => {
      if (!statuses.has(tool.bindingId)) return [];
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
