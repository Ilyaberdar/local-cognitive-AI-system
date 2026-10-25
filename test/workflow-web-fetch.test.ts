import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { AddressInfo } from "node:net";
import { WebFetchNodeExecutor, staticOrigin } from "../src/workflows/nodes/WebFetchNodeExecutor";
import { WebSearchNodeExecutor } from "../src/workflows/nodes/WebSearchNodeExecutor";
import { NodeExecutionContext } from "../src/workflows/nodes/NodeExecutor";
import { isBlockedAddress } from "../src/security/egress";

function context(config: Record<string, unknown> = {}): NodeExecutionContext {
  return { workflow: { id: "flow", name: "Flow", version: 1, entryNodeId: "web", nodes: [], transitions: [], createdAt: "", updatedAt: "" },
    run: { id: "run", workflowId: "flow", workflowVersion: 1, status: "running", state: {}, createdAt: "", updatedAt: "" },
    node: { id: "web", type: "web_fetch", label: "Read page", position: { x: 0, y: 0 }, config: { urlTemplate: "https://example.com", ...config } },
    previousNodeRuns: [], accessMode: "full", operationId: "fetch-1" };
}
/** A step whose address a model filled in (the run's input stands in for a model's output). */
function templated(url: string): NodeExecutionContext {
  const step = context({ urlTemplate: "{{input.title}}" });
  step.run.executionSnapshot = { input: { title: url, description: "" } } as never;
  return step;
}

interface Site { origin: string; port: number; hits: string[]; close: () => Promise<void> }
async function serve(handler: http.RequestListener, host = "127.0.0.1", name = "site.test"): Promise<Site> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => { hits.push(req.url ?? ""); handler(req, res); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, host, resolve); });
  const { port } = server.address() as AddressInfo;
  return { origin: `http://${name}:${port}`, port, hits, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
/** A test server on this machine stands in for a public site: site.test resolves to it, and the check
 * treats its address as public. Only for the paths that read a page. */
const publicSite = { resolve: async () => [{ address: "127.0.0.1", family: 4 }], blocked: () => false };
const page = (body: string, type = "text/html; charset=utf-8"): http.RequestListener => (_req, res) => { res.setHeader("content-type", type); res.end(body); };

test("webpage extracts bounded text, title and source URL without executing page content", async () => {
  const site = await serve(page('<html><head><title>Sources &amp; facts</title><style>hidden</style></head><body><script>alert(1)</script><h1>Facts</h1><p>Alpha &#65; &#x42;</p><p>Beta</p></body></html>'));
  try {
    const result = await new WebFetchNodeExecutor({ hooks: publicSite }).execute(context({ urlTemplate: `${site.origin}/` }));
    assert.equal(result.status, "ok"); assert.equal(result.data.title, "Sources & facts");
    assert.equal(result.data.text, "Facts\n\nAlpha A B\n\nBeta"); assert.equal(result.data.truncated, false);
    assert.equal(result.data.url, `${site.origin}/`);
  } finally { await site.close(); }
});

test("webpage fetch approval freezes URL and refuses rejected access", async () => {
  const site = await serve(page("hello", "text/plain"));
  try {
    const executor = new WebFetchNodeExecutor({ hooks: publicSite });
    const input = context({ urlTemplate: `${site.origin}/page` }); input.accessMode = "default";
    const waiting = await executor.execute(input);
    assert.equal(waiting.status, "needs_input"); assert.equal(site.hits.length, 0);
    assert.match(String(waiting.data.details), /Redirects are followed only to public addresses, or within this address/);
    input.node.config.urlTemplate = "https://changed.example";
    input.approval = { ...waiting.data, approved: false };
    assert.equal((await executor.execute(input)).status, "failed"); assert.equal(site.hits.length, 0);
    input.approval.approved = true;
    assert.equal((await executor.execute(input)).status, "ok"); assert.deepEqual(site.hits, ["/page"]);
  } finally { await site.close(); }
});

test("webpage follows bounded redirects and rejects non-HTTP or credential URLs", async () => {
  const site = await serve((req, res) => {
    if (req.url === "/") { res.writeHead(302, { location: "/facts" }); res.end(); }
    else if (req.url === "/loop") { res.writeHead(302, { location: "/loop" }); res.end(); }
    else page("Facts", "text/plain")(req, res);
  });
  try {
    const executor = new WebFetchNodeExecutor({ hooks: publicSite });
    assert.equal((await executor.execute(context({ urlTemplate: `${site.origin}/` }))).data.url, `${site.origin}/facts`);
    for (const urlTemplate of ["file:///etc/passwd", "https://user:password@example.com"]) {
      await assert.rejects(executor.execute(context({ urlTemplate })), /HTTP/);
    }
    await assert.rejects(executor.execute(context({ urlTemplate: `${site.origin}/loop` })), /redirect limit/);
  } finally { await site.close(); }
});

test("webpage errors, unsupported media, text limits and cancellation are explicit", async () => {
  const site = await serve((req, res) => {
    if (req.url === "/missing") { res.statusCode = 404; res.end("no"); }
    else if (req.url === "/pdf") page("pdf", "application/pdf")(req, res);
    else if (req.url === "/long") page("a".repeat(800), "text/plain")(req, res);
    else if (req.url === "/large") page("A".repeat(2_500_000), "text/plain")(req, res);
    else page("late", "text/plain")(req, res);
  });
  try {
    const executor = new WebFetchNodeExecutor({ hooks: publicSite });
    await assert.rejects(executor.execute(context({ urlTemplate: `${site.origin}/missing` })), /HTTP 404/);
    await assert.rejects(executor.execute(context({ urlTemplate: `${site.origin}/pdf` })), /application\/pdf/);
    const text = await executor.execute(context({ urlTemplate: `${site.origin}/long`, maxChars: 500 }));
    assert.equal(String(text.data.text).length, 500); assert.equal(text.data.truncated, true);
    const large = await executor.execute(context({ urlTemplate: `${site.origin}/large`, maxChars: 100000 }));
    assert.equal(large.data.truncated, true); assert.equal(String(large.data.text).length, 100000);
    const controller = new AbortController(); controller.abort();
    const input = context({ urlTemplate: `${site.origin}/late` }); input.signal = controller.signal;
    await assert.rejects(executor.execute(input));
  } finally { await site.close(); }
});

test("web step Full access skips approval under Ask, while Ask overrides a full run", async () => {
  const site = await serve(page("page", "text/plain"));
  try {
    const executor = new WebFetchNodeExecutor({ hooks: publicSite });
    const full = context({ approval: "never", urlTemplate: `${site.origin}/` }); full.accessMode = "ask";
    assert.equal((await executor.execute(full)).status, "ok");
    assert.equal(site.hits.length, 1);
    const ask = context({ approval: "always", urlTemplate: `${site.origin}/` });
    const pending = await executor.execute(ask);
    assert.equal(pending.status, "needs_input"); assert.equal(site.hits.length, 1);
    ask.approval = { ...pending.data, approved: true };
    assert.equal((await executor.execute(ask)).status, "ok"); assert.equal(site.hits.length, 2);
  } finally { await site.close(); }
});

test("a step's own address is static only when no template decides its scheme, host or port", () => {
  assert.equal(staticOrigin("http://192.168.1.5:8080/{{input.title}}?q={{x}}"), "http://192.168.1.5:8080");
  assert.equal(staticOrigin("https://example.com"), "https://example.com");
  for (const template of ["{{input.url}}", "http://{{input.host}}/", "http://example.com{{path}}", "http://user{{x}}@example.com/", "http://example.com:{{port}}/"]) {
    assert.equal(staticOrigin(template), undefined, template);
  }
});

test("this computer, the local network and metadata: read only at the address the user named, never the app's own API", async () => {
  const lan = await serve(page("LAN PAGE", "text/plain"), "127.0.0.1", "127.0.0.1");
  try {
    // Full access, an address a model filled in: this computer is refused, however it is spelled.
    const executor = new WebFetchNodeExecutor();
    for (const url of [`http://127.0.0.1:${lan.port}/`, `http://localhost:${lan.port}/`, `http://2130706433:${lan.port}/`, `http://0x7f000001:${lan.port}/`,
      `http://[::ffff:7f00:1]:${lan.port}/`, `http://[::1]:${lan.port}/`, "http://169.254.169.254/latest/meta-data/"]) {
      await assert.rejects(executor.execute(templated(url)), /on this computer or the local network|metadata/, url);
    }
    const host = context({ urlTemplate: "http://{{input.title}}/" });
    host.run.executionSnapshot = { input: { title: `127.0.0.1:${lan.port}`, description: "" } } as never;
    await assert.rejects(executor.execute(host), /on this computer or the local network/);
    assert.equal(lan.hits.length, 0, "nothing reached this computer");

    // An address written in the step itself, and one the user approved, are read.
    const written = await executor.execute(context({ urlTemplate: `${lan.origin}/{{input.title}}` }));
    assert.equal(written.data.text, "LAN PAGE");
    const asked = context({ urlTemplate: `${lan.origin}/` }); asked.accessMode = "default";
    const prompt = await executor.execute(asked);
    assert.match(String(prompt.data.details), /This address is on this computer/);
    assert.equal(prompt.data.place, "this computer");
    asked.approval = { ...prompt.data, approved: true };
    assert.equal((await executor.execute(asked)).data.text, "LAN PAGE");

    // Metadata is refused even when approved, and so is the app's own API port.
    const metadata = context({ urlTemplate: "http://169.254.169.254/" }); metadata.accessMode = "default";
    metadata.approval = { ...(await executor.execute(metadata)).data, approved: true };
    await assert.rejects(executor.execute(metadata), /link-local or cloud metadata/);
    const own = new WebFetchNodeExecutor({ ownPort: lan.port });
    const app = context({ urlTemplate: `${lan.origin}/app/settings` }); app.accessMode = "default";
    app.approval = { ...(await own.execute(app)).data, approved: true };
    await assert.rejects(own.execute(app), /this app's own address/);
    assert.equal(lan.hits.length, 2);
  } finally { await lan.close(); }
});

test("an approved address on the local network does not lead to another one by redirect", async () => {
  const other = await serve(page("OTHER", "text/plain"), "127.0.0.1", "localhost");
  const lan = await serve((req, res) => {
    if (req.url === "/same") { res.writeHead(302, { location: "/page" }); res.end(); }
    else if (req.url === "/away") { res.writeHead(302, { location: `http://localhost:${other.port}/` }); res.end(); }
    else page("LAN PAGE", "text/plain")(req, res);
  }, "127.0.0.1", "127.0.0.1");
  try {
    const executor = new WebFetchNodeExecutor();
    const approve = async (url: string) => {
      const step = context({ urlTemplate: url }); step.accessMode = "default";
      step.approval = { ...(await executor.execute(step)).data, approved: true };
      return executor.execute(step);
    };
    assert.equal((await approve(`${lan.origin}/same`)).data.text, "LAN PAGE", "a redirect within the approved address is followed");
    await assert.rejects(approve(`${lan.origin}/away`), /was not followed/);
    assert.equal(other.hits.length, 0);
  } finally { await lan.close(); await other.close(); }
});

test("a public page's redirect to this computer is never followed, the app's own port above all", async (t) => {
  // A public site, stood in for by IPv6 loopback (treated as public here), redirects to IPv4 loopback.
  let pub: Site;
  try { pub = await serve((req, res) => { res.writeHead(302, { location: decodeURIComponent((req.url ?? "/").slice(1)) }); res.end(); }, "::1", "public.test"); }
  catch { t.skip("no IPv6 loopback here"); return; }
  const app = await serve(page('{"providers":{}}', "application/json"), "127.0.0.1", "127.0.0.1");
  const hooks = { resolve: async (host: string) => host === "public.test" ? [{ address: "::1", family: 6 }] : [{ address: "127.0.0.1", family: 4 }],
    blocked: (address: string) => address === "::1" ? false : isBlockedAddress(address) };
  try {
    const executor = new WebFetchNodeExecutor({ hooks, ownPort: app.port });
    for (const target of [`http://127.0.0.1:${app.port}/app/settings`, `http://localhost:${app.port}/app/settings`, "http://169.254.169.254/", `http://[::ffff:7f00:1]:${app.port}/`]) {
      await assert.rejects(executor.execute(context({ urlTemplate: `${pub.origin}/${encodeURIComponent(target)}` })), /was not followed|own address|metadata/, target);
    }
    // Even approved, with that very address as the one it leads to, a hop through a public page does not get there.
    const named = new WebFetchNodeExecutor({ hooks });
    const step = context({ urlTemplate: `${pub.origin}/${encodeURIComponent(`http://127.0.0.1:${app.port}/`)}` }); step.accessMode = "default";
    step.approval = { ...(await named.execute(step)).data, approved: true };
    await assert.rejects(named.execute(step), /was not followed/);
    assert.equal(app.hits.length, 0, "nothing reached the app's API");
  } finally { await pub.close(); await app.close(); }
});

test("web search sends Brave's token with no redirect, and a device's step cannot choose the SearXNG address", async () => {
  const seen: RequestInit[] = [];
  const executor = new WebSearchNodeExecutor({ braveApiKey: "BSA-test-token", searxngUrl: "http://search.local", fetchImpl: async (_url, init) => {
    seen.push(init ?? {}); return new Response(JSON.stringify({ web: { results: [] }, results: [] }), { headers: { "content-type": "application/json" } }); } });
  const step = (config: Record<string, unknown>, device = false): NodeExecutionContext => {
    const input = context(); input.node = { ...input.node, type: "web_search", config: { queryTemplate: "q", ...config } };
    if (device) input.run.deviceOrigin = true;
    return input;
  };
  await executor.execute(step({ provider: "brave" }));
  assert.equal(seen[0]!.redirect, "error");
  await assert.rejects(executor.execute(step({ provider: "searxng", baseUrl: "http://192.168.1.1:8080" }, true)), /server's own SearXNG address/);
  assert.equal(seen.length, 1);
  assert.equal((await executor.execute(step({ provider: "searxng" }, true))).status, "ok", "the server's own address is used");
  assert.equal((await executor.execute(step({ provider: "searxng", baseUrl: "http://192.168.1.1:8080" }))).status, "ok", "the host's own step may name one");
});
