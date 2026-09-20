import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { RuntimeManager } from "../../app/RuntimeManager";
import { LocalModelService } from "../../local/LocalModelService";
import { LocalModelError } from "../../local/types";
import { errorResult, jsonResult, progressReporter } from "./results";

export const localModelStatus = (service: LocalModelService) => ({
  providerId: "llamacpp" as const,
  available: service.available,
  ...service.snapshot()
});

export const assertLocalModelAvailable = (service: LocalModelService, modelId?: string): void => {
  const snapshot = service.snapshot();
  if (!service.available) {
    throw new LocalModelError(snapshot.runtime.error || "The local model runtime is unavailable. Check local_ai_local_model_status.", 503, "local_runtime_unavailable");
  }
  if (!modelId) {
    throw new LocalModelError("No local model is selected. Call local_ai_local_model_status to see installed model IDs, then local_ai_load_model with modelId and selectForSession:true, or pass providerId:llamacpp and model to the chat tool. If the library is empty, download or import a GGUF in Models first.", 400, "model_not_selected");
  }
  if (!snapshot.models.some(model => model.id === modelId)) {
    throw new LocalModelError("This model is not installed. Use an exact model ID from local_ai_local_model_status. Download or import a GGUF in Models first if the library is empty.", 404, "model_not_installed");
  }
};

export const registerLocalModelMcpTools = (
  server: McpServer,
  runtimeManager: RuntimeManager,
  defaultSessionId: string
): void => {
  const modelId = z.string().trim().min(1).describe("Installed GGUF library ID from local_ai_local_model_status, not a filename or display name.");

  server.registerTool("local_ai_local_model_status", {
    title: "Local AI Local Model Status",
    description: "List installed GGUF models and their exact IDs, compatibility, loaded state, runtime availability and inference queue. This is the built-in llamacpp runtime owned by this MCP process.",
    inputSchema: {},
    annotations: { readOnlyHint: true }
  }, async () => jsonResult(localModelStatus(runtimeManager.getRuntime().localModelService)));

  server.registerTool("local_ai_load_model", {
    title: "Local AI Load Model",
    description: "Load an installed GGUF into the built-in llamacpp runtime and wait until ready. May take several minutes. Set selectForSession:true to use it for subsequent chat calls without provider/model overrides. Loading alone preserves session selection. Does not download models.",
    inputSchema: {
      modelId,
      sessionId: z.string().trim().min(1).optional().describe("Session to update when selectForSession is true; defaults to the configured MCP session."),
      selectForSession: z.boolean().optional().describe("When true, select this provider/model as the session default after a successful load. Defaults to false.")
    },
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, async (args, extra) => {
    const runtime = runtimeManager.getRuntime();
    const service = runtime.localModelService;
    const report = progressReporter(extra);
    let unsubscribe: (() => void) | undefined;
    try {
      extra.signal.throwIfAborted();
      assertLocalModelAvailable(service, args.modelId);
      report(`Waiting to load ${args.modelId}`);
      let previous = "";
      unsubscribe = service.subscribe(({ snapshot }) => {
        const message = `${snapshot.runtime.status}; model: ${snapshot.runtime.modelId || "none"}; queued: ${snapshot.runtime.queueLength}`;
        if (message !== previous) { previous = message; report(message); }
      });
      await service.loadModel(args.modelId, extra.signal);
      extra.signal.throwIfAborted();
      const sessionId = args.sessionId || defaultSessionId;
      if (args.selectForSession) {
        await runtime.sessionSettingsStore.update(sessionId, { defaultTarget: { providerId: "llamacpp", model: args.modelId } });
      }
      return jsonResult({
        ...localModelStatus(service), modelId: args.modelId,
        selectedForSession: args.selectForSession === true,
        ...(args.selectForSession ? { sessionId } : {})
      });
    } catch (error) { return errorResult(error, extra.signal); }
    finally { unsubscribe?.(); }
  });

  server.registerTool("local_ai_unload_model", {
    title: "Local AI Unload Model",
    description: "Unload an installed GGUF from memory. Keeps its files and session selection; a later chat using it loads it again automatically. A busy model must finish or have its requests cancelled before unloading.",
    inputSchema: { modelId },
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, async (args, extra) => {
    const service = runtimeManager.getRuntime().localModelService;
    try {
      extra.signal.throwIfAborted();
      await service.unloadModel(args.modelId, extra.signal);
      return jsonResult({ ...localModelStatus(service), modelId: args.modelId });
    } catch (error) { return errorResult(error, extra.signal); }
  });
};
