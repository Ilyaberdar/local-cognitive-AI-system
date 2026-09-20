import { McpClientError } from "./errors";
import type {
  McpClientConfiguration, McpClientConfigurationPatch, McpConnectionBinding, McpServerDefinition
} from "./types";

const commonServerFields = ["id", "name", "enabled", "connectTimeoutMs", "requestTimeoutMs", "reconnect"];
const stdioFields = ["command", "args", "cwd", "env"];
const bindingFields = ["id", "serverId", "enabled", "name", "accountId", "credentialRef"];
const reservedIds = new Set(["__proto__", "constructor", "prototype"]);
// These values belong to the injected credential provider, never ordinary settings.
const secretName = /(?:^|[_.-])(?:tokens?|secrets?|password|passwd|authorization|credentials?|api[_.-]?key|private[_.-]?key|access[_.-]?key|session[_.-]?key)(?:$|[_.-])/i;
const secretValue = /^(?:Bearer|Basic)\s|-----BEGIN [A-Z ]*PRIVATE KEY-----|^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./i;
const hasSecretName = (value: string): boolean => secretName.test(value.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));

function invalid(): never { throw new McpClientError("invalid_configuration"); }

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

function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) return invalid();
  return value;
}

function serverDefinition(key: string, input: unknown): McpServerDefinition {
  identity(key);
  const value = record(input);
  fields(value, [...commonServerFields, "transport", ...(value.transport === "stdio" ? stdioFields : ["endpoint"])]);
  if (identity(value.id) !== key) invalid();
  const shared = {
    id: key,
    enabled: boolean(value.enabled),
    ...(value.name === undefined ? {} : { name: text(value.name, 256) }),
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
    return {
      ...base, transport: "stdio", command: text(value.command, 4096),
      ...(args === undefined ? {} : { args }),
      ...(value.cwd === undefined ? {} : { cwd: text(value.cwd, 8192) }),
      ...(env === undefined ? {} : { env })
    };
  }
  if (value.transport !== "streamable-http") return invalid();
  const endpoint = text(value.endpoint, 8192);
  let url: URL;
  try { url = new URL(endpoint); } catch { return invalid(); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) invalid();
  if ([...url.searchParams].some(([name, value]) => hasSecretName(name) || /^(?:key|auth)$/i.test(name) || secretValue.test(value))) invalid();
  return { ...base, transport: "streamable-http", endpoint };
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
    const update = record(entry);
    const previous: Record<string, unknown> = { ...(result.servers[id] ?? {}) };
    // Switching transport discards only the old transport's fields; explicit invalid fields still fail validation.
    if (update.transport !== undefined && update.transport !== previous.transport) {
      for (const field of [...stdioFields, "endpoint"]) delete previous[field];
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
