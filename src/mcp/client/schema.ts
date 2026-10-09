import Ajv from "ajv";
import Ajv2019 from "ajv/dist/2019";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { McpClientError } from "./errors";

export function compileToolArguments(schema: Tool["inputSchema"]): (args: unknown) => boolean {
  const check = compileToolArgumentErrors(schema);
  return args => check(args).length === 0;
}

/** What is wrong with arguments, for the model to correct them: up to five problems, each with
 * where and what, bounded; never the argument values themselves. Empty when they are valid. */
export function compileToolArgumentErrors(schema: Tool["inputSchema"]): (args: unknown) => string[] {
  try {
    const dialect = typeof schema.$schema === "string" ? schema.$schema.replace(/#$/, "") : undefined;
    // MCP defaults to 2020-12. Keep older explicitly declared schemas usable.
    const Constructor = dialect === "http://json-schema.org/draft-07/schema" ? Ajv :
      dialect === "https://json-schema.org/draft/2019-09/schema" ? Ajv2019 : Ajv2020;
    // One compiler per schema prevents remote $id collisions across tools/accounts/refreshes.
    const ajv = new Constructor({ strict: false, validateSchema: true, allErrors: true, verbose: false });
    addFormats(ajv);
    // Asynchronous/remote validation is not part of this internal dispatch boundary.
    if (schema.$async) throw new McpClientError("invalid_schema");
    const validate = ajv.compile(schema);
    return args => validate(args) === true ? [] : (validate.errors ?? []).slice(0, 5).map(error => {
      const detail = error.params && typeof error.params === "object"
        ? ["missingProperty", "additionalProperty", "allowedValues", "type"].map(key => (error.params as Record<string, unknown>)[key])
          .filter(value => value !== undefined).map(value => JSON.stringify(value)).join(" ").slice(0, 160)
        : "";
      return `${error.instancePath || "(arguments)"} ${error.message ?? "is invalid"}${detail ? ` ${detail}` : ""}`.slice(0, 240);
    });
  } catch { throw new McpClientError("invalid_schema"); }
}

/** Snapshot only JSON values, without silently dropping undefined/functions or coercing NaN. */
export function snapshotArguments(value: unknown): Record<string, unknown> {
  const seen = new Set<object>();
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || seen.has(item)) throw new McpClientError("invalid_arguments");
    seen.add(item);
    try {
      if (Array.isArray(item)) return Array.from(item, visit);
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        throw new McpClientError("invalid_arguments");
      }
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry)]));
    } finally { seen.delete(item); }
  };
  const result = visit(value);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new McpClientError("invalid_arguments");
  return result as Record<string, unknown>;
}

/** A tool call's `argumentsJson` as a model writes it. Local models often put raw line breaks
 * inside a string (Python code for an editor), escape like Python (`\d`, `\.`), or add text after
 * the object; such a call would cost a step to correct. Inside strings, raw control characters are
 * escaped and an unknown escape is read as the backslash it meant; the first complete JSON value
 * is read. What is read is validated against the tool's schema, and that object is exactly what
 * the approval shows and the tool receives. */
export function parseArgumentsJson(text: string): unknown {
  try { return JSON.parse(text); } catch (error) {
    let repaired = "", inString = false, depth = 0;
    for (let index = 0; index < text.length; index++) {
      const char = text[index]!;
      if (inString) {
        if (char === "\\") {
          const next = text[index + 1];
          if (next !== undefined && "\"\\/bfnrtu".includes(next)) { repaired += char + next; index++; }
          else repaired += "\\\\";
          continue;
        }
        if (char === "\"") inString = false;
        else if (char < " ") { repaired += char === "\n" ? "\\n" : char === "\r" ? "\\r" : char === "\t" ? "\\t" : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`; continue; }
      } else if (char === "\"") inString = true;
      else if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") { depth--; if (depth === 0) { repaired += char; break; } }
      repaired += char;
    }
    try { return JSON.parse(repaired); } catch { throw error; }
  }
}
