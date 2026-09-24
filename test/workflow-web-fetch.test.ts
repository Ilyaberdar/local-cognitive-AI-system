import assert from "node:assert/strict";
import test from "node:test";
import { WebFetchNodeExecutor } from "../src/workflows/nodes/WebFetchNodeExecutor";
import { NodeExecutionContext } from "../src/workflows/nodes/NodeExecutor";

function context(config: Record<string, unknown> = {}): NodeExecutionContext {
  return { workflow: { id: "flow", name: "Flow", version: 1, entryNodeId: "web", nodes: [], transitions: [], createdAt: "", updatedAt: "" },
    run: { id: "run", workflowId: "flow", workflowVersion: 1, status: "running", state: {}, createdAt: "", updatedAt: "" },
    node: { id: "web", type: "web_fetch", label: "Read page", position: { x: 0, y: 0 }, config: { urlTemplate: "https://example.com", ...config } },
    previousNodeRuns: [], accessMode: "full", operationId: "fetch-1" };
}

test("webpage extracts bounded text, title and source URL without executing page content", async () => {
  const executor = new WebFetchNodeExecutor(async () => new Response('<html><head><title>Sources &amp; facts</title><style>hidden</style></head><body><script>alert(1)</script><h1>Facts</h1><p>Alpha &#65; &#x42;</p><p>Beta</p></body></html>', { headers: { "Content-Type": "text/html; charset=utf-8" } }));
  const result = await executor.execute(context());
  assert.equal(result.status, "ok"); assert.equal(result.data.title, "Sources & facts");
  assert.equal(result.data.text, "Facts\n\nAlpha A B\n\nBeta"); assert.equal(result.data.truncated, false);
  assert.equal(result.data.url, "https://example.com/");
});

test("webpage fetch approval freezes URL and refuses rejected access", async () => {
  const visited: string[] = [];
  const executor = new WebFetchNodeExecutor(async url => { visited.push(String(url)); return new Response("hello"); });
  const input = context(); input.accessMode = "default";
  const waiting = await executor.execute(input);
  assert.equal(waiting.status, "needs_input"); assert.equal(visited.length, 0);
  input.node.config.urlTemplate = "https://changed.example";
  input.approval = { ...waiting.data, approved: false };
  assert.equal((await executor.execute(input)).status, "failed"); assert.equal(visited.length, 0);
  input.approval.approved = true;
  assert.equal((await executor.execute(input)).status, "ok"); assert.deepEqual(visited, ["https://example.com/"]);
});

test("webpage follows bounded redirects and rejects non-HTTP or credential URLs", async () => {
  let calls = 0;
  const executor = new WebFetchNodeExecutor(async () => ++calls === 1
    ? new Response(null, { status: 302, headers: { location: "/facts" } }) : new Response("Facts"));
  assert.equal((await executor.execute(context())).data.url, "https://example.com/facts");
  for (const urlTemplate of ["file:///etc/passwd", "https://user:password@example.com"]) {
    await assert.rejects(executor.execute(context({ urlTemplate })), /HTTP/);
  }
  const loop = new WebFetchNodeExecutor(async () => new Response(null, { status: 302, headers: { location: "/loop" } }));
  await assert.rejects(loop.execute(context()), /redirect limit/);
});

test("webpage errors, unsupported media, text limits and stream cancellation are explicit", async () => {
  await assert.rejects(new WebFetchNodeExecutor(async () => new Response("no", { status: 404 })).execute(context()), /HTTP 404/);
  await assert.rejects(new WebFetchNodeExecutor(async () => new Response("pdf", { headers: { "Content-Type": "application/pdf" } })).execute(context()), /application\/pdf/);
  const text = await new WebFetchNodeExecutor(async () => new Response("a".repeat(800))).execute(context({ maxChars: 500 }));
  assert.equal(String(text.data.text).length, 500); assert.equal(text.data.truncated, true);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(600000).fill(65)); }, cancel() { cancelled = true; } });
  const large = await new WebFetchNodeExecutor(async () => new Response(stream)).execute(context());
  assert.equal(large.data.truncated, true); assert.equal(cancelled, true);
  const controller = new AbortController(); controller.abort();
  const input = context(); input.signal = controller.signal;
  await assert.rejects(new WebFetchNodeExecutor(async (_url, init) => { init?.signal?.throwIfAborted(); return new Response("late"); }).execute(input));
});

test("web step Full access skips approval under Ask, while Ask overrides a full run", async () => {
  let calls = 0;
  const executor = new WebFetchNodeExecutor(async () => { calls++; return new Response("page"); });
  const full = context({ approval: "never" }); full.accessMode = "ask";
  assert.equal((await executor.execute(full)).status, "ok");
  assert.equal(calls, 1);
  const ask = context({ approval: "always" });
  const pending = await executor.execute(ask);
  assert.equal(pending.status, "needs_input"); assert.equal(calls, 1);
  ask.approval = { ...pending.data, approved: true };
  assert.equal((await executor.execute(ask)).status, "ok"); assert.equal(calls, 2);
});
