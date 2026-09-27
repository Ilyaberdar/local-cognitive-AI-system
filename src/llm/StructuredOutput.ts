import { LLMResponseFormat } from "../types";
import Ajv, { ValidateFunction } from "ajv";

const validator = new Ajv({ strict: false, allErrors: true });
const compiled = new WeakMap<object, ValidateFunction>();

export function parseJsonDocument(text: string): unknown {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i, "$1"));
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
