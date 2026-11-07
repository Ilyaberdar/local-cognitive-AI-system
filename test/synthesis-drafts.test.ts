import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { ProjectStore } from "../src/projects/ProjectStore";
import { LLMRequest, LLMResponse, ProviderDescriptor } from "../src/types";
import { SynthesisService } from "../src/synthesis/SynthesisService";
import { checkDraft, draftPrompt, parseDraft, repairPrompt } from "../src/synthesis/draft";
import { SynthesisDraft, SynthesisError } from "../src/synthesis/types";
import { localModel } from "./fixtures/synthesisFixture";

const spec = (tests = `hard behavior = Tests("tests/add.test.ts");`) => `module Adder version "1" {
    target { language = TypeScript; }
    description = "[C1] src/add.ts exports add(a: number, b: number): number. [C2] add returns a + b. [C3] add throws TypeError when either argument is not a finite number.";
    artifacts { file "src/add.ts"; }
    evaluate "contract-v1" {
        hard shape = Exports("src/add.ts", ["add"]);   // [C1]
        ${tests}
    }
}`;
const testFile = (clauses = ["C2", "C3"]) => `import assert from "node:assert/strict";
import test from "node:test";
import { add } from "../src/add.ts";
${clauses.includes("C2") ? `test("[C2] adds", () => { assert.equal(add(1, 2), 3); });\n` : ""}${clauses.includes("C3") ? `test("[C3] refuses NaN", () => { assert.throws(() => add(Number.NaN, 1), TypeError); });\n` : ""}`;
const answer = (contract: string, tests: Record<string, string>, extra = "") => `Here is the module.

### Adder.lcspec
\`\`\`lcspec
${contract}
\`\`\`
${Object.entries(tests).map(([file, text]) => `\n### ${file}\n\`\`\`ts\n${text}\`\`\`\n`).join("")}${extra}`;
const good = answer(spec(), {"tests/add.test.ts": testFile()});

const deepseek: ProviderDescriptor = {id: "deepseek", name: "DeepSeek", configured: true, defaultModel: "deepseek-flash", capabilities: {local: false}} as ProviderDescriptor;

type Answer = string | {text: string; raw?: unknown};
async function draftFixture(t: TestContext, answers: Array<Answer | ((request: LLMRequest) => Promise<Answer>)>) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lcai-draft-test-")));
  const root = path.join(temp, "project"), data = path.join(temp, "app");
  await fs.mkdir(root); await fs.mkdir(data);
  const projects = new ProjectStore(data);
  const project = await projects.create({name: "Draft tests", rootPath: root});
  const requests: Array<LLMRequest & {provider?: string}> = [];
  const loaded: string[] = [];
  const service = new SynthesisService(data, {
    projects,
    models: {listAllModels: async () => [localModel("qwen3.8-27b-q4", 16_000_000_000), localModel("qwen2.5-coder-7b", 4_700_000_000)]},
    loadModel: async model => { loaded.push(model.id); },
    contextWindow: () => 16_384,
    providers: () => [deepseek],
    catalog: {listAll: async () => [{id: "deepseek-flash", providerId: "deepseek", providerName: "DeepSeek"}]},
    llm: {
      generateObject: async () => { throw new Error("drafts are text"); },
      generateText: async (request: LLMRequest, provider?: string): Promise<LLMResponse> => {
        requests.push({...request, provider});
        const next = answers[Math.min(requests.length, answers.length) - 1]!;
        // As a local stream reports itself: thinking, then the answer.
        request.onProgress?.({phase: "thinking", model: request.model ?? ""}); request.onProgress?.({phase: "responding", model: request.model ?? ""});
        const value = typeof next === "function" ? await next(request) : next;
        const {text, raw} = typeof value === "string" ? {text: value, raw: undefined} : value;
        return {provider: provider ?? "llamacpp", model: request.model ?? "", text, raw, usage: {inputTokens: 1000, outputTokens: 300}};
      }
    }
  });
  await service.init();
  t.after(async () => { await service.dispose(); await fs.rm(temp, {recursive: true, force: true}); });
  const settle = async (id: string): Promise<SynthesisDraft> => {
    for (let i = 0; i < 400; i++) { const draft = await service.drafts.get(id); if (draft.status !== "drafting") return draft; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error("the draft did not settle");
  };
  return {root, data, project, projects, service, requests, loaded, settle};
}
const local = {providerId: "llamacpp", id: "qwen3.8-27b-q4"};
const input = (extra: Record<string, unknown> = {}) => ({name: "Adder", language: "TypeScript", description: "Adds two finite numbers and refuses anything else with a TypeError.", model: local, ...extra});

test("a draft's prompt teaches with the reference and an example in its language, and its answer is read by headings", () => {
  const {system, prompt} = draftPrompt({name: "Slugger", language: "Python", output: "slugger", description: "Makes URL slugs."});
  assert.match(system, /# LC Spec and LC Flow: what a module author needs/);
  assert.match(system, /### Slug\.lcspec\n```lcspec\nmodule Slug/, "the Python example");
  assert.match(system, /### tests\/test_slug\.py\n```python\n/);
  assert.match(system, /Never `hidden = true`/);
  assert.match(system, /unittest, in tests\/test_\*\.py/);
  assert.match(prompt, /Module name: Slugger\nLanguage: Python\nOutput folder \(where the module's files go\): slugger\n/);
  assert.match(draftPrompt({name: "A", language: "JavaScript", output: "a", description: "x"}).system, /### RateLimiter\.lcspec/, "JavaScript learns from the TypeScript example");

  const parsed = parseDraft(answer(spec(), {"tests/add.test.ts": testFile()}, "\n### Adder.lcflow\n```lcflow\nimplement Adder ...\n```\n\n### src/add.ts\n```ts\nexport const add = 1;\n```\n"), "Adder");
  assert.match(parsed.spec!, /^module Adder version "1"/);
  assert.deepEqual(Object.keys(parsed.tests), ["tests/add.test.ts"]);
  assert.deepEqual(parsed.ignored, ["Adder.lcflow", "src/add.ts"], "no flow and no implementation are taken from the model");
  assert.equal(parseDraft("no blocks at all", "Adder").spec, undefined);

  const repair = repairPrompt("BASE", "LAST ANSWER", [{severity: "error", code: "SPEC_TEST_MISSING", message: "Test file x was not found.", file: "S/A.lcspec", line: 1, column: 1}]);
  assert.match(repair, /^BASE\n\n# Your last answer\n\nLAST ANSWER\n\n# The check found these problems\n\n- S\/A\.lcspec:1:1 error SPEC_TEST_MISSING: Test file x was not found\. Fix: Write the test file at the path/);
});

test("a draft may not seal tests or declare the engineer's files, and names a test file nothing runs", async () => {
  const checked = await checkDraft({name: "Adder", specPath: "Synthesis/Adder/Adder.lcspec", flowPath: "Synthesis/Adder/Adder.lcflow",
    spec: spec(`hard behavior = Tests("tests/add.test.ts"); soft holdout = Tests("tests/holdout.test.ts", hidden = true);`).replace(`file "src/add.ts";`, `frozen "src/types.ts"; file "src/add.ts";`),
    tests: {"tests/add.test.ts": testFile(), "tests/holdout.test.ts": testFile(), "tests/extra.test.ts": "x"}});
  assert.deepEqual(checked.diagnostics.map(item => [item.severity, item.code]),
    [["error", "DRAFT_FROZEN"], ["error", "DRAFT_HIDDEN"], ["warning", "DRAFT_TEST_UNUSED"]]);
  assert.equal(checked.valid, false);
  assert.deepEqual(checked.clauses, ["C1", "C2", "C3"]);

  // Paths in artifacts are inside the output folder: one that repeats it would nest the module in itself.
  const nested = await checkDraft({name: "Adder", specPath: "Synthesis/Adder/Adder.lcspec", flowPath: "Synthesis/Adder/Adder.lcflow", output: "lib/adder/",
    spec: spec().replace(`file "src/add.ts";`, `file "lib/adder/add.ts";`), tests: {"tests/add.test.ts": testFile()}});
  const repeated = nested.diagnostics.find(item => item.code === "DRAFT_OUTPUT_REPEATED");
  assert.equal(repeated?.severity, "warning");
  assert.match(repeated!.message, /would be written to lib\/adder\/lib\/adder\/add\.ts\. Declare it as "add\.ts"/);
});

test("a draft is checked and sent back with its problems until it holds, then runs on the model that wrote it", async (t) => {
  const first = answer(spec(`hard behavior = Tests("tests/add.test.ts", "tests/more.test.ts");`), {"tests/add.test.ts": testFile(["C2"])});
  const f = await draftFixture(t, [first, good]);
  const created = await f.service.drafts.create(f.project.id, input());
  assert.equal(created.status, "drafting");
  assert.equal(created.specPath, "Synthesis/Adder/Adder.lcspec");
  const draft = await f.settle(created.id);
  assert.equal(draft.status, "ready", draft.error);
  assert.equal(draft.attempt, 2);
  assert.equal(draft.valid, true, JSON.stringify(draft.diagnostics));
  assert.deepEqual(draft.diagnostics, []);
  assert.deepEqual(Object.keys(draft.tests), ["tests/add.test.ts"]);
  assert.deepEqual(f.loaded, ["qwen3.8-27b-q4"], "a local model is loaded before it is asked");
  assert.equal(f.requests[0]!.localReasoningBudget, 1024, "a local model thinks within a budget, then writes");
  assert.equal(f.requests[0]!.maxTokens, 9024);
  assert.equal(typeof f.requests[0]!.onProgress, "function", "progress streams the answer");
  assert.deepEqual(draft.usage, {inputTokens: 2000, outputTokens: 600, calls: 2});
  assert.deepEqual(f.requests.map(request => [request.usagePurpose, request.model, request.provider]), [["synthesis-draft", "qwen3.8-27b-q4", "llamacpp"], ["synthesis-draft", "qwen3.8-27b-q4", "llamacpp"]]);
  // The second request carries the first answer's problems with their fixes.
  assert.match(f.requests[1]!.prompt, /SPEC_TEST_MISSING: Test file tests\/more\.test\.ts was not found next to the contract/);
  assert.match(f.requests[1]!.prompt, /SPEC_CLAUSE_UNTESTED: Nothing checks clause \[C3\]/);
  // The flow is derived, on the model that wrote the draft.
  assert.match(draft.flow!, /selected = models\.select\(available, id = "qwen3\.8-27b-q4"\);/);
  assert.match(draft.flow!, /candidate = await developer\.revise\(candidate, spec, feedback, file = "src\/add\.ts", format = "source"\);/);
  assert.match(draft.flow!, /checkout\("generated\/Adder"\)/);

  // Nothing is in the project until Save; then the contract, flow and tests are the user's module.
  await assert.rejects(fs.access(path.join(f.root, "Synthesis")));
  const module = await f.service.drafts.save(draft.id);
  assert.equal(module.valid, true, JSON.stringify(module.diagnostics));
  assert.equal(await fs.readFile(path.join(f.root, "Synthesis/Adder/Adder.lcspec"), "utf8"), draft.spec);
  assert.equal(await fs.readFile(path.join(f.root, "Synthesis/Adder/tests/add.test.ts"), "utf8"), draft.tests["tests/add.test.ts"]);
  await assert.rejects(f.service.drafts.get(draft.id), (error: SynthesisError) => error.statusCode === 404);
  assert.deepEqual(await f.service.drafts.list(f.project.id), []);
  // A draft of a module that now exists is refused before a model is asked.
  await assert.rejects(f.service.drafts.create(f.project.id, input()), (error: SynthesisError) => error.statusCode === 409);
});

test("a model that never gets it right leaves an editable draft with its problems; an edited contract derives its flow again", async (t) => {
  const sealed = answer(spec(`hard behavior = Tests("tests/add.test.ts"); soft holdout = Tests("tests/add.test.ts", hidden = true);`), {"tests/add.test.ts": testFile()});
  const f = await draftFixture(t, [sealed]);
  const draft = await f.settle((await f.service.drafts.create(f.project.id, input({output: "lib/adder"}))).id);
  assert.equal(draft.status, "ready");
  assert.equal(draft.attempt, 4);
  assert.equal(draft.valid, false);
  assert.ok(draft.diagnostics.some(item => item.code === "DRAFT_HIDDEN"));

  const edited = await f.service.drafts.update(draft.id, {spec: spec().replace('file "src/add.ts";', 'file "src/types.ts"; file "src/add.ts";')});
  assert.equal(edited.valid, true, JSON.stringify(edited.diagnostics));
  assert.deepEqual([...edited.flow!.matchAll(/file = "([^"]+)"/g)].map(match => match[1]), ["src/types.ts", "src/add.ts"]);
  assert.match(edited.flow!, /limit iterations 10, time 40m/);
  assert.match(edited.flow!, /checkout\("lib\/adder"\)/);
  const ownFlow = edited.flow!.replace("limit iterations 10", "limit iterations 3");
  const withFlow = await f.service.drafts.update(draft.id, {flow: ownFlow});
  assert.equal(withFlow.flowEdited, true);
  const kept = await f.service.drafts.update(draft.id, {spec: spec()});
  assert.equal(kept.flow, ownFlow, "a flow the user edited is not derived again");
  await assert.rejects(f.service.drafts.update(draft.id, {tests: {"src/add.ts": "x"}}), /test files live in tests\//);
});

test("a cloud model drafts only in a project that allows cloud models, and is offered only there", async (t) => {
  const f = await draftFixture(t, [good]);
  const models = await f.service.drafts.models(f.project.id);
  assert.deepEqual(models.local.map(model => model.id), ["qwen3.8-27b-q4", "qwen2.5-coder-7b"], "larger first");
  assert.deepEqual(models.cloud, [{providerId: "deepseek", providerName: "DeepSeek", models: ["deepseek-flash"], defaultModel: "deepseek-flash"}]);
  assert.equal(models.cloudAllowed, false);
  assert.deepEqual(models.recommended, {providerId: "llamacpp", id: "qwen3.8-27b-q4"}, "the largest installed model while cloud models are off");
  const cloud = {providerId: "deepseek", id: "deepseek-flash"};
  await assert.rejects(f.service.drafts.create(f.project.id, input({model: cloud})), (error: SynthesisError) => error.statusCode === 403 && /does not allow cloud models/.test(error.message));
  assert.equal(f.requests.length, 0);

  await f.projects.update(f.project.id, {cloudModels: true});
  assert.deepEqual((await f.service.drafts.models(f.project.id)).recommended, {providerId: "deepseek", id: "deepseek-flash"}, "the provider's own model where the project allows cloud models");
  const draft = await f.settle((await f.service.drafts.create(f.project.id, input({model: cloud}))).id);
  assert.equal(draft.valid, true, JSON.stringify(draft.diagnostics));
  assert.deepEqual(f.loaded, [], "a cloud model is not loaded");
  assert.equal(f.requests[0]!.provider, "deepseek");
  assert.equal(f.requests[0]!.localReasoningBudget, undefined, "a cloud model thinks as its provider lets it");
  assert.match(draft.flow!, /policy = "cloud-files-v1";\n\n {4}developer = await model\("deepseek-flash", provider = "deepseek"\);/);
});

test("a draft is refused without a name, a language, a description or an output outside Synthesis", async (t) => {
  const f = await draftFixture(t, [good]);
  for (const [bad, message] of [[{name: "1bad"}, /Module names/], [{language: "Rust"}, /TypeScript, JavaScript, Python or C\+\+/],
    [{description: "short"}, /20 to 6,000 characters/], [{output: "Synthesis/out"}, /not be inside a Synthesis folder/], [{model: {providerId: "llamacpp", id: "nope"}}, /not an installed local model/]] as const) {
    await assert.rejects(f.service.drafts.create(f.project.id, input(bad)), message);
  }
  assert.equal(f.requests.length, 0);
});

test("discarding a draft stops its model, and a draft the app stopped writing says so", async (t) => {
  let started!: () => void;
  const asked = new Promise<void>(resolve => { started = resolve; });
  const f = await draftFixture(t, [request => new Promise((_resolve, reject) => { started(); request.signal!.addEventListener("abort", () => reject(new Error("aborted"))); })]);
  const draft = await f.service.drafts.create(f.project.id, input());
  await asked;
  await f.service.drafts.discard(draft.id);
  assert.deepEqual(await f.service.drafts.list(f.project.id), []);

  // A record left drafting (the app stopped) is ready with what it has, or failed with nothing.
  const folder = path.join(f.data, "synthesis", "drafts");
  const stopped = {...draft, id: "00000000-0000-4000-8000-000000000001", status: "drafting", phase: "writing"};
  await fs.writeFile(path.join(folder, `${stopped.id}.json`), JSON.stringify(stopped));
  const service = new SynthesisService(f.data, {projects: f.projects, models: {listAllModels: async () => []}, loadModel: async () => undefined,
    llm: {generateObject: async () => { throw new Error("unused"); }, generateText: async () => { throw new Error("unused"); }}});
  await service.init();
  const after = await service.drafts.get(stopped.id);
  assert.equal(after.status, "failed");
  assert.equal(after.phase, undefined);
  assert.match(after.error!, /The app stopped while this draft was written/);
  await service.dispose();
});

test("a draft whose model ran out of time says so in plain words", async (t) => {
  const now = Date.now();
  // The request's time limit ends a slow local answer with no text, as the provider reports an abort.
  const f = await draftFixture(t, [async () => { t.mock.method(Date, "now", () => now + 30 * 60_000); return ""; }]);
  const draft = await f.settle((await f.service.drafts.create(f.project.id, input())).id);
  assert.equal(draft.status, "failed");
  assert.equal(f.requests[0]!.timeoutMs, 30 * 60_000);
  assert.match(draft.error!, /did not finish answer 1 in 30 minutes and was stopped/);
});

test("a cloud model that thinks past its token limit without an answer is asked once more with more room", async (t) => {
  // DeepSeek counts its thinking toward max_tokens: a first answer can be all thinking.
  const thought = {text: "", raw: {choices: [{finish_reason: "length", message: {content: ""}}]}};
  const f = await draftFixture(t, [thought, good]);
  await f.projects.update(f.project.id, {cloudModels: true});
  const draft = await f.settle((await f.service.drafts.create(f.project.id, input({model: {providerId: "deepseek", id: "deepseek-flash"}}))).id);
  assert.equal(draft.valid, true, JSON.stringify(draft.diagnostics));
  assert.deepEqual(f.requests.map(request => request.maxTokens), [8000, 32_000]);
  assert.equal(draft.attempt, 2);

  const g = await draftFixture(t, [thought]);
  await g.projects.update(g.project.id, {cloudModels: true});
  const failed = await g.settle((await g.service.drafts.create(g.project.id, input({model: {providerId: "deepseek", id: "deepseek-flash"}}))).id);
  assert.equal(g.requests.length, 2, "once, not every answer");
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /deepseek-flash reached its token limit before it wrote an answer \(its thinking counts toward the limit\)/);
});
