import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

/** Persisted definitions contain configuration only, never credentials or connection state. */
interface McpServerBase {
  id: string;
  name?: string;
  enabled: boolean;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  reconnect?: { maxAttempts: number; initialDelayMs: number; maxDelayMs: number };
}

export type McpServerDefinition = McpServerBase & (
  | { transport: "stdio"; command: string; args?: string[]; cwd?: string; env?: Record<string, string> }
  | { transport: "streamable-http"; endpoint: string }
);

/** A binding is the connection/account identity; endpoint URLs are not identities. */
export interface McpConnectionBinding {
  id: string;
  serverId: string;
  enabled: boolean;
  name?: string;
  accountId?: string;
  credentialRef?: string;
}

export interface McpClientConfiguration {
  servers: Record<string, McpServerDefinition>;
  bindings: Record<string, McpConnectionBinding>;
}

/** Entries are merged individually; null removes an entry. Removing a server removes its bindings. */
export interface McpClientConfigurationPatch {
  servers?: Record<string, Partial<McpServerDefinition> | null>;
  bindings?: Record<string, Partial<McpConnectionBinding> | null>;
}

export type McpConnectionState = "disconnected" | "connecting" | "connected" | "authentication-required" | "error";
export type McpErrorCode = "invalid_configuration" | "binding_not_found" | "binding_disabled" |
  "disconnected" | "authentication_required" | "transport_error" | "protocol_error" |
  "tool_not_found" | "invalid_arguments" | "invalid_schema" | "cancelled" | "timeout" | "disposed";

export interface McpErrorDetails { code: McpErrorCode; message: string; retryable: boolean }

export interface McpConnectionStatus {
  bindingId: string;
  serverId: string;
  enabled: boolean;
  state: McpConnectionState;
  reconnectAttempt: number;
  error?: McpErrorDetails;
}

export interface McpDiscoveredTool {
  id: string;
  bindingId: string;
  serverId: string;
  /** The full server-provided definition, including its original name and JSON Schemas. */
  definition: Tool;
}

export interface McpOperationOptions { signal?: AbortSignal; timeoutMs?: number }

export interface McpCallRequest {
  bindingId: string;
  toolName: string;
  arguments?: unknown;
  runId?: string;
  sessionId?: string;
}

export interface McpInvocationResult {
  callId: string;
  bindingId: string;
  toolId: string;
  outcome: "success" | "tool-error";
  durationMs: number;
  result: CallToolResult;
}

export type McpLifecycleEvent =
  | { type: "connection"; status: McpConnectionStatus }
  | { type: "tools"; bindingId: string; toolIds: string[] }
  | { type: "invocation"; callId: string; bindingId: string; toolId: string;
      outcome: "success" | "tool-error" | "cancelled" | "timeout" | "error";
      durationMs: number; runId?: string; sessionId?: string; error?: McpErrorDetails };

/** Only in-memory transport material. Implementations may use a keychain; OAuth is out of scope. */
export interface McpCredentials { headers?: Record<string, string>; env?: Record<string, string> }
export interface McpCredentialProvider {
  resolve(context: {
    server: McpServerDefinition;
    binding: McpConnectionBinding;
    signal: AbortSignal;
  }): Promise<McpCredentials | undefined>;
}

/** Internal service for future connection/plugin/settings consumers. No HTTP execution route. */
export interface McpClientService {
  list(): McpConnectionStatus[];
  status(bindingId: string): McpConnectionStatus;
  tools(bindingId?: string): McpDiscoveredTool[];
  connect(bindingId: string, options?: McpOperationOptions): Promise<McpConnectionStatus>;
  disconnect(bindingId: string): Promise<void>;
  discoverTools(bindingId: string, options?: McpOperationOptions): Promise<McpDiscoveredTool[]>;
  callTool(request: McpCallRequest, options?: McpOperationOptions): Promise<McpInvocationResult>;
  /** Reconcile desired config. Enabled new/changed bindings connect; unchanged bindings are retained. */
  reconcile(configuration: McpClientConfiguration): Promise<void>;
  subscribe(listener: (event: McpLifecycleEvent) => void): () => void;
  dispose(): Promise<void>;
}

export interface McpConnection {
  listTools(cursor: string | undefined, options: McpOperationOptions): Promise<{ tools: Tool[]; nextCursor?: string }>;
  callTool(name: string, args: Record<string, unknown>, options: McpOperationOptions): Promise<CallToolResult>;
  close(): Promise<void>;
}

/**
 * Transport adapters own SDK clients, subprocesses, sessions and their cleanup.
 * open must honor cancellation and settle only after releasing resources it cannot return.
 * onError reports transport failures; late protocol responses are not connection failures.
 */
export interface McpConnector {
  open(server: McpServerDefinition, binding: McpConnectionBinding, options: {
    signal: AbortSignal;
    timeoutMs: number;
    credentialProvider?: McpCredentialProvider;
    onClose(): void;
    onError(error: unknown): void;
    onToolsChanged(): void;
  }): Promise<McpConnection>;
}
