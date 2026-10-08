import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { McpClientManager } from "../mcp/client/McpClientManager";
import { McpClientConfiguration, McpCredentialProvider } from "../mcp/client/types";
import { CatalogPlugin, CredentialVault, IntegrationAdapter, PluginError, PluginInvocationError, ServiceConnection } from "./contracts";
import { catalogEntry } from "./catalog";
import { OAuthConnections, OAuthClientRegistrations } from "./OAuthConnections";
import { callNative, nativeAccount, nativeTools } from "./NativeServiceTools";

export class DirectIntegrationAdapter implements IntegrationAdapter, McpCredentialProvider {
  readonly id = "direct";
  readonly oauth: OAuthConnections;
  private readonly connections = new Map<string, ServiceConnection>();
  private readonly tokenHashes = new Map<string, string>();
  private readonly config: McpClientConfiguration = { servers: {}, bindings: {} };
  private closed = false;
  constructor(vault: CredentialVault, ownerId: string, private readonly mcp: McpClientManager, registrations: OAuthClientRegistrations = {}) { this.oauth = new OAuthConnections(vault, ownerId, registrations); }
  async ready() { return { ready: this.oauth.available(), message: this.oauth.available() ? undefined : this.oauth.unavailableReason() ?? "Account connections require the desktop app's protected credential storage." }; }
  async connect(plugin: CatalogPlugin, ownerId: string, id: string) {
    if (ownerId !== this.oauth.ownerId || this.closed) throw new PluginError("Profile changed. Reload Plugins.", 409);
    return this.oauth.begin(plugin, id);
  }
  async resolve({ binding, server }: Parameters<McpCredentialProvider["resolve"]>[0]) {
    const connection = this.connections.get(binding.id);
    if (this.closed || !connection || binding.credentialRef !== `plugin:${connection.id}` ||
        binding.serverId !== this.binding(connection) || server.id !== this.binding(connection) ||
        binding.accountId !== connection.id || server.transport !== "streamable-http" ||
        server.endpoint !== catalogEntry(connection.pluginId).mcpEndpoint) return undefined;
    return { headers: { Authorization: `Bearer ${await this.oauth.accessToken(catalogEntry(connection.pluginId), connection)}` } };
  }
  private binding(connection: ServiceConnection) { return `plugin-${connection.id}`; }
  async inspect(plugin: CatalogPlugin, connection: ServiceConnection) {
    if (this.closed || connection.ownerId !== this.oauth.ownerId) throw new PluginError("Profile changed.", 409);
    if (this.oauth.pending(connection.id)) return { state: "connecting" as const, tools: [] };
    if (!await this.oauth.connected(connection.id)) return { state: "authentication-required" as const, tools: [], message: "Log in to connect this account." };
    try {
      const token = await this.oauth.accessToken(plugin, connection);
      if (!plugin.mcpEndpoint) {
        const label = await nativeAccount(plugin.id, token, AbortSignal.timeout(20_000));
        return { state: "connected" as const, label, tools: nativeTools[plugin.id].map(tool => tool.definition) };
      }
      const id = this.binding(connection), tokenHash = createHash("sha256").update(token).digest("hex");
      const changed = this.tokenHashes.has(id) && this.tokenHashes.get(id) !== tokenHash;
      this.connections.set(id, connection); this.tokenHashes.set(id, tokenHash);
      this.config.servers[id] = { id, name: plugin.name, enabled: true, transport: "streamable-http", endpoint: plugin.mcpEndpoint,
        connectTimeoutMs: 25_000, requestTimeoutMs: 55_000, reconnect: { maxAttempts: 0, initialDelayMs: 1000, maxDelayMs: 1000 } };
      this.config.bindings[id] = { id, serverId: id, enabled: true, accountId: connection.id, credentialRef: `plugin:${connection.id}` };
      if (changed) await this.mcp.disconnect(id);
      await this.mcp.reconcileScope("plugins", this.config);
      if (this.mcp.status(id).state !== "connected") await this.mcp.connect(id);
      const status = this.mcp.status(id);
      if (status.state !== "connected") return { state: status.state, tools: [], message: status.error?.message };
      const tools = (await this.mcp.discoverTools(id)).map(tool => tool.definition);
      return { state: "connected" as const, tools };
    } catch (error) {
      if (error instanceof PluginError && error.statusCode === 401) return { state: "authentication-required" as const, tools: [], message: error.message };
      throw error;
    }
  }
  currentTools(connection: ServiceConnection): Tool[] | undefined {
    if (!catalogEntry(connection.pluginId).mcpEndpoint) return undefined;
    const id = this.binding(connection);
    if (!this.connections.has(id) || this.mcp.status(id).state !== "connected") return [];
    return this.mcp.tools(id).map(tool => tool.definition);
  }
  async call(plugin: CatalogPlugin, connection: ServiceConnection, tool: Tool, args: Record<string, unknown>, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.closed) throw new PluginError("Profile changed.", 409);
    const token = await this.oauth.accessToken(plugin, connection).catch(error => {
      if (error instanceof PluginError) throw new PluginInvocationError(error.message, error.statusCode);
      throw new PluginInvocationError("Could not refresh account authorization. Check the connection or reconnect before continuing.", 401);
    });
    signal.throwIfAborted();
    if (!plugin.mcpEndpoint) return callNative(plugin.id, tool.name, args, token, signal);
    const id = this.binding(connection), hash = createHash("sha256").update(token).digest("hex");
    if (hash !== this.tokenHashes.get(id)) await this.inspect(plugin, connection);
    const actual = this.currentTools(connection)?.find(item => item.name === tool.name);
    if (!actual || JSON.stringify(actual) !== JSON.stringify(tool)) throw new PluginInvocationError("The service's tool definition changed. Search tools again before using it.", 409);
    return (await this.mcp.callTool({ bindingId: id, toolName: tool.name, arguments: args }, { signal })).result;
  }
  async disconnect(_plugin: CatalogPlugin, connection: ServiceConnection) {
    const id = this.binding(connection);
    // Local revocation is immediate. Users can revoke the provider grant in its account settings.
    this.connections.delete(id); this.tokenHashes.delete(id); delete this.config.servers[id]; delete this.config.bindings[id];
    await this.oauth.remove(connection.id);
    await this.mcp.reconcileScope("plugins", this.config);
  }
  async dispose() { this.closed = true; this.oauth.dispose(); this.connections.clear(); await this.mcp.reconcileScope("plugins", { servers: {}, bindings: {} }); }
}
