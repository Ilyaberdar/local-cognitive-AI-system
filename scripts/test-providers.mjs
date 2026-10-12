#!/usr/bin/env node
// Live check of cloud model providers with your own keys: what each service lists, whether it answers,
// answers in JSON, streams, reads an image and thinks. Every request is small (a few hundred tokens per
// service). Nothing runs without a key, and keys are read from a file only you can read, never from
// arguments.
//
//   npm run build:server
//   node scripts/test-providers.mjs [--keys ~/.config/local-cognitive/provider-keys.env] [--only qwen,groq] [--model qwen=qwen3.8-flash]
//
// The keys file has one NAME=value per line: QWEN_API_KEY, DEEPSEEK_API_KEY, OPENROUTER_API_KEY,
// GROQ_API_KEY, PERPLEXITY_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY. A region or
// address goes beside it as QWEN_BASE_URL (and likewise for the others).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dist = file => path.join(root, "dist/src", file);
if (!fs.existsSync(dist("llm/OpenAICompatibleProvider.js"))) { console.error("Build first: npm run build:server"); process.exit(2); }
const { OpenAICompatibleProvider } = require(dist("llm/OpenAICompatibleProvider.js"));
const { AnthropicProvider } = require(dist("llm/AnthropicProvider.js"));
const { GeminiProvider } = require(dist("llm/GeminiProvider.js"));
const { compatibleDialect } = require(dist("llm/ProviderDialect.js"));
const { PROVIDER_PRESETS } = require(dist("llm/providerCatalog.js"));
const { Logger } = require(dist("utils/Logger.js"));

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const keysFile = path.resolve((option("keys") ?? "~/.config/local-cognitive/provider-keys.env").replace(/^~(?=$|\/)/, os.homedir()));
const only = option("only")?.split(",").map(item => item.trim()).filter(Boolean);
const models = Object.fromEntries((option("model") ?? "").split(",").filter(Boolean).map(pair => pair.split("=")));

if (!fs.existsSync(keysFile)) { console.error(`No keys file at ${keysFile}. Create it (chmod 600) with lines such as QWEN_API_KEY=...`); process.exit(2); }
if (process.platform !== "win32" && (fs.statSync(keysFile).mode & 0o077)) { console.error(`${keysFile} is readable by others: run chmod 600 on it first.`); process.exit(2); }
const env = Object.fromEntries(fs.readFileSync(keysFile, "utf8").split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#") && line.includes("="))
  .map(line => { const at = line.indexOf("="); return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^(["'])(.*)\1$/, "$2")]; }));
const secrets = Object.entries(env).filter(([name]) => /KEY/.test(name)).map(([, value]) => value).filter(value => value.length >= 6);
const masked = text => secrets.reduce((value, secret) => value.split(secret).join("<key>"), String(text ?? "")).replace(/\b(?:sk|gsk|pplx|xai)-[A-Za-z0-9_\-]{8,}/g, "<key>");

/** An 8×8 red PNG, made here so the image test asks about something a model can see. */
function redSquare() {
  const crc = buffer => { const value = Buffer.alloc(4); value.writeUInt32BE(zlib.crc32(buffer)); return value; };
  const chunk = (type, data) => { const head = Buffer.alloc(4); head.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); return Buffer.concat([head, body, crc(body)]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(8, 0); header.writeUInt32BE(8, 4); header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: 8 }, () => Buffer.from([0, ...Array.from({ length: 8 }, () => [220, 30, 30]).flat()])));
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

const logger = new Logger();
const providers = [
  ...PROVIDER_PRESETS.map(preset => {
    const apiKey = preset.env.apiKey.map(name => env[name]).find(Boolean);
    if (!apiKey) return undefined;
    const dialect = compatibleDialect(preset.dialect);
    return { id: preset.id, dialect, provider: new OpenAICompatibleProvider({ id: preset.id, name: preset.name, dialect, apiKey,
      baseUrl: env[preset.env.baseUrl] || preset.baseUrl, model: models[preset.id] || env[preset.env.model] || preset.model, timeoutMs: 180_000 }, logger) };
  }),
  env.OPENAI_API_KEY && { id: "openai", provider: new OpenAICompatibleProvider({ id: "openai", name: "OpenAI", apiKey: env.OPENAI_API_KEY,
    baseUrl: "https://api.openai.com/v1", model: models.openai || env.OPENAI_MODEL || "gpt-5-mini", timeoutMs: 180_000 }, logger) },
  env.ANTHROPIC_API_KEY && { id: "anthropic", provider: new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, baseUrl: "https://api.anthropic.com",
    model: models.anthropic || env.ANTHROPIC_MODEL || "claude-haiku-4-5", timeoutMs: 180_000, version: "2023-06-01", maxTokens: 4000 }, logger) },
  env.GEMINI_API_KEY && { id: "gemini", provider: new GeminiProvider({ apiKey: env.GEMINI_API_KEY, baseUrl: "https://generativelanguage.googleapis.com",
    model: models.gemini || env.GEMINI_MODEL || "gemini-2.5-flash", timeoutMs: 180_000 }, logger) }
].filter(Boolean).filter(item => !only || only.includes(item.id));

if (!providers.length) { console.error(`No keys for ${only ? only.join(", ") : "any provider"} in ${keysFile}.`); process.exit(2); }

const rows = [];
async function check(id, name, run) {
  const started = Date.now();
  try {
    const { ok, detail, usage } = await run();
    rows.push({ id, name, ok, ms: Date.now() - started, tokens: usage ? `${usage.inputTokens ?? "?"}→${usage.outputTokens ?? "?"}` : "", detail: masked(detail ?? "") });
  } catch (error) {
    rows.push({ id, name, ok: false, ms: Date.now() - started, tokens: "", detail: masked(error instanceof Error ? error.message : error) });
  }
}
const answered = response => response.error ? { ok: false, detail: response.error, usage: response.usage } : undefined;

for (const { id, provider, dialect } of providers) {
  const capabilities = provider.getDescriptor().capabilities ?? {};
  process.stdout.write(`${id} (${provider.defaultModel})…\n`);
  await check(id, "models", async () => {
    const list = await provider.listModels();
    return { ok: list.length > 0, detail: `${list.length} listed${list.some(model => model.id === provider.defaultModel) ? ", default among them" : ", default not listed"}` };
  });
  await check(id, "answer", async () => {
    const response = await provider.generateText({ prompt: "Reply with exactly one word: ok", maxTokens: 64 });
    return answered(response) ?? { ok: /\bok\b/i.test(response.text), detail: response.text.slice(0, 60), usage: response.usage };
  });
  if (capabilities.jsonMode) await check(id, "json", async () => {
    const response = await provider.generateText({ prompt: "Return the object {\"ok\": true} and nothing else.", responseFormat: { type: "json_object" }, maxTokens: 64 });
    if (response.error) return answered(response);
    try { return { ok: JSON.parse(response.text.replace(/^```(?:json)?\s*|\s*```$/g, "")).ok === true, detail: response.text.slice(0, 60), usage: response.usage }; }
    catch { return { ok: false, detail: `not JSON: ${response.text.slice(0, 60)}`, usage: response.usage }; }
  });
  if (dialect?.streamChat) await check(id, "stream", async () => {
    const deltas = [];
    const response = await provider.generateText({ prompt: "Count from one to five in words.", maxTokens: 64, onTextDelta: delta => deltas.push(delta) });
    return answered(response) ?? { ok: deltas.length > 1, detail: `${deltas.length} pieces`, usage: response.usage };
  });
  if (capabilities.vision) await check(id, "image", async () => {
    const response = await provider.generateText({ prompt: "What color is this square? Answer with one word.", images: [{ dataUrl: redSquare() }], maxTokens: 64 });
    return answered(response) ?? { ok: /red|красн/i.test(response.text), detail: response.text.slice(0, 60), usage: response.usage };
  });
  if (capabilities.reasoning) await check(id, "thinking", async () => {
    const response = await provider.generateText({ prompt: "Is 391 a prime number? Answer yes or no.", reasoningEffort: "medium", maxTokens: 2000 });
    return answered(response) ?? { ok: /\bno\b/i.test(response.text), detail: response.text.slice(0, 60), usage: response.usage };
  });
}

const width = (key, minimum) => Math.max(minimum, ...rows.map(row => String(row[key]).length));
const [w1, w2, w3] = [width("id", 8), width("name", 8), width("tokens", 6)];
console.log(`\n${"provider".padEnd(w1)}  ${"check".padEnd(w2)}  ok  ${"tokens".padEnd(w3)}  time    detail`);
for (const row of rows) console.log(`${row.id.padEnd(w1)}  ${row.name.padEnd(w2)}  ${row.ok ? "✓ " : "✗ "}  ${row.tokens.padEnd(w3)}  ${(row.ms / 1000).toFixed(1).padStart(5)}s  ${row.detail}`);
const failed = rows.filter(row => !row.ok).length;
console.log(`\n${rows.length - failed} of ${rows.length} checks passed.`);
process.exit(failed ? 1 : 0);
