import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { ProjectStore } from "../src/projects/ProjectStore";
import { LLMRequest, LLMResponse, ManagedModel } from "../src/types";
import { BUDGET_MESSAGE, requestSeed, SynthesisService } from "../src/synthesis/SynthesisService";
import { applyEditBlocks, FEEDBACK_CHARS, filesUsedByTest, implicatedFiles, pointsAt, revisePrompt, RevisePromptInput } from "../src/synthesis/revisePrompt";
import { OpenAICompatibleProvider } from "../src/llm/OpenAICompatibleProvider";
import { Logger } from "../src/utils/Logger";
import { platformSandbox, unsandboxed } from "../src/synthesis/checks/sandbox";
import { localModel } from "./fixtures/synthesisFixture";

// How revise() helps a small model that copies the file it is shown: the result of the last check
// first-hand, one more request about one failure when a file comes back unchanged, the best candidate
// kept, and every request seeded and recorded.

const sandbox = async () => (await platformSandbox().unavailable()) ? unsandboxed : platformSandbox();
const NO_RUNNER = process.platform === "win32" && "Windows runs no contract tests: it has no sandbox yet";

const pairTests = `import assert from "node:assert/strict";
import test from "node:test";
import { add } from "../src/math.ts";
import { greet } from "../src/greet.ts";

test("adds", () => {
  assert.equal(add(2, 2), 4);
  assert.equal(add(2, 3), 5);
});
test("greets", () => {
  assert.equal(greet("Ann"), "Hello, Ann");
});
`;
const pairSpec = (name: string) => `module ${name} version "1" {
    target { language = TypeScript; }
    description = "src/math.ts exports function add(a: number, b: number): number, the sum. src/greet.ts exports function greet(name: string): string, 'Hello, ' and the name.";
    artifacts { file "src/math.ts"; file "src/greet.ts"; }
    tests { file "tests/pair.test.ts"; }
    evaluate "contract-v1" { hard behavior = Tests("tests/pair.test.ts", timeout = 30s); }
}`;
const pairFlow = (name: string, iterations: number) => `implement ${name} using "contract-v1" {
    limit iterations ${iterations}, time 5m, cost 0usd;
    policy = "local-files-v1";
    available = await models.list(provider = "llamacpp");
    selected = models.select(available);
    developer = await models.load(selected);
    spec = freeze(${name}.spec);
    candidate = checkout("${name.toLowerCase()}");
    feedback = none;
    while (!accepted(candidate, spec)) {
        candidate = await developer.revise(candidate, spec, feedback, file = "src/math.ts", format = "source");
        candidate = await developer.revise(candidate, spec, feedback, file = "src/greet.ts", format = "source");
        evidence = await evaluate(candidate, spec, keep = "best");
        verdict = verify(spec, evidence);
        if (verdict.status == Pass) { return accept(candidate, evidence); }
        feedback = verdict.violations;
    }
    return unresolved();
}`;
const add = (body: string) => `export function add(a: number, b: number): number {\n  ${body}\n}\n`;
const greet = `export function greet(name: string): string {\n  return "Hello, " + name;\n}\n`;

interface Asked { file: string; request: LLMRequest }
async function fixture(t: TestContext, model: ManagedModel, answer: (file: string, request: LLMRequest, asked: Asked[]) => string) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lcai-repair-test-")));
  const root = path.join(temp, "project"), data = path.join(temp, "app");
  await fs.mkdir(root); await fs.mkdir(data);
  const projects = new ProjectStore(data);
  const project = await projects.create({ name: "Repair tests", rootPath: root });
  const asked: Asked[] = [];
  const service = new SynthesisService(data, {
    projects,
    models: { listAllModels: async () => [model] },
    loadModel: async () => undefined,
    llm: {
      generateObject: async () => { throw new Error("these flows use source format"); },
      generateText: async (request: LLMRequest, provider?: string): Promise<LLMResponse> => {
        const file = /^Implement only the file (.+?)\. Other files:/.exec(request.prompt)?.[1];
        if (!file) return { provider: provider ?? "llamacpp", model: request.model ?? "", text: "Advisory notes only." };
        asked.push({ file, request });
        return { provider: provider ?? "llamacpp", model: request.model ?? "", text: answer(file, request, asked), usage: { inputTokens: 50, outputTokens: 100 } };
      }
    },
    checks: { sandbox: await sandbox(), workRoot: path.join(temp, "checks") }
  });
  await service.init();
  t.after(async () => { await service.dispose(); await fs.rm(temp, { recursive: true, force: true }); });
  const module = async (name: string, spec: string, flow: string, tests: Record<string, string>) => {
    const created = await service.createModule(project.id, name, { template: "empty" });
    await fs.writeFile(path.join(root, created.specPath), spec);
    await fs.writeFile(path.join(root, created.flowPath), flow);
    const folder = path.dirname(path.join(root, created.specPath));
    for (const [file, content] of Object.entries(tests)) {
      await fs.mkdir(path.dirname(path.join(folder, file)), { recursive: true });
      await fs.writeFile(path.join(folder, file), content);
    }
    const checked = await service.module(project.id, created.id);
    assert.equal(checked.valid, true, JSON.stringify(checked.diagnostics));
    return created.id;
  };
  return { service, project, asked, module, root };
}
const writes = (asked: Asked[], file: string) => asked.filter(item => item.file === file && !item.request.prompt.includes("Fix this failure in"));

test("a file that comes back unchanged while a failed test uses it is asked about its first failure once more, as edits; an unchanged file no failure points at is not", async (t) => {
  if (NO_RUNNER) return t.skip(NO_RUNNER);
  const f = await fixture(t, localModel("plain-coder", 4_000_000_000), (file, request, asked) => {
    if (file === "src/greet.ts") return greet;
    if (request.prompt.includes("<<<<<<< SEARCH\nlines copied exactly")) return "<<<<<<< SEARCH\n  return a - b; // v2\n=======\n  return a + b;\n>>>>>>> REPLACE";
    // A changed file (v1, then v2) is the model's own attempt; v2 again is a copy.
    return writes(asked, file).length === 1 ? add("return a - b;") : add("return a - b; // v2");
  });
  const id = await f.module("Pair", pairSpec("Pair"), pairFlow("Pair", 3), { "tests/pair.test.ts": pairTests });
  const run = await f.service.wait((await f.service.start(f.project.id, id)).id);
  assert.equal(run.status, "accepted", run.error);
  assert.equal(run.iteration, 3);
  const escalations = run.events.filter(event => /came back unchanged/.test(event.message));
  assert.deepEqual(escalations.map(event => [event.iteration, event.file, event.message]), [
    [3, "src/math.ts", "src/math.ts came back unchanged while the checks point at it: asking again about its first failure only, as edits"]
  ], "only the unchanged file a failed test uses, never greet.ts (unchanged, but no failure uses it), never a changed file");
  const modes = (file: string, iteration: number) => run.events.filter(event => event.generation && event.file === file && event.iteration === iteration).map(event => event.generation!.mode);
  assert.deepEqual([modes("src/math.ts", 2), modes("src/math.ts", 3), modes("src/greet.ts", 3)], [["write"], ["write", "edit"], ["write"]]);
  const edit = f.asked.find(item => item.request.prompt.includes("Fix this failure in src/math.ts now"))!;
  // One failure only, with the assertion that failed as it reads, and the edit protocol.
  assert.match(edit.request.prompt, /\n1\. behavior: adds: Expected values to be strictly equal: 0 !== 4 \(at tests\/pair\.test\.ts:7\) \(expected 4, actual 0\) \[tests\/pair\.test\.ts:6\]\n {3}tests\/pair\.test\.ts:7 is: assert\.equal\(add\(2, 2\), 4\);\n/);
  assert.ok(!/\n2\. /.test(edit.request.prompt.slice(edit.request.prompt.indexOf("# Result of the last check"))), "one failure at a time");
  assert.match(edit.request.prompt, /Answer with the change to src\/math\.ts only, as one or more blocks of this form/);
  assert.equal(edit.request.localReasoningBudget, 0);
});

test("a local model whose template thinks is asked again thinking first, with the budget message, and without /no_think", async (t) => {
  if (NO_RUNNER) return t.skip(NO_RUNNER);
  const thinking = { ...localModel("qwen3.5-9b", 9_000_000_000), metadata: { thinkingTemplate: true } } as ManagedModel;
  const f = await fixture(t, thinking, (file, request) => file === "src/greet.ts" ? greet
    : request.localReasoningBudget === 1024 ? add("return a + b;") : add("return a - b;"));
  const id = await f.module("Think", pairSpec("Think"), pairFlow("Think", 2), { "tests/pair.test.ts": pairTests });
  const run = await f.service.wait((await f.service.start(f.project.id, id)).id);
  assert.equal(run.status, "accepted", run.error);
  assert.equal(run.iteration, 2);
  const again = f.asked.find(item => item.request.localReasoningBudget === 1024)!;
  assert.equal(again.request.localReasoningBudgetMessage, BUDGET_MESSAGE);
  assert.ok(again.request.prompt.includes("Fix this failure in src/math.ts now"));
  assert.ok(!/\/no_think\s*$/.test(again.request.prompt), "the request thinks first");
  assert.ok(f.asked.filter(item => item !== again).every(item => item.request.prompt.endsWith("/no_think")));
  const focus = run.events.find(event => event.generation?.mode === "focus")!;
  assert.equal(focus.generation!.thinking, 1024);
  assert.equal(focus.generation!.budgetMessage, BUDGET_MESSAGE);
  assert.ok(run.events.some(event => event.message === "src/math.ts came back unchanged while the checks point at it: asking again about its first failure only, thinking first (1024 tokens)"));
});

const keepTests = {
  "tests/visible.test.ts": `import assert from "node:assert/strict";
import test from "node:test";
import { f } from "../src/f.ts";

test("one", () => assert.equal(f(1), 1));
test("two", () => assert.equal(f(2), 2));
test("three", () => assert.equal(f(3), 3));
`,
  "tests/hidden.test.ts": `import assert from "node:assert/strict";
import test from "node:test";
import { f } from "../src/f.ts";

test("ten", () => assert.equal(f(10), 10));
test("twenty", () => assert.equal(f(20), 20));
`
};
const keepSpec = `module Keep version "1" {
    target { language = TypeScript; }
    description = "src/f.ts exports function f(x: number): number returning x.";
    artifacts { file "src/f.ts"; }
    tests { file "tests/visible.test.ts"; file "tests/hidden.test.ts"; }
    evaluate "contract-v1" {
        hard behavior = Tests("tests/visible.test.ts", timeout = 30s);
        hard holdout = Tests("tests/hidden.test.ts", hidden = true, timeout = 30s);
    }
}`;
const keepFlow = `implement Keep using "contract-v1" {
    limit iterations 3, time 5m, cost 0usd;
    policy = "local-files-v1";
    available = await models.list(provider = "llamacpp");
    selected = models.select(available);
    developer = await models.load(selected);
    spec = freeze(Keep.spec);
    candidate = checkout("keep");
    feedback = none;
    while (!accepted(candidate, spec)) {
        candidate = await developer.revise(candidate, spec, feedback, file = "src/f.ts", format = "source");
        evidence = await evaluate(candidate, spec, keep = "best");
        verdict = verify(spec, evidence);
        if (verdict.status == Pass) { return accept(candidate, evidence); }
        feedback = verdict.violations;
    }
    return unresolved();
}`;

// The hidden gate is hard: only the rule that hidden gates never count keeps B (which passes it) from
// being chosen over A.
test("keep = \"best\" goes back to the best candidate by visible gates only, never by the hidden ones, and a tie goes to the newer", async (t) => {
  if (NO_RUNNER) return t.skip(NO_RUNNER);
  const fx = (body: string) => `export function f(x: number): number {\n  ${body}\n}\n`;
  // A: 2 of 3 visible, 0 of 2 hidden. B: 1 of 3 visible, but every hidden test. C: 2 of 3 visible, as A.
  const answers = [fx("return x <= 2 ? x : 0;"), fx("return x === 1 || x >= 10 ? x : 0;"), fx("return x === 1 || x === 3 ? x : 0;")];
  const f = await fixture(t, localModel("plain-coder", 4_000_000_000), (_file, _request, asked) => answers[Math.min(asked.length, answers.length) - 1]!);
  const id = await f.module("Keep", keepSpec, keepFlow, keepTests);
  const run = await f.service.wait((await f.service.start(f.project.id, id)).id);
  assert.equal(run.status, "unresolved");
  const kept = run.events.filter(event => event.message.startsWith("Kept the candidate"));
  assert.deepEqual(kept.map(event => [event.iteration, event.message]), [
    [2, "Kept the candidate of iteration 1 (1 of 2 required checks, 2 of 3 tests) over this one (1 of 2, 1 of 3)"]
  ], "B is better on the hidden tests, worse on the visible ones: set aside; C ties A and is newer: kept");
  // The third request reads A (the kept candidate), not B; the run ends on C.
  assert.ok(f.asked[2]!.request.prompt.includes(`# src/f.ts now (the version checked above: change what makes it fail, keep what works)\n\`\`\`ts\n${answers[0]}`));
  const record = JSON.parse(await fs.readFile(path.join(f.root, "..", "app", "synthesis", "runs", `${run.id}.json`), "utf8"));
  assert.equal(record.files["src/f.ts"], answers[2]!.trim(), "a model's answer is kept as it wrote it, trimmed");
  assert.equal(run.evidence?.gates.find(gate => gate.id === "behavior")?.message, "2 of 3 tests passed");
});

test("every request's seed derives from the run's seed, which only an interrupted run's restart keeps, and each request is recorded", async (t) => {
  if (NO_RUNNER) return t.skip(NO_RUNNER);
  const f = await fixture(t, localModel("plain-coder", 4_000_000_000), file => file === "src/greet.ts" ? greet : add("return a - b;"));
  const id = await f.module("Seeded", pairSpec("Seeded"), pairFlow("Seeded", 1), { "tests/pair.test.ts": pairTests });
  await assert.rejects(f.service.start(f.project.id, id, { seed: 0 }), /seed is a whole number from 1 to 2,147,483,646/);
  await assert.rejects(f.service.start(f.project.id, id, { seed: 1.5 }), /seed is a whole number/);
  const first = await f.service.wait((await f.service.start(f.project.id, id, { seed: 4242 })).id);
  assert.equal(first.status, "unresolved");
  assert.equal(first.seed, 4242);
  const generations = first.events.filter(event => event.generation);
  assert.deepEqual(generations.map(event => [event.file, event.generation!.seed]), [
    ["src/math.ts", requestSeed(4242, 1, "src/math.ts", 1)], ["src/greet.ts", requestSeed(4242, 1, "src/greet.ts", 1)]
  ]);
  assert.deepEqual(f.asked.map(item => item.request.sampling?.seed), generations.map(event => event.generation!.seed), "the seed is sent with the request");
  const recorded = generations[0]!.generation!;
  assert.deepEqual({ ...recorded, ms: 0, promptHash: "" }, { mode: "write", seed: recorded.seed, temperature: 0.2, topP: 0.9, topK: 40, minP: 0.05, repeatPenalty: 1.05,
    thinking: 0, maxTokens: 2600, promptHash: "", promptChars: recorded.promptChars, inputTokens: 50, outputTokens: 100, ms: 0, unchanged: false });
  assert.match(recorded.promptHash, /^[a-f0-9]{16}$/);
  assert.ok(recorded.promptChars > 1000 && recorded.ms >= 0);
  const requests = (run: typeof first) => run.events.filter(event => event.generation).map(event => [event.generation!.seed, event.generation!.promptHash]);
  // Restarting an unresolved run tries again with new answers: a new seed, new request seeds.
  const retried = await f.service.wait((await f.service.restart(first.id)).id);
  assert.notEqual(retried.seed, 4242);
  assert.notDeepEqual(requests(retried).map(([seed]) => seed), requests(first).map(([seed]) => seed));
  // A seed named for the restart repeats the run as it ran: the same request seeds and prompts.
  const repeated = await f.service.wait((await f.service.restart(first.id, { seed: 4242 })).id);
  assert.equal(repeated.seed, 4242);
  assert.deepEqual(requests(repeated), requests(first));
  // An interrupted run goes on as it was asked: it keeps its seed.
  const recordFile = path.join(f.root, "..", "app", "synthesis", "runs", `${first.id}.json`);
  await fs.writeFile(recordFile, JSON.stringify({ ...JSON.parse(await fs.readFile(recordFile, "utf8")), status: "interrupted" }));
  const resumed = await f.service.wait((await f.service.restart(first.id)).id);
  assert.equal(resumed.seed, 4242);
  assert.deepEqual(requests(resumed), requests(first));
  const drawn = await f.service.wait((await f.service.start(f.project.id, id)).id);
  assert.ok(Number.isInteger(drawn.seed) && drawn.seed! >= 1 && drawn.seed! <= 2_147_483_646);
});

const input = (extra: Partial<RevisePromptInput> = {}): RevisePromptInput => ({
  file: "src/pattern.ts", artifacts: ["src/query.ts", "src/pattern.ts", "src/router.ts"], module: "Router", description: "A router.", hint: "TypeScript only.",
  frozen: [], tests: [["tests/router.test.ts", `import assert from "node:assert/strict";
import test from "node:test";
import { parseQuery } from "../src/query.ts";
import { Pattern } from "../src/pattern.ts";

test("pattern: root", () => {
  assert.deepEqual(new Pattern("/").match("/"), {});
  assert.equal(new Pattern("/").match("/x"), null);
});
test("query: empty", () => {
  assert.deepEqual(parseQuery(""), {});
});
`]],
  files: { "src/query.ts": "export function parseQuery(q: string) {\n  return { q };\n}\n", "src/pattern.ts": "export class Pattern {\n  match(path: string) {\n    return {};\n  }\n}\n" },
  feedback: [
    "behavior: pattern: root: Expected values to be strictly equal: {} !== null (at tests/router.test.ts:8) (expected null, actual {}) [tests/router.test.ts:6]",
    "behavior: query: empty: Expected values to be strictly deep-equal: (expected {}, actual { q: '' }) (at tests/router.test.ts:11) [tests/router.test.ts:10]",
    "dependencies: src/pattern.ts:1 imports \"node:util\", which the contract does not allow."
  ],
  first: false, checked: { passed: 0, total: 2, hardPassed: 1, hardTotal: 3 }, reply: "source", ...extra
});

test("the prompt groups the feedback by the file it points into, with each cited line, the assertion and its test, and the module's other files as code", () => {
  const { prompt, system } = revisePrompt(input());
  assert.ok(prompt.startsWith("Implement only the file src/pattern.ts. Other files: src/query.ts, src/router.ts.\nTypeScript only."));
  const result = prompt.slice(prompt.indexOf("# Result of the last check"), prompt.indexOf("# src/pattern.ts now"));
  assert.equal(result, `# Result of the last check
0 of 2 tests passed; 1 of 3 required checks passed.

In src/pattern.ts, or in tests that use it:
1. behavior: pattern: root: Expected values to be strictly equal: {} !== null (at tests/router.test.ts:8) (expected null, actual {}) [tests/router.test.ts:6]
   tests/router.test.ts:8 is: assert.equal(new Pattern("/").match("/x"), null);
   The test:
     test("pattern: root", () => {
       assert.deepEqual(new Pattern("/").match("/"), {});
       assert.equal(new Pattern("/").match("/x"), null);
     });
2. dependencies: src/pattern.ts:1 imports "node:util", which the contract does not allow.
   src/pattern.ts:1 is: export class Pattern {

Elsewhere (the cause may still be in src/pattern.ts):
1. behavior: query: empty: Expected values to be strictly deep-equal: (expected {}, actual { q: '' }) (at tests/router.test.ts:11) [tests/router.test.ts:10]
   tests/router.test.ts:11 is: assert.deepEqual(parseQuery(""), {});
   The test:
     test("query: empty", () => {
       assert.deepEqual(parseQuery(""), {});
     });

`);
  assert.ok(prompt.includes("# The module's other files as they are now (use their exports exactly as written)\n--- src/query.ts\n```ts\nexport function parseQuery"));
  assert.ok(!prompt.includes("{\"src/query.ts\""), "never JSON strings");
  assert.ok(prompt.endsWith("Keep the code plain and as short as the contract allows. Finish the response as soon as this single file is complete. /no_think"));
  assert.match(system, /^You implement only src\/pattern\.ts/);
  // Focus: the first failure in this file only.
  const focus = revisePrompt(input({ focus: true })).prompt;
  assert.ok(focus.includes("Fix this failure in src/pattern.ts now, and leave the rest of the file as it is; the other failures come one at a time after it:\n1. behavior: pattern: root"));
  assert.ok(!focus.includes("query: empty") || focus.indexOf("query: empty") < focus.indexOf("# Result"), "no other failure in the result");
  // The first attempt, and feedback that is not a list of strings, read as before.
  assert.ok(revisePrompt(input({ feedback: [], first: true })).prompt.includes("# Result of the last check\nnone yet: this is the first attempt."));
  assert.ok(revisePrompt(input({ feedback: [], other: [{ note: "x" }] })).prompt.includes('# Result of the last check\n[{"note":"x"}]'));
});

test("the result of the last check keeps within its size: the items first, the tests' bodies only while they fit", () => {
  const many = Array.from({ length: 12 }, (_, i) => `behavior: pattern: root ${i}: ${"x".repeat(220)} (at tests/router.test.ts:8) [tests/router.test.ts:6]`);
  const { prompt } = revisePrompt(input({ feedback: many }));
  const result = prompt.slice(prompt.indexOf("# Result of the last check"), prompt.indexOf("# src/pattern.ts now") - 2);
  assert.ok(result.length <= FEEDBACK_CHARS, String(result.length));
  assert.ok(!result.includes("The test:"), "bodies go first");
  assert.ok(result.includes("12. behavior: pattern: root 11"), "every item stays");
});

test("the files a failure points at: the ones it names, and the ones a failed test imports and uses (JavaScript, TypeScript and Python); a file that did not load uses none in particular", () => {
  const { files, tests } = input();
  assert.deepEqual([...implicatedFiles(["behavior: pattern: root: failed [tests/router.test.ts:6]"], files, tests)], ["src/pattern.ts"]);
  assert.deepEqual([...implicatedFiles(["behavior: query: empty: failed (at tests/router.test.ts:11) [tests/router.test.ts:10]"], files, tests)], ["src/query.ts"]);
  assert.deepEqual([...implicatedFiles(["behavior: tests/router.test.ts: SyntaxError: Unexpected token (src/query.ts:3) [tests/router.test.ts:1]"], files, tests)], ["src/query.ts"]);
  assert.deepEqual([...implicatedFiles(["behavior: tests/router.test.ts: The test process ended. [tests/router.test.ts:1]"], files, tests)], []);
  assert.deepEqual([...implicatedFiles(["ui: index.html must have a <output id=\"result\"> element"], { "index.html": "", "calculator.js": "" }, [])], ["index.html"]);
  const python = "import unittest\nfrom src.rate_limiter import RateLimiter\n\n\nclass T(unittest.TestCase):\n    def test_take(self):\n        limiter = RateLimiter(1)\n        self.assertTrue(limiter.take())\n";
  assert.deepEqual(filesUsedByTest(python, 8, ["src/rate_limiter.py", "src/other.py"]), ["src/rate_limiter.py"]);
});

test("SEARCH/REPLACE edits apply where their text occurs once, exactly or line by line trimmed, and not otherwise", () => {
  const file = "function a() {\n  return 1;\n}\nfunction b() {\n  return 1;\n}\n";
  assert.equal(applyEditBlocks(file, "<<<<<<< SEARCH\nfunction b() {\n  return 1;\n=======\nfunction b() {\n  return 2;\n>>>>>>> REPLACE"), "function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\n");
  assert.equal(applyEditBlocks(file, "<<<<<<< SEARCH\nfunction a() {\nreturn 1;\n=======\nfunction a() {\n  return 0;\n>>>>>>> REPLACE"), "function a() {\n  return 0;\n}\nfunction b() {\n  return 1;\n}\n");
  assert.equal(applyEditBlocks(file, "<<<<<<< SEARCH\n  return 1;\n=======\n  return 3;\n>>>>>>> REPLACE"), undefined, "ambiguous");
  assert.equal(applyEditBlocks(file, "<<<<<<< SEARCH\nfunction c() {\n=======\nx\n>>>>>>> REPLACE"), undefined, "not in the file");
  assert.equal(applyEditBlocks(file, "The bug is in b."), undefined, "prose");
});

test("a feedback item points at the file it is about: its subject, a place it cites, or the only file it names; not a file named beside another", () => {
  const files = ["index.html", "calculator.js", "style.css"];
  const about = (item: string) => files.filter(file => pointsAt(item, file, files));
  assert.deepEqual(about('ui: index.html must load calculator.js exactly once, with <script src="calculator.js"></script> at the end of body; it loads it 2 times instead.'), ["index.html"]);
  assert.deepEqual(about("ui: calculator.js: clicking #calculate with 12 + 7 must show 19 in the <output id='result'>; it shows nothing instead."), ["calculator.js"]);
  assert.deepEqual(about("behavior: adds: TypeError: x is not a function (calculator.js:3), called at tests/a.test.ts:8 [tests/a.test.ts:6]"), ["calculator.js"]);
  assert.deepEqual(about('layering: The contract checks the imports of files matching "style.css", but no file matches it.'), ["style.css"]);
  assert.deepEqual(about("ui: #operation needs a visible label or accessible name."), []);
  assert.deepEqual(about("index.html: The answer was cut off at the token limit (2600 tokens)."), ["index.html"]);
});

test("SEARCH/REPLACE delimiters are whole lines: a ======= banner in the code does not end a block", () => {
  const file = "// ==========\n// Section\n// ==========\nexport const a = 1;\n";
  assert.equal(applyEditBlocks(file, "<<<<<<< SEARCH\n// ==========\n// Section\n// ==========\nexport const a = 1;\n=======\n// ==========\n// Section\n// ==========\nexport const a = 2;\n>>>>>>> REPLACE"),
    "// ==========\n// Section\n// ==========\nexport const a = 2;\n");
  assert.equal(applyEditBlocks("x = 1\n", "<<<<<<< SEARCH\nx = 1\n=========\nx = 2\n>>>>>>> REPLACE"), undefined, "nine = signs are not the separator");
  assert.equal(applyEditBlocks("a\nb\n", "<<<<<<< SEARCH\nb\n=======\n>>>>>>> REPLACE"), "a\n\n", "an empty REPLACE removes the lines");
});

test("Python imports: one line each, relative ones, and a parenthesized list over several lines", () => {
  const source = "from .router import Router\nimport unittest\nfrom src.query import (\n    parse_query,\n    QueryError,\n)\n\n\nclass T(unittest.TestCase):\n    def test_route(self):\n        self.assertTrue(Router())\n\n    def test_query(self):\n        self.assertEqual(parse_query(''), {})\n";
  const candidates = ["src/router.py", "src/query.py"];
  assert.deepEqual(filesUsedByTest(source, 11, candidates), ["src/router.py"], "the import ends with its line");
  assert.deepEqual(filesUsedByTest(source, 14, candidates), ["src/query.py"]);
});

test("the budget message goes to the app's own llama.cpp only, and only with a thinking budget", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const provider = (id: string) => new OpenAICompatibleProvider({ id, name: id, model: "m", baseUrl: "http://127.0.0.1:9/v1", timeoutMs: 5000 }, new Logger(), fetchImpl);
  const ask = (id: string, budget: number) => provider(id).generateText({ prompt: "x", model: "m", localReasoningBudget: budget, localReasoningBudgetMessage: BUDGET_MESSAGE });
  await ask("llamacpp", 1024); await ask("llamacpp", 0); await ask("lmstudio", 1024);
  assert.deepEqual(sent.map(body => body.reasoning_budget_message), [BUDGET_MESSAGE, undefined, undefined]);
  assert.deepEqual(sent.slice(0, 2).map(body => body.reasoning_budget_tokens), [1024, 0]);
});
