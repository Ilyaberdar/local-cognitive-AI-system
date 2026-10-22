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

/** An agent's reply as JSON: the document, or the first of several objects sent at once (DeepSeek sends
 * a file.write and its final answer together). `more` counts the objects left out. Text before or after
 * the object is refused, with what to send instead: models read "Unexpected non-whitespace character
 * after JSON at position 110" and sent the same again (DeepSeek goes on with an imagined next turn). */
export function firstJsonDocument(text: string): { value: unknown; more: number } {
  try { return { value: parseJsonDocument(text), more: 0 }; }
  catch (error) {
    const values = jsonObjectSequence(text);
    if (values) return { value: values[0], more: values.length - 1 };
    const source = unfenced(text), start = source.indexOf("{"), end = start < 0 ? -1 : objectEnd(source, start);
    let complete = false;
    if (end > 0) try { JSON.parse(source.slice(start, end)); complete = true; } catch {}
    if (complete && source.slice(0, start).trim()) throw new Error("Your reply had text before its JSON object, so nothing ran. Send only the one JSON object, with nothing before or after it.");
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
