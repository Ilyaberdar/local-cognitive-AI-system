import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { AddressInfo } from "node:net";
import { RequestBudget } from "../src/synthesis/agents/AgentHttp";
import { createEgressProxy, EgressOptions } from "../src/synthesis/agents/AgentHttpProxy";

/** A resolver that sends any name to the loopback test server and lets it through: the proxy's own
 * allowlist, consent and budget are what each test exercises, not the address guard (its own test). */
const toLoopback = { resolve: async () => [{ address: "127.0.0.1", family: 4 }], blocked: () => false };

/** An upstream HTTP server on loopback; it records the last request so passthrough can be checked. */
async function upstream(): Promise<{ port: number; last: { url?: string; method?: string; auth?: string; host?: string; body?: string }; close: () => Promise<void> }> {
  const last: { url?: string; method?: string; auth?: string; host?: string; body?: string } = {};
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on("data", c => chunks.push(c)); req.on("end", () => {
      last.url = req.url; last.method = req.method; last.auth = req.headers.authorization; last.host = req.headers.host; last.body = Buffer.concat(chunks).toString();
      res.end("ARRIVED");
    });
  });
  await new Promise<void>(resolve => srv.listen(0, "127.0.0.1", resolve));
  return { port: (srv.address() as AddressInfo).port, last, close: () => new Promise(resolve => srv.close(() => resolve())) };
}

/** A proxied plain-HTTP request: an absolute-form request line to the proxy, as a tool with HTTP_PROXY sends. */
function proxied(proxyPort: number, input: { method?: string; url: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(input.url);
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method: input.method ?? "GET", path: input.url, headers: { host: target.host, ...input.headers } }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    if (input.body !== undefined) req.write(input.body);
    req.end();
  });
}

/** A CONNECT to the proxy: resolves with the status line's code and, on success, the tunnel socket. */
function connect(proxyPort: number, hostPort: string): Promise<{ status: number; socket?: net.Socket }> {
  return new Promise(resolve => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: hostPort });
    let done = false;
    const finish = (value: { status: number; socket?: net.Socket }) => { if (!done) { done = true; resolve(value); } };
    req.on("connect", (res, socket) => finish({ status: res.statusCode ?? 0, socket }));
    req.on("response", res => { res.resume(); finish({ status: res.statusCode ?? 0 }); });
    req.on("error", () => finish({ status: 0 }));
    req.end();
  });
}

async function proxy(options: Partial<EgressOptions> & { allow: readonly string[] }): Promise<ReturnType<typeof createEgressProxy> extends Promise<infer T> ? T : never> {
  return createEgressProxy({ budget: new RequestBudget(100), hooks: toLoopback, ...options });
}

test("a plain request is forwarded only to an allowlisted origin and path; the tool's own headers go through unchanged", async () => {
  const up = await upstream();
  const p = await proxy({ allow: [`http://local.test:${up.port}/v1`] });
  try {
    const ok = await proxied(p.endpoint.port, { method: "POST", url: `http://local.test:${up.port}/v1/scan`, headers: { authorization: "Bearer token", "x-trace": "abc" }, body: '{"a":1}' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body, "ARRIVED");
    assert.equal(up.last.url, "/v1/scan");
    assert.equal(up.last.method, "POST");
    assert.equal(up.last.body, '{"a":1}');
    // Unlike http.request, a real tool's bytes pass through as sent (the tool, not the app, owns the hop).
    assert.equal(up.last.auth, "Bearer token", "the tool's own Authorization reaches the target");
    // A path outside the prefix, another host and another port are refused before anything is sent.
    assert.equal((await proxied(p.endpoint.port, { url: `http://local.test:${up.port}/admin` })).status, 403);
    assert.equal((await proxied(p.endpoint.port, { url: `http://other.test:${up.port}/v1` })).status, 403);
    assert.equal((await proxied(p.endpoint.port, { url: `http://local.test:${up.port + 1}/v1` })).status, 403);
  } finally { await p.close(); await up.close(); }
});

test("the forwarded Host is pinned to the allowlisted authority, not a tool's forged Host (a shared front-end routes by Host)", async () => {
  const up = await upstream();
  const p = await proxy({ allow: [`http://local.test:${up.port}`] });
  try {
    const ok = await proxied(p.endpoint.port, { url: `http://local.test:${up.port}/`, headers: { host: "admin.internal" } });
    assert.equal(ok.status, 200);
    assert.equal(up.last.host, `local.test:${up.port}`, "the target's own Host reaches it, never the forged one");
  } finally { await p.close(); await up.close(); }
});

test("a name that resolves to a private address is refused, so DNS rebinding cannot reach this machine through the proxy", async () => {
  const up = await upstream();
  // The default guard (no blocked hook): local.test resolves to 127.0.0.1, which is blocked.
  const p = await proxy({ allow: [`http://local.test:${up.port}/v1`], hooks: { resolve: async () => [{ address: "127.0.0.1", family: 4 }] } });
  try {
    assert.equal((await proxied(p.endpoint.port, { url: `http://local.test:${up.port}/v1/x` })).status, 502);
  } finally { await p.close(); await up.close(); }
});

test("CONNECT tunnels only to an allowlisted https host and port; the path cannot be checked, so host and port decide", async () => {
  const echo = net.createServer(socket => socket.on("data", () => socket.write("pong")));
  await new Promise<void>(resolve => echo.listen(0, "127.0.0.1", resolve));
  const port = (echo.address() as AddressInfo).port;
  const p = await proxy({ allow: [`https://local.test:${port}`] });
  try {
    const ok = await connect(p.endpoint.port, `local.test:${port}`);
    assert.equal(ok.status, 200);
    ok.socket!.write("ping");
    assert.match(await new Promise<string>(resolve => ok.socket!.once("data", d => resolve(d.toString()))), /pong/);
    ok.socket!.destroy();
    assert.equal((await connect(p.endpoint.port, `evil.test:${port}`)).status, 403, "another host is refused");
    assert.equal((await connect(p.endpoint.port, `local.test:${port + 1}`)).status, 403, "another port is refused");
  } finally { await p.close(); await new Promise<void>(resolve => echo.close(() => resolve())); }
});

test("a CONNECT whose host resolves to a private address is refused (rebinding), after it passes the allowlist", async () => {
  const p = await proxy({ allow: ["https://local.test:8443"], hooks: { resolve: async () => [{ address: "127.0.0.1", family: 4 }] } });
  try {
    assert.notEqual((await connect(p.endpoint.port, "local.test:8443")).status, 200);
  } finally { await p.close(); }
});

test("an open CONNECT tunnel is torn down soon after the owner revokes its target (consent cannot be re-checked per request inside TLS)", async () => {
  const echo = net.createServer(socket => socket.on("data", () => socket.write("pong")));
  await new Promise<void>(resolve => echo.listen(0, "127.0.0.1", resolve));
  const port = (echo.address() as AddressInfo).port;
  let on = true;
  const p = await proxy({ allow: [`https://local.test:${port}`], consent: async () => { if (!on) throw new Error("the owner revoked this target"); }, recheckMs: 40 });
  try {
    const c = await connect(p.endpoint.port, `local.test:${port}`);
    assert.equal(c.status, 200);
    c.socket!.write("ping");
    assert.match(await new Promise<string>(resolve => c.socket!.once("data", d => resolve(d.toString()))), /pong/, "the tunnel carries data while consent holds");
    on = false;
    const closed = await Promise.race([new Promise<boolean>(resolve => c.socket!.once("close", () => resolve(true))), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2000))]);
    assert.equal(closed, true, "the tunnel closed once consent was revoked");
  } finally { await p.close(); await new Promise<void>(resolve => echo.close(() => resolve())); }
});

test("the shared run budget and the per-request consent both stop the proxy, as they stop http.request", async () => {
  const up = await upstream();
  const budget = new RequestBudget(1);
  const bounded = await proxy({ allow: [`http://local.test:${up.port}`], budget });
  try {
    assert.equal((await proxied(bounded.endpoint.port, { url: `http://local.test:${up.port}/a` })).status, 200);
    assert.equal((await proxied(bounded.endpoint.port, { url: `http://local.test:${up.port}/b` })).status, 403, "the run's budget is spent");
  } finally { await bounded.close(); }

  let on = true;
  const gated = await proxy({ allow: [`http://local.test:${up.port}`], consent: async () => { if (!on) throw new Error("Web access is no longer allowed: the project's owner changed its web targets."); } });
  try {
    assert.equal((await proxied(gated.endpoint.port, { url: `http://local.test:${up.port}/a` })).status, 200);
    on = false;
    assert.equal((await proxied(gated.endpoint.port, { url: `http://local.test:${up.port}/b` })).status, 403, "consent turned off stops in-flight tools");
  } finally { await gated.close(); await up.close(); }
});
