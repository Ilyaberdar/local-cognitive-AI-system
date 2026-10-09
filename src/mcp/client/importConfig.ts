import { parse as parseToml } from "smol-toml";
import { hasSecretName } from "../../config/secrets";
import type { McpSecretKind } from "./credentials";
import type { McpApprovalMode, McpServerDefinition } from "./types";

/** MCP servers configured for another client, as Local Cognitive would add them (M3c). Codex's
 * `~/.codex/config.toml`, Claude Desktop's and Cursor's JSON, or a snippet from a README. */
export type McpImportSource = "codex" | "claude-desktop" | "cursor" | "text";

export interface McpImportSecret { kind: McpSecretKind; name: string; value?: string }
export interface McpImportCandidate {
  /** The server's name in the source. */
  key: string;
  /** The id it gets here. */
  id: string;
  server: McpServerDefinition;
  /** Values found in the source go to the vault; without one it is set later in Settings. */
  secrets: McpImportSecret[];
  /** Fields with nothing to map to here. */
  ignored: string[];
  /** Why it cannot be added (an unsupported transport); such a candidate is never imported. */
  unsupported?: string;
}

const secretValue = /^(?:Bearer|Basic)\s|-----BEGIN [A-Z ]*PRIVATE KEY-----|^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.|^(?:sk|pk|rk|ghp|gho|xox[abp]|AKIA)[-_A-Za-z0-9]{8,}/i;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every(item => typeof item === "string") ? value as string[] : undefined;

/** A server id: lowercase letters, digits, dots, dashes; never a reserved or plugin id. */
export function importedId(name: string, taken: Set<string>): string {
  const stem = name.toLowerCase().trim().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").slice(0, 116) || "imported-mcp";
  const base = /^(?:plugin-|local-cognitive$|new$|import$|__proto__$|constructor$|prototype$)/.test(stem) ? `mcp-${stem}` : stem;
  let id = base, suffix = 2;
  while (taken.has(id)) id = `${base.slice(0, 120)}-${suffix++}`;
  return id;
}

/** The servers in a source's text. Throws a message with no content of the file (a TOML or JSON
 * error could quote a line holding a secret). */
export function readMcpImport(source: McpImportSource, text: string): Record<string, unknown> {
  const trimmed = text.trim();
  let document: unknown;
  // A pasted snippet is JSON when it is an object; "[mcp_servers.x]" is a TOML table.
  if (source === "codex" || (source === "text" && !trimmed.startsWith("{"))) {
    try { document = parseToml(text); }
    catch (error) {
      const where = /line (\d+), column (\d+)/i.exec(String((error as Error)?.message ?? ""));
      throw new Error(`This is not valid TOML${where ? ` (line ${where[1]}, column ${where[2]})` : ""}.`);
    }
    const root = record(document) ?? {};
    // A snippet may be the [mcp_servers.x] tables or just the servers.
    return record(root.mcp_servers) ?? (source === "text" ? root : {});
  }
  try { document = JSON.parse(trimmed); }
  catch { throw new Error("This is not valid JSON."); }
  const root = record(document) ?? {};
  // Claude Desktop and Cursor: { mcpServers }; VS Code: { servers }; a snippet: the map itself.
  return record(root.mcpServers) ?? record(root.servers) ?? (record(root.mcp) && record(record(root.mcp)!.servers)) ?? root;
}

/** One source entry as a server here. `env` is this process's environment, for Codex's
 * `env_vars` and `bearer_token_env_var` (the values are taken, never kept in settings). */
export function importCandidate(key: string, input: unknown, taken: Set<string>, env: Record<string, string | undefined> = {}): McpImportCandidate | undefined {
  const entry = record(input);
  if (!entry) return undefined;
  const id = importedId(key, taken);
  const ignored: string[] = [];
  const secrets: McpImportSecret[] = [];
  const known = new Set<string>();
  const take = (...names: string[]) => { for (const name of names) known.add(name); };
  // Codex: startup_timeout_sec wins over startup_timeout_ms; JSON clients have no timeouts.
  const seconds = (value: unknown) => typeof value === "number" && value > 0 ? Math.min(3_600_000, Math.round(value * 1000)) : undefined;
  const connectTimeoutMs = seconds(entry.startup_timeout_sec) ?? (typeof entry.startup_timeout_ms === "number" && entry.startup_timeout_ms > 0 ? Math.min(3_600_000, Math.round(entry.startup_timeout_ms)) : undefined);
  const requestTimeoutMs = seconds(entry.tool_timeout_sec);
  take("startup_timeout_sec", "startup_timeout_ms", "tool_timeout_sec");
  const approvalModes: Record<string, McpApprovalMode> = { prompt: "ask", writes: "read-only", approve: "trust", auto: "ask" };
  const approval = typeof entry.default_tools_approval_mode === "string" ? approvalModes[entry.default_tools_approval_mode] : undefined;
  take("default_tools_approval_mode");
  const enabled = entry.enabled !== false && entry.disabled !== true;
  take("enabled", "disabled", "name", "type", "transport");
  const common = {
    id, name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim().slice(0, 256) : key.slice(0, 256), enabled,
    ...(approval && approval !== "ask" ? { approval } : {}),
    ...(strings(entry.enabled_tools) ? { enabledTools: strings(entry.enabled_tools) } : {}),
    ...(strings(entry.disabled_tools) ? { disabledTools: strings(entry.disabled_tools) } : {}),
    ...(connectTimeoutMs ? { connectTimeoutMs } : {}), ...(requestTimeoutMs ? { requestTimeoutMs } : {})
  };
  take("enabled_tools", "disabled_tools");
  if (entry.default_tools_approval_mode === "auto") ignored.push("default_tools_approval_mode = auto (asks for every call here)");
  const type = typeof entry.type === "string" ? entry.type : typeof entry.transport === "string" ? entry.transport : undefined;
  const url = typeof entry.url === "string" ? entry.url : typeof entry.serverUrl === "string" ? entry.serverUrl : undefined;
  take("url", "serverUrl");
  let server: McpServerDefinition;
  let unsupported: string | undefined;
  if (url) {
    if (type === "sse") unsupported = "It uses the older SSE transport, which is not supported here.";
    const headers: Record<string, string> = {};
    const plain = record(entry.http_headers) ?? record(entry.headers) ?? {};
    for (const [name, value] of Object.entries(plain)) {
      if (typeof value !== "string") continue;
      const bearer = /^authorization$/i.test(name) && /^Bearer\s+(.+)$/i.exec(value);
      if (bearer) secrets.push({ kind: "bearer", name: "Authorization", value: bearer[1] });
      else if (/^(?:authorization|proxy-authorization|cookie)$/i.test(name) || hasSecretName(name) || secretValue.test(value)) secrets.push({ kind: "header", name, value });
      else headers[name] = value;
    }
    for (const [name, variable] of Object.entries(record(entry.env_http_headers) ?? {})) {
      if (typeof variable === "string") secrets.push({ kind: "header", name, ...(env[variable] ? { value: env[variable] } : {}) });
    }
    const tokenVariable = typeof entry.bearer_token_env_var === "string" ? entry.bearer_token_env_var : undefined;
    if (tokenVariable) secrets.push({ kind: "bearer", name: "Authorization", ...(env[tokenVariable] ? { value: env[tokenVariable] } : {}) });
    if (typeof entry.bearer_token === "string") secrets.push({ kind: "bearer", name: "Authorization", value: entry.bearer_token });
    take("http_headers", "headers", "env_http_headers", "bearer_token_env_var", "bearer_token");
    const secretHeaders = [...new Set(secrets.filter(item => item.kind === "header").map(item => item.name))];
    server = { ...common, transport: "streamable-http", endpoint: url, ...(Object.keys(headers).length ? { headers } : {}),
      ...(secretHeaders.length ? { secretHeaders } : {}), ...(secrets.some(item => item.kind === "bearer") ? { bearerToken: true } : {}) };
  } else if (typeof entry.command === "string" && entry.command.trim()) {
    let command = entry.command.trim(), args = strings(entry.args) ?? [];
    // Windows snippets wrap the command for cmd.exe; the app runs .cmd shims itself.
    if (/^cmd(?:\.exe)?$/i.test(command) && /^\/c$/i.test(args[0] ?? "") && args[1]) { command = args[1]; args = args.slice(2); }
    const plain: Record<string, string> = {};
    for (const [name, value] of Object.entries(record(entry.env) ?? {})) {
      if (typeof value !== "string") continue;
      // Cursor's ${env:NAME}: taken from this process's environment when it has it.
      const reference = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
      const resolved = reference ? env[reference[1]!] : value;
      if (reference || hasSecretName(name) || secretValue.test(value)) secrets.push({ kind: "env", name, ...(resolved ? { value: resolved } : {}) });
      else plain[name] = value;
    }
    for (const item of Array.isArray(entry.env_vars) ? entry.env_vars : []) {
      const name = typeof item === "string" ? item : typeof record(item)?.name === "string" && record(item)!.source !== "remote" ? record(item)!.name as string : undefined;
      if (!name) { ignored.push("env_vars with source = remote"); continue; }
      if (hasSecretName(name)) secrets.push({ kind: "env", name, ...(env[name] ? { value: env[name] } : {}) });
      else if (env[name] !== undefined) plain[name] = env[name]!;
      else ignored.push(`env_vars ${name} (not set for this app)`);
    }
    take("command", "args", "env", "env_vars", "cwd");
    server = { ...common, transport: "stdio", command, ...(args.length ? { args } : {}), ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
      ...(Object.keys(plain).length ? { env: plain } : {}), ...(secrets.length ? { secretEnv: [...new Set(secrets.map(item => item.name))] } : {}) };
  } else return undefined;
  for (const field of Object.keys(entry)) if (!known.has(field)) ignored.push(field === "http_headers_helper" ? "http_headers_helper (runs a command; never imported)" : field);
  return { key, id, server, secrets, ignored, ...(unsupported ? { unsupported } : {}) };
}
