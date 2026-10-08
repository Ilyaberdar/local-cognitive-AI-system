import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { AccountConfig } from "./accountConfig";
import { AccountError } from "./errors";

export type SignInMethod = "google" | "email" | "signup";
export type FetchLike = typeof fetch;

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
export const safeEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const pkcePair = () => {
  const verifier = randomToken(32);
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

export const buildAuthorizeUrl = (config: AccountConfig, input: { redirectUri: string; state: string; nonce: string; challenge: string; method: SignInMethod }): string => {
  const url = new URL(`${config.authority}/authorize`);
  const parameters: Record<string, string> = {
    response_type: "code", client_id: config.clientId, redirect_uri: input.redirectUri, scope: config.scope, audience: config.audience,
    state: input.state, nonce: input.nonce, code_challenge: input.challenge, code_challenge_method: "S256",
    // Interactive sign-in always asks for credentials, so a signed-out user can switch accounts.
    prompt: "login"
  };
  if (input.method === "google") parameters.connection = "google-oauth2";
  if (input.method === "signup") parameters.screen_hint = "signup";
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  return url.href;
};

export interface IdTokenClaims { sub: string; email?: string; email_verified?: boolean; name?: string }

const decodePart = (part: string): Record<string, unknown> => {
  const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid token part");
  return value as Record<string, unknown>;
};

/** The ID token comes directly from the token endpoint over TLS, so its claims are validated
 * without a signature check (OIDC Core 3.1.3.7 (6)); the Cloud API verifies access tokens. */
export const validateIdToken = (token: string, config: AccountConfig, expected: { nonce?: string; subject?: string; now?: number }): IdTokenClaims => {
  try {
    if (token.length > 16 * 1024) throw new Error("Oversized token");
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Malformed token");
    const header = decodePart(parts[0]!), claims = decodePart(parts[1]!);
    const now = Math.floor((expected.now ?? Date.now()) / 1000);
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (header.alg !== "RS256" || claims.iss !== config.issuer || !audience.includes(config.clientId) ||
        (audience.length > 1 && claims.azp !== config.clientId) || typeof claims.exp !== "number" || claims.exp <= now - 120 ||
        (typeof claims.iat === "number" && claims.iat > now + 120) || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) {
      throw new Error("Invalid claims");
    }
    if (expected.nonce !== undefined && (typeof claims.nonce !== "string" || !safeEqual(claims.nonce, expected.nonce))) throw new Error("Nonce mismatch");
    if (expected.subject !== undefined && claims.sub !== expected.subject) throw new Error("Subject changed");
    return { sub: claims.sub, email: typeof claims.email === "string" ? claims.email : undefined,
      email_verified: claims.email_verified === true, name: typeof claims.name === "string" ? claims.name : undefined };
  } catch { throw new AccountError("id_token_invalid"); }
};

export interface TokenResponse { access_token: string; refresh_token?: string; id_token?: string; expires_in: number }

/** OAuth error from the token endpoint (e.g. invalid_grant) versus a transient failure. */
export class TokenEndpointError extends Error {
  constructor(readonly oauthError: string | undefined, readonly transient: boolean) { super(oauthError ?? "token_endpoint_unavailable"); }
}

const readLimited = async (response: Response): Promise<string> => {
  const text = await response.text();
  if (text.length > 64 * 1024) throw new TokenEndpointError(undefined, true);
  return text;
};

const post = (fetchImpl: FetchLike, url: string, body: Record<string, string>, signal?: AbortSignal, timeoutMs = 20_000) =>
  fetchImpl(url, { method: "POST", body: new URLSearchParams(body), redirect: "error", headers: { Accept: "application/json" },
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]) });

export const tokenRequest = async (config: AccountConfig, parameters: Record<string, string>, fetchImpl: FetchLike, signal?: AbortSignal): Promise<TokenResponse> => {
  let response: Response;
  try { response = await post(fetchImpl, `${config.authority}/oauth/token`, { client_id: config.clientId, ...parameters }, signal); }
  catch { throw new TokenEndpointError(undefined, true); }
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(await readLimited(response)) as Record<string, unknown>; } catch (error) { if (error instanceof TokenEndpointError) throw error; }
  if (!response.ok) throw new TokenEndpointError(typeof body.error === "string" ? body.error : undefined, response.status >= 500 || response.status === 429);
  if (typeof body.access_token !== "string" || !body.access_token) throw new TokenEndpointError(undefined, false);
  return { access_token: body.access_token, refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    id_token: typeof body.id_token === "string" ? body.id_token : undefined,
    expires_in: typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 300 };
};

/** Best effort: revoking a refresh token revokes its whole rotation family at Auth0. */
export const revokeRefreshToken = async (config: AccountConfig, token: string, fetchImpl: FetchLike): Promise<void> => {
  try { await post(fetchImpl, `${config.authority}/oauth/revoke`, { client_id: config.clientId, token }, undefined, 10_000); } catch { /* Local sign-out already happened. */ }
};
