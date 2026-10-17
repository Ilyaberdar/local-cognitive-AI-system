import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns/promises";
import { lookup as dnsLookup } from "node:dns";

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

/** The addresses an agent's request may never reach: its own machine, a private network, a link-local
 * or a cloud metadata service. Checked on every address a name resolves to, and on every redirect. */
const blocked = new net.BlockList();
for (const [net4, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as [string, number][]) blocked.addSubnet(net4, bits, "ipv4");
for (const [net6, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32]] as [string, number][]) blocked.addSubnet(net6, bits, "ipv6");
// IPv4-mapped (::ffff:0:0/96) is not added as a subnet: net.BlockList.check cross-matches every IPv4 input
// against it, which would block all IPv4. Embedded-IPv4 forms are decoded and checked as IPv4 instead.

/** The IPv4 an IPv6 address embeds, if any — IPv4-mapped (::ffff:a.b.c.d / ::ffff:HHHH:HHHH), -compatible
 * (::a.b.c.d), 6to4 (2002:V4::) and NAT64 (64:ff9b::V4, 64:ff9b:1::V4) — as dotted decimal. These route
 * to the embedded IPv4, so a hex form such as ::ffff:7f00:1 (127.0.0.1) must be checked as that IPv4. */
function embeddedIpv4(address: string): string | undefined {
  if (!net.isIPv6(address)) return undefined;
  const parts = address.split("%")[0]!.split("::");
  if (parts.length > 2) return undefined;
  const head = parts[0] ? parts[0].split(":") : [], tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  // A trailing a.b.c.d counts as two hextets; expand :: to eight groups in all.
  const expand = (groups: string[]): number[] => groups.flatMap(group => {
    const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(group);
    if (dotted) { const b = dotted.slice(1).map(Number); return [(b[0]! << 8) | b[1]!, (b[2]! << 8) | b[3]!]; }
    return [parseInt(group, 16)];
  });
  let h: number[];
  try { const h0 = expand(head), h1 = expand(tail); h = parts.length === 2 ? [...h0, ...Array(8 - h0.length - h1.length).fill(0), ...h1] : h0; }
  catch { return undefined; }
  if (h.length !== 8 || h.some(group => !Number.isInteger(group) || group < 0 || group > 0xffff)) return undefined;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && (h[5] === 0xffff || h[5] === 0)) {
    if (h[6] === 0 && (h[7] === 0 || h[7] === 1)) return undefined; // :: and ::1 are plain IPv6, handled above.
    return v4(h[6]!, h[7]!);
  }
  if (h[0] === 0x2002) return v4(h[1]!, h[2]!); // 6to4
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && ((h[4] === 0 && h[5] === 0) || true)) return v4(h[6]!, h[7]!); // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
  return undefined;
}
export function isBlockedAddress(address: string): boolean {
  if (!net.isIP(address)) return true;
  const v4 = net.isIPv6(address) ? embeddedIpv4(address) : address;
  if (v4 && net.isIPv4(v4)) return blocked.check(v4, "ipv4");
  return net.isIPv6(address) ? blocked.check(address, "ipv6") : blocked.check(address, "ipv4");
}

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

/** One request, with the address resolved and pinned so that the socket connects to exactly the address
 * this check passed: a name cannot resolve to an allowed address here and a blocked one at connect time. */
export interface Hooks { resolve(host: string): Promise<{ address: string; family: number }[]>; blocked(address: string): boolean }
export const defaultHooks: Hooks = { resolve: host => dns.lookup(host, { all: true }), blocked: isBlockedAddress };

/** A name resolved to the one address a connection is pinned to, with a `lookup` that always returns it:
 * every address the name gives must pass the block check, and the first is pinned, so the socket connects
 * to exactly what was checked. Shared by the engine's client and the terminal's egress proxy. */
export interface Pinned { address: string; family: 4 | 6; lookup: (hostname: string, options: { all?: boolean } | undefined, callback: (...args: unknown[]) => void) => void }
export async function resolveAndPin(hostname: string, hooks: Hooks): Promise<Pinned> {
  const family = net.isIP(hostname);
  const records = family ? [{ address: hostname, family: family as 4 | 6 }] : await hooks.resolve(hostname);
  if (!records.length) throw new Error(`${hostname} did not resolve.`);
  // Every address a name gives must be allowed: one blocked address among them is refused, so a name
  // cannot mix an allowed and a blocked answer.
  for (const record of records) if (hooks.blocked(record.address)) throw new Error(`${hostname} resolves to ${record.address}, a private, loopback, link-local or metadata address agents may not reach.`);
  const pinned = records[0]!; const pinnedFamily = pinned.family === 6 || net.isIPv6(pinned.address) ? 6 : 4;
  const lookup = (_hostname: string, options: { all?: boolean } | undefined, callback: (...args: unknown[]) => void) => {
    if (options && typeof options === "object" && options.all) callback(null, [{ address: pinned.address, family: pinnedFamily }]);
    else callback(null, pinned.address, pinnedFamily);
  };
  return { address: pinned.address, family: pinnedFamily, lookup };
}

async function once(url: URL, method: string, headers: Record<string, string>, body: string | undefined, signal: AbortSignal, hooks: Hooks): Promise<{ status: number; statusText: string; location?: string; headers: Record<string, string>; body: string; truncated: boolean; contentType: string }> {
  const literal = net.isIP(url.hostname);
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
