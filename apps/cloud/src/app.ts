import express, { type NextFunction, type Request, type Response } from "express";
import type pg from "pg";
import { createAccountRepository, type AccountRepository } from "./accounts/accountRepository.js";
import { toMeResponse } from "./accounts/meResponse.js";
import { requireAccount } from "./accounts/requireAccount.js";
import { requireAuth, type AuthOptions } from "./auth/verifyAccessToken.js";
import type { Logger } from "./log.js";
import { createRemoteRouter, type RemoteRouteDependencies } from "./remote/remoteRoutes.js";
import { createRemoteRepository } from "./remote/remoteRepository.js";
import { createUsageRepository, type UsageRepository } from "./usage/usageRepository.js";
import { createUsageRouter, type UsageRouteDependencies } from "./usage/usageRoutes.js";

export interface AppDependencies { pool: Pick<pg.Pool, "query">; auth: AuthOptions; trustProxy?: number; logger?: Logger; accounts?: AccountRepository;
  /** Remote pairing and tickets; the relay itself is attached to the HTTP server's upgrades. */
  remote?: Pick<RemoteRouteDependencies, "repo" | "relay" | "limits">;
  /** Usage statistics; built on the pool unless given. */
  usage?: { repo?: UsageRepository; limits?: UsageRouteDependencies["limits"] } }

export const createApp = (deps: AppDependencies) => {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", deps.trustProxy ?? 0);
  app.use(express.json({ limit: "64kb" }));

  app.get("/health", async (_req, res) => {
    try { await deps.pool.query("SELECT 1"); res.json({ status: "ok", db: "up" }); }
    catch { res.status(503).json({ status: "degraded", db: "down" }); }
  });

  const accounts = deps.accounts ?? createAccountRepository(deps.pool);
  app.get("/v1/me", requireAuth(deps.auth), requireAccount(accounts, deps.logger), (req, res) => {
    res.set("Cache-Control", "no-store").json(toMeResponse(req.account!.record));
  });
  if (deps.remote) app.use(createRemoteRouter({ ...deps.remote, auth: deps.auth, accounts, ...(deps.logger ? { logger: deps.logger } : {}) }));
  app.use(createUsageRouter({ repo: deps.usage?.repo ?? createUsageRepository(deps.pool), hosts: deps.remote?.repo ?? createRemoteRepository(deps.pool as pg.Pool),
    auth: deps.auth, accounts, ...(deps.usage?.limits ? { limits: deps.usage.limits } : {}), ...(deps.logger ? { logger: deps.logger } : {}) }));

  app.use((_req, res) => { res.status(404).json({ error: "not_found" }); });
  app.use((error: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (error.type === "entity.too.large") { res.status(413).json({ error: "payload_too_large" }); return; }
    if (error.type === "entity.parse.failed") { res.status(400).json({ error: "invalid_json" }); return; }
    deps.logger?.error("Unhandled request error", { name: error.name });
    res.status(500).json({ error: "internal_error" });
  });
  return app;
};
