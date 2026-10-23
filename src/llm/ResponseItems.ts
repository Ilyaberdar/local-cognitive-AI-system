import { LLMFunctionTool, LLMResponse } from "../types";
import { leadingJsonObject, wholeJsonObject } from "./StructuredOutput";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** Reasoning a model wrote before its answer in <think> or <thinking> blocks: never the answer. The JSON and
 * local paths leave out <analysis> blocks too, as they always did; a native answer may hold its findings in one. */
export const withoutLeadingThinking = (text: string, options: { analysis?: boolean } = {}): string =>
  text.replace(options.analysis === false ? /^(?:\s*<(think|thinking)>[\s\S]*?<\/\1>\s*)+/i : /^(?:\s*<(think|thinking|analysis)>[\s\S]*?<\/\1>\s*)+/i, "");
/** DeepSeek's own function-call markup (<｜DSML｜function_calls>, invoke, parameter; its bars doubled at times). */
export const DSML_CALL = /<\/?｜+DSML｜+\s*(?:function_calls|calls|invoke|parameter)\b/u;
const DSML_TAG = /<\/?｜+DSML｜+/uy;

/** A Markdown text without its code: fenced blocks (``` or ~~~; one left open runs to the end) and inline
 * code spans. Markup there is quoted (an answer about this very code), never the model's own call. */
export function outsideCode(text: string): string {
  const kept: string[] = []; let fence: string | undefined;
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) { if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !line.slice(marker[0].length).trim()) fence = undefined; continue; }
    if (marker) { fence = marker[1]; continue; }
    kept.push(line);
  }
  return kept.join("\n").replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, " ");
}

/** A JSON reply without DeepSeek's markup after it: cut from the first DSML tag outside a JSON string, so
 * markup an answer's text quotes stays in the answer, and the markup after the object (its closers too) goes. */
export function withoutDsmlTrailer(text: string): string {
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) { if (char === "\\") index++; else if (char === "\"") inString = false; continue; }
    if (char === "\"") { inString = true; continue; }
    if (char === "<") { DSML_TAG.lastIndex = index; if (DSML_TAG.test(text)) return text.slice(0, index).trimEnd(); }
  }
  return text;
}

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

/** A native reply's text that is a JSON envelope: a tool call written as text (never run: only a
 * protocol-level function call authorizes an action), or a final answer wrapped as one ({"type":"final"}). */
function textEnvelope(text: string, tools: LLMFunctionTool[]): { toolCall: true } | { final: string } | undefined {
  const value = leadingJsonObject(text);
  if (!record(value)) return undefined;
  const names = new Set(tools.flatMap(tool => [tool.name, tool.action]));
  const action = Object.keys(value).length === 1 && record(value.action) ? value.action : value;
  const whole = wholeJsonObject(text);
  // A call: one that names a tool this agent has, whatever follows it; or the whole reply in a call's shape.
  // A Markdown answer that only starts with JSON (a config with a "tool" key) stays the answer.
  const named = [action.tool, action.type, action.name].some(name => typeof name === "string" && names.has(name));
  const shaped = action.type === "tool_call" || typeof action.tool === "string" || (typeof action.name === "string" && ("arguments" in action || "parameters" in action));
  if (named || shaped && whole) return { toolCall: true };
  // Only a whole reply that is exactly {"type":"final","text":…} is unwrapped; anything else stays the answer as written.
  if (action.type === "final" && typeof action.text === "string" && action.text.trim() && Object.keys(action).length === 2 && whole) return { final: action.text.trim() };
  return undefined;
}

/** Only protocol-level function calls can authorize an action. Text is always a final answer. Several
 * calls in one reply (DeepSeek's chat sends them whatever parallel_tool_calls says): the first runs, as
 * it would have alone, and `extraCalls` names the others, which never run. */
export function readNativeAgentResponse(payload: Record<string, unknown>, tools: LLMFunctionTool[]): Pick<LLMResponse, "agentAction" | "protocolError" | "toolCallId" | "outputItems" | "extraCalls" | "textToolCall"> {
  const outputItems = responseItems(payload);
  const calls = outputItems.filter(item => item.type === "function_call");
  try {
    if (calls.length) {
      const [call, ...others] = calls;
      const tool = tools.find(tool => tool.name === call.name);
      if (!tool) throw new Error(`Unknown function: ${String(call.name)}. No action was executed.`);
      if (typeof call.call_id !== "string" || !call.call_id) throw new Error("Function call has no call_id. No action was executed.");
      if (call.status && call.status !== "completed") throw new Error("Function call is incomplete. No action was executed.");
      if (typeof call.arguments !== "string") throw new Error("Function arguments must be a JSON object.");
      const args: unknown = JSON.parse(call.arguments);
      if (!record(args)) throw new Error("Function arguments must be a JSON object.");
      for (const key of tool.optionalArguments) if (args[key] === null) delete args[key];
      const extraCalls = others.length ? { extraCalls: { count: others.length, callIds: others.map(item => item.call_id).filter((id): id is string => typeof id === "string" && id !== "") } } : {};
      return { agentAction: { type: "tool_call", tool: tool.action, arguments: args }, toolCallId: call.call_id, outputItems, ...extraCalls };
    }
    const messages = responseMessages(payload);
    if (messages.length > 1) throw new Error(`Expected one final message; received ${messages.length}.`);
    // Cleaned as an agent's JSON reply is (LLMService): reasoning before the answer is not part of it.
    const text = messages.length ? withoutLeadingThinking(messageText(messages[0]).trim(), { analysis: false }).trim() : "";
    if (!text) throw new Error("The model returned no final answer or function call.");
    // DeepSeek's call markup in the answer's prose is a call written as text; in its code it is quoted.
    const envelope = DSML_CALL.test(outsideCode(text)) ? { toolCall: true as const } : textEnvelope(text, tools);
    if (envelope && "toolCall" in envelope) return { textToolCall: true, protocolError: `Your reply wrote a tool call as text, so nothing ran. To act, call the function itself (${tools.slice(0, 3).map(tool => tool.name).join(", ")}…), not JSON in your answer; when you are done, answer in plain Markdown.` };
    return { agentAction: { type: "final", text: envelope?.final ?? text } };
  } catch (error) {
    return { protocolError: error instanceof Error ? error.message : String(error) };
  }
}
