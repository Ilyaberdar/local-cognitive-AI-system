import { hasSecretName } from "../../config/secrets";
import { McpClientError } from "./errors";
import type {
  McpApprovalMode, McpClientConfiguration, McpClientConfigurationPatch, McpConnectionBinding, McpServerDefinition
} from "./types";

const commonServerFields = ["id", "name", "enabled", "approval", "enabledTools", "disabledTools", "connectTimeoutMs", "requestTimeoutMs", "reconnect"];
const stdioFields = ["command", "args", "cwd", "env", "secretEnv"];
const httpFields = ["endpoint", "headers", "secretHeaders", "bearerToken"];
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
// Set by the transport or the protocol, or carrying credentials: never a plain header.
const reservedHeaders = new Set(["authorization", "proxy-authorization", "cookie", "host", "content-length", "content-type", "accept", "mcp-session-id", "mcp-protocol-version"]);
const bindingFields = ["id", "serverId", "enabled", "name", "accountId", "credentialRef"];
const reservedIds = new Set(["__proto__", "constructor", "prototype"]);
// These values belong to the injected credential provider, never ordinary settings.
const secretValue = /^(?:Bearer|Basic)\s|-----BEGIN [A-Z ]*PRIVATE KEY-----|^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./i;

function invalid(): never { throw new McpClientError("invalid_configuration"); }

/** How long a server may take to start: a first `uvx`/`npx` run downloads its packages. */
export const connectTimeoutMs = (server: McpServerDefinition): number =>
  server.connectTimeoutMs ?? (server.transport === "stdio" ? 60_000 : 15_000);
/** How long a request may go without an answer or, for a tool call, without progress. */
export const requestTimeoutMs = (server: McpServerDefinition): number => server.requestTimeoutMs ?? 60_000;
/** The longest a tool call that keeps reporting progress may run (a render, a compile). */
export const MAX_CALL_MS = 30 * 60_000;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}

function text(value: unknown, maximum = 2048, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > maximum || value.includes("\0")) return invalid();
  return value;
}

function identity(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || reservedIds.has(value)) return invalid();
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") return invalid();
  return value;
}

/** A list of tool names: unique, at most 512. */
function toolNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 512) return invalid();
  const names = value.map(name => text(name, 256));
  if (new Set(names).size !== names.length) invalid();
  return names;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) return invalid();
  return value;
}

function serverDefinition(key: string, input: unknown): McpServerDefinition {
  identity(key);
  const value = record(input);
  fields(value, [...commonServerFields, "transport", ...(value.transport === "stdio" ? stdioFields : httpFields)]);
  if (identity(value.id) !== key) invalid();
  const shared = {
    id: key,
    enabled: boolean(value.enabled),
    ...(value.name === undefined ? {} : { name: text(value.name, 256) }),
    ...(value.approval === undefined ? {} : { approval: ["ask", "read-only", "trust"].includes(value.approval as string) ? value.approval as McpApprovalMode : invalid() }),
    ...(value.enabledTools === undefined ? {} : { enabledTools: toolNames(value.enabledTools) }),
    ...(value.disabledTools === undefined ? {} : { disabledTools: toolNames(value.disabledTools) }),
    ...(value.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: integer(value.connectTimeoutMs, 1, 3600000) }),
    ...(value.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: integer(value.requestTimeoutMs, 1, 3600000) })
  };
  let reconnect: McpServerDefinition["reconnect"];
  if (value.reconnect !== undefined) {
    const options = record(value.reconnect);
    fields(options, ["maxAttempts", "initialDelayMs", "maxDelayMs"]);
    reconnect = {
      maxAttempts: integer(options.maxAttempts, 0, 10),
      initialDelayMs: integer(options.initialDelayMs, 1, 300000),
      maxDelayMs: integer(options.maxDelayMs, 1, 300000)
    };
    if (reconnect.maxDelayMs < reconnect.initialDelayMs) invalid();
  }
  const base = { ...shared, ...(reconnect === undefined ? {} : { reconnect }) };
  if (value.transport === "stdio") {
    let args: string[] | undefined;
    if (value.args !== undefined) {
      if (!Array.isArray(value.args) || value.args.length > 256) return invalid();
      args = value.args.map(argument => text(argument, 8192, true));
    }
    let env: Record<string, string> | undefined;
    if (value.env !== undefined) {
      const entries = Object.entries(record(value.env));
      if (entries.length > 256) invalid();
      env = Object.fromEntries(entries.map(([name, entry]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || hasSecretName(name)) invalid();
        const content = text(entry, 32768, true);
        if (secretValue.test(content)) invalid();
        return [name, content];
      }));
    }
    let secretEnv: string[] | undefined;
    if (value.secretEnv !== undefined) {
      secretEnv = names(value.secretEnv, 64, name => envName.test(name));
      if (secretEnv.some(name => env && Object.hasOwn(env, name))) invalid();
    }
    return {
      ...base, transport: "stdio", command: text(value.command, 4096),
      ...(args === undefined ? {} : { args }),
      ...(value.cwd === undefined ? {} : { cwd: text(value.cwd, 8192) }),
      ...(env === undefined ? {} : { env }),
      ...(secretEnv === undefined ? {} : { secretEnv })
    };
  }
  if (value.transport !== "streamable-http") return invalid();
  const endpoint = text(value.endpoint, 8192);
  let url: URL;
  try { url = new URL(endpoint); } catch { return invalid(); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) invalid();
  if ([...url.searchParams].some(([name, value]) => hasSecretName(name) || /^(?:key|auth)$/i.test(name) || secretValue.test(value))) invalid();
  let headers: Record<string, string> | undefined;
  if (value.headers !== undefined) {
    const entries = Object.entries(record(value.headers));
    if (entries.length > 64) invalid();
    headers = Object.fromEntries(entries.map(([name, entry]) => {
      if (!headerName.test(name) || reservedHeaders.has(name.toLowerCase()) || hasSecretName(name)) invalid();
      const content = text(entry, 8192, true);
      if (/[\r\n]/.test(content) || secretValue.test(content)) invalid();
      return [name, content];
    }));
  }
  let secretHeaders: string[] | undefined;
  if (value.secretHeaders !== undefined) {
    secretHeaders = names(value.secretHeaders, 32, name => headerName.test(name) && !["host", "content-length", "content-type", "accept", "mcp-session-id", "mcp-protocol-version"].includes(name.toLowerCase()));
    if (secretHeaders.some(name => headers && Object.keys(headers).some(plain => plain.toLowerCase() === name.toLowerCase()))) invalid();
    if (new Set(secretHeaders.map(name => name.toLowerCase())).size !== secretHeaders.length) invalid();
  }
  const bearerToken = value.bearerToken === undefined ? undefined : boolean(value.bearerToken);
  if (bearerToken && secretHeaders?.some(name => name.toLowerCase() === "authorization")) invalid();
  return { ...base, transport: "streamable-http", endpoint, ...(headers === undefined ? {} : { headers }),
    ...(secretHeaders === undefined ? {} : { secretHeaders }), ...(bearerToken ? { bearerToken } : {}) };
}

/** Names of secrets (values live in the vault): unique, valid, bounded. */
function names(value: unknown, maximum: number, valid: (name: string) => boolean): string[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  const list = value.map(name => text(name, 128));
  if (list.some(name => !valid(name)) || new Set(list).size !== list.length) invalid();
  return list;
}

function connectionBinding(key: string, input: unknown): McpConnectionBinding {
  identity(key);
  const value = record(input);
  fields(value, bindingFields);
  if (identity(value.id) !== key) invalid();
  return {
    id: key, serverId: identity(value.serverId), enabled: boolean(value.enabled),
    ...(value.name === undefined ? {} : { name: text(value.name, 256) }),
    ...(value.accountId === undefined ? {} : { accountId: text(value.accountId) }),
    ...(value.credentialRef === undefined ? {} : { credentialRef: text(value.credentialRef) })
  };
}

export function emptyMcpConfiguration(): McpClientConfiguration {
  return { servers: {}, bindings: {} };
}

/** Missing configuration is the backward-compatible default. Supplied data is validated, not repaired. */
export function parseMcpConfiguration(input: unknown): McpClientConfiguration {
  if (input === undefined) return emptyMcpConfiguration();
  const value = record(input);
  fields(value, ["servers", "bindings"]);
  const servers = Object.fromEntries(Object.entries(record(value.servers === undefined ? {} : value.servers)).map(([id, entry]) => [id, serverDefinition(id, entry)]));
  const bindings = Object.fromEntries(Object.entries(record(value.bindings === undefined ? {} : value.bindings)).map(([id, entry]) => [id, connectionBinding(id, entry)]));
  for (const binding of Object.values(bindings)) if (!Object.hasOwn(servers, binding.serverId)) invalid();
  return { servers, bindings };
}

/** Partial entries update only their identity. An explicit null deletes it. */
export function applyMcpConfigurationPatch(current: McpClientConfiguration, patch: McpClientConfigurationPatch): McpClientConfiguration {
  const result = parseMcpConfiguration(current);
  const changes = record(patch);
  fields(changes, ["servers", "bindings"]);
  for (const [id, entry] of Object.entries(record(changes.servers === undefined ? {} : changes.servers))) {
    identity(id);
    if (entry === null) {
      delete result.servers[id];
      for (const [bindingId, binding] of Object.entries(result.bindings)) if (binding.serverId === id) delete result.bindings[bindingId];
      continue;
    }
    const update = { ...record(entry) };
    const previous: Record<string, unknown> = { ...(result.servers[id] ?? {}) };
    // A field set to null is removed (a cleared working directory, environment or argument list).
    for (const [field, value] of Object.entries(update)) if (value === null) { delete previous[field]; delete update[field]; }
    // Switching transport discards only the old transport's fields; explicit invalid fields still fail validation.
    if (update.transport !== undefined && update.transport !== previous.transport) {
      for (const field of [...stdioFields, ...httpFields]) delete previous[field];
    }
    result.servers[id] = serverDefinition(id, { id, ...previous, ...update });
  }
  for (const [id, entry] of Object.entries(record(changes.bindings === undefined ? {} : changes.bindings))) {
    identity(id);
    if (entry === null) delete result.bindings[id];
    else {
      const previous: Record<string, unknown> = { ...(result.bindings[id] ?? {}) };
      result.bindings[id] = connectionBinding(id, { id, ...previous, ...record(entry) });
    }
  }
  return parseMcpConfiguration(result);
}
