import { Router, Request, Response, NextFunction } from "express";
import { SynthesisService } from "../synthesis/SynthesisService";
import { SynthesisError } from "../synthesis/types";
import { openWorkspaceEditor } from "./workspaceReview";

export function createSynthesisRouter(service: () => SynthesisService): Router {
  const router = Router();
  const route = (handler: (request: Request, response: Response) => Promise<unknown>) => (request: Request, response: Response, next: NextFunction) => { void handler(request, response).catch(next); };
  const param = (request: Request, key: string) => String(request.params[key] ?? "");
  router.get("/projects/:projectId/modules", route(async (req, res) => res.json({modules: await service().modules(param(req, "projectId"))})));
  router.get("/projects/:projectId/folders", route(async (req, res) => res.json(await service().folders(param(req, "projectId"), req.query.directory ?? ""))));
  router.post("/projects/:projectId/modules", route(async (req, res) => {
    if (!["empty", "calculator"].includes(req.body?.template)) throw new SynthesisError("Choose an empty module or calculator template.");
    if (req.body.name !== undefined && typeof req.body.name !== "string") throw new SynthesisError("name must be a string.");
    if (req.body.directory !== undefined && typeof req.body.directory !== "string") throw new SynthesisError("directory must be a project-relative path.");
    res.status(201).json(await service().createModule(param(req, "projectId"), req.body.name ?? (req.body.template === "empty" ? "NewModule" : "Calculator"), {template: req.body.template, directory: req.body.directory}));
  }));
  router.get("/projects/:projectId/modules/:moduleId", route(async (req, res) => res.json(await service().module(param(req, "projectId"), param(req, "moduleId")))));
  router.post("/projects/:projectId/open", route(async (req, res) => {
    if (req.body?.file !== undefined && !["spec", "flow"].includes(req.body.file)) throw new SynthesisError("file must be spec or flow.");
    if (req.body?.moduleId !== undefined && typeof req.body.moduleId !== "string") throw new SynthesisError("moduleId must be a string.");
    const target = await service().editorPath(param(req, "projectId"), req.body?.moduleId, req.body?.file);
    const editor = await openWorkspaceEditor(target); res.json({ok: true, editor});
  }));
  router.get("/projects/:projectId/runs", route(async (req, res) => res.json(await service().list(param(req, "projectId")))));
  router.post("/projects/:projectId/runs", route(async (req, res) => {
    if (typeof req.body?.moduleId !== "string") throw new SynthesisError("Select a module before Run.");
    res.status(202).json(await service().start(param(req, "projectId"), req.body.moduleId));
  }));
  router.get("/runs/:id", route(async (req, res) => res.json(await service().get(param(req, "id")))));
  router.get("/runs/:id/sources", route(async (req, res) => res.json(await service().sources(param(req, "id")))));
  router.post("/runs/:id/cancel", route(async (req, res) => res.json(await service().cancel(param(req, "id")))));
  router.post("/runs/:id/resume", route(async (req, res) => res.status(202).json(await service().restart(param(req, "id")))));
  router.get("/runs/:id/diff", route(async (req, res) => res.json(await service().diff(param(req, "id")))));
  router.post("/runs/:id/apply", route(async (req, res) => { await service().apply(param(req, "id")); res.json({ok: true}); }));
  router.get("/runs/:id/preview/*", route(async (req, res) => {
    const file = param(req, "0");
    const source = await service().preview(param(req, "id"), file);
    // Enforce an opaque origin even when preview is opened outside our sandboxed iframe.
    // Only this run's artifact subdirectory may supply scripts/styles; network/API access is denied.
    const base = `/synthesis/runs/${encodeURIComponent(param(req, "id"))}/preview/`;
    const host = req.get("host");
    if (!host || !/^[A-Za-z0-9.:[\]-]+$/.test(host)) throw new SynthesisError("Invalid preview origin.");
    const sourcePath = `${req.protocol}://${host}${base}`;
    res.setHeader("Content-Security-Policy", `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' ${sourcePath}; style-src 'unsafe-inline' ${sourcePath}; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; worker-src 'none'`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.type(file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "text/html").send(source);
  }));
  return router;
}
