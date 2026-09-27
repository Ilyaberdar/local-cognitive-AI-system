import { LLMFunctionTool, LLMResponse } from "../types";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

export const responseItems = (payload: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(payload.output) ? payload.output.filter(record) : [];

export function responseMessages(payload: Record<string, unknown>): Record<string, unknown>[] {
  const messages = responseItems(payload).filter(item => item.type === "message" && (item.role === "assistant" || item.role === undefined));
  const final = messages.filter(item => item.channel === "final");
  return final.length ? final : messages.filter(item => item.channel === undefined || item.channel === null);
}

export function messageText(message: Record<string, unknown>): string {
  return Array.isArray(message.content) ? message.content.filter(record)
    .filter(part => part.type === "output_text" || part.type === "text" || part.type === undefined)
    .map(part => typeof part.text === "string" ? part.text : typeof part.output_text === "string" ? part.output_text : "").join("") : "";
}

export function responseRefusal(payload: Record<string, unknown>): string | undefined {
  for (const message of responseMessages(payload)) {
    if (!Array.isArray(message.content)) continue;
    const refusal = message.content.find(part => record(part) && part.type === "refusal");
    if (refusal) return typeof refusal.refusal === "string" ? `Model refused the request: ${refusal.refusal}` : "Model refused the request.";
  }
}

/** Only protocol-level function calls can authorize an action. Text is always a final answer. */
export function readNativeAgentResponse(payload: Record<string, unknown>, tools: LLMFunctionTool[]): Pick<LLMResponse, "agentAction" | "protocolError" | "toolCallId" | "outputItems"> {
  const outputItems = responseItems(payload);
  const calls = outputItems.filter(item => item.type === "function_call");
  try {
    if (calls.length > 1) throw new Error("Expected one function call; received multiple calls. No action was executed.");
    if (calls.length === 1) {
      const call = calls[0];
      const tool = tools.find(tool => tool.name === call.name);
      if (!tool) throw new Error(`Unknown function: ${String(call.name)}. No action was executed.`);
      if (typeof call.call_id !== "string" || !call.call_id) throw new Error("Function call has no call_id. No action was executed.");
      if (call.status && call.status !== "completed") throw new Error("Function call is incomplete. No action was executed.");
      if (typeof call.arguments !== "string") throw new Error("Function arguments must be a JSON object.");
      const args: unknown = JSON.parse(call.arguments);
      if (!record(args)) throw new Error("Function arguments must be a JSON object.");
      for (const key of tool.optionalArguments) if (args[key] === null) delete args[key];
      return { agentAction: { type: "tool_call", tool: tool.action, arguments: args }, toolCallId: call.call_id, outputItems };
    }
    const messages = responseMessages(payload);
    if (messages.length !== 1) throw new Error(`Expected one final message; received ${messages.length}.`);
    const text = messageText(messages[0]).trim();
    if (!text) throw new Error("The model returned no final answer or function call.");
    return { agentAction: { type: "final", text } };
  } catch (error) {
    return { protocolError: error instanceof Error ? error.message : String(error) };
  }
}
