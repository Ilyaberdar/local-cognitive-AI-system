import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { ProjectStore } from "../src/projects/ProjectStore";
import { LLMRequest, LLMResponse, ManagedModel } from "../src/types";
import { SynthesisService } from "../src/synthesis/SynthesisService";
import { BudgetExhausted, Interpreter } from "../src/synthesis/Interpreter";
import { compileProgram, parseFlow } from "../src/synthesis/language";
import { calculatorTemplate } from "../src/synthesis/templates";
import { RunRecord } from "../src/synthesis/types";
import { localModel, workingFiles } from "./fixtures/synthesisFixture";

const tiny = localModel("qwen2.5-1.5b", 950_000_000);
interface FixtureOptions {
  templateMode?: "focused" | "compact";
  models?: () => ManagedModel[];
  content?: (file: string, call: number, request: LLMRequest) => string;
  load?: (model: ManagedModel, signal: AbortSignal) => Promise<void>;
  generation?: (request: LLMRequest) => Promise<void>;
  source?: (file: string, call: number, request: LLMRequest) => string | Partial<LLMResponse>;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const waitForAbort = (signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lcai-synthesis-test-")));
  const root = path.join(temp, "project");
  const data = path.join(temp, "app");
  await fs.mkdir(root); await fs.mkdir(data);
  const projects = new ProjectStore(data);
  const project = await projects.create({ name: "Calculator tests", rootPath: root });
  const requests: Array<{file: string; provider?: string; request: LLMRequest}> = [];
  const textRequests: Array<{file: string; provider?: string; request: LLMRequest}> = [];
  const loads: ManagedModel[] = [];
  const providers: Array<string | undefined> = [];
  const services = {
    projects,
    models: { listAllModels: async (provider?: string) => {
      providers.push(provider);
      return options.models?.() ?? [localModel("large-coder", 7_000_000_000), tiny, localModel("tiny-generic", 500_000_000)];
    } },
    loadModel: async (model: ManagedModel, signal: AbortSignal) => { loads.push(model); await options.load?.(model, signal); },
    llm: {
      generateObject: async <T extends object>(request: LLMRequest, provider?: string): Promise<{data: T | null; response: LLMResponse}> => {
        const match = /^Implement only the file (.+?)\. Other files:/.exec(request.prompt);
        assert.ok(match, "Provider receives a bounded file task");
        const file = match[1];
        requests.push({file, provider, request});
        await options.generation?.(request);
        const content = options.content?.(file, requests.length, request) ?? workingFiles[file];
        assert.equal(typeof content, "string", `No test output for ${file}`);
        return {data: {content} as unknown as T, response: {provider: provider ?? "llamacpp", model: request.model ?? "", text: JSON.stringify({content}), usage: {inputTokens: 50, outputTokens: 100}}};
      },
      generateText: async (request: LLMRequest, provider?: string): Promise<LLMResponse> => {
        const match = /^Implement only the file (.+?)\. Other files:/.exec(request.prompt);
        if (!match) return {provider: provider ?? "llamacpp", model: request.model ?? "", text: "Advisory notes only."};
        const file = match[1]; textRequests.push({file, provider, request});
        await options.generation?.(request);
        const answer = options.source?.(file, textRequests.length, request) ?? workingFiles[file];
        return {provider: provider ?? "llamacpp", model: request.model ?? "", usage: {inputTokens: 50, outputTokens: 100}, text: typeof answer === "string" ? answer : answer.text ?? "", ...(typeof answer === "string" ? {} : answer)};
      }
    }
  };
  const service = new SynthesisService(data, services);
  await service.init();
  const created = await service.createModule(project.id);
  assert.equal(created.valid, true, JSON.stringify(created.diagnostics));
  // Existing regression tests deliberately exercise the stable JSON repair loop.
  // A separate test below exercises the user-facing focused source template.
  if (options.templateMode !== "focused") {
    await fs.writeFile(path.join(root, created.flowPath), calculatorTemplate("Calculator", "compact").flow);
  }
  const module = await service.module(project.id, "Calculator");
  assert.equal(module.valid, true, JSON.stringify(module.diagnostics));
  const instances = [service];
  t.after(async () => { await Promise.all(instances.map(item => item.dispose())); await fs.rm(temp, {recursive: true, force: true}); });
  const readRecord = async (id: string) => JSON.parse(await fs.readFile(path.join(data, "synthesis", "runs", `${id}.json`), "utf8")) as RunRecord;
  const writeSources = async (update: {spec?: string; flow?: string}) => {
    if (update.spec !== undefined) await fs.writeFile(path.join(root, module.specPath), update.spec);
    if (update.flow !== undefined) await fs.writeFile(path.join(root, module.flowPath), update.flow);
  };
  const run = async () => service.wait((await service.start(project.id, "Calculator")).id);
  const newService = async () => { const next = new SynthesisService(data, services); instances.push(next); await next.init(); return next; };
  return {temp, root, data, projects, project, service, module, requests, textRequests, loads, providers, writeSources, readRecord, run, newService};
}

test("DSL lists/selects/loads a tiny local model, repairs failed evidence, and accepts without writing the project", async (t) => {
  const f = await fixture(t, {content: (file, call) => file === "calculator.js" && call <= 3 ? workingFiles[file].replace("return a+b", "return a-b") : workingFiles[file]});
  const result = await f.run();
  assert.equal(result.status, "accepted", result.error);
  assert.equal(result.iteration, 2);
  assert.deepEqual(f.providers, ["llamacpp"]);
  assert.deepEqual(f.loads.map(item => item.id), [tiny.id]);
  assert.ok(f.requests.every(item => item.provider === "llamacpp" && item.request.model === tiny.id));
  assert.equal(result.usage.calls, 6);
  assert.ok(f.requests[3].request.prompt.includes("arithmetic:"), "Failure evidence reaches the next revision");
  assert.ok(result.events.some(item => item.step === "gate.arithmetic" && item.status === "failed"));
  assert.ok(result.events.some(item => item.step === "gate.arithmetic" && item.status === "ok"));
  assert.equal(result.evidence?.status, "Pass");
  assert.equal(result.evidence?.gates.length, 3, "two declared gates and the implicit artifacts gate");
  assert.equal(result.evidence?.gates.find(gate => gate.id === "artifacts")?.status, "Pass");
  assert.ok(result.events.every((event, index) => index === 0 || event.sequence > result.events[index - 1].sequence));
  await assert.rejects(fs.access(path.join(f.root, "calculator")), {code: "ENOENT"});
  assert.equal(await fs.readFile(path.join(f.root, f.module.flowPath), "utf8"), f.module.flowSource);
  const diff = await f.service.diff(result.id);
  assert.equal(diff.canApply, true);
  assert.equal(diff.files.length, 3);
  assert.ok(diff.files.every(item => item.before === null));
  const page = await f.service.preview(result.id, "index.html");
  assert.match(page, /<meta http-equiv="Content-Security-Policy"/);
  assert.doesNotMatch(page, /<script[^>]+src=/, "the preview is one self-contained page");
});

test("Apply writes only an accepted candidate, preserves unrelated files and prevents repeated application", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "notes.txt"), "keep this");
  const result = await f.run(); assert.equal(result.status, "accepted", result.error);
  await f.service.apply(result.id);
  for (const [file, text] of Object.entries(workingFiles)) assert.equal(await fs.readFile(path.join(f.root, "calculator", file), "utf8"), text);
  assert.equal(await fs.readFile(path.join(f.root, "notes.txt"), "utf8"), "keep this");
  assert.ok((await f.service.get(result.id)).appliedAt);
  assert.equal((await f.service.diff(result.id)).canApply, false);
  await assert.rejects(f.service.apply(result.id), /unapplied/);
});

test("Apply detects an external source edit before writing any candidate files", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "calculator"));
  await fs.writeFile(path.join(f.root, "calculator", "calculator.js"), "// original user file");
  const result = await f.run(); assert.equal(result.status, "accepted", result.error);
  await fs.writeFile(path.join(f.root, "calculator", "calculator.js"), "// changed in IDE");
  await assert.rejects(f.service.apply(result.id), /Apply conflict/);
  assert.equal(await fs.readFile(path.join(f.root, "calculator", "calculator.js"), "utf8"), "// changed in IDE");
  await assert.rejects(fs.access(path.join(f.root, "calculator", "index.html")), {code: "ENOENT"});
});

test("a later revision invalidates previously passing acceptance evidence", async (t) => {
  const f = await fixture(t);
  await f.writeSources({flow: f.module.flowSource!.replace("return accept(candidate, evidence);", "candidate = await developer.revise(candidate, spec, feedback, file = \"calculator.js\"); return accept(candidate, evidence);")});
  const result = await f.run();
  assert.equal(result.status, "blocked");
  assert.match(result.error!, /fresh trusted Pass evidence/);
  assert.equal((await f.service.diff(result.id)).canApply, false);
  await assert.rejects(f.service.apply(result.id), /fresh accepted/);
});

test("verify refuses evidence from an earlier candidate revision", async (t) => {
  const f = await fixture(t);
  await f.writeSources({flow: f.module.flowSource!.replace("verdict = verify(spec, evidence);", "candidate = await developer.revise(candidate, spec, feedback, file = \"calculator.js\"); verdict = verify(spec, evidence);")});
  const result = await f.run();
  assert.equal(result.status, "blocked");
  assert.match(result.error!, /missing or stale/);
});

test("unknown trusted evaluator becomes NeedsReview and never Pass", async (t) => {
  const f = await fixture(t);
  await f.writeSources({spec: f.module.specSource!.replace('Pass("calculator-arithmetic-v1")', 'Pass("missing-evaluator-v1")')});
  const result = await f.run();
  assert.equal(result.status, "needs_review", result.error);
  assert.equal(result.evidence?.status, "Unknown");
  assert.equal(result.evidence?.gates[0].status, "Unknown");
  assert.equal((await f.service.diff(result.id)).canApply, false);
});

test("the global iteration budget terminates repeated failures as Unresolved", async (t) => {
  const f = await fixture(t, {content: (file) => file === "calculator.js" ? "function calculate(){return 0;}" : workingFiles[file]});
  await f.writeSources({flow: f.module.flowSource!.replace("iterations 6", "iterations 2")});
  const result = await f.run();
  assert.equal(result.status, "unresolved");
  assert.equal(result.iteration, 2);
  assert.match(result.error!, /Iteration budget exhausted/);
  assert.equal(result.evidence?.status, "Fail");
  assert.equal(f.requests.length, 6);
  await assert.rejects(f.service.apply(result.id), /fresh accepted/);
});

test("cancellation propagates to pending model operations and persists Cancelled", async (t) => {
  const entered = deferred();
  const f = await fixture(t, {load: async (_model, signal) => { entered.resolve(); await waitForAbort(signal); }});
  const started = await f.service.start(f.project.id, "Calculator");
  await entered.promise;
  const result = await f.service.cancel(started.id);
  assert.equal(result.status, "cancelled");
  assert.match(result.error!, /Cancelled by user/);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.readRecord(started.id)).status, "cancelled");
});

test("Apply is unavailable while a run is actively awaiting a model operation", async (t) => {
  const entered = deferred();
  const f = await fixture(t, {load: async (_model, signal) => { entered.resolve(); await waitForAbort(signal); }});
  const started = await f.service.start(f.project.id, "Calculator");
  await entered.promise;
  assert.equal((await f.service.get(started.id)).status, "running");
  await assert.rejects(f.service.apply(started.id), /fresh accepted|active|running/);
  await assert.rejects(fs.access(path.join(f.root, "calculator")), {code: "ENOENT"});
  await f.service.cancel(started.id);
});

test("run cannot begin when a flow tries to accept and then continue modifying its candidate", async (t) => {
  const f = await fixture(t);
  await f.writeSources({flow: f.module.flowSource!.replace("return accept(candidate, evidence);", "accept(candidate, evidence); candidate = await developer.revise(candidate, spec, feedback); return unresolved();")});
  const module = await f.service.module(f.project.id, "Calculator");
  assert.equal(module.valid, false);
  assert.ok(module.diagnostics.some(item => item.code === "FLOW_TERMINAL_RETURN"));
  await assert.rejects(f.service.start(f.project.id, "Calculator"), /direct expression of a return/);
  assert.equal(f.loads.length, 0);
});

test("wall-clock budget aborts a pending generation without accepting partial output", async (t) => {
  const entered = deferred();
  const f = await fixture(t, {generation: async (request) => { entered.resolve(); await waitForAbort(request.signal!); }});
  await f.writeSources({flow: f.module.flowSource!.replace("time 15m", "time 150ms")});
  const started = await f.service.start(f.project.id, "Calculator");
  await entered.promise;
  const keepAlive = setInterval(() => {}, 100);
  try {
    const result = await f.service.wait(started.id);
    assert.equal(result.status, "unresolved");
    assert.match(result.error!, /Wall-clock time budget exhausted/);
    assert.equal(result.evidence, undefined);
  } finally { clearInterval(keepAlive); }
});

test("restart creates a distinct run using frozen DSL after the authored files change", async (t) => {
  let available = false;
  const f = await fixture(t, {models: () => available ? [tiny] : []});
  const first = await f.run(); assert.equal(first.status, "blocked");
  await f.writeSources({flow: "this is an incomplete external edit", spec: "module broken"});
  available = true;
  const restarted = await f.service.restart(first.id);
  const result = await f.service.wait(restarted.id);
  assert.notEqual(result.id, first.id);
  assert.equal(result.restartedFrom, first.id);
  assert.equal(result.status, "accepted", result.error);
  assert.equal((await f.service.get(first.id)).status, "blocked");
  const original = await f.readRecord(first.id), next = await f.readRecord(result.id);
  assert.equal(next.specSource, original.specSource);
  assert.equal(next.flowSource, original.flowSource);
  assert.equal(next.specHash, original.specHash);
  await assert.rejects(f.service.restart(result.id), /Only unsuccessful or interrupted/);
});

test("runtime shutdown interrupts active work and startup recovers an abandoned persisted run", async (t) => {
  const entered = deferred();
  const f = await fixture(t, {load: async (_model, signal) => { entered.resolve(); await waitForAbort(signal); }});
  const started = await f.service.start(f.project.id, "Calculator");
  await entered.promise; await f.service.dispose();
  assert.equal((await f.service.get(started.id)).status, "interrupted");
  const record = await f.readRecord(started.id);
  // Simulate a process exit between the last persisted running event and finalization.
  record.status = "running";
  await fs.writeFile(path.join(f.data, "synthesis", "runs", `${record.id}.json`), JSON.stringify(record));
  const restored = await f.newService();
  const recovered = await restored.get(record.id);
  assert.equal(recovered.status, "interrupted");
  assert.ok(recovered.events.some(event => event.step === "recovery"));
  assert.equal(f.loads.length, 1, "Recovery must not replay a model load or other side effect");
});

test("paths reject candidate traversal and module/editor identifiers outside the project", async (t) => {
  const f = await fixture(t);
  await f.writeSources({flow: f.module.flowSource!.replace('checkout("calculator")', 'checkout("../outside")')});
  const result = await f.run();
  assert.equal(result.status, "blocked");
  assert.match(result.error!, /relative path/);
  assert.equal(f.requests.length, 0);
  await assert.rejects(f.service.editorPath(f.project.id, "../outside"), /Module names/);
  await assert.rejects(f.service.createModule(f.project.id, "../outside"), /Module names/);
  await assert.rejects(f.service.preview(result.id, "../outside.js"), /relative path/);
});

test("symlinks cannot redirect source reads, candidate checkout or Apply", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.temp, "outside"); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.root, "calculator"), "dir");
  const blocked = await f.run();
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.error!, /Symbolic links/);
  await fs.unlink(path.join(f.root, "calculator"));
  const accepted = await f.run(); assert.equal(accepted.status, "accepted", accepted.error);
  await fs.symlink(outside, path.join(f.root, "calculator"), "dir");
  await assert.rejects(f.service.apply(accepted.id), /Symbolic links/);
  assert.deepEqual(await fs.readdir(outside), []);
  const specPath = path.join(f.root, f.module.specPath);
  await fs.rename(specPath, path.join(outside, "contract.lcspec"));
  await fs.symlink(path.join(outside, "contract.lcspec"), specPath);
  const module = await f.service.module(f.project.id, "Calculator");
  assert.equal(module.valid, false);
  assert.ok(module.diagnostics.some(item => item.code === "SOURCE_READ" && /Symbolic links/.test(item.message)));
});

test("model selection stays local, enforces declared size and cannot fabricate an installed model", async (t) => {
  const cloud = {...tiny, id: "cloud-qwen", providerId: "cloud"};
  const f = await fixture(t, {models: () => [localModel("big", 4_000_000_000), cloud]});
  const result = await f.run();
  assert.equal(result.status, "blocked");
  assert.match(result.error!, /No installed local model matches/);
  assert.equal(f.loads.length, 0);
  assert.equal(f.requests.length, 0);
});

test("declared per-file revisions cannot write an undeclared artifact", async (t) => {
  const f = await fixture(t);
  await f.writeSources({flow: f.module.flowSource!.replace("developer.revise(candidate, spec, feedback)", "developer.revise(candidate, spec, feedback, file = \"outside.js\")")});
  const result = await f.run();
  assert.equal(result.status, "blocked");
  assert.match(result.error!, /only declared artifact files/);
  assert.equal(f.requests.length, 0);
});

test("interpreter follows conditions, continue and short circuit without evaluating skipped actions", async () => {
  const source = `implement Calculator using "calculator-v1" {
    limit iterations 4, time 1m;
    policy = "local-files-v1";
    count = 0;
    while (count < 3) {
      count = count + 1;
      if (count == 1) { continue; }
      if (false && stagnant(1)) { checkpoint("not called"); }
      if (true || stagnant(1)) { checkpoint(count); }
    }
    return unresolved();
  }`;
  const compiled = compileProgram(calculatorTemplate().spec, source);
  assert.deepEqual(compiled.diagnostics, []);
  const calls: Array<{name: string; args: unknown[]}> = [];
  const iterations: number[] = [];
  const interpreter = new Interpreter({signal: new AbortController().signal, globals: {},
    call: async (name, args) => { calls.push({name, args}); return name === "unresolved" ? "done" : undefined; },
    iteration: async (value) => { iterations.push(value); }
  }, compiled.flow!);
  assert.equal(await interpreter.run(), "done");
  assert.deepEqual(iterations, [1, 2, 3]);
  assert.deepEqual(calls, [{name: "checkpoint", args: [2]}, {name: "checkpoint", args: [3]}, {name: "unresolved", args: []}]);
});

test("nested loops share a single iteration budget and an already aborted interpreter makes no calls", async () => {
  const parsed = parseFlow(`implement Calculator using "calculator-v1" { limit iterations 2, time 1m; while (true) { while (true) { continue; } } }`);
  assert.deepEqual(parsed.diagnostics, []);
  const iterations: number[] = [];
  const controller = new AbortController();
  const host = {signal: controller.signal, globals: {}, call: async () => { assert.fail("No actions expected"); }, iteration: async (value: number) => { iterations.push(value); }};
  await assert.rejects(new Interpreter(host, parsed.ast!).run(), BudgetExhausted);
  assert.deepEqual(iterations, [1, 2]);
  controller.abort(new Error("stop"));
  await assert.rejects(new Interpreter(host, parsed.ast!).run(), /stop/);
  assert.deepEqual(iterations, [1, 2]);
});

test("source-mode DSL revisions generate one raw or fenced file at a time with focused instructions", async (t) => {
  const f = await fixture(t, {source: (file) => file === "style.css" ? workingFiles[file] : "```" + (file.endsWith(".js") ? "javascript" : "html") + "\n" + workingFiles[file] + "\n```"});
  const revisions = Object.keys(workingFiles).map(file => `candidate = await developer.revise(candidate, spec, feedback, file = "${file}", format = "source", instruction = "Focused task for ${file}");`).join("\n");
  await f.writeSources({flow: f.module.flowSource!.replace("candidate = await developer.revise(candidate, spec, feedback);", revisions)});
  const result = await f.run();
  assert.equal(result.status, "accepted", result.error);
  assert.equal(result.iteration, 1);
  assert.equal(f.requests.length, 0, "Source mode must not require JSON-escaped file content");
  assert.equal(f.textRequests.length, 3);
  assert.ok(f.textRequests.every(item => item.request.prompt.includes(`Focused task for ${item.file}`)));
  const record = await f.readRecord(result.id);
  for (const [file, content] of Object.entries(workingFiles)) assert.equal(record.files[file].trim(), content.trim());
  await assert.rejects(fs.access(path.join(f.root, "calculator")), {code: "ENOENT"});
});

test("source mode rejects mixed, multiple and incomplete fences without replacing a candidate file", async (t) => {
  const invalid = [
    "Here is the file:\n```css\nbody { color: red; }\n```",
    "```css\nbody { color: red; }\n```\n```css\nbody { color: blue; }\n```",
    "```css\nbody { color: red; }"
  ];
  for (const text of invalid) {
    const f = await fixture(t, {source: () => text});
    await fs.mkdir(path.join(f.root, "calculator"));
    await fs.writeFile(path.join(f.root, "calculator", "style.css"), "body { color: green; }");
    const prefix = f.module.flowSource!.slice(0, f.module.flowSource!.indexOf("    while"));
    await f.writeSources({flow: prefix + 'candidate = await developer.revise(candidate, spec, feedback, file = "style.css", format = "source"); return unresolved(); }'});
    const result = await f.run();
    assert.equal(result.status, "unresolved", result.error);
    const record = await f.readRecord(result.id);
    assert.equal(record.files["style.css"], "body { color: green; }");
    assert.ok(result.events.some(event => event.step === "agent.generate" && event.status === "failed"));
  }
});

test("source mode retains the artifact allowlist before requesting model text", async (t) => {
  const f = await fixture(t);
  await f.writeSources({flow: f.module.flowSource!.replace("developer.revise(candidate, spec, feedback)", "developer.revise(candidate, spec, feedback, file = \"outside.js\", format = \"source\", instruction = \"Try writing outside\")")});
  const result = await f.run();
  assert.equal(result.status, "blocked");
  assert.match(result.error!, /only declared artifact files/);
  assert.equal(f.requests.length + f.textRequests.length, 0);
});

test("source mode rejects provider-truncated output instead of saving an incomplete file", async (t) => {
  const f = await fixture(t, {source: () => ({text: "body { color: red", error: "Model response stopped: length. No action was executed."})});
  await fs.mkdir(path.join(f.root, "calculator"));
  await fs.writeFile(path.join(f.root, "calculator", "style.css"), "body { color: green; }");
  const prefix = f.module.flowSource!.slice(0, f.module.flowSource!.indexOf("    while"));
  await f.writeSources({flow: prefix + 'candidate = await developer.revise(candidate, spec, feedback, file = "style.css", format = "source"); return unresolved(); }'});
  const result = await f.run();
  assert.equal(result.status, "unresolved", result.error);
  assert.equal((await f.readRecord(result.id)).files["style.css"], "body { color: green; }");
  assert.ok(result.events.some(event => event.step === "agent.generate" && event.status === "failed" && event.message.includes("stopped: length")));
});

test("the default focused template selects the tested local coder and accepts per-file source revisions", async (t) => {
  const testedCoder = localModel("qwen2.5-7b", 4_800_000_000);
  const f = await fixture(t, {templateMode: "focused", models: () => [tiny, testedCoder]});
  assert.match(f.module.flowSource!, /max_size\s*=\s*6GiB/);
  assert.match(f.module.flowSource!, /prefer\s*=\s*"qwen2\.5-7b"/);
  assert.match(f.module.flowSource!, /format\s*=\s*"source"/);
  const result = await f.run();
  assert.equal(result.status, "accepted", result.error);
  assert.equal(result.iteration, 1);
  assert.equal(result.usage.calls, 3);
  assert.deepEqual(f.loads.map(model => model.id), [testedCoder.id]);
  assert.equal(f.requests.length, 0);
  assert.equal(f.textRequests.length, 3);
  assert.deepEqual(new Set(f.textRequests.map(item => item.file)), new Set(Object.keys(workingFiles)));
  await assert.rejects(fs.access(path.join(f.root, "calculator")), {code: "ENOENT"});
});

test("a candidate missing a declared file is never accepted, even when every declared gate passes", { timeout: 20_000 }, async t => {
  // The gates check only calculator.js; the model never writes index.html or style.css.
  const f = await fixture(t, { content: file => file === "calculator.js" ? workingFiles[file] : "" });
  const result = await f.run();
  assert.notEqual(result.status, "accepted");
  const artifacts = result.evidence?.gates.find(gate => gate.id === "artifacts");
  assert.equal(artifacts?.status, "Fail");
  assert.match(String(artifacts?.message), /index\.html, style\.css/);
});

test("module discovery skips a file it cannot name instead of failing the whole list, and errors name project files only", async t => {
  const f = await fixture(t);
  // Each folder is short enough to be searched; the file's whole path is over the 240-character limit.
  const deep = path.join(f.root, ...Array.from({ length: 5 }, (_, index) => `a-folder-with-quite-a-long-descriptive-name-${index}`));
  await fs.mkdir(deep, { recursive: true });
  await fs.writeFile(path.join(deep, "VeryLongModuleNameThatPushesThePathOverTheLimit.lcspec"), "module Long {}");
  assert.ok((await f.service.modules(f.project.id)).some(module => module.id === "Calculator"), "the other modules are still listed");
  await fs.mkdir(path.join(f.root, "Synthesis", "Half"), { recursive: true });
  await fs.writeFile(path.join(f.root, "Synthesis", "Half", "Half.lcspec"), "module Half {}");
  const half = await f.service.module(f.project.id, "Half");
  assert.equal(half.valid, false);
  assert.equal(half.diagnostics[0]!.message, "Missing Synthesis/Half/Half.lcflow.");
  assert.equal(JSON.stringify(half).includes(f.temp), false, "no folder of the host");
  await assert.rejects(f.service.folders(f.project.id, "Nope"), (error: unknown) => (error as { statusCode?: number }).statusCode === 404);
});

test("what Run would refuse is shown on the module before Run, and an unregistered evaluator is a warning", async t => {
  const f = await fixture(t);
  const files = Array.from({ length: 13 }, (_, index) => `        file "part${index}.js";`).join("\n");
  await f.writeSources({
    spec: `module Calculator version "1" {\n    description = "Too much.";\n\n    artifacts {\n${files}\n        file "main.ts";\n        file "my file.js";\n    }\n\n    evaluate "calculator-v1" {\n        hard arithmetic = Pass("calculator-arithmetic-v1");\n    }\n}\n`,
    flow: calculatorTemplate("Calculator", "compact").flow.replace("limit iterations 6, time 15m", "limit iterations 40, time 180m")
  });
  const module = await f.service.module(f.project.id, "Calculator");
  assert.equal(module.valid, false);
  const codes = new Set(module.diagnostics.map(item => item.code));
  for (const expected of ["SPEC_ARTIFACT_LIMIT", "SPEC_ARTIFACT_TYPE", "SPEC_ARTIFACT_PATH", "FLOW_LIMIT_RANGE"]) assert.ok(codes.has(expected), expected);
  await assert.rejects(f.service.start(f.project.id, "Calculator"), /invalid|Declare|iterations/i);

  const empty = await f.service.createModule(f.project.id, "Starter", { template: "empty" });
  assert.equal(empty.valid, true, "a starter module stays runnable");
  assert.ok(empty.diagnostics.some(item => item.code === "SPEC_EVALUATOR_UNREGISTERED" && item.severity === "warning"));
});
