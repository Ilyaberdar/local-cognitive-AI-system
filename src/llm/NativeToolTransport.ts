import { randomUUID } from "crypto";
import { LLMFunctionTool, LLMResponse } from "../types";
import { readNativeAgentResponse } from "./ResponseItems";
import { readResponseText } from "./provider-utils";

type Item = Record<string, any>;

/** Consecutive tool results go back in one user turn: every call of the turn before answered together. */
function grouped(turns: Item[], key: "content" | "parts"): Item[] {
  return turns.reduce<Item[]>((out, turn) => {
    const last = out.at(-1);
    if (last?.role === "user" && turn.role === "user" && last.tools && turn.tools) last[key] = [...last[key], ...turn[key]];
    else out.push(turn);
    return out;
  }, []).map(({ tools: _tools, ...turn }) => turn);
}

export function anthropicContinuation(items: Item[] = []): Item[] {
  return grouped(items.flatMap(item => item.type === "anthropic_message" ? [{ role: "assistant", content: item.content }]
    : item.type === "function_call_output" ? [{ role: "user", tools: true, content: [{ type: "tool_result", tool_use_id: item.call_id, content: item.output }] }] : []), "content");
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
  return grouped(items.flatMap(item => {
    if (item.type === "gemini_content") return [item.content];
    if (item.type !== "function_call_output") return [];
    const call = items.find(candidate => candidate.type === "function_call" && candidate.call_id === item.call_id);
    return [{ role: "user", tools: true, parts: [{ functionResponse: { name: call?.name,
      ...(call?.providerCallId ? { id: call.providerCallId } : {}), response: { output: item.output } } }] }];
  }), "parts");
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

/** Chat completions' tool calls (DeepSeek, Groq, OpenRouter, Qwen) read as Responses items. Stateless:
 * nothing is kept for a continuation, so each turn is one request with the transcript (DeepSeek's thinking
 * mode would want its reasoning sent back beside earlier calls). */
export function chatAgentResponse(payload: Item, tools: LLMFunctionTool[]): Partial<LLMResponse> {
  const message: Item = payload.choices?.[0]?.message ?? {};
  const calls: Item[] = Array.isArray(message.tool_calls) ? message.tool_calls.filter((call: unknown) => call && typeof call === "object") : [];
  const text = readResponseText(payload);
  const output = [
    ...calls.map((call, index) => {
      const args = call.function?.arguments;
      return { type: "function_call", name: call.function?.name, call_id: typeof call.id === "string" && call.id ? call.id : `call_${index + 1}`,
        // A call without arguments may send "" (or an object, from some servers).
        arguments: typeof args === "string" ? (args.trim() ? args : "{}") : JSON.stringify(args ?? {}), status: "completed" };
    }),
    ...(text ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] : [])
  ];
  const { outputItems: _outputItems, ...result } = readNativeAgentResponse({ output }, tools);
  return result;
}
