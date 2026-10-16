import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { AddressInfo } from "node:net";
import { AgentHttpClient, isBlockedAddress, parseTarget } from "../src/synthesis/agents/AgentHttp";

test("the address guard refuses this machine, private networks, link-local and metadata; a public address passes", () => {
  for (const address of ["127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.5.6", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) assert.equal(isBlockedAddress(address), false, address);
});

test("a target is a scheme, host and port, with an optional path prefix; credentials, a query or a fragment are refused", () => {
  assert.deepEqual(parseTarget("https://api.example.com/v1"), { scheme: "https:", host: "api.example.com", port: 443, prefix: "/v1" });
  assert.deepEqual(parseTarget("http://staging.example.com:8080"), { scheme: "http:", host: "staging.example.com", port: 8080, prefix: "" });
  for (const bad of ["ftp://example.com", "https://user:pass@example.com", "https://example.com/?q=1", "https://example.com/#x"]) assert.throws(() => parseTarget(bad), bad);
});

/** A server on this machine (a blocked address): the client reaches it only when a test resolver and
 * check let it, which is how a successful request is exercised; by default it is refused. */
async function server(handler: http.RequestListener): Promise<{ origin: string; host: string; port: number; close: () => Promise<void> }> {
  const srv = http.createServer(handler);
  await new Promise<void>(resolve => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as AddressInfo;
  return { origin: `http://local.test:${port}`, host: "local.test", port, close: () => new Promise(resolve => srv.close(() => resolve())) };
}
/** Hooks that resolve any name to the loopback test server and permit it: only for the success paths. */
const toLoopback = { resolve: async () => [{ address: "127.0.0.1", family: 4 }], blocked: () => false };

test("a request goes only to an allowlisted origin; the response and the request are recorded, secrets as \"set\"", async () => {
  const seen: { url?: string; auth?: string; body?: string } = {};
  const srv = await server((req, res) => {
    const chunks: Buffer[] = []; req.on("data", c => chunks.push(c)); req.on("end", () => {
      seen.url = req.url; seen.auth = req.headers.authorization; seen.body = Buffer.concat(chunks).toString();
      res.setHeader("content-type", "application/json"); res.setHeader("set-cookie", "session=secret"); res.end('{"ok":true}');
    });
  });
  try {
    const client = new AgentHttpClient(10, toLoopback);
    const allow = [`${srv.origin}/v1`];
    const result = await client.request({ method: "POST", url: `${srv.origin}/v1/scan`, headers: { Authorization: "Bearer token", "X-Trace": "abc" }, body: '{"a":1}' }, allow);
    assert.equal(result.status, 200);
    assert.equal(result.body, '{"ok":true}');
    assert.equal(seen.auth, "Bearer token", "the agent's own header is sent");
    assert.equal(seen.body, '{"a":1}');
    assert.equal(result.request.headers.Authorization, "set", "a secret header is recorded without its value");
    assert.equal(result.request.headers["X-Trace"], "abc");
    assert.equal(result.headers["set-cookie"], "set", "a secret response header is kept without its value");
    // A path outside the prefix, another host and another port are all refused, before any request.
    await assert.rejects(client.request({ method: "GET", url: `${srv.origin}/admin` }, allow), /not in this agent's allowed targets/);
    await assert.rejects(client.request({ method: "GET", url: `http://other.test:${srv.port}/v1` }, allow), /not in this agent's allowed targets/);
  } finally { await srv.close(); }
});

test("a name that resolves to a private address is refused, so DNS rebinding cannot reach this machine", async () => {
  const srv = await server((_req, res) => res.end("secret"));
  try {
    // The default guard (no test hooks): local.test resolves to 127.0.0.1, which is blocked.
    const client = new AgentHttpClient(10, { resolve: async () => [{ address: "127.0.0.1", family: 4 }] });
    await assert.rejects(client.request({ method: "GET", url: `${srv.origin}/` }, [srv.origin]),
      /private, loopback, link-local or metadata address/);
  } finally { await srv.close(); }
});

test("a redirect is followed only within the allowlist; one that leaves it stops the request", async () => {
  const srv = await server((req, res) => {
    if (req.url === "/v1/start") { res.writeHead(302, { location: "/v1/next" }); res.end(); }
    else if (req.url === "/v1/next") { res.end("arrived"); }
    else if (req.url === "/v1/out") { res.writeHead(302, { location: "http://evil.test/" }); res.end(); }
    else res.end("other");
  });
  try {
    const client = new AgentHttpClient(10, toLoopback);
    const allow = [`${srv.origin}/v1`];
    const ok = await client.request({ method: "GET", url: `${srv.origin}/v1/start` }, allow);
    assert.equal(ok.body, "arrived");
    assert.deepEqual(ok.redirects, [`${srv.origin}/v1/next`]);
    await assert.rejects(client.request({ method: "GET", url: `${srv.origin}/v1/out` }, allow), /redirect left the allowed targets/);
  } finally { await srv.close(); }
});

test("the run's request budget, the method list and a too-large body are all enforced", async () => {
  const srv = await server((_req, res) => res.end("ok"));
  try {
    const client = new AgentHttpClient(1, toLoopback);
    const allow = [srv.origin];
    assert.equal((await client.request({ method: "GET", url: `${srv.origin}/` }, allow)).body, "ok");
    await assert.rejects(client.request({ method: "GET", url: `${srv.origin}/` }, allow), /budget of agent HTTP requests/);
    await assert.rejects(new AgentHttpClient(5, toLoopback).request({ method: "TRACE", url: `${srv.origin}/` }, allow), /method is one of/);
    await assert.rejects(new AgentHttpClient(5, toLoopback).request({ method: "POST", url: `${srv.origin}/`, body: "x".repeat(2 * 1024 * 1024) }, allow), /request body is at most/);
  } finally { await srv.close(); }
});
