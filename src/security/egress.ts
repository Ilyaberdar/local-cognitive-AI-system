import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import zlib from "node:zlib";
import dns from "node:dns/promises";
import { lookup as dnsLookup } from "node:dns";
import type { Readable } from "node:stream";

/** Requests the app makes to an address that a model, a workflow or a device may have chosen: what
 * they may never reach (this machine, a private network, link-local and cloud metadata addresses),
 * checked on every address a name resolves to and on every redirect, with the connection pinned to
 * the address that passed. Shared by agents' HTTP (synthesis/agents/AgentHttp.ts), their terminals'
 * egress proxy, and a workflow's Read webpage step. */

/** Private, loopback, link-local, metadata, multicast and reserved ranges. */
const blocked = new net.BlockList();
for (const [net4, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as [string, number][]) blocked.addSubnet(net4, bits, "ipv4");
// Besides the unspecified, loopback, unique-local, link-local, multicast and documentation ranges: the
// old site-local fec0::/10, the discard-only 100::/64, Teredo 2001::/32 (it hides an IPv4 behind a
// relay) and the local-use NAT64 prefix 64:ff9b:1::/48 (RFC 8215), which a network may map anywhere.
for (const [net6, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["2001:db8::", 32],
  ["100::", 64], ["2001::", 32], ["64:ff9b:1::", 48]] as [string, number][]) blocked.addSubnet(net6, bits, "ipv6");
// IPv4-mapped (::ffff:0:0/96) is not added as a subnet: net.BlockList.check cross-matches every IPv4 input
// against it, which would block all IPv4. Embedded-IPv4 forms are decoded and checked as IPv4 instead.

/** Never reached, whatever was approved: link-local addresses (where clouds serve their instance
 * metadata, credentials among it) and the metadata services elsewhere (AWS's IPv6 one, Alibaba's). */
const metadata = new net.BlockList();
metadata.addSubnet("169.254.0.0", 16, "ipv4");
metadata.addAddress("100.100.100.200", "ipv4");
metadata.addSubnet("fe80::", 10, "ipv6");
metadata.addAddress("fd00:ec2::254", "ipv6");

/** A URL's host as net and dns take it: an IPv6 literal without its brackets ("[::1]" → "::1"). */
export const hostOf = (url: URL | string): string => {
  const host = typeof url === "string" ? url : url.hostname;
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
};

/** The IPv4 an IPv6 address embeds, if any — IPv4-mapped (::ffff:a.b.c.d / ::ffff:HHHH:HHHH), -compatible
 * (::a.b.c.d), 6to4 (2002:V4::) and the well-known NAT64 prefix (64:ff9b::/96) — as dotted decimal. These
 * route to the embedded IPv4, so a hex form such as ::ffff:7f00:1 (127.0.0.1) must be checked as that
 * IPv4. The local-use NAT64 prefix 64:ff9b:1::/48 is blocked as a whole instead (its mapping is the
 * network's own). */
export function embeddedIpv4(address: string): string | undefined {
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
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) return v4(h[6]!, h[7]!); // NAT64 64:ff9b::/96
  return undefined;
}

const inList = (list: net.BlockList, address: string): boolean => {
  const bare = hostOf(address);
  const v4 = net.isIPv6(bare) ? embeddedIpv4(bare) : bare;
  if (v4 && net.isIPv4(v4)) return list.check(v4, "ipv4");
  return net.isIPv6(bare) && list.check(bare, "ipv6");
};

/** Whether an address is one agents and fetched pages may never reach unasked: this machine, a private
 * network, link-local, metadata, multicast or reserved. Anything that is not an IP address is too. */
export function isBlockedAddress(address: string): boolean {
  return !net.isIP(hostOf(address)) || inList(blocked, address);
}

/** A link-local or cloud metadata address: never reached, approved or not. */
export function isMetadataAddress(address: string): boolean { return inList(metadata, address); }

/** This machine whatever its interfaces: loopback and the unspecified address (which connects to it). */
const loopback = new net.BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addSubnet("0.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");
loopback.addAddress("::", "ipv6");

/** Whether an address is this machine: loopback, unspecified, or one of its interfaces' addresses. */
export function isOwnAddress(address: string): boolean {
  if (inList(loopback, address)) return true;
  const bare = hostOf(address).split("%")[0]!;
  const v4 = net.isIPv6(bare) ? embeddedIpv4(bare) ?? bare : bare;
  try {
    for (const items of Object.values(os.networkInterfaces())) for (const item of items ?? []) if (item.address.split("%")[0] === v4) return true;
  } catch { /* Unknown interfaces: loopback is checked above. */ }
  return false;
}

/** How a request's name is resolved and its addresses judged; tests replace them to reach a server
 * on this machine. */
export interface Hooks { resolve(host: string): Promise<{ address: string; family: number }[]>; blocked(address: string): boolean }
// This machine's own addresses count as private even when public (a server's address on its interface):
// a request from here to one reaches services a firewall keeps from the internet.
export const defaultHooks: Hooks = { resolve: host => dns.lookup(host, { all: true }), blocked: address => isBlockedAddress(address) || isOwnAddress(address) };

/** A name resolved to the one address a connection is pinned to, with a `lookup` that always returns it:
 * every address the name gives must pass the block check, and the first is pinned, so the socket connects
 * to exactly what was checked. Shared by the engine's client and the terminal's egress proxy. */
export interface Pinned { address: string; family: 4 | 6; lookup: (hostname: string, options: { all?: boolean } | undefined, callback: (...args: unknown[]) => void) => void }
const pin = (record: { address: string; family: number }): Pinned => {
  const family = record.family === 6 || net.isIPv6(record.address) ? 6 : 4;
  const lookup = (_hostname: string, options: { all?: boolean } | undefined, callback: (...args: unknown[]) => void) => {
    if (options && typeof options === "object" && options.all) callback(null, [{ address: record.address, family }]);
    else callback(null, record.address, family);
  };
  return { address: record.address, family, lookup };
};
const resolveAll = async (hostname: string, hooks: Pick<Hooks, "resolve">): Promise<{ address: string; family: number }[]> => {
  const host = hostOf(hostname), family = net.isIP(host);
  const records = family ? [{ address: host, family }] : await hooks.resolve(host);
  if (!records.length) throw new Error(`${host} did not resolve.`);
  return records;
};
export async function resolveAndPin(hostname: string, hooks: Hooks): Promise<Pinned> {
  const records = await resolveAll(hostname, hooks);
  // Every address a name gives must be allowed: one blocked address among them is refused, so a name
  // cannot mix an allowed and a blocked answer.
  for (const record of records) if (hooks.blocked(record.address)) throw new Error(`${hostOf(hostname)} resolves to ${record.address}, a private, loopback, link-local or metadata address agents may not reach.`);
  return pin(records[0]!);
}

/** A request refused before it was sent: what it says is shown as is. */
export class EgressRefusedError extends Error {}

export interface GuardedGetOptions {
  /** Sent to the first origin only: a redirect to another origin carries none of them. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** The most bytes of the body kept (after decompression); the rest is cut off. Default 1 MB. */
  maxBytes?: number;
  /** Default 5. */
  maxRedirects?: number;
  /** Each hop's limit. Default 30 s. */
  timeoutMs?: number;
  /** The exact origin (scheme://host:port) the user named — the URL they approved, or one written in
   * the step itself: a private address is reached there, and only while every hop stays on it. */
  allowPrivateOrigin?: string;
  /** The app's own API port: this machine at that port is never reached, approved or not. */
  ownPort?: number;
  hooks?: Partial<Hooks>;
  /** Called before each hop (progress). */
  onHop?: (url: URL) => void;
  /** Whether the body of a final answer is wanted (by its status and content type): without, it is not read. */
  accept?: (status: number, contentType: string) => boolean;
  /** The addresses the first origin had when the user approved it: its hops connect to these, without
   * a new lookup, so a name that changes after the prompt (DNS rebinding) cannot lead elsewhere. */
  approvedAddresses?: string[];
  /** What a private address at the first origin is refused with, when no private origin is allowed
   * (an address approved as public that now points to this computer or the network). */
  privateRefusal?: string;
}

export interface GuardedResponse {
  status: number; statusText: string;
  /** Where the answer came from, after redirects. */
  url: string;
  redirects: string[];
  headers: Record<string, string>;
  contentType: string;
  body: Buffer;
  truncated: boolean;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const portOf = (url: URL) => Number(url.port || (url.protocol === "https:" ? 443 : 80));

function checkedUrl(input: string | URL): URL {
  let url: URL;
  try { url = new URL(String(input)); } catch { throw new EgressRefusedError(`${String(input)} is not an address.`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new EgressRefusedError("Only http(s) addresses are read.");
  if (url.username || url.password) throw new EgressRefusedError("An address with a user name or password in it is not read.");
  return url;
}

/** The addresses of one hop, judged: the always-refused ones first, then private ones only at the
 * origin the user named, and never after a public hop. */
async function judge(url: URL, hop: number, state: { hooks: Hooks; privateOrigin?: string; ownPort?: number; reachedPublic: boolean; startOrigin: string; approvedAddresses?: string[]; privateRefusal?: string }): Promise<{ pinned: Pinned; private: boolean }> {
  const approved = url.origin === state.startOrigin && state.approvedAddresses?.length ? state.approvedAddresses : undefined;
  const records = approved ? approved.map(address => ({ address, family: net.isIPv6(address) ? 6 : 4 })) : await resolveAll(url.hostname, state.hooks);
  const port = portOf(url);
  for (const record of records) {
    if (isMetadataAddress(record.address)) throw new EgressRefusedError(`${url.host} is a link-local or cloud metadata address, which is never read.`);
    if (state.ownPort !== undefined && port === state.ownPort && isOwnAddress(record.address)) throw new EgressRefusedError(`${url.host} is this app's own address, which is never read.`);
  }
  const privates = records.filter(record => state.hooks.blocked(record.address)).length;
  if (privates && privates < records.length) throw new EgressRefusedError(`${hostOf(url)} resolves to both public and private addresses, so it is not read.`);
  if (privates) {
    const where = "on this computer or the local network";
    if (hop > 0 && state.reachedPublic) throw new EgressRefusedError(`A redirect from a public address to ${url.origin}, ${where}, was not followed.`);
    if (url.origin !== state.privateOrigin) {
      if (url.origin === state.startOrigin && state.privateRefusal) throw new EgressRefusedError(state.privateRefusal);
      throw new EgressRefusedError(hop > 0 ? `A redirect to ${url.origin}, ${where}, was not followed: redirects go only to public addresses, or within the address you named.`
        : `${url.origin} is ${where}. Such an address is read only when you approve it, or when the step names it itself.`);
    }
  }
  return { pinned: pin(records[0]!), private: privates > 0 };
}

interface Hop { status: number; statusText: string; location?: string; headers: Record<string, string>; contentType: string; body: Buffer; truncated: boolean }

function decoded(response: http.IncomingMessage): Readable {
  const encoding = String(response.headers["content-encoding"] ?? "").trim().toLowerCase();
  if (!encoding || encoding === "identity") return response;
  if (encoding === "gzip" || encoding === "x-gzip") return response.pipe(zlib.createGunzip());
  if (encoding === "deflate") return response.pipe(zlib.createInflate());
  if (encoding === "br") return response.pipe(zlib.createBrotliDecompress());
  throw new Error(`The answer is encoded as ${encoding.slice(0, 40)}, which is not read.`);
}

function once(url: URL, headers: Record<string, string>, pinned: Pinned, options: { signal?: AbortSignal; timeoutMs: number; maxBytes: number; accept?: GuardedGetOptions["accept"] }): Promise<Hop> {
  const client = url.protocol === "https:" ? https : http;
  const agent = new client.Agent({ lookup: pinned.lookup as unknown as typeof dnsLookup });
  const host = hostOf(url);
  return new Promise<Hop>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | undefined, hop?: Hop) => { if (settled) return; settled = true; agent.destroy(); if (error) reject(error); else resolve(hop!); };
    const request = client.request(url, { method: "GET", headers, agent, signal: options.signal, servername: net.isIP(host) ? undefined : host }, response => {
      const status = response.statusCode ?? 0, statusText = response.statusMessage ?? "";
      const all: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) all[name] = Array.isArray(value) ? value.join(", ") : String(value);
      const contentType = String(response.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      const location = typeof response.headers.location === "string" ? response.headers.location : undefined;
      const empty = { status, statusText, headers: all, contentType, body: Buffer.alloc(0), truncated: false };
      if ((REDIRECTS.has(status) && location) || (options.accept && !options.accept(status, contentType))) {
        response.destroy(); finish(undefined, { ...empty, location: REDIRECTS.has(status) ? location : undefined }); return;
      }
      let body: Readable;
      try { body = decoded(response); } catch (error) { response.destroy(); finish(error as Error); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      body.on("data", (chunk: Buffer) => {
        if (settled) return;
        const room = options.maxBytes - bytes;
        if (chunk.length > room) {
          chunks.push(chunk.subarray(0, room)); bytes += room;
          // A body (or a decompressed one) past the limit is cut off here: nothing more is read.
          finish(undefined, { ...empty, body: Buffer.concat(chunks), truncated: true });
          response.destroy(); if (body !== response) body.destroy();
          return;
        }
        chunks.push(chunk); bytes += chunk.length;
      });
      body.on("end", () => finish(undefined, { ...empty, body: Buffer.concat(chunks) }));
      body.on("error", error => finish(new Error(`The answer could not be read: ${error.message}`)));
      response.on("error", error => finish(error));
    });
    request.on("error", error => finish(error));
    request.setTimeout(options.timeoutMs, () => request.destroy(new Error(`No answer in ${Math.round(options.timeoutMs / 1000)} s.`)));
    request.end();
  });
}

/** A GET to an address that may come from a model, a workflow or a device: http(s) only, no
 * credentials in it; every hop's name resolved and each of its addresses checked, the connection
 * pinned to the first; a private address only at `allowPrivateOrigin` and never after a public hop;
 * link-local, metadata and the app's own API never; the caller's headers to the first origin only;
 * the body capped after decompression. Redirects are followed by hand and listed. */
export async function guardedGet(input: string | URL, options: GuardedGetOptions = {}): Promise<GuardedResponse> {
  const hooks: Hooks = { ...defaultHooks, ...options.hooks };
  const maxRedirects = options.maxRedirects ?? 5, maxBytes = options.maxBytes ?? 1_000_000, timeoutMs = options.timeoutMs ?? 30_000;
  const start = checkedUrl(input);
  let privateOrigin: string | undefined;
  if (options.allowPrivateOrigin) { try { privateOrigin = new URL(options.allowPrivateOrigin).origin; } catch { /* None. */ } }
  // Only addresses: anything else in an approval is ignored, and the name is looked up as usual.
  const approvedAddresses = options.approvedAddresses?.map(hostOf).filter(address => net.isIP(address));
  const state = { hooks, privateOrigin, ownPort: options.ownPort, reachedPublic: false, startOrigin: start.origin, approvedAddresses, privateRefusal: options.privateRefusal };
  const redirects: string[] = [];
  let current = start;
  for (let hop = 0; ; hop++) {
    options.signal?.throwIfAborted();
    options.onHop?.(current);
    const judged = await judge(current, hop, state);
    if (!judged.private) state.reachedPublic = true;
    const headers: Record<string, string> = { ...(current.origin === start.origin ? options.headers : {}), "Accept-Encoding": "gzip, deflate, br" };
    const answer = await once(current, headers, judged.pinned, { signal: options.signal, timeoutMs, maxBytes, accept: options.accept });
    if (answer.location === undefined) {
      return { status: answer.status, statusText: answer.statusText, url: current.href, redirects, headers: answer.headers, contentType: answer.contentType, body: answer.body, truncated: answer.truncated };
    }
    if (hop >= maxRedirects) throw new EgressRefusedError(`The redirect limit (${maxRedirects}) was reached from ${start.href}.`);
    let next: URL;
    try { next = new URL(answer.location, current); } catch { throw new EgressRefusedError("A redirect named something that is not an address."); }
    current = checkedUrl(next);
    redirects.push(current.href);
  }
}

export type AddressPlace = "this computer" | "the local network";

/** Where an address is, for a prompt that asks to read it, and the addresses its name gives now (kept
 * with the approval and connected to): on this computer, on the local network, or neither (public, or
 * a name that does not resolve now, with no addresses). Never throws. */
export async function describeAddress(url: URL, hooks: Partial<Hooks> = {}): Promise<{ place?: AddressPlace; addresses: string[] }> {
  const checks = { ...defaultHooks, ...hooks };
  let records: { address: string }[];
  try { records = await resolveAll(url.hostname, checks); } catch { return { addresses: [] }; }
  const addresses = [...new Set(records.map(record => record.address))];
  const private_ = records.filter(record => checks.blocked(record.address));
  if (!private_.length) return { addresses };
  return { place: private_.some(record => isOwnAddress(record.address)) ? "this computer" : "the local network", addresses };
}

/** Where an address is (describeAddress without the addresses). */
export async function addressPlace(url: URL, hooks: Partial<Hooks> = {}): Promise<AddressPlace | undefined> {
  return (await describeAddress(url, hooks)).place;
}
