import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Request, RequestHandler, Response } from "express";

/** This computer's HTTP API answers only who has this launch's key: the desktop window (its main
 * process adds the header, electron/api-auth.cjs), a browser that opened the link `npm start`
 * prints (a cookie), and commands of the server's user (`local-cognitive-server api-token`). Other
 * programs and other users on this computer reach the loopback port too; the origin guard
 * (integrationControllers.ts) keeps web pages out, this keeps them out. */

/** A key is base64url, so it is safe in a header and a cookie as it is. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,256}$/;
/** Longer values are refused without being hashed. */
const MAX_TOKEN_LENGTH = 256;

export const API_TOKEN_REFUSAL = { error: "This computer's API needs the app's key.", code: "api_token_required" } as const;

/** A new key: 32 random bytes, base64url. */
export const createApiToken = (): string => randomBytes(32).toString("base64url");

/** Where a runtime keeps its key for its user's commands: beside the data root's lock (0700). */
export const apiTokenFilePath = (appDataDir: string): string => path.join(appDataDir, "runtime", "api-token");

/** The cookie's name has the port in it: cookies ignore ports, and two runtimes on one computer
 * (the app and `npm start`, say) must not replace each other's. */
export const apiTokenCookieName = (port: number | undefined): string => `lc_api_${port ?? 0}`;

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

const bearerToken = (header: string | undefined): string | undefined => /^Bearer +([^\s,]+) *$/i.exec(header ?? "")?.[1];

const cookieValue = (header: string | undefined, name: string): string | undefined => {
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
};

/** The `token` of the browser's sign-in link (`GET /?token=…`), when the request is one. */
const bootstrapToken = (req: Request): { token?: string } | undefined => {
  if (req.method !== "GET" || req.path !== "/") return undefined;
  const query = req.originalUrl.indexOf("?");
  if (query < 0) return undefined;
  const values = new URLSearchParams(req.originalUrl.slice(query + 1)).getAll("token");
  if (!values.length) return undefined;
  return values.length === 1 ? { token: values[0] } : {};
};

const refuse = (res: Response): void => {
  res.status(401).set({ "WWW-Authenticate": 'Bearer realm="Local Cognitive"', "Cache-Control": "no-store" }).json(API_TOKEN_REFUSAL);
};

/** Every request needs the key (`Authorization: Bearer <key>` or the cookie `lc_api_<port>`), except
 * `GET`/`HEAD /health` and the browser's link `GET /?token=<key>`, which sets the cookie (HttpOnly,
 * SameSite=Strict) and sends the browser on to `/`, so the key does not stay in the address. Keys are
 * compared by their SHA-256 in constant time; the key is never logged or sent back otherwise. */
export const createLocalApiAuth = ({ token }: { token: string }): RequestHandler => {
  if (!TOKEN_SHAPE.test(token)) throw new Error("The API key must be 32 to 256 base64url characters.");
  const expected = digest(token);
  const matches = (candidate: string | undefined): boolean =>
    typeof candidate === "string" && candidate.length > 0 && candidate.length <= MAX_TOKEN_LENGTH && timingSafeEqual(expected, digest(candidate));
  return (req, res, next) => {
    if ((req.method === "GET" || req.method === "HEAD") && req.path === "/health") { next(); return; }
    const bootstrap = bootstrapToken(req);
    if (bootstrap) {
      if (!matches(bootstrap.token)) { refuse(res); return; }
      res.set({ "Set-Cookie": `${apiTokenCookieName(req.socket.localPort)}=${token}; HttpOnly; SameSite=Strict; Path=/`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      res.redirect(303, "/");
      return;
    }
    if (matches(bearerToken(req.headers.authorization)) || matches(cookieValue(req.headers.cookie, apiTokenCookieName(req.socket.localPort)))) { next(); return; }
    refuse(res);
  };
};

/** Writes the key for its user's commands: whole or not at all, readable only by its owner. */
export const writeApiTokenFile = (file: string, token: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, `${token}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
};

/** The key in the file, or undefined when the file holds none; errors reading it (missing, no
 * permission) are thrown for the caller to explain. */
export const readApiTokenFile = (file: string): string | undefined => {
  const value = fs.readFileSync(file, "utf8").trim();
  return TOKEN_SHAPE.test(value) ? value : undefined;
};

/** Removes the file if it still holds this key (a later runtime's stays). */
export const removeApiTokenFile = (file: string, token: string): void => {
  try { if (readApiTokenFile(file) === token) fs.unlinkSync(file); } catch { /* Already gone. */ }
};
