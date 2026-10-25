import http from "node:http";
import https from "node:https";
import net from "node:net";
import { lookup as dnsLookup } from "node:dns";
import { defaultHooks, hostOf, resolveAndPin, type Hooks } from "../../security/egress";

/** One HTTP request an agent asked for, and one it received. Headers the agent sent that carry a
 * secret (Authorization, Cookie…) are recorded as "set", never their value. */
export interface HttpResult {
  status: number; statusText: string; url: string; redirects: string[];
  headers: Record<string, string>; body: string; truncated: boolean; contentType: string; durationMs: number;
  /** The request as it was sent: a secret header shows as "set", never its value. */
  request: { method: string; url: string; headers: Record<string, string> };
}

/** Performs an agent's HTTP requests against an allowlist the owner declared, never anywhere else. The
 * engine makes the request, not code in a sandbox: only an allowlisted origin, the address resolved and
 * pinned so it cannot change under the request, no private, loopback, link-local or metadata address, a
 * capped body, a timeout, and a budget for the whole run. Nothing it sends carries the app's own
 * credentials; a header the agent sets with a secret is recorded without its value. */
export interface HttpHost {
  request(input: HttpInput, allow: readonly string[], signal?: AbortSignal): Promise<HttpResult>;
}
export interface HttpInput { method: string; url: string; headers?: Record<string, unknown>; body?: string }

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_BODY_CHARS = 200_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_REQUEST_BODY = 1024 * 1024;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
/** Headers a request never carries, whatever the agent sets: the engine owns the hop, and none of the
 * app's own identity rides along. A header with a secret the agent itself sets is kept as "set". */
const SECRET_HEADER = /^(authorization|cookie|proxy-authorization|x-api-key|api-key|x-auth-token)$/i;
const DROPPED_HEADER = /^(host|content-length|connection|transfer-encoding|keep-alive|upgrade|te|trailer|expect)$/i;

// What a request may never reach (this machine, a private network, link-local and metadata addresses)
// and the pinned resolution are shared with the terminal's egress proxy and workflows' web steps.
export { isBlockedAddress, embeddedIpv4, resolveAndPin, defaultHooks, type Hooks, type Pinned } from "../../security/egress";

/** A declared target: its scheme, host, port and, when the pattern has a path, the path it must start
 * with. "https://api.example.com/v1" allows that host's /v1…; "https://staging.example.com" all of it. */
export interface Target { scheme: string; host: string; port: number; prefix: string }
export function parseTarget(pattern: string): Target {
  const url = new URL(pattern);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${pattern}: a target is an https:// (or http://) address.`);
  if (url.username || url.password || url.search || url.hash) throw new Error(`${pattern}: a target has no credentials, query or fragment.`);
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const path = url.pathname.replace(/\/+$/, "");
  return { scheme: url.protocol, host: url.hostname.toLowerCase(), port, prefix: path === "/" ? "" : path };
}
/** Whether one declared target is within another: the same scheme, host and port, and a path at least
 * as specific. Used to check an agent's allowlist is within what the project allows. */
export function targetWithin(inner: Target, outer: Target[]): boolean {
  return outer.some(o => o.scheme === inner.scheme && o.host === inner.host && o.port === inner.port &&
    (!o.prefix || inner.prefix === o.prefix || inner.prefix.startsWith(`${o.prefix}/`)));
}
/** A target as it reads, for a message or to store. */
export function targetLabel(t: Target): string { return `${t.scheme}//${t.host}${t.port === (t.scheme === "https:" ? 443 : 80) ? "" : `:${t.port}`}${t.prefix}`; }

/** Whether a URL is one the allowlist permits: same scheme, host and port, and the path under the
 * target's prefix. A target without a path allows the whole host. */
export function allowed(url: URL, targets: Target[]): boolean {
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const host = url.hostname.toLowerCase(), path = url.pathname;
  return targets.some(target => target.scheme === url.protocol && target.host === host && target.port === port &&
    (!target.prefix || path === target.prefix || path.startsWith(`${target.prefix}/`)));
}

async function once(url: URL, method: string, headers: Record<string, string>, body: string | undefined, signal: AbortSignal, hooks: Hooks): Promise<{ status: number; statusText: string; location?: string; headers: Record<string, string>; body: string; truncated: boolean; contentType: string }> {
  // An IPv6 literal's hostname is "[::1]": without its brackets for the check and the TLS name.
  const literal = net.isIP(hostOf(url));
  // The socket connects to the one address this check passed; a name cannot re-resolve mid-request.
  const { lookup } = await resolveAndPin(url.hostname, hooks);
  const agent = new (url.protocol === "https:" ? https : http).Agent({ lookup: lookup as unknown as typeof dnsLookup });
  const client = url.protocol === "https:" ? https : http;
  return await new Promise((resolve, reject) => {
    const request = client.request(url, { method, headers, agent, signal, servername: literal ? undefined : url.hostname }, response => {
      const status = response.statusCode ?? 0, location = response.headers.location;
      const contentType = String(response.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if ([301, 302, 303, 307, 308].includes(status)) { response.resume(); resolve({ status, statusText: response.statusMessage ?? "", location: typeof location === "string" ? location : undefined, headers: {}, body: "", truncated: false, contentType }); return; }
      const chunks: Buffer[] = []; let bytes = 0, truncated = false;
      response.on("data", (chunk: Buffer) => { if (truncated) return; const room = MAX_BODY_BYTES - bytes; if (chunk.length > room) { chunks.push(chunk.subarray(0, room)); bytes += room; truncated = true; response.destroy(); } else { chunks.push(chunk); bytes += chunk.length; } });
      response.on("end", () => resolve({ status, statusText: response.statusMessage ?? "", headers: headersOf(response.headers), body: Buffer.concat(chunks).toString("utf8").slice(0, MAX_BODY_CHARS), truncated, contentType }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error(`No response in ${REQUEST_TIMEOUT_MS / 1000} s.`)));
    if (body !== undefined) request.write(body);
    request.end();
  });
}
function headersOf(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) if (value !== undefined) out[name] = Array.isArray(value) ? value.join(", ") : String(value);
  return out;
}

/** The web requests left for a whole run. One budget is shared by the engine's client (http.request) and
 * the terminal's egress proxy, so a run draws down one count whichever way it reaches the web. */
export class RequestBudget {
  constructor(private left: number) {}
  get remaining(): number { return this.left; }
  take(): boolean { if (this.left <= 0) return false; this.left--; return true; }
}

/** The engine's HTTP for an agent, with a budget for the whole run: each request is checked against the
 * agent's own allowlist (a subset of what the project allows), resolved, pinned and bounded. */
export class AgentHttpClient implements HttpHost {
  private readonly budget: RequestBudget;
  private readonly hooks: Hooks;
  /** Re-checks, before each request, that the project still allows the agent's targets: turning web
   * access off takes effect at once, instead of in-flight agents keeping it. Throws when it is gone. */
  private readonly consent?: (allow: readonly string[]) => Promise<void>;
  constructor(budget: number | RequestBudget, hooks?: Partial<Hooks>, consent?: (allow: readonly string[]) => Promise<void>) {
    this.budget = typeof budget === "number" ? new RequestBudget(budget) : budget; this.hooks = { ...defaultHooks, ...hooks }; this.consent = consent;
  }
  async request(input: HttpInput, allow: readonly string[], signal?: AbortSignal): Promise<HttpResult> {
    if (this.budget.remaining <= 0) throw new Error("This run has used its budget of agent HTTP requests.");
    await this.consent?.(allow);
    const method = String(input.method ?? "GET").toUpperCase();
    if (!METHODS.has(method)) throw new Error(`method is one of ${[...METHODS].join(", ")}.`);
    const targets = allow.map(parseTarget);
    let url: URL;
    try { url = new URL(String(input.url)); } catch { throw new Error(`${input.url} is not a URL.`); }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) throw new Error("Use an http(s) URL without credentials in it.");
    if (!allowed(url, targets)) throw new Error(`${url.href} is not in this agent's allowed targets (${allow.join(", ")}).`);
    const body = input.body === undefined ? undefined : String(input.body);
    if (body !== undefined && Buffer.byteLength(body) > MAX_REQUEST_BODY) throw new Error(`A request body is at most ${MAX_REQUEST_BODY / 1024} KiB.`);
    const { headers, secret } = cleanHeaders(input.headers);
    const shownHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) shownHeaders[name] = secret.includes(name) ? "set" : value;
    this.budget.take();
    const started = Date.now();
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS * (MAX_REDIRECTS + 1));
    const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const redirects: string[] = [];
    let current = url, sent = { method, body };
    for (let hop = 0; ; hop++) {
      const response = await once(current, sent.method, { ...headers, Host: current.host }, sent.body, merged, this.hooks);
      if (!response.location || ![301, 302, 303, 307, 308].includes(response.status)) {
        return { status: response.status, statusText: response.statusText, url: current.href, redirects,
          headers: scrubResponseHeaders(response.headers), body: response.body, truncated: response.truncated, contentType: response.contentType, durationMs: Date.now() - started,
          request: { method, url: url.href, headers: shownHeaders } };
      }
      if (hop >= MAX_REDIRECTS) throw new Error(`More than ${MAX_REDIRECTS} redirects from ${url.href}.`);
      let next: URL;
      try { next = new URL(response.location, current); } catch { throw new Error(`A redirect to ${response.location} is not a URL.`); }
      if ((next.protocol !== "https:" && next.protocol !== "http:") || !allowed(next, targets)) throw new Error(`A redirect left the allowed targets: ${next.href}. Agents follow redirects only within their allowlist.`);
      redirects.push(next.href);
      // 303, and 301/302 of a POST, continue as GET without the body, as browsers do.
      sent = response.status === 303 || ((response.status === 301 || response.status === 302) && sent.method === "POST") ? { method: "GET", body: undefined } : sent;
      current = next;
    }
  }
}

/** The headers a request carries: the agent's own, without the ones the engine sets or that would leak
 * the app's identity. A header whose name says it holds a secret is kept (the agent set it on purpose)
 * but noted, so the recorded request can show it was set without its value. */
function cleanHeaders(raw: Record<string, unknown> | undefined): { headers: Record<string, string>; secret: string[] } {
  const headers: Record<string, string> = {}, secret: string[] = [];
  for (const [name, value] of Object.entries(raw ?? {})) {
    if (typeof value !== "string" || DROPPED_HEADER.test(name) || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue;
    if (value.length > 4096 || /[\r\n]/.test(value)) continue;
    headers[name] = value;
    if (SECRET_HEADER.test(name)) secret.push(name);
  }
  return { headers, secret };
}
/** A response's headers with any that carries a secret (Set-Cookie…) kept as "set", not its value. */
function scrubResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name] = /^(set-cookie|authorization|proxy-authenticate|www-authenticate)$/i.test(name) ? "set" : value;
  return out;
}
export { cleanHeaders as cleanRequestHeaders };
