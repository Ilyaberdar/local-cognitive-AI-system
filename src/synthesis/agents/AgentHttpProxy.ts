import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { allowed, defaultHooks, parseTarget, resolveAndPin, type Hooks, type RequestBudget, type Target } from "./AgentHttp";

/** An HTTP(S) proxy a sandboxed terminal is pointed at (a loopback port, or on Linux a UNIX socket), so a real tool (curl, a scanner) reaches
 * only the web targets the agent's allowlist permits — the same allowlist, owner consent and run budget
 * as http.request, enforced here because the sandbox's one way out is this proxy. A plain HTTP request is
 * checked in full (scheme, host, port and path prefix); an HTTPS request arrives as CONNECT, whose path
 * the proxy cannot see, so https is allowed by host and port only (the connection is tunnelled, never
 * decrypted). Every target is resolved, block-checked and pinned, so a name cannot rebind to a private
 * address through the proxy. Nothing of the app's own identity is added; the tool sends its own headers. */
export interface EgressProxy { url: string; endpoint: { host: string; port: number; socketPath?: string }; close(): Promise<void> }
/** The longest UNIX socket path every platform takes (sun_path is 104 or 108 bytes). */
const MAX_SOCKET_PATH = 100;
/** A command could otherwise open connections without end (each a descriptor in the engine's process)
 * and starve every run: a few at once, and one that sends nothing is closed soon. */
const MAX_CONNECTIONS = 64, SILENT_MS = 10_000;
export interface EgressOptions {
  /** The agent's web targets (a subset of what the project allows). */
  allow: readonly string[];
  /** The run's shared request budget (the same object http.request draws down). */
  budget: RequestBudget;
  /** Re-checked before each request: throws when the owner has turned the targets off mid-run. */
  consent?: (allow: readonly string[]) => Promise<void>;
  /** Test seam: resolve a name and decide a blocked address, as for the engine's client. */
  hooks?: Partial<Hooks>;
  /** How often an open tunnel re-asks consent (default 15 s); a test seam to exercise the teardown. */
  recheckMs?: number;
  /** Listen on a UNIX socket (proxy.sock, alone in a new folder only this user may open) instead of a
   * loopback port: a Linux sandbox has a network of its own with nothing in it, and reaches the proxy
   * only through this socket. Its folder is bound into the sandbox read-only, so the socket cannot be
   * replaced; a command may still connect to it directly, which reaches the same proxy. */
  unix?: boolean;
  /** How long a connection may stay silent before its request (default 10 s); a test seam. */
  silentMs?: number;
}

/** Headers the proxy never forwards: the hop's own, and any that would carry proxy credentials onward. */
const HOP_BY_HOP = /^(proxy-connection|connection|keep-alive|transfer-encoding|te|trailer|upgrade|proxy-authorization|proxy-authenticate)$/i;
const CONNECT_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 120_000;
/** How often an open CONNECT tunnel re-asks consent: the proxy cannot see inside TLS, so it cannot
 * re-check each request; instead it tears the tunnel down this soon after the owner revokes a target. */
const CONSENT_RECHECK_MS = 15_000;

export async function createEgressProxy(options: EgressOptions): Promise<EgressProxy> {
  const targets: Target[] = options.allow.map(parseTarget);
  const hooks: Hooks = { ...defaultHooks, ...options.hooks };
  const { allow, budget, consent } = options;

  /** Shared by plain requests and CONNECT: the owner still consents, and the run has budget left.
   * Returns a reason to refuse, or undefined to let it through. Budget is spent only on an allowed hop. */
  const gate = async (): Promise<string | undefined> => {
    // A spent budget answers at once, without asking the project again.
    if (budget.remaining <= 0) return "This run has used its budget of agent HTTP requests.";
    try { await consent?.(allow); } catch (error) { return error instanceof Error ? error.message : String(error); }
    return budget.take() ? undefined : "This run has used its budget of agent HTTP requests.";
  };

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    req.socket.setTimeout(0);
    const deny = (status: number, message: string) => { res.writeHead(status, { "content-type": "text/plain" }); res.end(message); };
    let url: URL;
    try { url = new URL(req.url ?? ""); } catch { deny(400, "A proxied request uses an absolute URL."); return; }
    if (url.protocol !== "http:") { deny(400, "Only http:// is proxied in request form; https goes through CONNECT."); return; }
    if (!allowed(url, targets)) { deny(403, `${url.href} is not in this agent's allowed targets (${allow.join(", ")}).`); return; }
    const refusal = await gate();
    if (refusal) { deny(403, refusal); return; }
    let lookup;
    try { ({ lookup } = await resolveAndPin(url.hostname, hooks)); } catch (error) { deny(502, error instanceof Error ? error.message : String(error)); return; }
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined && !HOP_BY_HOP.test(name)) headers[name] = value;
    // The Host header is pinned to the allowlisted authority, never the tool's: a shared front-end IP
    // routes by Host, so a forged Host could otherwise reach a vhost off the allowlist on an allowed IP.
    headers.host = url.host;
    const upstream = http.request({ host: url.hostname, port: url.port ? Number(url.port) : 80, method: req.method, path: url.pathname + url.search, headers, lookup: lookup as never }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy(new Error("No response in time.")));
    upstream.on("error", () => { if (res.headersSent) res.destroy(); else deny(502, "The upstream request failed."); });
    // A client that drops mid-request must not throw past this handler and end the engine's process.
    req.on("error", () => upstream.destroy());
    res.on("error", () => upstream.destroy());
    req.pipe(upstream);
  }

  async function handleConnect(req: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    // Attached before any await: a reset while the gate or resolve runs must not throw past this handler.
    socket.on("error", () => socket.destroy());
    socket.setTimeout(0);
    const end = (line: string) => { try { socket.write(`HTTP/1.1 ${line}\r\n\r\n`); } catch { /* the client is gone */ } socket.destroy(); };
    const match = /^([^:]+):(\d+)$/.exec(req.url ?? "");
    const host = match?.[1], port = Number(match?.[2]);
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) { end("400 Bad Request"); return; }
    // CONNECT hides the path: https is allowed by host and port (the path prefix cannot be checked here).
    if (!targets.some(target => target.scheme === "https:" && target.host === host.toLowerCase() && target.port === port)) { end("403 Forbidden"); return; }
    const refusal = await gate();
    if (refusal) { end("403 Forbidden"); return; }
    let address: string;
    try { ({ address } = await resolveAndPin(host, hooks)); } catch { end("502 Bad Gateway"); return; }
    const upstream = net.connect({ host: address, port }, () => {
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy());
    // A tunnel is opaque, so consent cannot be re-checked per request; instead it is re-asked on a timer
    // and the tunnel is torn down when the owner has revoked the target (or the socket closes either way).
    let recheck: ReturnType<typeof setInterval> | undefined;
    const teardown = () => { if (recheck) { clearInterval(recheck); recheck = undefined; } upstream.destroy(); socket.destroy(); };
    recheck = consent ? setInterval(() => void consent(allow).catch(teardown), options.recheckMs ?? CONSENT_RECHECK_MS) : undefined;
    recheck?.unref?.();
    upstream.on("error", () => teardown());
    upstream.on("close", () => teardown());
    socket.on("close", () => teardown());
  }

  const server = http.createServer();
  server.on("request", (req, res) => void handleRequest(req, res));
  server.on("connect", (req, socket, head) => void handleConnect(req, socket as net.Socket, head));
  // A malformed request from a tool closes its own socket, never the engine's process.
  server.on("clientError", (_error, socket) => { try { socket.destroy(); } catch { /* already gone */ } });
  server.maxConnections = MAX_CONNECTIONS;
  server.headersTimeout = Math.max(options.silentMs ?? SILENT_MS, 1000);
  server.keepAliveTimeout = 5_000;
  // Until its request (or CONNECT) begins; the handlers then clear it and the upstream's own timeouts apply.
  server.on("connection", socket => socket.setTimeout(options.silentMs ?? SILENT_MS, () => socket.destroy()));
  if (options.unix) {
    // mkdtemp makes the folder 0700: only this user (the server's) may connect to the socket in it.
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "lce-"));
    const socketPath = path.join(folder, "proxy.sock");
    try {
      if (Buffer.byteLength(socketPath) >= MAX_SOCKET_PATH) throw new Error(`The egress proxy's socket path is too long (${socketPath}).`);
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
      await fs.chmod(socketPath, 0o600);
    } catch (error) {
      server.close();
      await fs.rm(folder, { recursive: true, force: true });
      throw error;
    }
    return {
      url: `unix:${socketPath}`,
      endpoint: { host: "127.0.0.1", port: 0, socketPath },
      close: () => new Promise<void>(resolve => server.close(() => resolve())).then(() => fs.rm(folder, { recursive: true, force: true }))
    };
  }
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    endpoint: { host: "127.0.0.1", port },
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  };
}
