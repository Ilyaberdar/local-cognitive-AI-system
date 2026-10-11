import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { ProjectStore } from "../src/projects/ProjectStore";
import { LLMRequest, LLMResponse } from "../src/types";
import { SynthesisService } from "../src/synthesis/SynthesisService";
import { compileProgram } from "../src/synthesis/language";
import { runCheck } from "../src/synthesis/checks";
import { platformSandbox, unsandboxed } from "../src/synthesis/checks/sandbox";
import { localModel } from "./fixtures/synthesisFixture";

// The platform's sandbox where it exists (macOS, Linux with bubblewrap); otherwise, only in these
// tests, the runner's direct mode, so CI without bubblewrap still runs the contract end to end.
const sandbox = async () => (await platformSandbox().unavailable()) ? unsandboxed : platformSandbox();

const rateLimiter = (refill: boolean) => `export class RateLimiter {
  private tokens: number;
  private last: number;
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;

  constructor(options: { capacity: number; refillPerSecond: number; now: () => number }) {
    if (!(Number.isFinite(options.capacity) && options.capacity > 0)) throw new RangeError("capacity must be positive");
    if (!(Number.isFinite(options.refillPerSecond) && options.refillPerSecond > 0)) throw new RangeError("refillPerSecond must be positive");
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.now = options.now;
    this.tokens = options.capacity;
    this.last = options.now();
  }

  private refill(): void {
    const now = this.now();
    ${refill ? "this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSecond);" : ""}
    this.last = now;
  }

  available(): number {
    this.refill();
    return this.tokens;
  }

  tryAcquire(tokens = 1): boolean {
    if (!Number.isInteger(tokens) || tokens <= 0) throw new RangeError("tokens must be a positive integer");
    this.refill();
    if (this.tokens < tokens) return false;
    this.tokens -= tokens;
    return true;
  }
}
`;

async function contractFixture(t: TestContext, source: (file: string, call: number, request: LLMRequest) => string) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lcai-contract-test-")));
  const root = path.join(temp, "project"), data = path.join(temp, "app");
  await fs.mkdir(root); await fs.mkdir(data);
  const projects = new ProjectStore(data);
  const project = await projects.create({ name: "Contract tests", rootPath: root });
  const prompts: string[] = [];
  const service = new SynthesisService(data, {
    projects,
    models: { listAllModels: async () => [localModel("qwen2.5-coder-7b", 4_700_000_000)] },
    loadModel: async () => undefined,
    llm: {
      generateObject: async () => { throw new Error("contracts on rails use source format"); },
      generateText: async (request: LLMRequest, provider?: string): Promise<LLMResponse> => {
        const match = /^Implement only the file (.+?)\. Other files:/.exec(request.prompt);
        if (!match) return { provider: provider ?? "llamacpp", model: request.model ?? "", text: "Advisory notes only." };
        prompts.push(request.prompt);
        return { provider: provider ?? "llamacpp", model: request.model ?? "", text: source(match[1], prompts.length, request), usage: { inputTokens: 50, outputTokens: 100 } };
      }
    },
    checks: { sandbox: await sandbox(), workRoot: path.join(temp, "checks") }
  });
  await service.init();
  t.after(async () => { await service.dispose(); await fs.rm(temp, { recursive: true, force: true }); });
  return { root, project, service, prompts };
}

test("a contract on rails: the engineer's tests fail the first candidate, the exact failure guides the fix, and it is accepted", async (t) => {
  const f = await contractFixture(t, (_file, call) => rateLimiter(call > 1));
  const module = await f.service.createModule(f.project.id, "RateLimiter", { template: "rate-limiter" });
  assert.equal(module.valid, true, JSON.stringify(module.diagnostics));
  assert.ok(await fs.stat(path.join(f.root, "Synthesis/RateLimiter/tests/rateLimiter.test.ts")), "the template's tests sit next to the contract");

  const run = await f.service.wait((await f.service.start(f.project.id, "RateLimiter")).id);
  assert.equal(run.status, "accepted", run.error);
  assert.equal(run.iteration, 2);
  assert.deepEqual(run.evidence?.gates.map(gate => [gate.id, gate.status]), [
    ["shape", "Pass"], ["dependencies", "Pass"], ["clock", "Pass"], ["behavior", "Pass"], ["artifacts", "Pass"]
  ]);
  const behavior = run.evidence!.gates.find(gate => gate.id === "behavior")!;
  assert.equal(behavior.cases?.length, 6);
  assert.ok(behavior.cases?.every(item => item.status === "pass"));

  // The model reads the engineer's tests from the start, and the next prompt carries the exact failure.
  assert.ok(f.prompts[0].includes(`test("refills with the time that passed"`), "visible tests are in the prompt");
  assert.ok(!f.prompts[0].includes("Feedback from trusted tests: 1."), "no feedback before the first evaluation");
  const feedback = f.prompts[1].slice(f.prompts[1].indexOf("Feedback from trusted tests:"));
  assert.match(feedback, /1\. behavior: refills with the time that passed/);
  assert.match(feedback, /expected 2, actual 0/);
  assert.match(feedback, /tests\/rateLimiter\.test\.ts:\d+/);
  assert.ok(!feedback.includes(os.tmpdir()), "no absolute paths reach the model");
});

test("a frozen interface is the engineer's: it must exist at checkout, the model reads it and may not write it", async (t) => {
  const header = "#pragma once\nint Answer();\n";
  const f = await contractFixture(t, () => "#include \"Answer.h\"\nint Answer() { return 42; }\n");
  const module = await f.service.createModule(f.project.id, "Answer", { template: "empty" });
  const spec = `module Answer version "1" {
    target { language = Cpp; }
    artifacts { frozen "include/Answer.h"; file "src/Answer.cpp"; }
    evaluate "contract-v1" { hard shape = Exports("src/Answer.cpp", ["Answer"]); }
}`;
  const flow = (file: string) => `implement Answer using "contract-v1" {
    limit iterations 2, time 5m, cost 0usd;
    policy = "local-files-v1";
    available = await models.list(provider = "llamacpp");
    selected = models.select(available);
    developer = await models.load(selected);
    spec = freeze(Answer.spec);
    candidate = checkout("answer");
    candidate = await developer.revise(candidate, spec, none, file = "${file}", format = "source");
    evidence = await evaluate(candidate, spec);
    verdict = verify(spec, evidence);
    if (verdict.status == Pass) { return accept(candidate, evidence); }
    return unresolved();
}`;
  await fs.writeFile(path.join(f.root, module.specPath), spec);
  await fs.writeFile(path.join(f.root, module.flowPath), flow("src/Answer.cpp"));

  const missing = await f.service.wait((await f.service.start(f.project.id, "Answer")).id);
  assert.equal(missing.status, "blocked");
  assert.match(missing.error ?? "", /Frozen file include\/Answer\.h is missing in answer/);

  await fs.mkdir(path.join(f.root, "answer/include"), { recursive: true });
  await fs.writeFile(path.join(f.root, "answer/include/Answer.h"), header);
  const accepted = await f.service.wait((await f.service.start(f.project.id, "Answer")).id);
  assert.equal(accepted.status, "accepted", accepted.error);
  assert.ok(f.prompts.at(-1)!.includes("--- include/Answer.h\n#pragma once"), "the model reads the frozen header");

  await fs.writeFile(path.join(f.root, module.flowPath), flow("include/Answer.h"));
  const rewrite = await f.service.wait((await f.service.start(f.project.id, "Answer")).id);
  assert.equal(rewrite.status, "blocked");
  assert.match(rewrite.error ?? "", /may revise only declared artifact files/);
  assert.equal(await fs.readFile(path.join(f.root, "answer/include/Answer.h"), "utf8"), header);
});

test("the C++ ability system example: its reference passes every gate, and each gate catches what it guards", async (t) => {
  const example = path.join(__dirname, "../../examples/synthesis-ability-system");
  const read = (file: string) => fs.readFile(path.join(example, file), "utf8");
  const compiled = compileProgram(await read("Synthesis/AbilitySystem/AbilitySystem.lcspec"), await read("Synthesis/AbilitySystem/AbilitySystem.lcflow"));
  assert.deepEqual(compiled.diagnostics, []);
  const reference = await read("reference/AbilitySystem.cpp");
  const header = await read("ability-system/include/AbilitySystem.h");
  const suite = await read("Synthesis/AbilitySystem/tests/ability_system_test.cpp");
  const files = (implementation: string) => ({
    candidate: { "src/AbilitySystem.cpp": implementation },
    frozen: { "include/AbilitySystem.h": header },
    suite: { "tests/ability_system_test.cpp": suite }
  });
  const options = { sandbox: await sandbox(), workRoot: await fs.mkdtemp(path.join(os.tmpdir(), "lcai-ability-")) };
  t.after(() => fs.rm(options.workRoot, { recursive: true, force: true }));
  const gates = compiled.spec!.gates;
  const verdicts = async (implementation: string) => {
    const result: Record<string, { status: string; feedback: string[] }> = {};
    for (const gate of gates) result[gate.id] = await runCheck(gate.check!, files(implementation), options);
    return result;
  };

  const passing = await verdicts(reference);
  const compiler = passing.behavior.status === "Unknown" ? passing.behavior.feedback.join(" ") || "no C++ toolchain" : "";
  for (const [id, verdict] of Object.entries(passing)) {
    if (id === "behavior" && compiler) { t.diagnostic(`behavior skipped: ${compiler}`); continue; }
    assert.equal(verdict.status, "Pass", `${id}: ${verdict.feedback.join(" | ")}`);
  }

  const clocked = await verdicts(reference.replace("#include <algorithm>", "#include <algorithm>\n#include <chrono>"));
  assert.equal(clocked.layering.status, "Fail");
  assert.match(clocked.layering.feedback[0], /src\/AbilitySystem\.cpp:\d+ includes "<chrono>"/);

  const random = await verdicts(reference.replace("return ActivationResult::Activated;", "return rand() > 0 ? ActivationResult::Activated : ActivationResult::Activated;"));
  assert.equal(random.deterministic.status, "Fail");
  assert.match(random.deterministic.feedback[0], /the core takes time from the caller and does no I\/O/);

  if (!compiler) {
    // Mana checked before the cooldown: the contract's order is broken, and the test names it.
    const reordered = reference.replace(
      "  if (CooldownRemaining(id, now) > 0.0) return ActivationResult::OnCooldown;\n",
      "").replace("  if (attributes_.mana < spec.manaCost) return ActivationResult::NotEnoughMana;\n",
      "  if (attributes_.mana < spec.manaCost) return ActivationResult::NotEnoughMana;\n  if (CooldownRemaining(id, now) > 0.0) return ActivationResult::OnCooldown;\n");
    assert.notEqual(reordered, reference);
    const broken = await verdicts(reordered);
    assert.equal(broken.behavior.status, "Fail");
    assert.ok(broken.behavior.feedback.some(item => item.startsWith("checks_run_in_the_contract_order")), broken.behavior.feedback.join(" | "));
  }
});

test("a candidate cannot print its way past the tests: only lines signed with the run's token count", async (t) => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lcai-forgery-"));
  t.after(() => fs.rm(workRoot, { recursive: true, force: true }));
  const forged = [
    "import os",
    "print('{\"lc\": \"case\", \"name\": \"test_limits\", \"status\": \"pass\"}', flush=True)",
    "print('{\"lc\": \"done\", \"total\": 1, \"failed\": 0}', flush=True)",
    "os._exit(0)"
  ].join("\n");
  const result = await runCheck({ kind: "tests", files: ["tests/test_limits.py"] }, {
    candidate: { "src/limits.py": forged }, frozen: {},
    suite: { "tests/test_limits.py": "import unittest\nfrom src.limits import *\n\nclass Limits(unittest.TestCase):\n    def test_limits(self):\n        self.fail('never reached')\n" }
  }, { sandbox: await sandbox(), workRoot });
  if (result.status === "Unknown" && /python/i.test(result.message)) { t.skip(result.message); return; }
  assert.equal(result.status, "Fail", result.message);
  assert.ok(!result.cases?.some(item => item.status === "pass"), "the forged pass is not a case");
});
