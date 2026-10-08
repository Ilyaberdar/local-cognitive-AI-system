import type { RequestHandler } from "express";

// While draining, work that is already accepted can still be reviewed, cancelled or freed.
const allowedWhileDraining = [
  /^\/(?:process-runs|workflow-runs)\/[^/]+\/(?:review|cancel)$/,
  /^\/local\/downloads\/[^/]+\/(?:pause|cancel)$/,
  /^\/local\/models\/unload$/
];

/** Rejects new work with 503 once the server has started shutting down. */
export const createDrainGate = (isDraining: () => boolean): RequestHandler => (req, res, next) => {
  if (!isDraining() || ["GET", "HEAD", "OPTIONS"].includes(req.method) || allowedWhileDraining.some(pattern => pattern.test(req.path))) { next(); return; }
  res.set("Retry-After", "30").status(503).json({ error: "The server is shutting down and accepts no new work.", code: "draining" });
};
