import { z } from "zod";

/** A code: lower-case letters, digits and `_.:-`. Never free text: a message, a path or a
 * prompt cannot pass, whatever a caller puts in. */
export const diagnosticCode = z.string().regex(/^[a-z0-9_.:-]{1,64}$/);
const count = z.number().int().min(0).max(1_000_000_000);
const httpStatus = z.number().int().min(100).max(599);

/** Every event the technical log may hold, and the only fields each may carry. Adding one is a
 * reviewed change here; nothing else reaches the log, Sentry or a bug report automatically. */
export const DIAGNOSTIC_EVENTS = {
  "app.started": { runtimeKind: z.enum(["desktop", "server", "mcp-stdio", "test"]), previousShutdown: z.enum(["clean", "unclean", "none"]) },
  "startup.failed": { category: diagnosticCode },
  "app.crash": { process: z.enum(["main", "renderer", "gpu", "utility", "other"]), reason: diagnosticCode, exitCode: z.number().int() },
  "renderer.error": { category: diagnosticCode },
  "provider.call_failed": { provider: diagnosticCode, outcome: z.enum(["rejected", "failed", "cancelled"]), httpStatus },
  "mcp.connection_failed": { transport: z.enum(["stdio", "http"]), code: diagnosticCode },
  "mcp.tool_failed": { code: diagnosticCode },
  "remote.client_state": { state: diagnosticCode, code: diagnosticCode },
  "remote.host_event": { event: diagnosticCode, code: diagnosticCode },
  "local_runtime.load_failed": { code: diagnosticCode, backend: diagnosticCode, placement: diagnosticCode },
  "local_runtime.exited": { exitCode: z.number().int(), signal: diagnosticCode },
  "local_runtime.oom_retry": { placement: diagnosticCode },
  "workflow.failed": { nodeType: diagnosticCode, category: diagnosticCode },
  "chat_run.failed": { category: diagnosticCode },
  "schedule.failed": { category: diagnosticCode },
  "usage.sync_failed": { category: diagnosticCode, count }
} as const satisfies Record<string, Record<string, z.ZodType>>;

export type DiagnosticEventName = keyof typeof DIAGNOSTIC_EVENTS;
export type DiagnosticFields<E extends DiagnosticEventName> = { [K in keyof (typeof DIAGNOSTIC_EVENTS)[E]]?: z.input<(typeof DIAGNOSTIC_EVENTS)[E][K]> };

/** The event's fields that pass its schema; any other field, or a value that does not fit, is dropped. */
export const allowedFields = (event: string, fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
  const schema = (DIAGNOSTIC_EVENTS as Record<string, Record<string, z.ZodType>>)[event];
  if (!schema) return undefined;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    const field = Object.hasOwn(schema, key) ? schema[key] : undefined;
    const parsed = field?.safeParse(value);
    if (parsed?.success) kept[key] = parsed.data;
  }
  return kept;
};
