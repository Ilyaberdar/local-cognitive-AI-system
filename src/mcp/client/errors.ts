import { McpErrorCode, McpErrorDetails } from "./types";

const messages: Record<McpErrorCode, string> = {
  invalid_configuration: "Invalid outbound MCP configuration.",
  binding_not_found: "MCP connection binding was not found.",
  binding_disabled: "MCP connection binding is disabled.",
  disconnected: "MCP connection is not connected.",
  authentication_required: "MCP authentication is required. Supply credentials and reconnect.",
  transport_error: "MCP transport failed.",
  protocol_error: "MCP server returned a protocol error.",
  tool_not_found: "MCP tool is unavailable. Refresh discovery before calling it.",
  invalid_arguments: "MCP tool arguments do not satisfy the discovered JSON Schema.",
  invalid_schema: "MCP tool has an unsupported or invalid JSON Schema.",
  cancelled: "MCP operation was cancelled. An external action may already have occurred.",
  timeout: "MCP operation timed out. An external action may already have occurred.",
  command_not_found: "The MCP server's command was not found on this computer.",
  server_exited: "The MCP server process stopped.",
  disposed: "MCP client manager has been disposed."
};

/** Never copy remote error messages, URLs, stderr, arguments, or credentials into diagnostics.
 * `detail` (a launch failure, a server's last stderr lines with secrets hidden) is for the host's
 * own Settings only: it is not part of the error's JSON, events or answers to devices. */
export class McpClientError extends Error implements McpErrorDetails {
  readonly retryable: boolean;
  constructor(readonly code: McpErrorCode, readonly detail?: string) {
    super(messages[code]);
    this.name = "McpClientError";
    this.retryable = code === "transport_error" || code === "timeout" || code === "server_exited";
  }
  toJSON(): McpErrorDetails { return { code: this.code, message: this.message, retryable: this.retryable }; }
}

export function safeMcpError(error: unknown): McpClientError {
  if (error instanceof McpClientError) return error;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === 401 || code === 403) return new McpClientError("authentication_required");
  if (code === -32001) return new McpClientError("timeout");
  if (code === -32000) return new McpClientError("transport_error");
  if (typeof code === "number" && code < 0) return new McpClientError("protocol_error");
  return new McpClientError("transport_error");
}
