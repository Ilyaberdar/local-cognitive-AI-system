import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { ExecutionContext, PendingApproval, ToolExecutionRequest, ToolExecutionResult } from "../types";
import { isMissingFile, withFileLock, writeJsonAtomically } from "../utils/fileStore";
import { Tool } from "./Tool.interface";

type FrozenContext = Omit<ExecutionContext, "signal" | "onProgress" | "requestApproval">;
type FrozenRequest = Omit<ToolExecutionRequest, "context"> & { context: FrozenContext };
type OperationStatus = "prepared" | "waiting" | "approved" | "executing" | "completed" | "unknown";

export interface SavedPluginOperation {
  version: 1;
  id: string;
  agentRunId: string;
  toolName: string;
  configurationIdentity?: string;
  status: OperationStatus;
  requiresApproval: boolean;
  request: FrozenRequest;
  approval: PendingApproval;
  result?: ToolExecutionResult;
}

export interface PluginOperationOutcome {
  result?: ToolExecutionResult;
  pendingApproval?: PendingApproval;
}

export class PluginOperationStore {
  constructor(private readonly appDataDir: string) {}

  key(id: string): string {
    return path.join(this.appDataDir, "plugin-operations", `${digest(id)}.json`);
  }

  async get(id: string): Promise<SavedPluginOperation | undefined> {
    let operation: SavedPluginOperation;
    try { operation = JSON.parse(await fs.readFile(this.key(id), "utf8")) as SavedPluginOperation; }
    catch (error) { if (isMissingFile(error)) return undefined; throw error; }
    if (operation.version !== 1 || operation.id !== id ||
        !["prepared", "waiting", "approved", "executing", "completed", "unknown"].includes(operation.status)) {
      throw new Error("The saved plugin operation is invalid. It was not executed.");
    }
    return operation;
  }

  async save(operation: SavedPluginOperation): Promise<void> {
    await writeJsonAtomically(this.key(operation.id), operation);
  }
}

/** Compatibility path for explicitly selected registry plugins, outside the model's tool protocol. */
export class PluginOperationExecutor {
  readonly store: PluginOperationStore;

  constructor(appDataDir: string) {
    this.store = new PluginOperationStore(appDataDir);
  }

  async execute(tool: Tool, request: ToolExecutionRequest): Promise<PluginOperationOutcome> {
    const execution = request.context.execution;
    if (!execution?.agentRunId) throw new Error("A plugin operation requires a stable server-owned agent run ID.");
    const toolName = tool.name.trim().toLowerCase();
    if (!toolName || ["file", "command"].includes(toolName)) {
      throw new Error("PluginOperationExecutor only executes explicitly selected external plugins.");
    }
    request.context.signal?.throwIfAborted();
    // Capture synchronously, before a permission callback or caller can change the proposal.
    const snapshot = freezeRequest(request);
    const id = `plugin-${digest(JSON.stringify([execution.agentRunId, toolName]))}`;
    const requiresApproval = execution.requireApproval === true || execution.accessMode !== "full";

    return withFileLock(this.store.key(id), async () => {
      request.context.signal?.throwIfAborted();
      let saved = await this.store.get(id);
      if (saved) this.assertIdentity(saved, toolName, execution.agentRunId, snapshot);
      if (saved?.status === "completed") {
        if (!saved.result) throw new Error("The completed plugin operation has no saved result. It was not repeated.");
        return { result: cloneJson(saved.result) };
      }
      if (saved?.status === "executing" || saved?.status === "unknown") {
        return this.markUnknown(saved);
      }
      if(saved && saved.configurationIdentity !== tool.approvalFingerprint?.()) {
        return { result: { tool: toolName, ok: false, output: "The plugin configuration changed after this operation was proposed. Start a new run to approve the new destination.", metadata: { permissionRequired: true, operationId: id } } };
      }
      if (!saved) {
        saved = {
          version: 1, id, agentRunId: execution.agentRunId, toolName, configurationIdentity:tool.approvalFingerprint?.(), status: "prepared", requiresApproval,
          request: snapshot,
          approval: {
            id, tool: toolName, operation: "plugin", summary: `Run ${toolName} · ${snapshot.title}`,
            details: [tool.description, `Title: ${snapshot.title}`, snapshot.content,
              snapshot.metadata ? `Plugin parameters:\n${JSON.stringify(snapshot.metadata, null, 2)}` : ""].filter(Boolean).join("\n\n"),
            requestedAt: new Date().toISOString()
          }
        };
        await this.store.save(saved);
      }

      // A later looser policy never authorizes an already waiting proposal by itself.
      if ((saved.requiresApproval || requiresApproval) && saved.status !== "approved") {
        saved.requiresApproval = true;
        saved.status = "waiting";
        await this.store.save(saved);
        let decision: boolean;
        if (execution.approval?.id === saved.id) decision = execution.approval.approved;
        else if (execution.pauseForApproval) return { pendingApproval: cloneJson(saved.approval) };
        else if (request.context.requestApproval) {
          decision = await withFileLock(`approval:${execution.agentRunId.split(":agent:")[0]}`,
            () => request.context.requestApproval!(cloneJson(saved!.approval)));
        } else {
          return { result: {
            tool: toolName, ok: false, output: `Permission required: ${saved.approval.summary}`,
            metadata: { permissionRequired: true, operation: "plugin", operationId: id, approvalId: id }
          } };
        }
        request.context.signal?.throwIfAborted();
        if (!decision) {
          saved.status = "completed";
          saved.result = { tool: toolName, ok: false, output: `Cancelled: ${saved.approval.summary}. Nothing was executed.`,
            metadata: { cancelled: true, operation: "plugin", operationId: id } };
          await this.store.save(saved);
          return { result: cloneJson(saved.result) };
        }
        saved.status = "approved";
        await this.store.save(saved);
      }

      request.context.signal?.throwIfAborted();
      if(saved.configurationIdentity !== tool.approvalFingerprint?.()) {
        return { result: { tool: toolName, ok: false, output: "The plugin configuration changed while awaiting approval. Start a new run to approve the new destination.", metadata: { permissionRequired: true, operationId: id } } };
      }
      // A durable executing marker must precede any connector effect. On restart it is unknown.
      saved.status = "executing";
      await this.store.save(saved);
      try {
        const frozen = cloneJson(saved.request);
        const result = await tool.execute({ ...frozen, context: {
          ...frozen.context,
          signal: request.context.signal,
          onProgress: request.context.onProgress,
          requestApproval: request.context.requestApproval
        } });
        request.context.signal?.throwIfAborted();
        if (!result || typeof result.ok !== "boolean" || typeof result.output !== "string") {
          throw new Error("The plugin returned no valid result after execution.");
        }
        saved.result = cloneJson({ ...result, tool: toolName,
          metadata: { ...result.metadata, operation: "plugin", operationId: id } });
        saved.status = "completed";
        // A failed completion write is also uncertain: the external action already happened.
        await this.store.save(saved);
        return { result: cloneJson(saved.result) };
      } catch (error) {
        return this.markUnknown(saved, error);
      }
    });
  }

  private assertIdentity(saved: SavedPluginOperation, toolName: string, agentRunId: string, request: FrozenRequest): void {
    if (saved.toolName !== toolName || saved.agentRunId !== agentRunId || saved.request.rawInput !== request.rawInput ||
        JSON.stringify(saved.request.context.actor) !== JSON.stringify(request.context.actor) ||
        JSON.stringify(saved.request.context.execution?.workspace) !== JSON.stringify(request.context.execution?.workspace)) {
      throw new Error("Plugin operation identity or workspace differs from its saved proposal. It was not executed.");
    }
  }

  private async markUnknown(saved: SavedPluginOperation, error?: unknown): Promise<PluginOperationOutcome> {
    saved.status = "unknown";
    saved.result = {
      tool: saved.toolName, ok: false,
      output: "Plugin outcome is unknown after interruption. Inspect the external service before starting a new run; this operation was not repeated.",
      metadata: { unknown: true, operation: "plugin", operationId: saved.id,
        ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) }
    };
    // If storage is unavailable, the earlier executing marker still prevents a later replay.
    try { await this.store.save(saved); }
    catch { /* Return the hard-stop outcome even if its diagnostic cannot be persisted. */ }
    return { result: cloneJson(saved.result) };
  }
}

function freezeRequest(request: ToolExecutionRequest): FrozenRequest {
  if ([request.rawInput, request.title, request.content].some(value => typeof value !== "string")) {
    throw new Error("Plugin request input, title and content must be strings.");
  }
  const { signal: _signal, onProgress: _onProgress, requestApproval: _requestApproval, ...context } = request.context;
  // Approval is specific to the current invocation and is never replayed into another plugin.
  const execution = context.execution ? { ...context.execution, approval: undefined } : undefined;
  return cloneJson({ ...request, context: { ...context, execution } });
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
