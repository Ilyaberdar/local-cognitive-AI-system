import { LLMResponseFormat } from "../types";
import Ajv, { ValidateFunction } from "ajv";

const validator = new Ajv({ strict: false, allErrors: true });
const compiled = new WeakMap<object, ValidateFunction>();

const unfenced = (text: string) => text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i, "$1");

export function parseJsonDocument(text: string): unknown {
  return JSON.parse(unfenced(text));
}

/** Where the JSON object starting at `at` ends (after its closing brace), or -1 when it does not. */
function objectEnd(source: string, at: number): number {
  let depth = 0, inString = false;
  for (let index = at; index < source.length; index++) {
    const char = source[index];
    if (inString) { if (char === "\\") index++; else if (char === "\"") inString = false; }
    else if (char === "\"") inString = true;
    else if (char === "{" || char === "[") depth++;
    else if ((char === "}" || char === "]") && --depth === 0) return index + 1;
  }
  return -1;
}

/** The JSON object a text starts with (after a code fence), whatever follows it; undefined when it starts otherwise. */
export function leadingJsonObject(text: string): unknown {
  const source = unfenced(text);
  if (!source.startsWith("{")) return undefined;
  const end = objectEnd(source, 0);
  if (end < 0) return undefined;
  try { return JSON.parse(source.slice(0, end)); } catch { return undefined; }
}

/** Whether the text (after a code fence) is one JSON object and nothing else. */
export function wholeJsonObject(text: string): boolean {
  try { const value = parseJsonDocument(text); return Boolean(value && typeof value === "object" && !Array.isArray(value)); } catch { return false; }
}

/** The JSON objects of a text that holds several, one after another ({...}\n{...}), or undefined when
 * it is anything else: one object, text around them, an object that is not valid JSON. */
export function jsonObjectSequence(text: string): unknown[] | undefined {
  const source = unfenced(text), values: unknown[] = [];
  let at = 0;
  while (at < source.length) {
    while (at < source.length && /\s/.test(source[at]!)) at++;
    if (at === source.length) break;
    const end = source[at] === "{" ? objectEnd(source, at) : -1;
    if (end < 0) return undefined;
    try { values.push(JSON.parse(source.slice(at, end))); } catch { return undefined; }
    at = end;
  }
  return values.length > 1 ? values : undefined;
}

/** Line breaks and tabs written raw inside a JSON string (Gemini writes a final answer's Markdown so)
 * escaped as JSON wants them; anything outside strings, and valid JSON, stays exactly as it is. */
export function escapeControlCharacters(source: string): string {
  let out = "", inString = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (inString && char === "\\") { out += char + (source[index + 1] ?? ""); index++; continue; }
    if (char === "\"") inString = !inString;
    const code = char.charCodeAt(0);
    out += inString && code < 0x20 ? char === "\n" ? "\\n" : char === "\r" ? "\\r" : char === "\t" ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}` : char;
  }
  return out;
}

const STRAYS = /^[\s}\]"]*/;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const isFinal = (value: unknown): boolean => {
  const item = value as Record<string, any> | null;
  return Boolean(item && typeof item === "object" && (item.type === "final" || item.action?.type === "final"));
};

/** What follows a complete action when it is only stray closing brackets and quotes, perhaps around the
 * very same object once more (gpt-5.4-nano writes `}}}`, `]}` or `"}` after its action, then the action
 * again): "closers" or "repeated"; undefined for anything else. */
function strayTail(rest: string, first: unknown): "closers" | "repeated" | undefined {
  const at = STRAYS.exec(rest)![0].length;
  if (at === rest.length) return "closers";
  if (rest[at] !== "{") return undefined;
  const end = objectEnd(rest, at);
  if (end < 0) return undefined;
  let again: unknown;
  try { again = JSON.parse(rest.slice(at, end)); } catch { return undefined; }
  return canonical(again) === canonical(first) && STRAYS.exec(rest.slice(end))![0].length === rest.length - end ? "repeated" : undefined;
}

/** An agent's reply as JSON: the document, or the first of several objects sent at once (DeepSeek sends
 * a file.write and its final answer together). `more` counts the objects left out; `note` says what was
 * left out of a tool call taken anyway: stray closers after it, or the same action written twice. Text
 * before or after the object is refused, with what to send instead: models read "Unexpected
 * non-whitespace character after JSON at position 110" and sent the same again (DeepSeek goes on with an
 * imagined next turn). A final answer followed by anything is refused too. */
export function firstJsonDocument(text: string): { value: unknown; more: number; note?: string } {
  const source = escapeControlCharacters(unfenced(text));
  try { return { value: JSON.parse(source), more: 0 }; }
  catch (error) {
    const values = jsonObjectSequence(source);
    if (values) return { value: values[0], more: values.length - 1 };
    const start = source.indexOf("{"), end = start < 0 ? -1 : objectEnd(source, start);
    let complete = false, value: unknown;
    if (end > 0) try { value = JSON.parse(source.slice(start, end)); complete = true; } catch {}
    if (complete && source.slice(0, start).trim()) throw new Error("Your reply had text before its JSON object, so nothing ran. Send only the one JSON object, with nothing before or after it.");
    const tail = complete && !isFinal(value) ? strayTail(source.slice(end), value) : undefined;
    if (tail) return { value, more: 0, note: tail === "repeated"
      ? "Your reply wrote its JSON object twice, with stray closing brackets; it was taken once and runs now. Send the one object once and stop there."
      : "Your reply had stray closing brackets after its JSON object; the object was taken and runs now. Send only the one object, with its brackets balanced." };
    if (complete) throw new Error("Your reply went on after its JSON object, so nothing ran. Send only that one JSON object and stop there: no second message, no TOOL RESULT of your own, no next turn.");
    throw error;
  }
}

export function validateStructuredObject(data: unknown, schema: Record<string, unknown>): string | undefined {
  let check = compiled.get(schema);
  if (!check) { check = validator.compile(schema); compiled.set(schema, check); }
  return check(data) ? undefined : validator.errorsText(check.errors, { separator: "; " });
}

/** OpenAI strict schemas require explicit nulls for optional object properties. */
export function strictJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (["$schema", "default"].includes(key)) continue;
    if (key === "properties") {
      const required = Array.isArray(schema.required) ? schema.required : [];
      result.properties = Object.fromEntries(Object.entries(value as Record<string, Record<string, unknown>>).map(([name, child]) => {
        const normalized = strictJsonSchema(child);
        return [name, required.includes(name) ? normalized : { anyOf: [normalized, { type: "null" }] }];
      }));
      result.required = Object.keys(value as object);
      result.additionalProperties = false;
    } else if (key !== "required" && key !== "additionalProperties") {
      result[key] = Array.isArray(value) ? value.map(item => item && typeof item === "object" ? strictJsonSchema(item) : item)
        : value && typeof value === "object" ? strictJsonSchema(value as Record<string, unknown>) : value;
    }
  }
  if (schema.type === "object" && !schema.properties) { result.properties = {}; result.required = []; result.additionalProperties = false; }
  return result;
}

export const objectFormat = (name: string, properties: Record<string, unknown>): LLMResponseFormat => ({
  type: "json_schema", name, strict: true,
  schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false }
});

export const debateFormat = objectFormat("debate", { summary: { type: "string" }, arguments: { type: "array", items: { type: "string" } } });
