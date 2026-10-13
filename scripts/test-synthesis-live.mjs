#!/usr/bin/env node
// Live check of Synthesis with cloud models and your own keys: runs a module on a copy of a project
// in a temporary folder and prints what each model and agent did. Keys are read from a file only you
// can read (the same as scripts/test-providers.mjs), never from arguments, and never printed.
//
//   npm run build:server
//   node scripts/test-synthesis-live.mjs --module scripts/synthesis-live/RateLimiterCloud [--project src/synthesis] [--keep]
//
// --module: a folder with Name.lcspec, Name.lcflow and the contract's tests (copied to Synthesis/Name).
// --project: folders of this repository copied into the project (default: none), for agents to read.
// --keep: keep the temporary folder (its path is printed) to look at the run and its agents.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dist = file => path.join(root, "dist/src", file);
if (!fs.existsSync(dist("synthesis/SynthesisService.js"))) { console.error("Build first: npm run build:server"); process.exit(2); }
const { OpenAICompatibleProvider } = require(dist("llm/OpenAICompatibleProvider.js"));
const { AnthropicProvider } = require(dist("llm/AnthropicProvider.js"));
const { GeminiProvider } = require(dist("llm/GeminiProvider.js"));
const { compatibleDialect } = require(dist("llm/ProviderDialect.js"));
const { PROVIDER_PRESETS } = require(dist("llm/providerCatalog.js"));
const { LLMRegistry } = require(dist("llm/LLMRegistry.js"));
const { LLMService } = require(dist("llm/LLMService.js"));
const { ModelCatalogService } = require(dist("llm/ModelCatalogService.js"));
const { OutputSanitizer } = require(dist("llm/OutputSanitizer.js"));
const { ProjectStore } = require(dist("projects/ProjectStore.js"));
const { SynthesisService } = require(dist("synthesis/SynthesisService.js"));
const { Logger } = require(dist("utils/Logger.js"));

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const keysFile = path.resolve((option("keys") ?? "~/.config/local-cognitive/provider-keys.env").replace(/^~(?=$|\/)/, os.homedir()));
const moduleDir = option("module") && path.resolve(option("module"));
if (!moduleDir || !fs.existsSync(moduleDir)) { console.error("Name a module folder: --module scripts/synthesis-live/<Name>"); process.exit(2); }
if (!fs.existsSync(keysFile)) { console.error(`No keys file at ${keysFile}.`); process.exit(2); }
if (process.platform !== "win32" && (fs.statSync(keysFile).mode & 0o077)) { console.error(`${keysFile} is readable by others: run chmod 600 on it first.`); process.exit(2); }
const env = Object.fromEntries(fs.readFileSync(keysFile, "utf8").split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#") && line.includes("="))
  .map(line => { const at = line.indexOf("="); return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^(["'])(.*)\1$/, "$2")]; }));
const secrets = Object.entries(env).filter(([name]) => /KEY/.test(name)).map(([, value]) => value).filter(value => value.length >= 6);
const masked = text => secrets.reduce((value, secret) => value.split(secret).join("<key>"), String(text ?? ""));

const logger = new Logger();
const registry = new LLMRegistry();
for (const preset of PROVIDER_PRESETS) {
  const apiKey = preset.env.apiKey.map(name => env[name]).find(Boolean);
  if (!apiKey) continue;
  const dialect = compatibleDialect(preset.dialect);
  registry.register(new OpenAICompatibleProvider({ id: preset.id, name: preset.name, dialect, apiKey, baseUrl: env[preset.env.baseUrl] || preset.baseUrl,
    model: env[preset.env.model] || preset.model, timeoutMs: 240_000 }, logger));
}
if (env.OPENAI_API_KEY) registry.register(new OpenAICompatibleProvider({ id: "openai", name: "OpenAI", apiKey: env.OPENAI_API_KEY, baseUrl: "https://api.openai.com/v1", model: "gpt-5-mini", timeoutMs: 240_000 }, logger));
if (env.ANTHROPIC_API_KEY) registry.register(new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, baseUrl: "https://api.anthropic.com", model: "claude-haiku-4-5", timeoutMs: 240_000, version: "2023-06-01", maxTokens: 8000 }, logger));
if (env.GEMINI_API_KEY) registry.register(new GeminiProvider({ apiKey: env.GEMINI_API_KEY, baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash", timeoutMs: 240_000 }, logger));
const configured = registry.list().map(item => item.id);
if (!configured.length) { console.error(`No provider keys in ${keysFile}.`); process.exit(2); }
const firstProvider = configured[0];
const llm = new LLMService(registry, firstProvider, logger, new OutputSanitizer());

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lc-synthesis-live-")));
const data = path.join(temp, "app"), project = path.join(temp, "project");
fs.mkdirSync(data); fs.mkdirSync(project);
for (const folder of (option("project") ?? "").split(",").filter(Boolean)) fs.cpSync(path.join(root, folder), path.join(project, folder), { recursive: true });
const name = path.basename(moduleDir);
fs.cpSync(moduleDir, path.join(project, "Synthesis", name), { recursive: true });

const projects = new ProjectStore(data);
const created = await projects.create({ name: "Live check", rootPath: project });
await projects.update(created.id, { cloudModels: true });
const services = {
  projects, llm,
  models: { listAllModels: async () => [] },
  loadModel: async () => { throw new Error("This live check runs cloud models only."); },
  catalog: new ModelCatalogService(registry),
  providers: () => registry.list()
};
const synthesis = new SynthesisService(data, { ...services, agents: { llm } });
await synthesis.init();
const module = await synthesis.module(created.id, name);
if (!module.valid) { console.error(module.diagnostics.map(item => `${item.file}:${item.line} ${item.code} ${item.message}`).join("\n")); process.exit(1); }

console.log(`Providers with keys: ${configured.join(", ")}. Module ${name}; project at ${project}.`);
const started = Date.now();
const run = await synthesis.start(created.id, module.id);
let shown = 0;
const timer = setInterval(async () => {
  const current = await synthesis.get(run.id).catch(() => undefined);
  if (!current) return;
  for (const event of current.events.slice(shown)) if (event.status !== "running") console.log(`  ${((Date.parse(event.at) - started) / 1000).toFixed(1).padStart(6)}s ${event.status === "ok" ? "✓" : "✗"} ${event.step}: ${masked(event.message).slice(0, 160)}`);
  shown = current.events.length;
}, 1000);
const result = await synthesis.wait(run.id);
clearInterval(timer);
for (const event of result.events.slice(shown)) if (event.status !== "running") console.log(`  ${((Date.parse(event.at) - started) / 1000).toFixed(1).padStart(6)}s ${event.status === "ok" ? "✓" : "✗"} ${event.step}: ${masked(event.message).slice(0, 160)}`);

console.log(`\nRun ${result.status}${result.error ? `: ${masked(result.error)}` : ""} in ${((Date.now() - started) / 1000).toFixed(1)} s, iteration ${result.iteration}.`);
console.log(`Models: ${result.models.map(model => `${model.providerId}/${model.id}`).join(", ") || "none"}.`);
console.log(`Calls ${result.usage.calls}, tokens ${result.usage.inputTokens} in, ${result.usage.outputTokens} out.`);
for (const gate of result.evidence?.gates ?? []) console.log(`  gate ${gate.id}: ${gate.status} ${masked(gate.message).slice(0, 140)}`);
if (result.agents) {
  const agents = await synthesis.agents(result.id);
  console.log(`\nAgents: ${JSON.stringify(result.agents)}`);
  console.log(["#", "model", "status", "steps", "tokens in/out", "seconds", "files", "task"].join("\t"));
  for (const agent of agents.items) console.log([agent.index, `${agent.providerId}/${agent.model}`, agent.status, agent.steps, `${agent.inputTokens}/${agent.outputTokens}`,
    (agent.durationMs / 1000).toFixed(1), agent.files.join(" ") || "-", masked(agent.task).slice(0, 60)].join("\t"));
  for (const agent of agents.items.filter(item => item.error)) console.log(`  agent ${agent.index} error: ${masked(agent.error).slice(0, 200)}`);
}
const diff = await synthesis.diff(result.id);
console.log(`\nCandidate files: ${diff.files.map(file => `${file.path} (${Buffer.byteLength(file.after)} B)`).join(", ") || "none"}.`);
if (args.includes("--keep")) console.log(`Kept ${temp}`); else fs.rmSync(temp, { recursive: true, force: true });
await synthesis.dispose();
process.exit(result.status === "accepted" ? 0 : 1);
