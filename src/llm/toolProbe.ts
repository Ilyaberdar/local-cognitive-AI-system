import { LLMFunctionTool } from "../types";
import { Logger } from "../utils/Logger";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";
import { withChatTools, type ProviderDialect } from "./ProviderDialect";

/** Says nothing: a check's failure (a refused key, a server without tools) is its answer, never a log line. */
class QuietLogger extends Logger { override log(): void { /* nothing */ } }

const LIST: LLMFunctionTool = { name: "list_files", action: "file.list", description: "List the files in a folder of the workspace.", optionalArguments: [],
  parameters: { type: "object", properties: { path: { type: "string", description: "The folder, relative to the workspace." } }, required: ["path"], additionalProperties: false } };

/** How long the check may take: after the models are listed (at most 5 s), within the 30 s the window waits. */
export const TOOL_CHECK_TIMEOUT_MS = 8_000;

/** Add provider, for a service added as Other: whether it answers a chat tool call properly. One tiny
 * request with one function; anything but that function called with its argument (an error, text, a
 * refusal of tools) is no. Its agents then act through tool calls instead of JSON. */
export async function answersToolCalls(options: { baseUrl: string; apiKey?: string; model: string; dialect: ProviderDialect; timeoutMs?: number }, fetchImpl?: typeof fetch): Promise<boolean> {
  const provider = new OpenAICompatibleProvider({ id: "tool-check", name: "Provider", baseUrl: options.baseUrl, model: options.model, apiKey: options.apiKey,
    timeoutMs: options.timeoutMs ?? TOOL_CHECK_TIMEOUT_MS, dialect: withChatTools(options.dialect) }, new QuietLogger(), fetchImpl);
  try {
    const response = await provider.generateText({ prompt: 'List the files in the folder "src" with list_files. Call the function; do not answer in text.',
      systemPrompt: "You act only through the provided functions.", outputPurpose: "agent-action", tools: [LIST], maxTokens: 1024 });
    const action = response.agentAction;
    return !response.error && !response.protocolError && action?.type === "tool_call" && action.tool === "file.list" && typeof action.arguments.path === "string";
  } catch { return false; }
}
