import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { RuntimeManager } from "../../app/RuntimeManager";
import { SessionIndexStore } from "../../session/SessionIndexStore";
import { Mode } from "../../types";
import { processRuntimeInput } from "../shared/runtimeActions";

interface McpToolContext {
  runtimeManager: RuntimeManager;
  sessionIndexStore: SessionIndexStore;
  defaultSessionId: string;
}

const optionalString = () => z.string().trim().optional();

const metadataSchema = z.record(z.string(), z.unknown()).optional();

const processInputSchema = {
  input: z.string().min(1).describe("Prompt or instruction to process."),
  sessionId: optionalString().describe("Stable session id. Defaults to the configured MCP session."),
  sessionTitle: optionalString().describe("Optional title used when creating or touching the session."),
  userId: optionalString().describe("Optional caller/user id for memory attribution."),
  providerId: optionalString().describe("Provider id override, for example lmstudio, openai, anthropic, gemini, ollama."),
  model: optionalString().describe("Model id override for the selected provider."),
  metadata: metadataSchema.describe("Optional structured metadata passed to the runtime.")
};

const modeSchema = z.enum(["general", "code", "hypothesis"]);

const textResult = (text: string, data?: unknown) => ({
  content: [
    {
      type: "text" as const,
      text
    }
  ],
  ...(data === undefined ? {} : { structuredContent: { result: data } })
});

const jsonText = (value: unknown): string => JSON.stringify(value, null, 2);

const runProcessTool = async (
  context: McpToolContext,
  args: z.infer<z.ZodObject<typeof processInputSchema>>,
  mode?: Mode
) => {
  const result = await processRuntimeInput(
    context.runtimeManager,
    context.sessionIndexStore,
    {
      input: args.input,
      sessionId: args.sessionId || context.defaultSessionId,
      sessionTitle: args.sessionTitle,
      userId: args.userId,
      providerId: args.providerId,
      model: args.model,
      metadata: args.metadata,
      mode
    },
    "mcp"
  );
  const runtime = context.runtimeManager.getRuntime();
  const text = runtime.formatter.formatForChat(result, { maxChars: 12000 });

  return textResult(text, result);
};

export const registerLocalCognitiveMcpTools = (
  server: McpServer,
  context: McpToolContext
): void => {
  server.registerTool(
    "local_ai_chat",
    {
      title: "Local AI Chat",
      description: "Run the Local Cognitive AI runtime with automatic mode routing.",
      inputSchema: {
        ...processInputSchema,
        mode: modeSchema.optional().describe("Optional mode override: general, code, or hypothesis.")
      },
      annotations: {
        readOnlyHint: false
      }
    },
    async (args) => runProcessTool(context, args, args.mode)
  );

  server.registerTool(
    "local_ai_code",
    {
      title: "Local AI Code",
      description: "Run a code-focused task through the Local Cognitive AI runtime.",
      inputSchema: processInputSchema,
      annotations: {
        readOnlyHint: false
      }
    },
    async (args) => runProcessTool(context, args, "code")
  );

  server.registerTool(
    "local_ai_hypothesis",
    {
      title: "Local AI Hypothesis",
      description: "Run a hypothesis/debate task through the Local Cognitive AI runtime.",
      inputSchema: processInputSchema,
      annotations: {
        readOnlyHint: false
      }
    },
    async (args) => runProcessTool(context, args, "hypothesis")
  );

  server.registerTool(
    "local_ai_runtime_status",
    {
      title: "Local AI Runtime Status",
      description: "Return configured providers, tools, plugins, and MCP defaults.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true
      }
    },
    async () => {
      const runtime = context.runtimeManager.getRuntime();

      return textResult(
        jsonText({
          defaultSessionId: context.defaultSessionId,
          providers: runtime.providerDescriptors,
          tools: runtime.tools,
          plugins: runtime.plugins
        })
      );
    }
  );

  server.registerTool(
    "local_ai_list_models",
    {
      title: "Local AI List Models",
      description: "List provider model aliases and optionally locally managed LM Studio/Ollama models.",
      inputSchema: {
        providerId: optionalString().describe("Optional provider id filter."),
        includeManagedModels: z.boolean().optional().describe("When true, include locally managed model list.")
      },
      annotations: {
        readOnlyHint: true
      }
    },
    async ({ providerId, includeManagedModels }) => {
      const runtime = context.runtimeManager.getRuntime();
      const models = await runtime.modelCatalog.listAll(providerId);
      const managedModels = includeManagedModels
        ? await runtime.localModelManager.listAllModels(providerId)
        : undefined;

      return textResult(jsonText({ models, managedModels }), { models, managedModels });
    }
  );

  server.registerTool(
    "local_ai_get_session_settings",
    {
      title: "Local AI Get Session Settings",
      description: "Read normalized session settings for a Local Cognitive AI session.",
      inputSchema: {
        sessionId: optionalString().describe("Session id. Defaults to the configured MCP session.")
      },
      annotations: {
        readOnlyHint: true
      }
    },
    async ({ sessionId }) => {
      const runtime = context.runtimeManager.getRuntime();
      const resolvedSessionId = sessionId || context.defaultSessionId;
      const settings = await runtime.sessionSettingsStore.get(resolvedSessionId);

      return textResult(jsonText({ sessionId: resolvedSessionId, settings }), {
        sessionId: resolvedSessionId,
        settings
      });
    }
  );

  server.registerTool(
    "local_ai_update_session_settings",
    {
      title: "Local AI Update Session Settings",
      description: "Patch session settings. Uses the same normalized settings store as the UI.",
      inputSchema: {
        sessionId: optionalString().describe("Session id. Defaults to the configured MCP session."),
        patch: z.record(z.string(), z.unknown()).describe("SessionSettingsPatch object.")
      },
      annotations: {
        readOnlyHint: false
      }
    },
    async ({ sessionId, patch }) => {
      const runtime = context.runtimeManager.getRuntime();
      const resolvedSessionId = sessionId || context.defaultSessionId;
      const settings = await runtime.sessionSettingsStore.update(resolvedSessionId, patch);

      return textResult(jsonText({ sessionId: resolvedSessionId, settings }), {
        sessionId: resolvedSessionId,
        settings
      });
    }
  );
};
