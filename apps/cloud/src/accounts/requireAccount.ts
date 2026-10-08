import type { NextFunction, Request, RequestHandler, Response } from "express";
import { extractProfileClaims, isUserToken } from "../auth/profileClaims.js";
import type { Logger } from "../log.js";
import type { AccountRepository } from "./accountRepository.js";
import { providerFromSubject, type AccountRecord } from "./meResponse.js";

export interface RequestAccount { id: string; status: AccountRecord["status"]; emailVerified: boolean; record: AccountRecord }

declare global {
  namespace Express { interface Request { account?: RequestAccount } }
}

/** Maps a verified identity to its account, creating it on first use (spec §4: the account
 * is keyed by issuer + subject, never by email). Runs after requireAuth. */
export const requireAccount = (accounts: AccountRepository, logger?: Logger): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    const identity = req.identity!;
    if (!isUserToken(identity)) { res.status(403).json({ error: "user_token_required" }); return; }
    const profile = extractProfileClaims(identity.claims);
    const resolve = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const { accountId, created } = await accounts.upsertIdentity({ issuer: identity.issuer, subject: identity.subject, ...profile });
        if (created) logger?.info("Account created", { accountId, provider: providerFromSubject(identity.subject) });
        if (!profile.email) logger?.warn("Profile claims missing", { accountId });
        const record = await accounts.loadAccount(accountId, identity.issuer, identity.subject);
        // Deleted between the two statements: the retry links the identity to a new account.
        if (record) return record;
      }
      throw new Error("Account could not be resolved");
    };
    resolve().then((record) => {
      if (record.status === "disabled") { res.status(403).json({ error: "account_disabled" }); return; }
      const current = record.identities.find((item) => item.current);
      req.account = { id: record.id, status: record.status, emailVerified: current?.emailVerified ?? false, record };
      next();
    }).catch(next);
  };
