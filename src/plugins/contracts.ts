import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export interface CatalogPlugin {
  id: string; name: string; description: string; category: string; version: string;
  toolkit: string; documentation: string; privacy: string; color: string; initials: string;
  /** Optional first-party MCP transport; availability never implies an account is connected. */
  mcpEndpoint?: string;
}
export interface PluginInstallation {
  pluginId: string; version: string; installedAt: string; enabled: boolean;
  permission: "none" | "read" | "read-write"; connectionId?: string; revision: string;
}
export interface ServiceConnection {
  id: string; pluginId: string; ownerId: string; adapter: string;
  accountRef: string; label: string; createdAt: string; revision: string;
}
export type ConnectionState = "disconnected" | "connecting" | "connected" | "authentication-required" | "error";
export interface ConnectionSnapshot {
  state: ConnectionState; label?: string; message?: string; tools: Tool[];
}
export interface ConnectionAttempt { accountRef: string; authorizationUrl: string; userCode?: string; }
export interface IntegrationAdapter {
  readonly id: string;
  ready(): Promise<{ ready: boolean; message?: string }>;
  connect(plugin: CatalogPlugin, ownerId: string, connectionId: string): Promise<ConnectionAttempt>;
  inspect(plugin: CatalogPlugin, connection: ServiceConnection): Promise<ConnectionSnapshot>;
  currentTools?(connection: ServiceConnection): Tool[] | undefined;
  call(plugin: CatalogPlugin, connection: ServiceConnection, tool: Tool, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult>;
  disconnect(plugin: CatalogPlugin, connection: ServiceConnection): Promise<void>;
  dispose?(): Promise<void>;
}
export interface CredentialVault {
  available(): boolean;
  /** Why storage is unavailable, for the UI; undefined when available or unknown. */
  unavailableReason?(): string | undefined;
  read(key: string): Promise<string | undefined>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
export const unavailableVault: CredentialVault = {
  available: () => false,
  read: async () => undefined,
  write: async () => { throw new Error("Protected credential storage is unavailable. Open the desktop application to connect accounts."); },
  remove: async () => {}
};
export class PluginError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); this.name = "PluginError"; }
}
/** The request was rejected before any effect, rather than losing an uncertain response. */
export class PluginInvocationError extends PluginError {}
