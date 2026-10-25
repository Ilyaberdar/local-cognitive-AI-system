import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { AddressInfo } from "node:net";
import { AnthropicProvider } from "../src/llm/AnthropicProvider";
import { GeminiProvider } from "../src/llm/GeminiProvider";
import { OpenAICompatibleProvider } from "../src/llm/OpenAICompatibleProvider";
import { LMStudioManager } from "../src/llm/LMStudioManager";
import { sameOriginFetch } from "../src/llm/sameOriginFetch";
import { Logger } from "../src/utils/Logger";

class QuietLogger extends Logger { override log(): void { /* nothing */ } }
const KEY = "sk-test-redirect-key-0123456789abcdef";

async function listen(handler: http.RequestListener): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

/** A provider at one origin that redirects every request with 307 to a second origin, which records
 * what reached it. The second origin is another port of this machine: another origin all the same. */
async function redirecting() {
  const reached: http.IncomingHttpHeaders[] = [];
  const elsewhere = await listen((req, res) => { reached.push(req.headers); res.setHeader("content-type", "application/json"); res.end("{}"); });
  const provider = await listen((req, res) => { res.writeHead(307, { location: `${elsewhere.origin}${req.url}` }); res.end(); });
  return { reached, origin: provider.origin, close: async () => { await provider.close(); await elsewhere.close(); } };
}

const leaked = (headers: http.IncomingHttpHeaders[]) => headers.some(item => JSON.stringify(item).includes(KEY));

test("a provider's 307 to another origin is refused: Anthropic's x-api-key never reaches it", async () => {
  const setup = await redirecting();
  try {
    const provider = new AnthropicProvider({ enabled: true, baseUrl: setup.origin, model: "claude", timeoutMs: 5000, apiKey: KEY, version: "2023-06-01", maxTokens: 64 }, new QuietLogger());
    await assert.rejects(provider.listModels(), /redirected to http:\/\/127\.0\.0\.1:\d+\. A key is sent only to the address it was saved for/);
    const answer = await provider.generateText({ prompt: "hello" });
    assert.match(String(answer.error), /A key is sent only to the address it was saved for/);
    assert.equal(setup.reached.length, 0, "nothing reached the other origin");
    assert.equal(leaked(setup.reached), false);
  } finally { await setup.close(); }
});

test("Gemini's x-goog-api-key is not sent along a redirect to another origin", async () => {
  const setup = await redirecting();
  try {
    const provider = new GeminiProvider({ enabled: true, baseUrl: setup.origin, model: "gemini", timeoutMs: 5000, apiKey: KEY }, new QuietLogger());
    await assert.rejects(provider.listModels(), /A key is sent only to the address it was saved for/);
    const answer = await provider.generateText({ prompt: "hello" });
    assert.match(String(answer.error), /A key is sent only to the address it was saved for/);
    assert.equal(setup.reached.length, 0);
  } finally { await setup.close(); }
});

test("an OpenAI-compatible service, Add provider's check and LM Studio follow no redirect to another origin", async () => {
  const setup = await redirecting();
  try {
    const provider = new OpenAICompatibleProvider({ id: "openai", name: "OpenAI", baseUrl: `${setup.origin}/v1`, model: "gpt", timeoutMs: 5000, apiKey: KEY }, new QuietLogger());
    await assert.rejects(provider.listModels({ strict: true }), /A key is sent only to the address it was saved for/);
    const answer = await provider.generateText({ prompt: "hello" });
    assert.match(String(answer.error), /A key is sent only to the address it was saved for/);
    const studio = new LMStudioManager({ baseUrl: `${setup.origin}/v1`, apiKey: KEY, timeoutMs: 5000 });
    assert.deepEqual(await studio.listAllModels(), [], "the redirect is refused, as an unreachable LM Studio is");
    assert.equal(setup.reached.length, 0);
  } finally { await setup.close(); }
});

test("a redirect within the provider's own origin is followed with the key; a POST after a 303 continues as GET", async () => {
  const seen: Array<{ url?: string; method?: string; key?: string }> = [];
  const own = await listen((req, res) => {
    seen.push({ url: req.url, method: req.method, key: String(req.headers["x-api-key"] ?? "") });
    if (req.url === "/v1/models?limit=1000") { res.writeHead(308, { location: "/moved/v1/models?limit=1000" }); res.end(); return; }
    if (req.url === "/post") { res.writeHead(303, { location: "/after" }); res.end(); return; }
    if (req.url === "/loop") { res.writeHead(302, { location: "/loop" }); res.end(); return; }
    res.setHeader("content-type", "application/json"); res.end('{"data":[{"id":"claude-x"}]}');
  });
  try {
    const provider = new AnthropicProvider({ enabled: true, baseUrl: own.origin, model: "claude", timeoutMs: 5000, apiKey: KEY, version: "2023-06-01", maxTokens: 64 }, new QuietLogger());
    assert.deepEqual((await provider.listModels()).map(model => model.id), ["claude-x"]);
    assert.deepEqual(seen.map(item => item.url), ["/v1/models?limit=1000", "/moved/v1/models?limit=1000"]);
    assert.ok(seen.every(item => item.key === KEY), "the key goes to its own origin on every hop");
    seen.length = 0;
    const response = await sameOriginFetch()(`${own.origin}/post`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 200);
    assert.deepEqual(seen.map(item => `${item.method} ${item.url}`), ["POST /post", "GET /after"]);
    await assert.rejects(sameOriginFetch()(`${own.origin}/loop`), /More than 5 redirects/);
  } finally { await own.close(); }
});
