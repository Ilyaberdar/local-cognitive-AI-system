import { randomUUID } from "crypto";
import { LLMFunctionTool, LLMResponse } from "../types";
import { readNativeAgentResponse } from "./ResponseItems";

type Item = Record<string, any>;

export function anthropicContinuation(items: Item[] = []): Item[] {
  return items.flatMap(item => item.type === "anthropic_message" ? [{ role: "assistant", content: item.content }]
    : item.type === "function_call_output" ? [{ role: "user", content: [{ type: "tool_result", tool_use_id: item.call_id, content: item.output }] }] : []);
}

export function anthropicAgentResponse(payload: Item, tools: LLMFunctionTool[]): Partial<LLMResponse> {
  const content: Item[] = Array.isArray(payload.content) ? payload.content : [];
  const calls = content.filter(item => item.type === "tool_use").map(item => ({ type: "function_call", name: item.name,
    call_id: item.id, arguments: JSON.stringify(item.input), status: "completed" }));
  const output = [{ type: "anthropic_message", content }, ...calls,
    { type: "message", role: "assistant", content: content.filter(item => item.type === "text").map(item => ({ type: "output_text", text: item.text })) }];
  const result = readNativeAgentResponse({ output }, tools);
  if (result.outputItems) result.outputItems = output.filter(item => item.type !== "message");
  return result;
}

export function geminiContinuation(items: Item[] = []): Item[] {
  return items.flatMap(item => {
    if (item.type === "gemini_content") return [item.content];
    if (item.type !== "function_call_output") return [];
    const call = items.find(candidate => candidate.type === "function_call" && candidate.call_id === item.call_id);
    return [{ role: "user", parts: [{ functionResponse: { name: call?.name,
      ...(call?.providerCallId ? { id: call.providerCallId } : {}), response: { output: item.output } } }] }];
  });
}

export function geminiAgentResponse(content: Item, tools: LLMFunctionTool[]): Partial<LLMResponse> {
  const parts: Item[] = Array.isArray(content.parts) ? content.parts : [];
  const calls = parts.filter(part => part.functionCall).map(part => ({ type: "function_call", name: part.functionCall.name,
    call_id: part.functionCall.id || randomUUID(), providerCallId: part.functionCall.id,
    arguments: JSON.stringify(part.functionCall.args ?? {}), status: "completed" }));
  const output = [{ type: "gemini_content", content }, ...calls,
    { type: "message", role: "assistant", content: parts.filter(part => typeof part.text === "string" && !part.thought).map(part => ({ type: "output_text", text: part.text })) }];
  const result = readNativeAgentResponse({ output }, tools);
  if (result.outputItems) result.outputItems = output.filter(item => item.type !== "message");
  return result;
}
