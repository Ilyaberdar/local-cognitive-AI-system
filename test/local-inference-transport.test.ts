import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchLocalInference } from "../src/local/fetchLocalInference";
import { OpenAICompatibleProvider } from "../src/llm/OpenAICompatibleProvider";
import { Logger } from "../src/utils/Logger";
import { withLocalThinkingBudget } from "../src/llm/InferenceThinking";
import { LLMService } from "../src/llm/LLMService";
import { LLMRegistry } from "../src/llm/LLMRegistry";
import { OutputSanitizer } from "../src/llm/OutputSanitizer";

async function server(t: TestContext, handler: http.RequestListener) {
  const instance = http.createServer(handler);
  await new Promise<void>(resolve => instance.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { instance.close(() => resolve()); instance.closeAllConnections(); }));
  return `http://127.0.0.1:${(instance.address() as import("node:net").AddressInfo).port}`;
}

test("local inference accepts delayed headers without invoking fetch's separate header deadline", async t => {
  let received: unknown;
  const url = await server(t, async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    received = { path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) };
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "Файл готов" }] }] }));
    }, 80);
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected built-in fetch"); });
  const provider = new OpenAICompatibleProvider({ id: "llamacpp", name: "Local", model: "bonsai", baseUrl: `${url}/v1`, apiKey: "local-test", timeoutMs: 1000 }, new Logger(), fetchLocalInference);
  const result = await provider.generateText({ prompt: "Write a file", systemPrompt: "Use tools", responseFormat: { type: "json_object" } });
  assert.equal(result.error, undefined);
  assert.equal(result.text, "Файл готов");
  assert.deepEqual(received, { path: "/v1/responses", authorization: "Bearer local-test", body: {
    model: "bonsai", input: "Write a file", instructions: "Use tools", text: { format: { type: "json_object" } }
  } });
});

test("local inference honours abort before headers and while receiving a body", async t => {
  for (const sendHeaders of [false, true]) {
    let close!: () => void;
    const closed = new Promise<void>(resolve => { close = resolve; });
    const url = await server(t, (_req, res) => {
      res.on("close", close);
      if (sendHeaders) { res.writeHead(200); res.write('{"output":'); }
    });
    await assert.rejects(fetchLocalInference(url, { signal: AbortSignal.timeout(60) }), /abort/i);
    await closed;
  }
});

test("local inference propagates HTTP errors and rejects a disconnected response", async t => {
  const url = await server(t, (req, res) => {
    if (req.url === "/error") { res.writeHead(503); res.end("model unavailable"); }
    else { res.writeHead(200, { "content-length": "100" }); res.write("partial"); setImmediate(() => res.destroy()); }
  });
  const response = await fetchLocalInference(`${url}/error`);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "model unavailable");
  await assert.rejects(fetchLocalInference(`${url}/disconnect`), /abort|socket/i);
  await assert.rejects(fetchLocalInference("https://example.com"), /loopback/);
});

test("local thinking budgets use the supported chat endpoint and never alter other providers", async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const transport: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ choices: [{ message: { content: "ok" } }] });
  };
  for (const id of ["llamacpp", "lmstudio"]) {
    const provider = new OpenAICompatibleProvider({ id, name: id, model: "test", baseUrl: "http://127.0.0.1:1/v1", timeoutMs: 1000 }, new Logger(), transport);
    for (const budget of [0, 256, undefined]) {
      const result = await provider.generateText({ prompt: "Use tools", systemPrompt: "Agent", localReasoningBudget: budget });
      assert.equal(result.error, undefined);
      const call = calls.at(-1)!;
      if (id === "llamacpp" && budget !== undefined) {
        assert.match(call.url, /chat\/completions$/);
        assert.equal(call.body.messages[1].content, "Use tools");
        assert.equal(call.body.reasoning_budget_tokens, budget);
        assert.equal(call.body.reasoning_effort, budget === 0 ? "none" : undefined);
        assert.equal(call.body.chat_template_kwargs?.enable_thinking, budget === 0 ? false : undefined);
      } else {
        assert.match(call.url, /responses$/);
        assert.equal(call.body.reasoning_budget_tokens, undefined);
      }
    }
  }
});

test("thinking budget scopes cover nested inference without leaking into simultaneous chats", async () => {
  const registry = new LLMRegistry();
  const received = new Map<string, number | undefined>();
  registry.register({ id: "fixture", name: "fixture", defaultModel: "test", isConfigured: () => true,
    getDescriptor: () => ({ id: "fixture", name: "fixture", defaultModel: "test", configured: true }),
    generateText: async request => {
      await new Promise(resolve => setTimeout(resolve, request.prompt === "no-thinking" ? 15 : 1));
      received.set(request.prompt, request.localReasoningBudget);
      return { provider: "fixture", model: "test", text: "ok" };
    }
  });
  const service = new LLMService(registry, "fixture", new Logger(), new OutputSanitizer());
  await Promise.all([
    withLocalThinkingBudget(0, () => service.generateText({ prompt: "no-thinking" })),
    withLocalThinkingBudget(256, async () => {
      await service.generateText({ prompt: "hypothesis" });
      await service.generateText({ prompt: "override", localReasoningBudget: 0 });
    }),
    service.generateText({ prompt: "ordinary-chat" })
  ]);
  assert.equal(received.get("no-thinking"), 0);
  assert.equal(received.get("hypothesis"), 256);
  assert.equal(received.get("override"), 0);
  assert.equal(received.get("ordinary-chat"), undefined);
});
