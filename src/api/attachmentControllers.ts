import { Router } from "express";
import { extractDocument } from "../utils/DocumentTextExtractor";

export function createAttachmentRouter(): Router {
  const router = Router();
  router.post("/attachments/extract", async (req, res) => {
    const abort = new AbortController();
    res.once("close", () => { if (!res.writableEnded) abort.abort(); });
    try {
      const result = await extractDocument(req.body?.name, req.body?.dataUrl, abort.signal);
      if (!res.destroyed) res.json(result);
    } catch (error) {
      if (!res.destroyed) res.status(400).json({ error: error instanceof Error ? error.message : "Unable to read this document." });
    }
  });
  return router;
}
