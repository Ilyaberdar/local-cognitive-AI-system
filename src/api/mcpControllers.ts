import { randomUUID } from "node:crypto";
import { Router, RequestHandler } from "express";
import { RuntimeManager } from "../app/RuntimeManager";
import { emptyMcpConfiguration } from "../mcp/client/configuration";
import { MCP_CREDENTIAL_PREFIX, mcpSecretNames, type McpSecretKind } from "../mcp/client/credentials";
import { McpClientError } from "../mcp/client/errors";

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
  return router;
}
