import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { ProjectStore } from "../src/projects/ProjectStore";
import { LLMRequest, LLMResponse, ProviderDescriptor } from "../src/types";
import type { LLMService } from "../src/llm/LLMService";
import { SynthesisService } from "../src/synthesis/SynthesisService";
import { compileProgram } from "../src/synthesis/language";

const descriptor = (id: string): ProviderDescriptor => ({id, name: id[0].toUpperCase() + id.slice(1), configured: true, defaultModel: "",
  capabilities: {local: false, managed: false, jsonMode: true, nativeTools: false, structuredOutputs: false, reasoning: false}});
type Action = Record<string, unknown>;
/** What an agent does next: from its task and the tool results it has seen so far. */
type Script = (task: string, results: string[]) => Action | {error: string};
const final = (text: string): Action => ({type: "final", text});
const tool = (name: string, args: Record<string, unknown>): Action => ({type: "tool_call", tool: name, arguments: args});

const spec = `module Review version "1" {
    description = "Notes about the project by parallel agents, and a report.";
    artifacts {
        file "REPORT.md";
        files "notes/**";
    }
    evaluate "contract-v1" {
        hard clean = Forbid("notes/**", "FORBIDDEN");
    }
}`;
const flow = (body: string, limits = "iterations 2, time 5m, steps 20000") => `implement Review using "contract-v1" {
    limit ${limits};
    policy = "agents-v1";
    lead = await model("deepseek-flash", provider = "deepseek");
    spec = freeze(Review.spec);
    candidate = checkout("review");
    ${body}
    evidence = await evaluate(candidate, spec);
    verdict = verify(spec, evidence);
    if (verdict.status == Pass) { return accept(candidate, evidence); }
    return needs_review(evidence);
}`;

async function fixture(t: TestContext, options: {script: Script; delay?: (task: string) => Promise<void>; window?: number; report?: (prompt: string) => string}) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lcai-synthesis-agents-")));
  const root = path.join(temp, "project"), data = path.join(temp, "app");
  await fs.mkdir(path.join(root, "src"), {recursive: true}); await fs.mkdir(data);
  for (const name of ["alpha", "beta", "gamma"]) await fs.writeFile(path.join(root, "src", `${name}.ts`), `export const ${name} = 1;\n// line two of ${name}\n`);
  await fs.mkdir(path.join(root, "secret")); await fs.writeFile(path.join(root, "secret", "keys.txt"), "not for agents");
  const projects = new ProjectStore(data);
  const project = await projects.create({name: "Agents", rootPath: root});
  await projects.update(project.id, {cloudModels: true});
  let inFlight = 0, peak = 0;
  const agentRequests: LLMRequest[] = [];
  const advisory: LLMRequest[] = [];
  const agentLlm = {
    supportsNativeTools: () => false, supportsStructuredOutputs: () => false, getContextWindow: () => options.window,
    generateObject: async (request: LLMRequest) => {
      agentRequests.push(request);
      const task = /USER TASK:\n([\s\S]*?)\n\nOBSERVED TOOL TRANSCRIPT/.exec(request.prompt)?.[1] ?? "";
      // Each tool result as the model reads it, its lines up to the next transcript entry.
      const results = [...request.prompt.matchAll(/^RESULT: ([\s\S]*?)(?=\n\n(?:TOOL|RESULT|FORMAT_ERROR): |\n\nChoose the next action)/gm)].map(match => match[1].replace(/\n/g, " "));
      inFlight++; peak = Math.max(peak, inFlight);
      try {
        await options.delay?.(task);
        request.signal?.throwIfAborted();
        const next = options.script(task, results);
        if ("error" in next) return {data: null, response: {provider: "deepseek", model: "deepseek-flash", text: "", error: String(next.error)} as LLMResponse};
        return {data: next, response: {provider: "deepseek", model: "deepseek-flash", text: JSON.stringify(next), usage: {inputTokens: 100, outputTokens: 20}} as LLMResponse};
      } finally { inFlight--; }
    }
  } as unknown as LLMService;
  const llm = {
    getContextWindow: () => options.window,
    generateObject: async <T extends object>(request: LLMRequest) => {
      advisory.push(request);
      const count = Number(/into exactly (\d+) tasks/.exec(request.prompt)?.[1] ?? 1);
      const tasks = Array.from({length: count}, (_value, index) => `Task ${index + 1}: write notes/n${index + 1}.md`);
      return {data: {tasks} as unknown as T, response: {provider: "deepseek", model: "deepseek-flash", text: JSON.stringify({tasks}), usage: {inputTokens: 10, outputTokens: 10}} as LLMResponse};
    },
    generateText: async (request: LLMRequest): Promise<LLMResponse> => {
      advisory.push(request);
      const text = /^Merge these findings/.test(request.prompt) ? `merged ${request.prompt.split("### Agent").length - 1} results` : options.report?.(request.prompt) ?? `# Report\n\n${request.prompt.slice(-200)}`;
      return {provider: "deepseek", model: "deepseek-flash", text, usage: {inputTokens: 10, outputTokens: 10}};
    }
  } as unknown as LLMService;
  const service = new SynthesisService(data, {projects, models: {listAllModels: async () => []}, loadModel: async () => undefined, llm,
    providers: () => [descriptor("deepseek")], catalog: {listAll: async () => []}, agents: {llm: agentLlm}});
  await service.init();
  await fs.mkdir(path.join(root, "Synthesis", "Review"), {recursive: true});
  await fs.writeFile(path.join(root, "Synthesis", "Review", "Review.lcspec"), spec);
  const run = async (body: string, limits?: string) => {
    await fs.writeFile(path.join(root, "Synthesis", "Review", "Review.lcflow"), flow(body, limits));
    const module = await service.module(project.id, "Review");
    assert.equal(module.valid, true, JSON.stringify(module.diagnostics));
    return service.wait((await service.start(project.id, "Review")).id);
  };
  t.after(async () => { await service.dispose(); await fs.rm(temp, {recursive: true, force: true}); });
  return {root, data, service, project, run, agentRequests, advisory, peak: () => peak};
}

/** An agent that writes the note its task names, then reports it. */
const writer: Script = (task, results) => {
  const note = /write (notes\/\S+\.md)/.exec(task)?.[1];
  if (!note) return final("No note to write.");
  if (!results.length) return tool("file.write", {path: `review/${note}`, content: `- src/alpha.ts:1 ${task}`, expectedVersion: "missing"});
  return final(`Wrote review/${note}: src/alpha.ts:1`);
};
const spawn = (count: number, rights = 'files.read("src/**"), files.write("review/notes/**")', concurrency = 4) => `
    tasks = await lead.split("Write notes", ${count});
    agents = [];
    for (i in range(${count})) {
        agents = append(agents, agent(provider = "deepseek", model = "deepseek-flash", tools = [${rights}], steps = 4));
    }
    results = await parallel_map(agents, tasks, concurrency = ${concurrency});
    checkpoint(results.completed, results.failed, results[0].output);
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");`;

test("twenty agents made in a for loop write their notes in parallel, at most `concurrency` at once, into the run's copy until Apply", async (t) => {
  const f = await fixture(t, {script: writer, delay: () => new Promise(resolve => setTimeout(resolve, 5))});
  const result = await f.run(spawn(20, undefined, 6));
  assert.equal(result.status, "accepted", result.error);
  assert.ok(f.peak() <= 6 && f.peak() >= 2, `peak ${f.peak()}`);
  assert.deepEqual(result.agents, {total: 20, queued: 0, running: 0, done: 20, failed: 0, cancelled: 0});
  const agents = await f.service.agents(result.id);
  assert.deepEqual(agents.items.map(item => item.index), Array.from({length: 20}, (_v, index) => index), "in task order");
  assert.ok(agents.items.every(item => item.status === "done" && item.steps === 2 && item.files.length === 1 && item.providerId === "deepseek"));
  assert.deepEqual(agents.items[4].files, ["review/notes/n5.md"]);
  assert.equal(result.usage.inputTokens >= 20 * 200, true, "the agents' tokens are the run's");
  await assert.rejects(fs.access(path.join(f.root, "review")), {code: "ENOENT"}, "nothing reaches the project before Apply");
  const diff = await f.service.diff(result.id);
  assert.equal(diff.files.length, 21);
  assert.ok(diff.files.some(file => file.path === "review/REPORT.md" && /^# Report/.test(file.after ?? "")));
  const one = await f.service.agent(result.id, 4);
  assert.match(one.final!, /review\/notes\/n5\.md/);
  assert.ok(one.turns.some(turn => turn.type === "tool" && turn.content.includes("file.write")));
  await f.service.apply(result.id);
  assert.equal(await fs.readFile(path.join(f.root, "review", "notes", "n5.md"), "utf8"), "- src/alpha.ts:1 Task 5: write notes/n5.md");
  const split = f.advisory.find(request => /into exactly 20 tasks/.test(request.prompt));
  assert.ok(split, "the lead split the goal");
  const report = f.advisory.find(request => /^You write REPORT\.md/.test(request.systemPrompt ?? ""));
  assert.ok(report && /### Agent 20/.test(report.prompt), "the report reads every agent's result");
});

test("an agent reads and writes only what its rights name, never the contract, and asks no one", async (t) => {
  const f = await fixture(t, {script: (task, results) => {
    const steps = [
      tool("file.read", {path: "secret/keys.txt"}),
      tool("file.read", {path: "Synthesis/Review/Review.lcspec"}),
      tool("file.write", {path: "src/alpha.ts", content: "x", expectedVersion: "missing"}),
      tool("file.write", {path: "review/other.md", content: "x", expectedVersion: "missing"}),
      tool("file.search", {path: ".", query: "line two"}),
      tool("file.read", {path: "src/beta.ts"})
    ];
    return results.length < steps.length ? steps[results.length] : final(results.join("\n"));
  }});
  const result = await f.run(`agents = [agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("src/**", "Synthesis/**"), files.write("review/notes/**")], steps = 10)];
    results = await parallel_map(agents, ["look around"]);
    checkpoint(results[0].output);
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");`);
  assert.equal(result.status, "accepted", result.error);
  const {final: answer} = await f.service.agent(result.id, 0);
  const lines = answer!.split("\n");
  assert.match(lines[0], /may not read secret\/keys\.txt/);
  assert.match(lines[1], /may not read Synthesis\/Review\/Review\.lcspec/, "the contract is not the agents' to read, whatever their rights");
  assert.match(lines[2], /may not write src\/alpha\.ts/);
  assert.match(lines[3], /may not write review\/other\.md/);
  assert.match(lines[4], /src\/alpha\.ts.*src\/beta\.ts.*src\/gamma\.ts/s);
  assert.doesNotMatch(lines[4], /secret|Synthesis/);
  assert.match(lines[5], /"version":"[a-f0-9]{64}"/);
  assert.doesNotMatch(answer!, new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no host path reaches the model");
  assert.ok(f.agentRequests.every(request => !/command\.run/.test(request.systemPrompt ?? "")), "an agent with file rights has no command tool");
});

test("two agents writing one file: the second learns of the conflict, reads again and keeps both changes", async (t) => {
  const f = await fixture(t, {script: (task, results) => {
    const line = `- ${task}\n`;
    if (!results.length) return tool("file.read", {path: "review/notes/shared.md"});
    const last = results.at(-1)!;
    const version = /"version":"([a-f0-9]{64})"/.exec(last)?.[1];
    if (/does not exist/.test(last)) return tool("file.write", {path: "review/notes/shared.md", content: line, expectedVersion: "missing"});
    if (version && !/Saved/.test(last)) return tool("file.append", {path: "review/notes/shared.md", content: line, expectedVersion: version});
    if (/version conflict/.test(last)) return tool("file.read", {path: "review/notes/shared.md"});
    return final("done");
  }, delay: task => new Promise(resolve => setTimeout(resolve, task === "second" ? 15 : 1))});
  const result = await f.run(`writer = agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("review/**"), files.write("review/notes/**")], steps = 10);
    results = await parallel_map(writer, ["first", "second"], concurrency = 2);
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");`);
  assert.equal(result.status, "accepted", result.error);
  const diff = await f.service.diff(result.id);
  const shared = diff.files.find(file => file.path === "review/notes/shared.md");
  assert.ok(shared?.after?.includes("- first") && shared.after.includes("- second"), shared?.after ?? "missing");
});

test("on_error = \"fail\" stops the other agents at the first failure; \"collect\" returns failures as results", async (t) => {
  const failing: Script = (task, results) => task === "Task 2: write notes/n2.md" ? {error: "model unavailable"} : writer(task, results);
  const f = await fixture(t, {script: failing, delay: task => new Promise(resolve => setTimeout(resolve, task.startsWith("Task 2") ? 1 : 30))});
  const collected = await f.run(spawn(4, undefined, 4));
  assert.equal(collected.status, "accepted", collected.error);
  const items = (await f.service.agents(collected.id)).items;
  assert.equal(items[1].status, "failed"); assert.match(items[1].error!, /model unavailable/);
  assert.equal(items.filter(item => item.status === "done").length, 3);
  const stopped = await f.run(spawn(4, undefined, 4).replace("concurrency = 4", "concurrency = 4, on_error = \"fail\""));
  assert.equal(stopped.status, "blocked");
  assert.match(stopped.error!, /Agent 2 failed: .*model unavailable/);
  assert.ok((await f.service.agents(stopped.id)).items.some(item => item.status === "cancelled"));
});

test("cancelling a run stops every agent and leaves none running", async (t) => {
  let started!: () => void; const first = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, {script: writer, delay: () => { started(); return new Promise(resolve => setTimeout(resolve, 200)); }});
  await fs.writeFile(path.join(f.root, "Synthesis", "Review", "Review.lcflow"), flow(spawn(8, undefined, 2)));
  const run = await f.service.start(f.project.id, "Review");
  await first;
  const result = await f.service.cancel(run.id);
  assert.equal(result.status, "cancelled");
  const items = (await f.service.agents(run.id)).items;
  assert.ok(items.length === 8 && items.every(item => item.status !== "running" && item.status !== "queued"), JSON.stringify(items.map(item => item.status)));
  assert.ok(items.filter(item => item.status === "cancelled").length >= 6);
});

test("an agent deletes a project file in its area: the diff shows it, Apply removes it, and a write before checkout is refused", async (t) => {
  const f = await fixture(t, {script: (task, results) => {
    if (!results.length) return tool("file.read", {path: "review/notes/old.md"});
    const version = /"version":"([a-f0-9]{64})"/.exec(results[0])?.[1];
    if (results.length === 1) return tool("file.delete", {path: "review/notes/old.md", expectedVersion: version});
    return final("deleted");
  }});
  await fs.mkdir(path.join(f.root, "review", "notes"), {recursive: true});
  await fs.writeFile(path.join(f.root, "review", "notes", "old.md"), "stale");
  const result = await f.run(`cleaner = agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("review/**"), files.delete("review/notes/**")]);
    results = await parallel_map(cleaner, ["remove the stale note"]);
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");`);
  assert.equal(result.status, "accepted", result.error);
  const diff = await f.service.diff(result.id);
  assert.deepEqual(diff.files.find(file => file.path === "review/notes/old.md"), {path: "review/notes/old.md", before: "stale", after: null});
  await f.service.apply(result.id);
  await assert.rejects(fs.access(path.join(f.root, "review", "notes", "old.md")), {code: "ENOENT"});
  assert.match(await fs.readFile(path.join(f.root, "review", "REPORT.md"), "utf8"), /^# Report/);
  await fs.writeFile(path.join(f.root, "Synthesis", "Review", "Review.lcflow"), `implement Review using "contract-v1" {
    limit iterations 1, time 1m;
    policy = "agents-v1";
    early = agent(provider = "deepseek", model = "deepseek-flash", tools = [files.write("review/notes/**")]);
    results = await parallel_map(early, ["write"]);
    return unresolved();
}`);
  const early = await f.service.wait((await f.service.start(f.project.id, "Review")).id);
  assert.equal(early.status, "blocked");
  assert.match(early.error!, /Check out the candidate before giving agents write access/);
});

test("results too many for the model's prompt are merged in groups before the report is written", async (t) => {
  const f = await fixture(t, {script: (task) => final(`Finding for ${task}: ${"detail ".repeat(60)}`), window: 9000});
  const result = await f.run(spawn(30, 'files.read("src/**")', 8));
  assert.equal(result.status, "accepted", result.error);
  const merges = f.advisory.filter(request => /^Merge these findings/.test(request.prompt));
  assert.ok(merges.length >= 2, `${merges.length} merges`);
  const report = f.advisory.find(request => /^You write REPORT\.md/.test(request.systemPrompt ?? ""))!;
  assert.match(report.prompt, /merged \d+ results/);
  assert.ok(report.prompt.length < 9000 * 2.5, "the final prompt fits");
});

test("agents need agents-v1, an agent names its model once, and write patterns are checked as written", () => {
  const codes = (body: string, policy = "agents-v1") => compileProgram(spec, flow(body).replace('policy = "agents-v1";', `policy = "${policy}";`)).diagnostics.map(item => item.code);
  assert.deepEqual(codes(spawn(3)), []);
  assert.ok(codes(spawn(3), "cloud-files-v1").includes("FLOW_POLICY_CAPABILITY"));
  assert.ok(codes(`a = agent(lead, provider = "deepseek", model = "x");`).includes("FLOW_AGENT_MODEL"));
  assert.ok(codes(`a = agent(provider = "deepseek");`).includes("FLOW_AGENT_MODEL"));
  assert.ok(codes(`a = agent(provider = "deepseek", model = "x", tools = [files.read("../etc/**")]);`).includes("FLOW_FILE_PATTERN"));
  assert.ok(codes(`a = agent(provider = "deepseek", model = "x", tools = [files.read(".git/**")]);`).includes("FLOW_FILE_PATTERN"));
  assert.ok(codes(`a = agent(provider = "deepseek", model = "x", tools = ["filesystem"]);`).includes("FLOW_TYPE"));
  assert.ok(codes(`a = agent(provider = "deepseek", model = "x"); results = parallel_map(a, ["t"]);`).includes("FLOW_AWAIT_REQUIRED"));
  assert.ok(codes(`a = agent(provider = "deepseek", model = "x"); results = await parallel_map(a, ["t"], on_error = "ignore");`).includes("FLOW_TYPE"));
  assert.ok(codes(`results = await parallel_map(lead, ["t"]);`).includes("FLOW_TYPE"));
});

test("security: a contract at the project root, its hidden tests and any .lcspec stay unread; a linked folder leads nowhere; model patterns cannot stall a search", async (t) => {
  const f = await fixture(t, {script: (task, results) => {
    const steps = [
      tool("file.read", {path: "Review.lcspec"}), tool("file.read", {path: "tests/hidden.test.ts"}), tool("file.read", {path: "other/Other.lcflow"}),
      tool("file.read", {path: "src/outside/secret.txt"}), tool("file.list", {path: "src/outside"}),
      tool("file.search", {path: ".", query: "", include: ["*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b"]}),
      tool("file.search", {path: ".", query: "export"})
    ];
    return results.length < steps.length ? steps[results.length] : final(results.join("\n"));
  }});
  // The module at the project root, with a hidden test beside it.
  await fs.writeFile(path.join(f.root, "Review.lcspec"), spec.replace('hard clean = Forbid("notes/**", "FORBIDDEN");', 'hard clean = Forbid("notes/**", "FORBIDDEN");\n        soft holdout = Tests("tests/hidden.test.ts", hidden = true);'));
  await fs.mkdir(path.join(f.root, "tests")); await fs.writeFile(path.join(f.root, "tests", "hidden.test.ts"), "// the holdout answers");
  await fs.mkdir(path.join(f.root, "other")); await fs.writeFile(path.join(f.root, "other", "Other.lcflow"), "implement Other");
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "lcai-outside-"));
  t.after(() => fs.rm(outside, {recursive: true, force: true}));
  await fs.writeFile(path.join(outside, "secret.txt"), "outside the project");
  await fs.symlink(outside, path.join(f.root, "src", "outside"));
  await fs.writeFile(path.join(f.root, "src", `${"a".repeat(60)}.ts`), "export const long = 1;");
  await fs.writeFile(path.join(f.root, "Review.lcflow"), flow(`agents = [agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("**")], steps = 12)];
    results = await parallel_map(agents, ["look everywhere"]);
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");`).replace("Review.spec", "Review.spec"));
  const module = await f.service.module(f.project.id, "file:Review");
  assert.equal(module.valid, true, JSON.stringify(module.diagnostics));
  const started = Date.now();
  const result = await f.service.wait((await f.service.start(f.project.id, "file:Review")).id);
  assert.ok(["accepted", "needs_review"].includes(result.status), result.error);
  const answer = (await f.service.agent(result.id, 0)).final!;
  const lines = answer.split("\n");
  assert.match(lines[0], /may not read Review\.lcspec/);
  assert.match(lines[1], /may not read tests\/hidden\.test\.ts/);
  assert.match(lines[2], /may not read other\/Other\.lcflow/);
  assert.match(lines[3], /do not follow symbolic links/);
  assert.match(lines[4], /do not follow symbolic links|"entries":\[\]/);
  assert.doesNotMatch(answer, /outside the project|the holdout answers|implement Other/);
  assert.match(lines[5], /"matches":\[\]/);
  assert.match(lines[6], /src\/alpha\.ts/);
  assert.ok(Date.now() - started < 5000, "the pathological pattern is matched in linear time");
});

test("globMatches: * stays within a folder, ** crosses them, **/ may stand for none", async () => {
  const { globMatches } = await import("../src/synthesis/agents/SynthesisFileTools");
  const cases: Array<[string, string, boolean]> = [
    ["*.ts", "a.ts", true], ["*.ts", "src/a.ts", false], ["src/*.ts", "src/a.ts", true], ["src/*.ts", "src/x/a.ts", false],
    ["src/**", "src/x/a.ts", true], ["src/**/a.ts", "src/a.ts", true], ["src/**/a.ts", "src/x/y/a.ts", true], ["**/a.ts", "a.ts", true],
    ["a*b*c", "aXbYc", true], ["a*b*c", "aXbY", false], ["**", "anything/at/all", true], ["review/notes/*.md", "review/notes/x.md", true]
  ];
  for (const [pattern, value, expected] of cases) assert.equal(globMatches(pattern, value), expected, `${pattern} ~ ${value}`);
  const started = Date.now();
  assert.equal(globMatches(`${"*a".repeat(40)}*b`, "a".repeat(240)), false);
  assert.ok(Date.now() - started < 200);
});

test("security: the contract stays unread and frozen files unwritten in any letter case", async (t) => {
  const f = await fixture(t, {script: (task, results) => {
    const steps = [
      tool("file.read", {path: "SYNTHESIS/Review/Review.lcspec"}), tool("file.read", {path: "synthesis/review/review.LCSPEC"}),
      tool("file.write", {path: "review/notes/X.md", content: "a", expectedVersion: "missing"}), tool("file.write", {path: "review/notes/x.md", content: "b", expectedVersion: "missing"}),
      tool("file.write", {path: "review/report.md", content: "c", expectedVersion: "missing"})
    ];
    return results.length < steps.length ? steps[results.length] : final(results.join("\n"));
  }});
  const result = await f.run(`agents = [agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("**"), files.write("review/**")], steps = 10)];
    results = await parallel_map(agents, ["try every case"]);
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");`);
  const lines = (await f.service.agent(result.id, 0)).final!.split("\n");
  assert.match(lines[0], /may not read SYNTHESIS\/Review\/Review\.lcspec/);
  assert.match(lines[1], /may not read synthesis\/review\/review\.LCSPEC/);
  assert.doesNotMatch(lines.join("\n"), /Synthesis\.?.*module Review|hard clean/, "nothing of the contract is shown");
  assert.match(lines[2], /Saved review\/notes\/X\.md/);
  assert.match(lines[3], /differs from notes\/X\.md only in case/);
  assert.match(lines[4], /differs from REPORT\.md only in case|not a file of the contract/);
});

test("a provider that answers 429 gets fewer requests at once and each refused request again, without spending a step", async () => {
  const { gatedLlm } = await import("../src/synthesis/agents/ProviderGate");
  let inFlight = 0, peak = 0, calls = 0, refused = 0;
  const llm = {
    generateObject: async (request: LLMRequest) => {
      calls++; inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight--;
      // The first requests over three at once are turned away.
      if (calls <= 8 && peak > 3) { refused++; return {data: null, response: {provider: "p", model: "m", text: "", error: "perplexity request failed (HTTP 429): Request rate limit exceeded, please try again later."}}; }
      return {data: {type: "final", text: request.prompt}, response: {provider: "p", model: "m", text: "{}"}};
    }
  } as unknown as LLMService;
  const waits: number[] = [];
  const gated = gatedLlm(llm, 8, {baseDelayMs: 5, waited: (_provider, ms) => waits.push(ms)});
  const answers = await Promise.all(Array.from({length: 8}, (_value, index) => gated.generateObject<{text: string}>({prompt: `task ${index}`}, "perplexity")));
  assert.deepEqual(answers.map(answer => answer.data?.text), Array.from({length: 8}, (_value, index) => `task ${index}`), "every request came through in the end");
  assert.ok(refused > 0 && waits.length === refused, `${refused} refused, ${waits.length} waits`);
  const controller = new AbortController();
  const stuck = gatedLlm({generateObject: async () => ({data: null, response: {provider: "p", model: "m", text: "", error: "HTTP 429"}})} as unknown as LLMService, 2, {baseDelayMs: 50});
  const pending = stuck.generateObject({prompt: "x", signal: controller.signal}, "perplexity");
  setTimeout(() => controller.abort(new Error("cancelled")), 20);
  await assert.rejects(pending, /cancelled/, "a wait ends when the run is cancelled");
});

test("a project folder that only looks like a contract folder (src/synthesis) stays readable", async (t) => {
  const f = await fixture(t, {script: (_task, results) => results.length ? final(results.join("\n")) : tool("file.read", {path: "src/synthesis/engine.ts"})});
  await fs.mkdir(path.join(f.root, "src", "synthesis"));
  await fs.writeFile(path.join(f.root, "src", "synthesis", "engine.ts"), "export const engine = true;");
  const result = await f.run(`agents = [agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("src/**")])];
    results = await parallel_map(agents, ["read the engine"]);
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");`);
  assert.match((await f.service.agent(result.id, 0)).final!, /export const engine = true/);
});

test("New module → Repository review makes a valid agents module: notes, a report and a Grounded gate", async (t) => {
  const f = await fixture(t, {script: writer});
  const created = await f.service.createModule(f.project.id, "RepositoryReview", { template: "repository-review" });
  assert.equal(created.valid, true, JSON.stringify(created.diagnostics));
  assert.match(created.specSource!, /files "notes\/\*\*";/);
  assert.match(created.specSource!, /Grounded\("REPORT\.md", min = 3\)/);
  assert.match(created.flowSource!, /slots = 4/);
  assert.match(created.flowSource!, /parallel_map\(agents, tasks, concurrency = 4\)/);
});

test("races: two agents creating twin names at once leave one file; every agent reads one version of a project file, as Grounded does", async (t) => {
  let edited = false;
  const f = await fixture(t, {script: (task, results) => {
    if (task === "upper" || task === "lower") return results.length ? final(results[0]) : tool("file.write", {path: `review/notes/${task === "upper" ? "A" : "a"}.md`, content: task, expectedVersion: "missing"});
    return results.length ? final(results[0]) : tool("file.read", {path: "src/alpha.ts"});
  }, delay: async task => {
    if (task === "late reader") {
      await new Promise(resolve => setTimeout(resolve, 40));
      // The project file changes on disk while the run's agents are reading it.
      if (!edited) { edited = true; await fs.writeFile(path.join(f.root, "src", "alpha.ts"), "export const alpha = 2; // edited during the run\n"); }
    }
  }});
  const result = await f.run(`writer = agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("src/**"), files.write("review/notes/**")], steps = 4);
    results = await parallel_map(writer, ["upper", "lower", "early reader", "late reader"], concurrency = 4);
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");`);
  const answers = await Promise.all([0, 1, 2, 3].map(async index => (await f.service.agent(result.id, index)).final!));
  const saved = answers.slice(0, 2).filter(answer => /Saved/.test(answer)), refused = answers.slice(0, 2).filter(answer => /only in case/.test(answer));
  assert.equal(saved.length, 1, answers.slice(0, 2).join("\n")); assert.equal(refused.length, 1);
  const notes = (await f.service.diff(result.id)).files.filter(file => /review\/notes\/a\.md$/i.test(file.path));
  assert.equal(notes.length, 1, "one candidate file, not two that the disk would merge");
  assert.ok(edited);
  assert.match(answers[2], /export const alpha = 1/); assert.match(answers[3], /export const alpha = 1/, "the late reader sees the version the run read first");
});

test("races: a local model keeps more slots than a later load asks for while it is loaded; a shared provider gate spans runs", async () => {
  const { servedShape } = await import("../src/local/LocalModelService");
  const six = {parallel: 6, contextSize: 16384}, two = {parallel: 2, contextSize: 8192};
  assert.deepEqual(servedShape(six, two, true, 4096), six, "another run's six agents keep their slots");
  assert.deepEqual(servedShape(two, six, true, 4096), six, "more slots: loaded again, with the model to itself");
  assert.deepEqual(servedShape(six, two, false, 4096), two, "an unloaded model takes the shape asked for");
  assert.equal(servedShape(undefined, {parallel: 1, contextSize: 4096}, false, 4096), undefined);
  const { gatedLlm } = await import("../src/synthesis/agents/ProviderGate");
  let inFlight = 0, peak = 0, refusals = 2;
  const llm = {generateObject: async () => {
    inFlight++; peak = Math.max(peak, inFlight); await new Promise(resolve => setTimeout(resolve, 5)); inFlight--;
    if (refusals > 0) { refusals--; return {data: null, response: {provider: "p", model: "m", text: "", error: "HTTP 429"}}; }
    return {data: {}, response: {provider: "p", model: "m", text: "{}"}};
  }} as unknown as LLMService;
  const first = gatedLlm(llm, 4, {baseDelayMs: 2}), second = gatedLlm(llm, 4, {baseDelayMs: 2});
  await Promise.all([...Array.from({length: 4}, () => first.generateObject({prompt: "a"}, "p")), ...Array.from({length: 4}, () => second.generateObject({prompt: "b"}, "p"))]);
  assert.ok(peak <= 4, `two runs together sent ${peak} at once to one provider`);
});

test("a report that cites what does not exist is written again with the exact problems until Grounded holds", async (t) => {
  const prompts: string[] = [];
  const f = await fixture(t, {script: writer, report: prompt => { prompts.push(prompt); return /failed the contract's checks/.test(prompt) ? "# Report\n- src/alpha.ts:1 is fine" : "# Report\n- src/missing.ts:3 swallows an error"; }});
  await fs.writeFile(path.join(f.root, "Synthesis", "Review", "Review.lcspec"), spec.replace('hard clean = Forbid("notes/**", "FORBIDDEN");', 'hard grounded = Grounded("REPORT.md");'));
  await fs.writeFile(path.join(f.root, "Synthesis", "Review", "Review.lcflow"), flow(spawn(2, undefined, 2)).replace(/    evidence = await evaluate[\s\S]*$/, `    while (!accepted(candidate, spec)) {
        evidence = await evaluate(candidate, spec);
        verdict = verify(spec, evidence);
        if (verdict.status == Pass) { return accept(candidate, evidence); }
        candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md", feedback = verdict.violations);
    }
    return unresolved();
}`));
  const result = await f.service.wait((await f.service.start(f.project.id, "Review")).id);
  assert.equal(result.status, "accepted", result.error);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /REPORT\.md:2 cites src\/missing\.ts, which does not exist/);
  assert.match(prompts[1], /The last REPORT\.md, to correct[\s\S]*- src\/missing\.ts:3 swallows an error/, "the repair edits the last version");
  assert.equal((await f.service.diff(result.id)).files.find(file => file.path === "review/REPORT.md")?.after, "# Report\n- src/alpha.ts:1 is fine");
});

/** An agent that runs its steps in order: each a tool call, or a function of what it has seen. */
const steps = (byTask: Record<string, Array<Action | ((results: string[]) => Action)>>): Script => (task, results) => {
  const plan = byTask[task] ?? [];
  const next = plan[results.length];
  return next === undefined ? final(results.join("\n")) : typeof next === "function" ? next(results) : next;
};
const versionOf = (result: string) => /"version":"([a-f0-9]{64}|missing)"/.exec(result)?.[1];

test("ownership: a file under an own right belongs to the agent that made it; the others read it and change nothing", async (t) => {
  const f = await fixture(t, {script: steps({
    maker: [tool("file.write", {path: "review/notes/mine.md", content: "made by the maker", expectedVersion: "missing"})],
    other: [tool("file.read", {path: "review/notes/mine.md"}), results => tool("file.write", {path: "review/notes/mine.md", content: "taken over", expectedVersion: versionOf(results[0])}),
      results => tool("file.delete", {path: "review/notes/mine.md", expectedVersion: versionOf(results[0])})]
  }), delay: task => new Promise(resolve => setTimeout(resolve, task === "other" ? 30 : 1))});
  const result = await f.run(`team = agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("review/**"), files.write("review/notes/**", own = true), files.delete("review/notes/**")], steps = 6);
    results = await parallel_map(team, ["maker", "other"], concurrency = 2);
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");`);
  const other = (await f.service.agent(result.id, 1)).final!.split("\n");
  assert.match(other[0], /made by the maker/, "it reads the owner's file");
  assert.match(other[1], /belongs to agent 1, which created it/);
  assert.match(other[2], /belongs to agent 1/);
  assert.equal((await f.service.diff(result.id)).files.find(file => file.path === "review/notes/mine.md")?.after, "made by the maker");
});

test("checkout: the holder's changes stay its own until it submits; the others read the submitted version and change nothing meanwhile", async (t) => {
  const order: string[] = [];
  let holderSubmitted!: () => void; const submitted = new Promise<void>(resolve => { holderSubmitted = resolve; });
  const f = await fixture(t, {script: steps({
    holder: [tool("file.checkout", {paths: ["review/notes/shared.md", "src/alpha.ts"]}),
      results => tool("file.write", {path: "review/notes/shared.md", content: "draft 1", expectedVersion: versionOf(results[0]) ?? "missing"}),
      results => tool("file.write", {path: "review/notes/shared.md", content: "final", expectedVersion: versionOf(results[1])}),
      tool("file.submit", {})],
    reader: [tool("file.read", {path: "review/notes/shared.md"}), tool("file.write", {path: "review/notes/shared.md", content: "mine", expectedVersion: "missing"}),
      tool("file.checkout", {paths: ["src/alpha.ts"]}), tool("file.read", {path: "review/notes/shared.md"})]
  }), delay: async task => {
    if (task === "reader") {
      order.push("reader");
      // The reader's last read comes after the holder submitted.
      if (order.filter(item => item === "reader").length === 4) await submitted;
      else await new Promise(resolve => setTimeout(resolve, 20));
    } else {
      order.push("holder");
      if (order.filter(item => item === "holder").length === 5) holderSubmitted();
      await new Promise(resolve => setTimeout(resolve, order.filter(item => item === "holder").length === 1 ? 1 : 60));
    }
  }});
  const result = await f.run(`team = agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("src/**", "review/**"), files.write("review/notes/**")], steps = 8);
    results = await parallel_map(team, ["holder", "reader"], concurrency = 2);
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");`);
  const holder = (await f.service.agent(result.id, 0)).final!.split("\n"), reader = (await f.service.agent(result.id, 1)).final!.split("\n");
  assert.match(holder[0], /"checkedOut"/);
  assert.match(holder[1], /in your checkout/);
  assert.match(holder[3], /Submitted review\/notes\/shared\.md/);
  assert.match(reader[0], /does not exist/, "the holder's draft is not visible before it submits");
  assert.match(reader[1], /checked out by agent 1/);
  assert.match(reader[2], /Nothing was checked out: agent 1/, "a file only read is held too");
  assert.match(reader[3], /final/, "after the submit, everyone reads it");
  assert.equal((await f.service.diff(result.id)).files.find(file => file.path === "review/notes/shared.md")?.after, "final");
  assert.deepEqual((await f.service.agents(result.id)).items[0].files, ["review/notes/shared.md"]);
});

test("checkout: a failed agent's pending changes are dropped, a finished one's submitted; checkout = \"required\" refuses changes without one", async (t) => {
  const f = await fixture(t, {script: (task, results) => {
    if (task === "fails") return results.length < 2 ? [tool("file.checkout", {paths: ["review/notes/f.md"]}), tool("file.write", {path: "review/notes/f.md", content: "half done", expectedVersion: "missing"})][results.length] : {error: "model unavailable"};
    if (task === "forgets") return results.length < 2 ? [tool("file.checkout", {paths: ["review/notes/g.md"]}), tool("file.write", {path: "review/notes/g.md", content: "kept", expectedVersion: "missing"})][results.length] : final("done");
    return results.length ? final(results.join("\n")) : tool("file.write", {path: "review/notes/h.md", content: "no checkout", expectedVersion: "missing"});
  }});
  const result = await f.run(`team = agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("review/**"), files.write("review/notes/**")], steps = 6);
    results = await parallel_map(team, ["fails", "forgets", "writes"], concurrency = 3, checkout = "required");
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");`);
  const items = (await f.service.agents(result.id)).items;
  assert.equal(items[0].status, "failed"); assert.deepEqual(items[0].reverted, ["review/notes/f.md"]);
  assert.deepEqual(items[1].files, ["review/notes/g.md"], "a finished agent's checkout is submitted");
  const diff = (await f.service.diff(result.id)).files.map(file => file.path);
  assert.ok(!diff.includes("review/notes/f.md") && diff.includes("review/notes/g.md") && !diff.includes("review/notes/h.md"), diff.join(" "));
  assert.match((await f.service.agent(result.id, 2)).final!, /Check review\/notes\/h\.md out before changing it/);
});

test("checkout: an agent holding files never waits for others, so two agents cannot wait on each other; one holding nothing may wait", async (t) => {
  const f = await fixture(t, {script: steps({
    left: [tool("file.checkout", {paths: ["review/notes/x.md"]}), tool("file.checkout", {paths: ["review/notes/y.md"], waitSeconds: 60})],
    right: [tool("file.checkout", {paths: ["review/notes/y.md"]}), tool("file.checkout", {paths: ["review/notes/x.md"], waitSeconds: 60})],
    patient: [tool("file.checkout", {paths: ["review/notes/x.md"], waitSeconds: 60}), tool("file.revert", {})]
  }), delay: task => new Promise(resolve => setTimeout(resolve, task === "patient" ? 15 : 5))});
  const started = Date.now();
  const result = await f.run(`team = agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("review/**"), files.write("review/notes/**")], steps = 4);
    results = await parallel_map(team, ["left", "right", "patient"], concurrency = 3);
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");`);
  assert.ok(Date.now() - started < 30_000, "no one waited out its 60 s");
  const [left, right, patient] = await Promise.all([0, 1, 2].map(async index => (await f.service.agent(result.id, index)).final!));
  assert.match(left + right, /You hold other files, so you cannot wait/);
  assert.match(patient.split("\n")[0], /"checkedOut"/, "the agent holding nothing waited for x.md and got it");
});

test("an agent's steps read as actions and file text, and its requests may take the minutes a thinking model needs", async (t) => {
  const f = await fixture(t, {script: steps({ reader: [tool("file.read", {path: "src/alpha.ts", startLine: 1, endLine: 2}), tool("file.read", {path: "secret/keys.txt"})] })});
  const result = await f.run(`agents = [agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("src/**")])];
    results = await parallel_map(agents, ["reader"]);
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");`);
  const { turns } = await f.service.agent(result.id, 0);
  assert.deepEqual(turns.slice(0, 4).map(turn => [turn.type, turn.content.split("\n")[0], turn.ok]), [
    ["tool", "file.read src/alpha.ts · lines 1–2", undefined], ["result", "1: export const alpha = 1;", true],
    ["tool", "file.read secret/keys.txt", undefined], ["result", "This agent may not read secret/keys.txt. It may read: src/**.", false]]);
  assert.ok(f.agentRequests.every(request => (request.timeoutMs ?? 0) >= 600_000), "a step may take ten minutes, whatever a chat's timeout is");
  assert.ok(f.advisory.every(request => (request.timeoutMs ?? 0) >= 600_000), "and so may split and synthesize");
});

const sandboxed = process.platform === "darwin" || process.platform === "linux";
test("terminal: an agent runs node in a sandboxed copy of what it may read, with its own changes, and nothing leaves the copy", { skip: !sandboxed }, async (t) => {
  const { platformSandbox } = await import("../src/synthesis/checks/sandbox");
  if (await platformSandbox().unavailable()) { t.skip("no working sandbox here"); return; }
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "lcai-terminal-outside-"));
  t.after(() => fs.rm(outside, {recursive: true, force: true}));
  await fs.writeFile(path.join(outside, "secret.txt"), "the host's secret");
  const node = (code: string, extra: Record<string, unknown> = {}) => tool("terminal.run", {command: "node", args: ["-e", code], ...extra});
  const f = await fixture(t, {script: steps({ builder: [
    tool("file.write", {path: "review/notes/mine.md", content: "my own change", expectedVersion: "missing"}),
    node("const fs=require('fs');console.log(fs.readFileSync('src/alpha.ts','utf8').trim(), '|', fs.readFileSync('review/notes/mine.md','utf8'))"),
    tool("terminal.run", {command: "cat", args: [path.join(outside, "secret.txt")]}),
    node("console.log(require('fs').existsSync('Synthesis') || require('fs').existsSync('secret'))"),
    node("require('fs').writeFileSync('src/made-in-the-copy.ts','x'); console.log('written')"),
    node("setTimeout(() => {}, 20000)", {timeoutSeconds: 1}),
    tool("terminal.run", {command: "curl", args: ["https://example.com"]}),
    tool("terminal.run", {command: "git", args: ["push"]})
  ]})});
  const result = await f.run(`builder = agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("src/**", "review/**"), files.write("review/notes/**"), terminal(allow = ["node", "cat", "git"])], steps = 12);
    results = await parallel_map(builder, ["builder"]);
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");`);
  const lines = (await f.service.agent(result.id, 0)).final!.split("\n");
  assert.match(lines[1], /export const alpha = 1;.*\| my own change/, "the copy holds the project's files and the agent's own change");
  assert.doesNotMatch(lines[2], /the host's secret/, "a file outside the copy is out of reach");
  assert.match(lines[3], /false/, "no contract and no unreadable folder in the copy");
  assert.match(lines[4], /written/);
  assert.match(lines[5], /"timedOut":true/);
  assert.match(lines[6], /curl is not one of this agent's commands/);
  assert.match(lines[7], /git runs only to read/);
  const diff = (await f.service.diff(result.id)).files.map(file => file.path);
  assert.ok(!diff.some(file => file.includes("made-in-the-copy")), "what a command writes stays in its copy");
  await assert.rejects(fs.access(path.join(f.root, "src", "made-in-the-copy.ts")), {code: "ENOENT"});
});

test("terminal: a run refuses agents with a terminal where no sandbox isolates, before any agent starts", async (t) => {
  const f = await fixture(t, {script: writer});
  const service = f.service as unknown as {services: {checks?: {sandbox: unknown}}};
  service.services.checks = {sandbox: {name: "none", unavailable: async () => "this platform has no sandbox yet", wrap: () => { throw new Error("never"); }}};
  const result = await f.run(`builder = agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("src/**"), terminal()]);
    results = await parallel_map(builder, ["x"]);`);
  assert.equal(result.status, "blocked");
  assert.match(result.error!, /Agents with a terminal need a sandbox.*this platform has no sandbox yet/);
  assert.equal(f.agentRequests.length, 0);
  assert.ok(compileProgram(spec, flow(`t = terminal(allow = ["node"]);`).replace('policy = "agents-v1";', 'policy = "cloud-files-v1";')).diagnostics.some(item => item.code === "FLOW_POLICY_CAPABILITY"));
});
