import { Router, RequestHandler } from "express";
import { RuntimeManager } from "../app/RuntimeManager";
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
  return router;
}
