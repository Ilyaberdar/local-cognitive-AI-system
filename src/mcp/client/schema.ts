import Ajv from "ajv";
import Ajv2019 from "ajv/dist/2019";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { McpClientError } from "./errors";

export function compileToolArguments(schema: Tool["inputSchema"]): (args: unknown) => boolean {
  try {
    const dialect = typeof schema.$schema === "string" ? schema.$schema.replace(/#$/, "") : undefined;
    // MCP defaults to 2020-12. Keep older explicitly declared schemas usable.
    const Constructor = dialect === "http://json-schema.org/draft-07/schema" ? Ajv :
      dialect === "https://json-schema.org/draft/2019-09/schema" ? Ajv2019 : Ajv2020;
    // One compiler per schema prevents remote $id collisions across tools/accounts/refreshes.
    const ajv = new Constructor({ strict: false, validateSchema: true, allErrors: false });
    addFormats(ajv);
    // Asynchronous/remote validation is not part of this internal dispatch boundary.
    if (schema.$async) throw new McpClientError("invalid_schema");
    const validate = ajv.compile(schema);
    return args => validate(args) === true;
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
