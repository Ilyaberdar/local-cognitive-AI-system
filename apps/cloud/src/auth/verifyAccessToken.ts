import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { NextFunction, Request, RequestHandler, Response } from "express";

export interface VerifiedIdentity { issuer: string; subject: string; claims: JWTPayload }
export interface AuthOptions { issuer: string; audience: string; keys?: JWTVerifyGetKey }

declare global {
  namespace Express { interface Request { identity?: VerifiedIdentity } }
}

// Auth0 or network trouble must not look like a bad token, or clients would sign out.
const unavailableCodes = new Set(["ERR_JWKS_TIMEOUT", "ERR_JWKS_INVALID"]);
export const isInvalidToken = (error: unknown): boolean =>
  error instanceof errors.JOSEError && !unavailableCodes.has(error.code);

/** Verifies an Auth0 access token for this API: RS256 signature from the tenant's JWKS,
 * issuer, audience (which also rejects ID tokens), expiry and subject. */
export const requireAuth = (options: AuthOptions): RequestHandler => {
  const keys = options.keys ?? createRemoteJWKSet(new URL(".well-known/jwks.json", options.issuer));
  return (req: Request, res: Response, next: NextFunction) => {
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(req.get("authorization") ?? "");
    if (!match?.[1]) { res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" }); return; }
    jwtVerify(match[1], keys, { issuer: options.issuer, audience: options.audience, algorithms: ["RS256"],
      requiredClaims: ["sub", "exp"], clockTolerance: 5 })
      .then(({ payload }) => { req.identity = { issuer: payload.iss!, subject: payload.sub!, claims: payload }; next(); })
      .catch((error: unknown) => {
        if (isInvalidToken(error)) res.status(401).set("WWW-Authenticate", 'Bearer error="invalid_token"').json({ error: "invalid_token" });
        else res.status(503).json({ error: "auth_unavailable" });
      });
  };
};
