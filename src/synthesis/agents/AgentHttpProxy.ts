import http from "node:http";
import net from "node:net";
import { allowed, defaultHooks, parseTarget, resolveAndPin, type Hooks, type RequestBudget, type Target } from "./AgentHttp";

/** A loopback HTTP(S) proxy a sandboxed terminal is pointed at, so a real tool (curl, a scanner) reaches
 * only the web targets the agent's allowlist permits — the same allowlist, owner consent and run budget
 * as http.request, enforced here because the sandbox's one way out is this proxy. A plain HTTP request is
 * checked in full (scheme, host, port and path prefix); an HTTPS request arrives as CONNECT, whose path
 * the proxy cannot see, so https is allowed by host and port only (the connection is tunnelled, never
 * decrypted). Every target is resolved, block-checked and pinned, so a name cannot rebind to a private
 * address through the proxy. Nothing of the app's own identity is added; the tool sends its own headers. */
export interface EgressProxy { url: string; endpoint: { host: string; port: number }; close(): Promise<void> }
export interface EgressOptions {
  /** The agent's web targets (a subset of what the project allows). */
  allow: readonly string[];
  /** The run's shared request budget (the same object http.request draws down). */
  budget: RequestBudget;
  /** Re-checked before each request: throws when the owner has turned the targets off mid-run. */
  consent?: (allow: readonly string[]) => Promise<void>;
  /** Test seam: resolve a name and decide a blocked address, as for the engine's client. */
  hooks?: Partial<Hooks>;
}

/** Headers the proxy never forwards: the hop's own, and any that would carry proxy credentials onward. */
const HOP_BY_HOP = /^(proxy-connection|connection|keep-alive|transfer-encoding|te|trailer|upgrade|proxy-authorization|proxy-authenticate)$/i;
const CONNECT_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 120_000;

export async function createEgressProxy(options: EgressOptions): Promise<EgressProxy> {
  const targets: Target[] = options.allow.map(parseTarget);
  const hooks: Hooks = { ...defaultHooks, ...options.hooks };
  const { allow, budget, consent } = options;

  /** Shared by plain requests and CONNECT: the owner still consents, and the run has budget left.
   * Returns a reason to refuse, or undefined to let it through. Budget is spent only on an allowed hop. */
  const gate = async (): Promise<string | undefined> => {
    try { await consent?.(allow); } catch (error) { return error instanceof Error ? error.message : String(error); }
    return budget.take() ? undefined : "This run has used its budget of agent HTTP requests.";
  };

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
    const upstream = http.request({ host: url.hostname, port: url.port ? Number(url.port) : 80, method: req.method, path: url.pathname + url.search, headers, lookup: lookup as never }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy(new Error("No response in time.")));
    upstream.on("error", () => { if (res.headersSent) res.destroy(); else deny(502, "The upstream request failed."); });
    req.pipe(upstream);
  }

  async function handleConnect(req: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
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
    upstream.on("error", () => end("502 Bad Gateway"));
    socket.on("error", () => upstream.destroy());
  }

  const server = http.createServer();
  server.on("request", (req, res) => void handleRequest(req, res));
  server.on("connect", (req, socket, head) => void handleConnect(req, socket as net.Socket, head));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    endpoint: { host: "127.0.0.1", port },
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  };
}
