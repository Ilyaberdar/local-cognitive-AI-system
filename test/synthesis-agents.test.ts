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

async function fixture(t: TestContext, options: {script: Script; delay?: (task: string) => Promise<void>; window?: number}) {
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
      const text = /^Merge these findings/.test(request.prompt) ? `merged ${request.prompt.split("### Agent").length - 1} results` : `# Report\n\n${request.prompt.slice(-200)}`;
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
