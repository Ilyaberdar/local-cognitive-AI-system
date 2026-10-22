import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AnthropicProvider } from "../src/llm/AnthropicProvider";
import { GeminiProvider } from "../src/llm/GeminiProvider";
import { OpenAICompatibleProvider } from "../src/llm/OpenAICompatibleProvider";
import { isKeyRefusal, ProviderHttpError, refusalMessage } from "../src/llm/ProviderHttpError";
import { checkProvider, currentStatuses, ProviderStatusStore, statusFingerprint } from "../src/llm/providerStatus";
import { Logger } from "../src/utils/Logger";

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a refused key reads as what happened and where to fix it, in the service's own words", () => {
  const anthropic = refusalMessage("Anthropic", 401, JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" }, request_id: "req_1" }))!;
  assert.match(anthropic, /^Anthropic refused the API key \(HTTP 401, authentication_error: invalid x-api-key\)\. The key is not valid: it was mistyped, expired or revoked\. Enter a new one in Settings → Models & Providers\.$/);
  assert.match(refusalMessage("OpenAI", 401, JSON.stringify({ error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } }))!, /OpenAI refused the API key \(HTTP 401, invalid_request_error: Incorrect API key provided\.\)/);
  assert.match(refusalMessage("Gemini", 400, JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }))!, /Gemini refused the API key \(HTTP 400/);
  assert.match(refusalMessage("Anthropic", 403, JSON.stringify({ error: { type: "permission_error", message: "no access to this model" } }))!, /refused the request \(HTTP 403, permission_error: no access to this model\)\. The key may not have access/);
  assert.equal(refusalMessage("OpenAI", 400, JSON.stringify({ error: { message: "bad parameter" } })), undefined, "another 400 is not about the key");
  assert.equal(refusalMessage("OpenAI", 429, "{}"), undefined);
  assert.equal(isKeyRefusal(400, "API_KEY_INVALID"), true);
});

test("a chat with a refused key says so instead of the service's raw JSON", async t => {
  const answers: Response[] = [];
  t.mock.method(globalThis, "fetch", async () => answers.shift()!);
  const anthropic = new AnthropicProvider({ id: "anthropic", name: "Anthropic", model: "claude", baseUrl: "https://api.example", apiKey: "k", timeoutMs: 5000, version: "2023-06-01", maxTokens: 1000 } as never, new Logger());
  answers.push(reply(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
  const said = (await anthropic.generateText({ prompt: "hi" })).error ?? "";
  assert.match(said, /^Anthropic refused the API key \(HTTP 401, authentication_error: invalid x-api-key\)/);
  assert.doesNotMatch(said, /\{"type"/);
  const gemini = new GeminiProvider({ id: "gemini", name: "Gemini", model: "gemini-2.5-flash", baseUrl: "https://api.example", apiKey: "k", timeoutMs: 5000 } as never, new Logger());
  answers.push(reply(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }));
  assert.match((await gemini.generateText({ prompt: "hi" })).error ?? "", /^Gemini refused the API key \(HTTP 400/);
  const openai = new OpenAICompatibleProvider({ id: "openai", name: "OpenAI", model: "gpt-x", baseUrl: "https://api.example/v1", apiKey: "k", timeoutMs: 5000 }, new Logger(),
    (async () => reply(401, { error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } })) as typeof fetch);
  const openaiSaid = await openai.generateText({ prompt: "hi" }).then(response => response.error ?? "", (error: Error) => error.message);
  assert.match(openaiSaid, /^OpenAI refused the API key \(HTTP 401/);
  // A model list keeps its message (Add provider reads "status 401" from it) and now carries the status.
  answers.push(reply(401, { error: { type: "authentication_error" } }));
  await assert.rejects(anthropic.listModels!(), (error: any) => error instanceof ProviderHttpError && error.status === 401 && /models request failed with status 401/.test(error.message));
});

test("a provider's check lists its models: connected, a refused key, a service down, no answer", async () => {
  const settings = { enabled: true, baseUrl: "https://api.example", apiKey: "sk-secret-value" };
  const connected = await checkProvider(async () => [{}, {}, {}], settings);
  assert.deepEqual([connected.state, connected.models, connected.message], ["connected", 3, "3 models"]);
  const refused = await checkProvider(async () => { throw new ProviderHttpError("Anthropic models request failed with status 401", 401); }, settings);
  assert.deepEqual([refused.state, refused.httpStatus, refused.message], ["rejected", 401, "Key refused (HTTP 401)"]);
  const gemini = await checkProvider(async () => { throw new ProviderHttpError("Gemini models request failed with status 400: API key not valid", 400); }, settings);
  assert.equal(gemini.state, "rejected");
  assert.equal((await checkProvider(async () => { throw new ProviderHttpError("x", 404); }, settings)).state, "failed", "a wrong address");
  assert.equal((await checkProvider(async () => { throw new ProviderHttpError("x", 503); }, settings)).state, "unreachable");
  assert.equal((await checkProvider(async () => { throw new TypeError("fetch failed"); }, settings)).message, "Not reachable");
  const slow = await checkProvider(() => new Promise(() => undefined), settings, 20);
  assert.deepEqual([slow.state, slow.message], ["unreachable", "No answer"]);
  assert.equal(connected.fingerprint, statusFingerprint(settings));
  assert.doesNotMatch(JSON.stringify(connected), /sk-secret-value/, "never the key");
});

test("the last checks are kept without keys, and a new key or address makes its result stale", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lc-provider-status-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new ProviderStatusStore(dir);
  assert.deepEqual(await store.read(), {});
  const providers: Record<string, { enabled: boolean; baseUrl: string; apiKey?: string }> = {
    anthropic: { enabled: true, baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-old" }, openai: { enabled: true, baseUrl: "https://api.openai.com/v1", apiKey: "sk-open" }
  };
  const refused = await checkProvider(async () => { throw new ProviderHttpError("x", 401); }, providers.anthropic!);
  const ok = await checkProvider(async () => [{}], providers.openai!);
  await store.write({ anthropic: refused, openai: ok, gone: ok }, Object.keys(providers));
  const raw = await fs.readFile(path.join(dir, "provider-status.json"), "utf8");
  assert.doesNotMatch(raw, /sk-ant-old|sk-open/);
  assert.equal(((await fs.stat(path.join(dir, "provider-status.json"))).mode & 0o777).toString(8), "600");
  assert.deepEqual(Object.keys(await store.read()).sort(), ["anthropic", "openai"], "a provider no longer set up is dropped");
  assert.deepEqual(Object.keys(currentStatuses(await store.read(), providers)).sort(), ["anthropic", "openai"]);
  providers.anthropic!.apiKey = "sk-ant-new";
  assert.deepEqual(Object.keys(currentStatuses(await store.read(), providers)), ["openai"], "the refusal was of the old key");
  await fs.writeFile(path.join(dir, "provider-status.json"), "{not json");
  assert.deepEqual(await store.read(), {}, "a damaged file reads as no checks yet");
});
