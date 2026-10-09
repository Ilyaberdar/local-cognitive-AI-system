import type { CredentialVault } from "../../plugins/contracts";
import { McpClientError } from "./errors";
import type { McpClientConfiguration, McpCredentialProvider, McpCredentials, McpServerDefinition } from "./types";

/** A server's secrets: its binding's `credentialRef` is "mcp:<id>"; settings keep only their names. */
export const MCP_CREDENTIAL_PREFIX = "mcp:";
export type McpSecretKind = "env" | "header" | "bearer";

export const mcpSecretKey = (ref: string, kind: McpSecretKind, name = ""): string =>
  `mcp/${ref}/${kind}${kind === "bearer" ? "" : `/${kind === "header" ? name.toLowerCase() : name}`}`;

/** The secrets a server's settings name, as (kind, name) pairs. */
export function mcpSecretNames(server: McpServerDefinition): Array<{ kind: McpSecretKind; name: string }> {
  if (server.transport === "stdio") return (server.secretEnv ?? []).map(name => ({ kind: "env" as const, name }));
  return [...(server.secretHeaders ?? []).map(name => ({ kind: "header" as const, name })),
    ...(server.bearerToken ? [{ kind: "bearer" as const, name: "Authorization" }] : [])];
}

/** An HTTP secret is kept with the origin it was given for: a changed endpoint does not get it. */
interface StoredHeader { value: string; origin: string }

/** Reads an MCP server's secrets from the vault when it starts. A missing one says which (the
 * detail reaches only the host's Settings); nothing is sent to an endpoint other than the one
 * a header was saved for. */
export class VaultMcpCredentialProvider implements McpCredentialProvider {
  constructor(private readonly vault: CredentialVault) {}

  async resolve({ server, binding }: Parameters<McpCredentialProvider["resolve"]>[0]): Promise<McpCredentials | undefined> {
    const ref = binding.credentialRef?.startsWith(MCP_CREDENTIAL_PREFIX) ? binding.credentialRef.slice(MCP_CREDENTIAL_PREFIX.length) : undefined;
    if (!ref) return undefined;
    if (!this.vault.available()) {
      throw new McpClientError("authentication_required", `This server's secrets cannot be read here: ${this.vault.unavailableReason?.() ?? "protected storage is unavailable"}.`);
    }
    const missing = (name: string) => new McpClientError("authentication_required", `${name} is not set. Set it in this server's Settings.`);
    if (server.transport === "stdio") {
      const env: Record<string, string> = {};
      for (const name of server.secretEnv ?? []) {
        const value = await this.vault.read(mcpSecretKey(ref, "env", name));
        if (value === undefined) throw missing(name);
        env[name] = value;
      }
      return { env };
    }
    const origin = new URL(server.endpoint).origin;
    const header = async (kind: McpSecretKind, name: string) => {
      const raw = await this.vault.read(mcpSecretKey(ref, kind, name));
      if (raw === undefined) throw missing(kind === "bearer" ? "The bearer token" : name);
      const stored = JSON.parse(raw) as StoredHeader;
      if (stored.origin !== origin) throw new McpClientError("authentication_required", `${kind === "bearer" ? "The bearer token" : name} was saved for another address. Set it again for this one.`);
      return stored.value;
    };
    const headers: Record<string, string> = {};
    for (const name of server.secretHeaders ?? []) headers[name] = await header("header", name);
    if (server.bearerToken) headers.Authorization = `Bearer ${await header("bearer", "Authorization")}`;
    return { headers };
  }

  /** Stores a secret's value (an HTTP one with the endpoint's origin). */
  async write(ref: string, server: McpServerDefinition, kind: McpSecretKind, name: string, value: string): Promise<void> {
    const stored = server.transport === "stdio" ? value : JSON.stringify({ value, origin: new URL(server.endpoint).origin } satisfies StoredHeader);
    await this.vault.write(mcpSecretKey(ref, kind, name), stored);
  }

  async remove(ref: string, kind: McpSecretKind, name: string): Promise<void> {
    await this.vault.remove(mcpSecretKey(ref, kind, name));
  }

  async isSet(ref: string, kind: McpSecretKind, name: string): Promise<boolean> {
    return (await this.vault.read(mcpSecretKey(ref, kind, name))) !== undefined;
  }

  /** Removes the values of secrets that a settings change no longer names: a removed server, a
   * name taken off its list, a switched transport. The vault cannot list its keys, so this is
   * worked out from the settings before and after. */
  async prune(before: McpClientConfiguration, after: McpClientConfiguration): Promise<void> {
    if (!this.vault.available()) return;
    const named = (configuration: McpClientConfiguration) => new Set(Object.values(configuration.bindings).flatMap(binding => {
      const server = configuration.servers[binding.serverId];
      const ref = binding.credentialRef?.startsWith(MCP_CREDENTIAL_PREFIX) ? binding.credentialRef.slice(MCP_CREDENTIAL_PREFIX.length) : undefined;
      return server && ref ? mcpSecretNames(server).map(({ kind, name }) => mcpSecretKey(ref, kind, name)) : [];
    }));
    const kept = named(after);
    for (const key of named(before)) if (!kept.has(key)) await this.vault.remove(key).catch(() => undefined);
  }
}
