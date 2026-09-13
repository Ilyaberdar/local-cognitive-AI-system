import { Router, Request, Response } from "express";
import { LocalModelService } from "../local/LocalModelService";
import { LocalModelError } from "../local/types";

export const createLocalModelRouter = (getService: () => LocalModelService): Router => {
  const router = Router();
  const route = (handler: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    try { await handler(req, res); } catch (error) {
      res.status(error instanceof LocalModelError ? error.statusCode : 500).json({ error: error instanceof Error ? error.message : "Local model operation failed.", code: error instanceof LocalModelError ? error.code : "local_model_error" });
    }
  };
  const string = (value: unknown, name: string): string => { if (typeof value !== "string" || !value.trim()) throw new LocalModelError(`Field '${name}' must be a nonempty string.`); return value.trim(); };
  router.get("/local/catalog", route(async (req, res) => res.json(await getService().listCatalog(typeof req.query.q === "string" ? req.query.q : undefined, typeof req.query.cursor === "string" ? req.query.cursor : undefined, typeof req.query.source === "string" ? req.query.source : undefined))));
  router.get("/local/catalog/model", route(async (req, res) => res.json(await getService().getCatalogModel(string(req.query.repoId, "repoId"), typeof req.query.revision === "string" && req.query.revision ? req.query.revision : undefined))));
  router.get("/local/downloads", route(async (_req, res) => res.json(getService().listDownloads())));
  router.post("/local/downloads", route(async (req, res) => res.status(202).json(await getService().startDownload({ repoId: string(req.body?.repoId, "repoId"), revision: string(req.body?.revision, "revision"), variantId: string(req.body?.variantId, "variantId") }))));
  router.post("/local/downloads/:id/pause", route(async (req, res) => res.json(await getService().pauseDownload(String(req.params.id)))));
  router.post("/local/downloads/:id/resume", route(async (req, res) => res.json(await getService().resumeDownload(String(req.params.id)))));
  router.post("/local/downloads/:id/cancel", route(async (req, res) => res.json(await getService().cancelDownload(String(req.params.id)))));
  router.post("/local/models/import", route(async (req, res) => {
    const paths = req.body?.paths ?? (req.body?.path ? [req.body.path] : undefined);
    if (!Array.isArray(paths)) throw new LocalModelError("Field 'paths' must contain the selected GGUF file paths.");
    res.status(201).json(await getService().importModel(paths));
  }));
  router.delete("/local/models/:libraryId", route(async (req, res) => { await getService().deleteModel(String(req.params.libraryId)); res.json({ ok: true }); }));
  router.get("/local/runtime", route(async (_req, res) => res.json(getService().snapshot())));
  router.get("/local/events", (req, res) => {
    res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" }); res.flushHeaders();
    const service = getService();
    const write = (event: unknown, sequence: number) => { if (!res.destroyed && !res.writableEnded) { if (res.writableLength > 256 * 1024) { res.end(); return; } res.write(`id: ${sequence}\ndata: ${JSON.stringify(event)}\n\n`); } };
    const snapshot = service.snapshot();
    write({ type: "snapshot", sequence: snapshot.sequence, at: new Date().toISOString(), snapshot }, snapshot.sequence);
    const unsubscribe = service.subscribe((event) => write(event, event.sequence));
    const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(": keepalive\n\n"); }, 15000); heartbeat.unref();
    req.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
  });
  return router;
};
