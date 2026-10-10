import { diagnosticCode } from "./events";

const ERRNO: Record<string, string> = {
  ENOSPC: "disk_full", EDQUOT: "disk_full", EACCES: "permission_denied", EPERM: "permission_denied", ENOENT: "not_found",
  ECONNREFUSED: "connection_refused", ECONNRESET: "connection_reset", EPIPE: "connection_reset", ETIMEDOUT: "timeout",
  UND_ERR_CONNECT_TIMEOUT: "timeout", UND_ERR_HEADERS_TIMEOUT: "timeout", UND_ERR_BODY_TIMEOUT: "timeout",
  ENOTFOUND: "dns_failed", EAI_AGAIN: "dns_failed", EADDRINUSE: "address_in_use", EMFILE: "too_many_files", ENOMEM: "out_of_memory",
  ERR_SQLITE_ERROR: "database_error"
};
const JS_ERRORS = new Set(["TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError"]);

/** What kind of failure an error is, from its code, class or status: never from its message,
 * which may hold a provider's answer, a path or a prompt. */
export const errorCategory = (error: unknown): string => {
  if (!error || typeof error !== "object") return "unknown";
  const record = error as { code?: unknown; name?: unknown; statusCode?: unknown; status?: unknown; cause?: unknown };
  if (typeof record.code === "string") {
    if (Object.hasOwn(ERRNO, record.code)) return ERRNO[record.code]!;
    const code = record.code.toLowerCase();
    if (diagnosticCode.safeParse(code).success) return code;
  }
  if (record.name === "AbortError") return "cancelled";
  if (record.name === "TimeoutError") return "timeout";
  const status = typeof record.statusCode === "number" ? record.statusCode : typeof record.status === "number" ? record.status : undefined;
  if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) return `http_${status}`;
  // fetch() failures carry their cause (a socket error) one level down.
  if (record.cause && record.cause !== error) { const cause = errorCategory(record.cause); if (cause !== "unknown") return cause; }
  if (typeof record.name === "string" && JS_ERRORS.has(record.name)) return `js_${record.name.toLowerCase()}`;
  return "unknown";
};
