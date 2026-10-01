import { Router, RequestHandler } from "express";
import { z } from "zod";
import { RuntimeManager } from "../app/RuntimeManager";
import { catalogEntry, pluginCatalog } from "../plugins/catalog";
import { PluginError } from "../plugins/contracts";

/** Local-only, same-origin API. No arbitrary URL, credential lookup or call-tool endpoint. */
export const localApiOriginGuard: RequestHandler = (req, res, next) => {
  const host = req.headers.host, address = req.socket.remoteAddress;
  const allowedHosts = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`, `[::1]:${req.socket.localPort}`];
  if (!host || !allowedHosts.includes(host) || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? "") ||
      (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers["sec-fetch-site"] === "cross-site") {
    res.status(403).json({ error: "Integrations are only available to this local application." }); return;
  }
  // Content-Type is not a trustworthy app signal: browsers can omit it for a
  // body-less DELETE. A non-simple header forces a CORS preflight for a page
  // outside this origin, while the loopback and origin checks above prevent
  // DNS-rebinding access.
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers["x-local-cognitive"] !== "1") {
    res.status(403).json({ error: "A same-origin application request is required." }); return;
  }
  res.setHeader("Cache-Control", "no-store"); next();
};
export const integrationOriginGuard: RequestHandler = (req, res, next) => localApiOriginGuard(req, res, () => {
  if (req.method !== "GET" && req.headers["x-local-cognitive"] !== "1") { res.status(403).json({ error: "A same-origin application request is required." }); return; }
  next();
});
export function createIntegrationRouter(runtime: RuntimeManager): Router {
  const router = Router(); router.use(integrationOriginGuard);
  const route = (action: (req: Parameters<RequestHandler>[0]) => Promise<unknown>): RequestHandler => async (req, res) => {
    try { res.json(await action(req)); }
    catch (error) {
      const status = error instanceof PluginError ? error.statusCode : error instanceof z.ZodError ? 400 : 500;
      res.status(status).json({ error: error instanceof PluginError ? error.message : status === 400 ? "Invalid integration settings." : "Integration operation failed. Check the connection and try again." });
    }
  };
  router.get("/", route(async () => ({ ...await runtime.getPluginManager().snapshot(),
    setup: Object.fromEntries(await Promise.all(pluginCatalog.map(async plugin => [plugin.id, await runtime.getConnectionService().configuration(plugin)]))) })));
  router.get("/available", route(() => runtime.getPluginManager().choices()));
  router.post("/:id/install", route(req => runtime.getPluginManager().install(String(req.params.id))));
  router.patch("/:id", route(req => runtime.getPluginManager().configure(String(req.params.id), z.object({
    enabled: z.boolean().optional(), permission: z.enum(["none", "read", "read-write"]).optional(), connectionId: z.string().uuid().optional()
  }).strict().parse(req.body))));
  router.delete("/:id", route(req => runtime.getPluginManager().uninstall(String(req.params.id))));
  router.put("/:id/oauth-client", route(req => runtime.getConnectionService().configure(catalogEntry(String(req.params.id)), req.body)));
  router.post("/:id/connect", route(async req => {
    const attempt = await runtime.getPluginManager().connect(String(req.params.id));
    let opened = false;
    if (runtime.integrations.openExternal) {
      try { await runtime.integrations.openExternal(attempt.authorizationUrl); opened = true; } catch { /* UI offers the validated authorization link. */ }
    }
    return { ...attempt, opened };
  }));
  router.post("/connections/:id/refresh", route(async req => {
    await runtime.getPluginManager().refresh(String(req.params.id)); return runtime.getPluginManager().snapshot();
  }));
  router.delete("/connections/:id", route(req => runtime.getPluginManager().disconnect(String(req.params.id))));
  return router;
}
