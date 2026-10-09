import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Router, RequestHandler } from "express";
import { RuntimeManager } from "../app/RuntimeManager";
import { emptyMcpConfiguration, parseMcpConfiguration } from "../mcp/client/configuration";
import { MCP_CREDENTIAL_PREFIX, mcpSecretNames, type McpSecretKind } from "../mcp/client/credentials";
import { McpClientError } from "../mcp/client/errors";
import { importCandidate, readMcpImport, type McpImportCandidate, type McpImportSource } from "../mcp/client/importConfig";

/** Where other clients keep their MCP servers (fixed paths: a request never names a file). */
const importFiles = (): Record<Exclude<McpImportSource, "text">, { label: string; file: string }> => {
  const home = os.homedir();
  return {
    codex: { label: "Codex", file: path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "config.toml") },
    "claude-desktop": { label: "Claude Desktop", file: process.platform === "win32" ? path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
      : process.platform === "darwin" ? path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json") : path.join(home, ".config", "Claude", "claude_desktop_config.json") },
    cursor: { label: "Cursor", file: path.join(home, ".cursor", "mcp.json") }
  };
};
const MAX_IMPORT_BYTES = 256 * 1024;
/** A regular file of at most 256 KB, after following links; its content is never logged. */
const readImportFile = async (file: string): Promise<string | undefined> => {
  try {
    const real = await fs.realpath(file);
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size > MAX_IMPORT_BYTES) return undefined;
    return await fs.readFile(real, "utf8");
  } catch { return undefined; }
};
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
  : JSON.stringify(value);
/** A server's connection, without what only names or presents it. */
const connectionOf = (server: object) => { const { id: _id, name: _name, ...rest } = server as Record<string, unknown>; return canonical(rest); };

/** Local-only status and lifecycle controls for already-saved outbound MCP definitions. */
export function createMcpRouter(runtime: RuntimeManager): Router {
  const router = Router();
  const route = (action: (bindingId?: string) => Promise<unknown>): RequestHandler => async (req, res) => {
    try { res.json(await action(typeof req.params.bindingId === "string" ? req.params.bindingId : undefined)); }
    catch (error) {
      const known = error instanceof McpClientError;
      const status = known && error.code === "binding_not_found" ? 404 : known && error.code === "binding_disabled" ? 409 : 500;
      res.status(status).json({ error: known ? error.message : "MCP connection operation failed. Check the server and try again." });
    }
  };

  router.get("/", route(async () => {
    const clients = runtime.getRuntime().mcpClients;
    return {
      connections: clients.list(),
      tools: clients.tools().map(tool => ({ id: tool.id, bindingId: tool.bindingId, serverId: tool.serverId,
        name: tool.definition.name, description: tool.definition.description }))
    };
  }));
  router.post("/:bindingId/connect", route(async bindingId => {
    const clients = runtime.getRuntime().mcpClients;
    await clients.connect(bindingId!);
    return { connection: clients.status(bindingId!), tools: clients.tools(bindingId!).map(tool => ({
      id: tool.id, name: tool.definition.name, description: tool.definition.description
    })) };
  }));
  router.post("/:bindingId/disconnect", route(async bindingId => {
    const clients = runtime.getRuntime().mcpClients;
    await clients.disconnect(bindingId!);
    return { connection: clients.status(bindingId!) };
  }));
  // A server's secrets (environment variables, headers, a bearer token). Values go into the vault
  // and never come back: this answers only which names are set. Local only, like this router.
  const secretsOf = async (serverId: string) => {
    const client = (await runtime.getSettings()).mcp?.client ?? emptyMcpConfiguration();
    const server = client.servers[serverId];
    if (!server) return undefined;
    const bindings = Object.values(client.bindings).filter(binding => binding.serverId === serverId);
    const ref = bindings.map(binding => binding.credentialRef).find(item => item?.startsWith(MCP_CREDENTIAL_PREFIX))?.slice(MCP_CREDENTIAL_PREFIX.length);
    return { server, bindings, ref };
  };
  const view = async (serverId: string) => {
    const found = await secretsOf(serverId);
    if (!found) return undefined;
    const vault = runtime.integrations.vault;
    const available = Boolean(vault?.available());
    const secrets = await Promise.all(mcpSecretNames(found.server).map(async item => ({ ...item,
      set: Boolean(found.ref && available && await runtime.mcpSecrets.isSet(found.ref, item.kind, item.name)) })));
    return { available, ...(available ? {} : { reason: vault?.unavailableReason?.() ?? "Protected storage is unavailable on this computer." }), secrets };
  };
  const secretRoute = (action: (req: Parameters<RequestHandler>[0]) => Promise<unknown>): RequestHandler => async (req, res) => {
    try { res.json(await action(req)); }
    catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      // A refused settings change carries no secret; the value itself is never in a message.
      res.status(typeof status === "number" ? status : 400).json({ error: error instanceof Error ? error.message : "The secret could not be saved." });
    }
  };
  const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
  router.get("/servers/:serverId/secrets", secretRoute(async req => (await view(String(req.params.serverId))) ?? Promise.reject(fail(404, "MCP server not found."))));
  router.put("/servers/:serverId/secrets", secretRoute(async req => {
    const serverId = String(req.params.serverId);
    const kind = req.body?.kind as McpSecretKind, value = req.body?.value;
    if (!["env", "header", "bearer"].includes(kind)) throw fail(400, "Choose an environment variable, a header or a bearer token.");
    const name = kind === "bearer" ? "Authorization" : String(req.body?.name ?? "").trim();
    if (typeof value !== "string" || !value || value.length > 16384) throw fail(400, "Enter the secret's value (at most 16 KB).");
    if (kind !== "env" && /[\r\n]/.test(value)) throw fail(400, "A header value cannot contain line breaks.");
    const found = await secretsOf(serverId);
    if (!found) throw fail(404, "MCP server not found.");
    if ((kind === "env") !== (found.server.transport === "stdio")) throw fail(400, kind === "env" ? "Environment variables are for servers the app starts." : "Headers are for servers reached by URL.");
    if (kind === "env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw fail(400, "Use a variable name such as API_KEY.");
    if (kind === "header" && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)) throw fail(400, "Use a header name such as X-Api-Key.");
    if (!runtime.integrations.vault?.available()) throw fail(503, runtime.integrations.vault?.unavailableReason?.() ?? "Protected storage is unavailable on this computer.");
    const ref = found.ref ?? randomUUID();
    await runtime.mcpSecrets.write(ref, found.server, kind, name, value);
    const listed = mcpSecretNames(found.server).some(item => item.kind === kind && item.name === name);
    const server = found.server;
    const serverPatch = listed ? {} : kind === "env" && server.transport === "stdio" ? { secretEnv: [...(server.secretEnv ?? []), name] }
      : kind === "header" && server.transport === "streamable-http" ? { secretHeaders: [...(server.secretHeaders ?? []), name] } : { bearerToken: true };
    const bindingPatch = Object.fromEntries(found.bindings.filter(binding => binding.credentialRef !== `${MCP_CREDENTIAL_PREFIX}${ref}`)
      .map(binding => [binding.id, { credentialRef: `${MCP_CREDENTIAL_PREFIX}${ref}` }]));
    if (!listed || Object.keys(bindingPatch).length) {
      // A new name or credential changes the connection: the server starts again with it.
      await runtime.updateSettings({ mcp: { client: { servers: { [serverId]: serverPatch }, bindings: bindingPatch } } } as never);
    } else {
      // A new value under a known name: start it again explicitly.
      const clients = runtime.getRuntime().mcpClients;
      for (const binding of found.bindings.filter(item => item.enabled && server.enabled)) {
        await clients.disconnect(binding.id).catch(() => undefined);
        void clients.connect(binding.id).catch(() => undefined);
      }
    }
    return view(serverId);
  }));
  router.delete("/servers/:serverId/secrets/:kind/:name", secretRoute(async req => {
    const serverId = String(req.params.serverId), kind = String(req.params.kind), name = String(req.params.name);
    const found = await secretsOf(serverId);
    if (!found) throw fail(404, "MCP server not found.");
    const server = found.server;
    const serverPatch = kind === "bearer" ? { bearerToken: null }
      : kind === "env" && server.transport === "stdio" ? { secretEnv: (server.secretEnv ?? []).filter(item => item !== name) }
      : kind === "header" && server.transport === "streamable-http" ? { secretHeaders: (server.secretHeaders ?? []).filter(item => item !== name) } : undefined;
    if (!serverPatch) throw fail(400, "Unknown secret.");
    // The settings no longer name it, so its value leaves the vault (RuntimeManager prunes).
    await runtime.updateSettings({ mcp: { client: { servers: { [serverId]: serverPatch } } } } as never);
    return view(serverId);
  }));
  // Import from Codex, Claude Desktop, Cursor or a pasted snippet (M3c). The preview carries no
  // secret value: those wait here, by a one-time token, until Import (at most 10 minutes).
  const previews = new Map<string, { candidates: McpImportCandidate[]; expires: number }>();
  router.get("/import/sources", secretRoute(async () => ({ sources: await Promise.all(Object.entries(importFiles()).map(async ([source, { label, file }]) =>
    ({ source, label, available: (await readImportFile(file)) !== undefined }))) })));
  router.post("/import/preview", secretRoute(async req => {
    const source = String(req.body?.source ?? "") as McpImportSource;
    let text: string | undefined;
    if (source === "text") {
      text = typeof req.body?.text === "string" ? req.body.text : undefined;
      if (!text?.trim() || text.length > MAX_IMPORT_BYTES) throw fail(400, "Paste a configuration of at most 256 KB.");
    } else {
      const known = importFiles()[source as Exclude<McpImportSource, "text">];
      if (!known) throw fail(400, "Choose Codex, Claude Desktop, Cursor or paste a snippet.");
      text = await readImportFile(known.file);
      if (text === undefined) throw fail(404, `No ${known.label} configuration was found on this computer.`);
    }
    const servers = readMcpImport(source, text);
    const client = (await runtime.getSettings()).mcp?.client ?? emptyMcpConfiguration();
    const taken = new Set([...Object.keys(client.servers), ...Object.keys(client.bindings)]);
    const existing = new Map(Object.values(client.servers).map(server => [connectionOf(server), server.id]));
    const candidates: McpImportCandidate[] = [];
    for (const [key, value] of Object.entries(servers).slice(0, 64)) {
      // A pasted snippet (from a web page) gets no value from this computer's environment: only the
      // user's own app configs refer to it, as their apps do.
      const candidate = importCandidate(key, value, taken, source === "text" ? {} : process.env);
      if (!candidate) continue;
      // Checked as Settings would check it, so one unusable server does not stop the others.
      if (!candidate.unsupported) {
        try { parseMcpConfiguration({ servers: { [candidate.id]: candidate.server }, bindings: {} }); }
        catch { candidate.unsupported = "Some of its settings cannot be used here (for example a credential in a plain field or an invalid address)."; }
      }
      taken.add(candidate.id);
      candidates.push(candidate);
    }
    const now = Date.now();
    for (const [token, preview] of previews) if (preview.expires < now) previews.delete(token);
    const token = randomUUID();
    previews.set(token, { candidates, expires: now + 10 * 60_000 });
    return { token, vault: Boolean(runtime.integrations.vault?.available()), servers: candidates.map(candidate => ({
      key: candidate.key, id: candidate.id, server: candidate.server, ignored: candidate.ignored,
      ...(candidate.unsupported ? { unsupported: candidate.unsupported } : {}),
      ...(existing.has(connectionOf(candidate.server)) ? { alreadyAdded: existing.get(connectionOf(candidate.server)) } : {}),
      secrets: candidate.secrets.map(({ kind, name, value, from }) => ({ kind, name, found: value !== undefined, ...(from ? { from } : {}) }))
    })) };
  }));
  router.post("/import/apply", secretRoute(async req => {
    const preview = previews.get(String(req.body?.token ?? ""));
    if (!preview || preview.expires < Date.now()) throw fail(409, "This preview has expired. Preview the import again.");
    const keys = new Set(Array.isArray(req.body?.keys) ? req.body.keys.map(String) : []);
    const chosen = preview.candidates.filter(candidate => keys.has(candidate.key) && !candidate.unsupported);
    if (!chosen.length) throw fail(400, "Choose at least one server to import.");
    previews.delete(String(req.body.token));
    const vault = runtime.integrations.vault;
    const storing = Boolean(vault?.available());
    const written: Array<{ ref: string; server: McpImportCandidate["server"]; kind: McpImportCandidate["secrets"][number]["kind"]; name: string }> = [];
    const servers: Record<string, unknown> = {}, bindings: Record<string, unknown> = {};
    const missing: Array<{ id: string; name: string }> = [];
    try {
      for (const candidate of chosen) {
        const ref = candidate.secrets.length ? randomUUID() : undefined;
        for (const secret of candidate.secrets) {
          if (secret.value !== undefined && storing && ref) {
            await runtime.mcpSecrets.write(ref, candidate.server, secret.kind, secret.name, secret.value);
            written.push({ ref, server: candidate.server, kind: secret.kind, name: secret.name });
          } else missing.push({ id: candidate.id, name: secret.kind === "bearer" ? "Bearer token" : secret.name });
        }
        servers[candidate.id] = candidate.server;
        bindings[candidate.id] = { id: candidate.id, serverId: candidate.id, enabled: candidate.server.enabled, ...(ref ? { credentialRef: `${MCP_CREDENTIAL_PREFIX}${ref}` } : {}) };
      }
      await runtime.updateSettings({ mcp: { client: { servers, bindings } } } as never);
    } catch (error) {
      // Nothing was added: the values stored for it leave the vault.
      for (const item of written) await runtime.mcpSecrets.remove(item.ref, item.kind, item.name).catch(() => undefined);
      throw error;
    }
    return { added: chosen.map(candidate => candidate.id), missing };
  }));
  return router;
}
