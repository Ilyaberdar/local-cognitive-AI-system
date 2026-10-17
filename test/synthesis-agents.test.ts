import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { AddressInfo } from "node:net";
import { AgentHttpClient } from "../src/synthesis/agents/AgentHttp";
import express from "express";
import { localApiOriginGuard } from "../src/api/integrationControllers";
import { createSynthesisRouter } from "../src/api/synthesisControllers";
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

async function fixture(t: TestContext, options: {script: Script; delay?: (task: string) => Promise<void>; window?: number; report?: (prompt: string) => string; httpHooks?: object}) {
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
    providers: () => [descriptor("deepseek")], catalog: {listAll: async () => []},
    agents: {llm: agentLlm, ...(options.httpHooks ? {httpClient: budget => new AgentHttpClient(budget, options.httpHooks)} : {})}});
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
  return {root, data, service, project, projects, run, agentRequests, advisory, peak: () => peak};
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
  assert.match(created.flowSource!, /parallel_map\(agents, tasks, concurrency = 4, answer_file = "review\/notes\/agent-\{n\}\.md"\)/, "a local model's answer in text still becomes a note");
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

// Small local models, and DeepSeek now and then, answer in text instead of calling file.write: a swarm
// whose test counts notes failed on fedora with nine of the twelve. answer_file saves such an answer.
const toLoopback = { resolve: async () => [{ address: "127.0.0.1", family: 4 }], blocked: () => false };

test("an agent with the http right reaches only the project's allowed targets; the request is recorded with its secret header hidden; a request elsewhere is refused", async (t) => {
  const seen: { url?: string; auth?: string; method?: string } = {};
  const srv = http.createServer((req, res) => { seen.url = req.url; seen.auth = req.headers.authorization; seen.method = req.method;
    res.setHeader("content-type", "application/json"); res.end('{"missing_header":"x-frame-options"}'); });
  await new Promise<void>(resolve => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as AddressInfo).port, origin = `http://scan.test:${port}`;
  t.after(() => new Promise<void>(resolve => srv.close(() => resolve())));
  const f = await fixture(t, { httpHooks: toLoopback, script: steps({
    probe: [tool("http.request", { method: "GET", url: `${origin}/headers`, headers: { Authorization: "Bearer secret-token" } }),
      results => tool("file.write", { path: "review/notes/probe.md", content: `- ${origin}/headers: ${/missing_header/.test(results[0]) ? "no X-Frame-Options" : "ok"}`, expectedVersion: "missing" })],
    escape: [tool("http.request", { method: "GET", url: `http://evil.test:${port}/` }), results => final(results[0])]
  })});
  await f.service.setWebTargets(f.project.id, [origin]);
  const result = await f.run(`checker = agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("src/**"), files.write("review/notes/**"), http(allow = ["${origin}"])], steps = 4);
    results = await parallel_map(checker, ["probe", "escape"], concurrency = 2);
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");`);
  assert.equal(result.status, "accepted", result.error);
  assert.equal(seen.url, "/headers"); assert.equal(seen.method, "GET");
  assert.equal(seen.auth, "Bearer secret-token", "the agent's own token reaches the service");
  assert.equal((await f.service.diff(result.id)).files.find(file => file.path === "review/notes/probe.md")?.after, `- ${origin}/headers: no X-Frame-Options`);
  const probe = await f.service.agent(result.id, 0);
  const request = probe.turns.find(turn => turn.type === "tool" && /http\.request/.test(turn.content));
  assert.ok(request, "the request is a recorded step");
  const result0 = probe.turns.find(turn => turn.type === "result" && turn.content.includes("missing_header"))!;
  assert.ok(result0, "the response is a recorded step");
  assert.ok(result0.content.includes("200"), "its status is recorded");
  assert.ok(result0.content.includes("set") && !result0.content.includes("secret-token"), "a secret header is recorded without its value");
  // The agent that tried another host got a refusal, not a request.
  const escape = await f.service.agent(result.id, 1);
  assert.match(escape.final ?? "", /not in this agent's allowed targets/);
});

test("http targets must be within what the project allows: Run is refused before it starts, and the module says so with SYNTHESIS_WEB_CONSENT", async (t) => {
  const f = await fixture(t, { httpHooks: toLoopback, script: () => final("done") });
  const flowBody = `checker = agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("src/**"), http(allow = ["https://api.example.com"])], steps = 2);
    results = await parallel_map(checker, ["t"]);`;
  // No targets allowed yet: the module is invalid with the consent diagnostic.
  await fs.writeFile(path.join(f.root, "Synthesis", "Review", "Review.lcflow"), flow(flowBody));
  let module = await f.service.module(f.project.id, "Review");
  assert.equal(module.valid, false);
  assert.ok(module.diagnostics.some(item => item.code === "SYNTHESIS_WEB_CONSENT" && /api\.example\.com/.test(item.message)), JSON.stringify(module.diagnostics));
  // Allow a wider target that covers it: the module becomes valid and Run is not refused for this.
  await f.service.setWebTargets(f.project.id, ["https://api.example.com/"]);
  module = await f.service.module(f.project.id, "Review");
  assert.equal(module.diagnostics.some(item => item.code === "SYNTHESIS_WEB_CONSENT"), false, JSON.stringify(module.diagnostics));
  // A host the allowlist does not cover is still refused.
  await f.service.setWebTargets(f.project.id, ["https://other.example.com"]);
  assert.ok((await f.service.module(f.project.id, "Review")).diagnostics.some(item => item.code === "SYNTHESIS_WEB_CONSENT"));
});

test("http(allow=[...]) checks its targets, and the web-targets setter normalizes and refuses bad ones", async (t) => {
  const codes = (value: string) => compileProgram(spec, flow(`a = agent(provider = "deepseek", model = "x", tools = [http(allow = [${value}])]);
    results = await parallel_map(a, ["t"]);`)).diagnostics.map(item => item.code);
  assert.deepEqual(codes('"https://staging.example.com"'), []);
  assert.deepEqual(codes('"https://api.example.com/v1"'), []);
  for (const bad of ['"ftp://example.com"', '"https://user:pass@example.com"', '"https://example.com/?q=1"', '"not a url"']) assert.deepEqual(codes(bad), ["FLOW_HTTP_TARGET"], bad);
  const f = await fixture(t, { script: () => final("done") });
  assert.deepEqual((await f.service.setWebTargets(f.project.id, ["https://API.Example.com:443/v1/", "https://api.example.com/v1"])).targets, ["https://api.example.com/v1"], "normalized and deduped");
  await assert.rejects(f.service.setWebTargets(f.project.id, ["https://user:pass@x.com"]), /no credentials/);
  assert.deepEqual((await f.service.setWebTargets(f.project.id, [])).targets, []);
});

test("answer_file: the answer of an agent that wrote no file is saved as its own file; one that wrote, failed or answered nothing gets none", async (t) => {
  const f = await fixture(t, {script: steps({
    answers: [final("- src/alpha.ts:1 swallows an error")],
    writes: [tool("file.write", {path: "review/notes/mine.md", content: "its own note", expectedVersion: "missing"})],
    fenced: [final("```markdown\n# Beta\n\n- src/beta.ts:2 misleads\n```")],
    fails: [{error: "model unavailable"} as unknown as Action]
  })});
  const result = await f.run(`team = agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("src/**"), files.write("review/notes/**", own = true)], steps = 4);
    results = await parallel_map(team, ["answers", "writes", "fenced", "fails"], concurrency = 4, answer_file = "review/notes/agent-{n}.md");
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");`);
  assert.equal(result.status, "accepted", result.error);
  const files = new Map((await f.service.diff(result.id)).files.map(file => [file.path, file.after]));
  assert.equal(files.get("review/notes/agent-1.md"), "- src/alpha.ts:1 swallows an error\n");
  assert.equal(files.get("review/notes/mine.md"), "its own note");
  assert.equal(files.has("review/notes/agent-2.md"), false, "an agent that wrote its own file gets no answer file");
  assert.equal(files.get("review/notes/agent-3.md"), "# Beta\n\n- src/beta.ts:2 misleads\n", "an answer in one fence is the fence's text");
  assert.equal(files.has("review/notes/agent-4.md"), false, "a failed agent's error is not an answer");
  const items = (await f.service.agents(result.id)).items;
  assert.equal(items[0].answerFile, "review/notes/agent-1.md");
  assert.deepEqual(items[0].files, ["review/notes/agent-1.md"]);
  assert.equal(items[1].answerFile, undefined);
  assert.equal(items[3].status, "failed");
  // Told before it answers, so that its findings go into the answer, not a claim that it wrote a file.
  const told = f.agentRequests.find(request => /USER TASK:\nanswers\n/.test(request.prompt))!;
  assert.match(`${told.systemPrompt}\n${told.prompt}`, /If you write no file yourself, your final answer is saved for you as review\/notes\/agent-1\.md/);
});

test("answer_file: saved as the agent, so its rights, another agent's file and a required checkout apply; a note an earlier Apply left is replaced", async (t) => {
  const f = await fixture(t, {script: steps({
    squatter: [tool("file.write", {path: "review/notes/agent-2.md", content: "the squatter's", expectedVersion: "missing"})],
    late: [final("- src/gamma.ts:1 the late agent's finding")],
    stale: [final("- src/alpha.ts:2 a fresh finding")]
  }), delay: task => new Promise(resolve => setTimeout(resolve, task === "late" ? 40 : 1))});
  // What an earlier Apply left in the project: replaced, since this run has not written it.
  await fs.mkdir(path.join(f.root, "review", "notes"), {recursive: true});
  await fs.writeFile(path.join(f.root, "review", "notes", "agent-3.md"), "a note from the last run\n");
  const result = await f.run(`team = agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("src/**", "review/**"), files.write("review/notes/**", own = true)], steps = 4);
    reader = agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("src/**")], steps = 4);
    results = await parallel_map(team, ["squatter", "late", "stale"], concurrency = 3, answer_file = "review/notes/agent-{n}.md");
    others = await parallel_map(reader, ["late"], answer_file = "review/notes/reader-{call}-{n}.md");
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");`);
  assert.equal(result.status, "accepted", result.error);
  const diff = new Map((await f.service.diff(result.id)).files.map(file => [file.path, file]));
  assert.equal(diff.get("review/notes/agent-2.md")?.after, "the squatter's", "another agent's file is never taken");
  assert.equal(diff.get("review/notes/agent-3.md")?.before, "a note from the last run\n");
  assert.equal(diff.get("review/notes/agent-3.md")?.after, "- src/alpha.ts:2 a fresh finding\n");
  assert.equal(diff.has("review/notes/reader-2-1.md"), false, "an agent without the right writes nothing");
  const items = (await f.service.agents(result.id)).items;
  assert.equal(items[1].status, "done", "a refused save never fails the agent");
  assert.match(items[1].answerRefused!, /belongs to agent 1, which created it/);
  assert.equal(items[2].answerFile, "review/notes/agent-3.md");
  assert.match(items[3].answerRefused!, /may not write review\/notes\/reader-2-1\.md/);

  // A map that requires checkouts: the save checks the file out and is submitted with the agent's work.
  const required = await f.run(`team = agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("src/**"), files.write("review/notes/**")], steps = 4);
    results = await parallel_map(team, ["late"], checkout = "required", answer_file = "review/notes/agent-{n}.md");
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");`);
  assert.equal(required.status, "accepted", required.error);
  assert.equal((await f.service.agents(required.id)).items[0].answerFile, "review/notes/agent-1.md");
  assert.equal((await f.service.diff(required.id)).files.find(file => file.path === "review/notes/agent-1.md")?.after, "- src/gamma.ts:1 the late agent's finding\n");
});

test("answer_file is a file path with {n}, checked as written and again when the flow runs: inside the candidate, never a pattern", async (t) => {
  const codes = (value: string) => compileProgram(spec, flow(`a = agent(provider = "deepseek", model = "x", tools = [files.write("review/notes/**")]);
    results = await parallel_map(a, ["t"], answer_file = ${value});`)).diagnostics.map(item => item.code);
  assert.deepEqual(codes('"review/notes/agent-{n}.md"'), []);
  assert.deepEqual(codes('"review/notes/map-{call}/agent-{n}.md"'), []);
  for (const value of ['"review/notes/agent.md"', '"../agent-{n}.md"', '"review/.hidden/agent-{n}.md"', '"review/notes/*-{n}.md"', '"review/notes/{task}-{n}.md"', '"/tmp/agent-{n}.md"']) {
    assert.deepEqual(codes(value), ["FLOW_ANSWER_FILE"], value);
  }
  assert.ok(codes('lead').includes("FLOW_TYPE"));
  const f = await fixture(t, {script: () => final("an answer")});
  const outside = await f.run(`a = agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("src/**")], steps = 2);
    results = await parallel_map(a, ["t"], answer_file = "notes/agent-{n}.md");`);
  assert.equal(outside.status, "blocked");
  assert.match(outside.error!, /answer_file "notes\/agent-\{n\}\.md" is outside the candidate folder review/);
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

test("terminal: npm test runs the project's own test script in the sandbox, with the npm beside this Node (a server ships it there)", { skip: !sandboxed }, async (t) => {
  const { platformSandbox } = await import("../src/synthesis/checks/sandbox");
  if (await platformSandbox().unavailable()) { t.skip("no working sandbox here"); return; }
  const npm = [path.join(path.dirname(process.execPath), "npm"), ...(process.env.PATH ?? "").split(path.delimiter).map(dir => path.join(dir, "npm"))];
  if (!(await Promise.all(npm.map(file => fs.access(file).then(() => true, () => false)))).some(Boolean)) { t.skip("no npm on this computer"); return; }
  const f = await fixture(t, {script: steps({ tester: [tool("terminal.run", {command: "npm", args: ["test"]}), tool("terminal.run", {command: "npm", args: ["install", "left-pad"]})] })});
  await fs.writeFile(path.join(f.root, "package.json"), JSON.stringify({ name: "app", private: true, scripts: { test: "node --test" } }));
  await fs.mkdir(path.join(f.root, "tests"));
  await fs.writeFile(path.join(f.root, "tests", "a.test.js"), "require('node:test')('adds', () => { require('node:assert').equal(1 + 1, 2); });\n");
  const result = await f.run(`tester = agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("package.json", "tests/**"), terminal(allow = ["npm"])], steps = 6);
    results = await parallel_map(tester, ["tester"]);
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");`);
  const agent = await f.service.agent(result.id, 0);
  const final = agent.final ?? "";
  assert.match(final, /# pass 1/, `${result.status} ${result.error ?? ""} ${agent.error ?? ""} ${JSON.stringify(agent.turns).slice(0, 1500)}`);
  assert.match(final, /"exitCode":0/);
  assert.match(final, /npm runs only npm test, npm run <script> and npm ls here/, "an install (network, package scripts) is never run");
});

test("terminal: a run refuses agents with a terminal where no sandbox isolates, before any agent starts", async (t) => {
  const f = await fixture(t, {script: writer});
  const service = f.service as unknown as {services: {checks?: {sandbox: unknown}}};
  service.services.checks = {sandbox: {name: "bubblewrap", unavailable: async () => "bubblewrap does not isolate here", wrap: () => { throw new Error("never"); }}};
  const result = await f.run(`builder = agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("src/**"), terminal()]);
    results = await parallel_map(builder, ["x"]);`);
  assert.equal(result.status, "blocked");
  assert.match(result.error!, /Agents with a terminal need a sandbox that works: bubblewrap does not isolate here/);
  assert.equal(f.agentRequests.length, 0);
  // Where the platform has no sandbox at all (Windows), the module says so before Run.
  service.services.checks = {sandbox: {name: "none", unavailable: async () => "This platform has no sandbox yet.", wrap: () => { throw new Error("never"); }}};
  const module = await f.service.module(f.project.id, "Review");
  assert.equal(module.valid, false);
  const refusal = module.diagnostics.find(item => item.code === "SYNTHESIS_SANDBOX");
  assert.match(refusal?.message ?? "", /need a sandbox: This platform has no sandbox yet\. Remove terminal\(\.\.\.\)/);
  assert.equal(refusal?.file, "Synthesis/Review/Review.lcflow");
  assert.ok(refusal!.line > 1, "it points at terminal(...)");
  assert.ok(compileProgram(spec, flow(`t = terminal(allow = ["node"]);`).replace('policy = "agents-v1";', 'policy = "cloud-files-v1";')).diagnostics.some(item => item.code === "FLOW_POLICY_CAPABILITY"));
});

test("terminal, security: links a command plants in its copy lead nowhere: the app never writes through them, and they open nothing to reading", { skip: !sandboxed }, async (t) => {
  const { platformSandbox } = await import("../src/synthesis/checks/sandbox");
  if (await platformSandbox().unavailable()) { t.skip("no working sandbox here"); return; }
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "lcai-terminal-escape-"));
  t.after(() => fs.rm(outside, {recursive: true, force: true}));
  await fs.writeFile(path.join(outside, "secret.txt"), "outside secret");
  const node = (code: string) => tool("terminal.run", {command: "node", args: ["-e", code]});
  const f = await fixture(t, {script: steps({ attacker: [
    // The copy's review folder becomes a link out of it; the agent then changes a candidate file there.
    node(`const fs=require('fs');fs.rmSync('review',{recursive:true,force:true});fs.symlinkSync(${JSON.stringify(outside)},'review');console.log('planted')`),
    tool("file.write", {path: "review/notes/escape.md", content: "should stay in the run", expectedVersion: "missing"}),
    node("console.log('synced')"),
    // node_modules becomes a link to the outside folder: reading through it must still fail.
    node(`const fs=require('fs');fs.rmSync('node_modules',{recursive:true,force:true});fs.symlinkSync(${JSON.stringify(outside)},'node_modules');console.log('swapped')`),
    node("try{console.log(require('fs').readFileSync('node_modules/secret.txt','utf8'))}catch(e){console.log('denied',e.code)}")
  ]})});
  await fs.mkdir(path.join(f.root, "node_modules", "pkg"), {recursive: true});
  await fs.writeFile(path.join(f.root, "node_modules", "pkg", "index.js"), "module.exports = 1;");
  await fs.mkdir(path.join(f.root, "review", "notes"), {recursive: true});
  await fs.writeFile(path.join(f.root, "review", "notes", "keep.md"), "kept");
  const result = await f.run(`attacker = agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("src/**", "review/**"), files.write("review/notes/**"), terminal(allow = ["node"])], steps = 10);
    results = await parallel_map(attacker, ["attacker"]);
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");`);
  const lines = (await f.service.agent(result.id, 0)).final!.split("\n");
  await assert.rejects(fs.access(path.join(outside, "notes", "escape.md")), {code: "ENOENT"}, "nothing was written through the planted link");
  assert.equal(await fs.readFile(path.join(outside, "secret.txt"), "utf8"), "outside secret", "removing the copy deleted nothing through the links left in it");
  assert.doesNotMatch(lines.join("\n"), /outside secret/, "the swapped node_modules link opens nothing");
  assert.match(lines[2], /synced/, "a copy the command broke is made again, and the terminal goes on");
  assert.match(lines[4], /denied/);
  const { toolchainPrefix } = await import("../src/synthesis/agents/Terminal");
  assert.equal(toolchainPrefix(path.join(os.homedir(), "Documents")), false, "a folder of the user's is never a tool's prefix");
  assert.equal(toolchainPrefix(path.join(os.homedir(), ".nvm", "versions", "node", "v22.18.0")), true);
  assert.equal(toolchainPrefix("/opt/homebrew"), true);
});

test("a command that exits before reading its input, and one that leaves a process running, leave the app as it was", { skip: !sandboxed }, async () => {
  const { runCommand } = await import("../src/utils/runCommand");
  const early = await runCommand("/bin/sh", ["-c", "exit 3"], os.tmpdir(), 10_000, undefined, undefined, { input: "x".repeat(4 * 1024 * 1024) });
  assert.equal(early.exitCode, 3, "a broken pipe is the command's answer, not the app's failure");
  const { platformSandbox } = await import("../src/synthesis/checks/sandbox");
  if (await platformSandbox().unavailable()) return;
  const { AgentTerminal } = await import("../src/synthesis/agents/Terminal");
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lcai-orphan-project-")));
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lcai-orphan-work-"));
  const terminal = new AgentTerminal({ sandbox: platformSandbox(), workRoot, git: false },
    { root, readable: async () => [], content: async () => null, candidate: () => ({ files: {}, removed: [] }) }, "agent-0", ["node"]);
  // A child that ignores SIGTERM and would run for good.
  const result = await terminal.run("node", ["-e", "const c=require('child_process').spawn(process.execPath,['-e','process.on(\\'SIGTERM\\',()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);process.exit(7)"], "", 30);
  assert.equal(result.exitCode, 7, "the command's own status comes back");
  const orphan = Number(result.stdout.trim().split("\n")[0]);
  assert.ok(orphan > 0, result.stdout + result.stderr);
  await new Promise(resolve => setTimeout(resolve, 300));
  let alive = true; try { process.kill(orphan, 0); } catch { alive = false; }
  if (alive) process.kill(orphan, "SIGKILL");
  assert.equal(alive, false, "what the command left running, even ignoring SIGTERM, ended with it");
  await terminal.dispose();
  for (const dir of [root, workRoot]) await fs.rm(dir, { recursive: true, force: true });
});

test("consent withdrawn while agents work: a started agent's next request is not sent, nor the lead's", async (t) => {
  let withdrawn = false;
  const f: Awaited<ReturnType<typeof fixture>> = await fixture(t, {script: (_task, results) => results.length ? final(results.join("\n")) : tool("file.read", {path: "src/alpha.ts"}),
    delay: async () => { if (!withdrawn) { withdrawn = true; await f.projects.update(f.project.id, {cloudModels: false}); } }});
  const result = await f.run(`agents = [agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("src/**")])];
    results = await parallel_map(agents, ["read alpha"]);
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");`);
  assert.equal(f.agentRequests.length, 1, "the agent's second request was never sent");
  assert.match((await f.service.agent(result.id, 0)).error ?? "", /does not allow cloud models/);
  assert.equal(result.status, "blocked");
  assert.match(result.error!, /does not allow cloud models/);
  assert.equal(f.advisory.length, 0, "the lead sent nothing either");
});

test("Changes reads what a report cites: Grounded marks each place, and this computer may open a cited project file, nothing else", async (t) => {
  const f = await fixture(t, {script: writer, report: () => "# Report\n- src/alpha.ts:2 is fine\n- src/missing.ts:3 is not\n- src/link.ts and src/bin.ts\n"});
  await fs.symlink(path.join(f.root, "secret", "keys.txt"), path.join(f.root, "src", "link.ts"));
  await fs.writeFile(path.join(f.root, "src", "bin.ts"), "binary\0data");
  await fs.writeFile(path.join(f.root, "Synthesis", "Review", "Review.lcspec"), spec.replace('hard clean = Forbid("notes/**", "FORBIDDEN");', 'hard grounded = Grounded("REPORT.md");'));
  await fs.writeFile(path.join(f.root, "Synthesis", "Review", "Review.lcflow"), flow(`agents = [agent(provider = "deepseek", model = "deepseek-flash", tools = [files.read("src/**"), files.write("review/notes/**")], steps = 4)];
    results = await parallel_map(agents, ["Task 1: write notes/n1.md"]);
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");`));
  const run = await f.service.wait((await f.service.start(f.project.id, "Review")).id);
  const gate = run.evidence?.gates.find(item => item.id === "grounded");
  assert.equal(gate?.grounded?.file, "REPORT.md");
  assert.deepEqual(gate?.grounded?.references.map(item => [item.path, item.status]), [["src/alpha.ts", "ok"], ["src/missing.ts", "missing"], ["src/link.ts", "missing"], ["src/bin.ts", "ok"]]);
  assert.equal((await f.service.diff(run.id)).root, "review");

  const app = express();
  app.use(localApiOriginGuard);
  app.use("/synthesis", createSynthesisRouter(() => f.service));
  app.use((error: Error & { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.statusCode ?? 500).json({ message: error.message }); });
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const read = (cited: string, headers: Record<string, string> = {}) => fetch(`${origin}/synthesis/runs/${run.id}/project-file?path=${encodeURIComponent(cited)}`, { headers });
  const alpha = await read("src/alpha.ts");
  assert.equal(alpha.status, 200);
  assert.deepEqual(await alpha.json(), { path: "src/alpha.ts", content: "export const alpha = 1;\n// line two of alpha\n" });
  assert.equal(alpha.headers.get("cache-control"), "no-store");
  assert.equal((await read("src/beta.ts")).status, 403, "a project file the run does not cite");
  assert.equal((await read("secret/keys.txt")).status, 403);
  assert.equal((await read("../outside.ts")).status, 400);
  assert.equal((await read(".env/a.ts")).status, 400);
  assert.equal((await read("src/missing.ts")).status, 404);
  assert.equal((await read("src/link.ts")).status, 400, "a link leads nowhere");
  assert.equal((await read("src/bin.ts")).status, 415);
  assert.equal((await read("src/alpha.ts", { "sec-fetch-site": "cross-site" })).status, 403, "another site cannot read it");
});

test("a report cut off at the model's output limit is asked for again, half as long, and one of reasoning only again; twice, the run says what to change", async () => {
  const { synthesizeResults } = await import("../src/synthesis/agents");
  const model = {id: "deepseek-flash", providerId: "deepseek", displayName: "deepseek-flash"} as never;
  const results = [{index: 0, task: "a", ok: true, output: "- src/a.ts:1 swallows an error", error: "", files: []}];
  const prompts: string[] = [], progress: string[] = [];
  const llm = (answers: Array<Partial<LLMResponse>>) => ({
    generateObject: async () => { throw new Error("never"); },
    generateText: async (request: LLMRequest) => { prompts.push(request.prompt); return {provider: "deepseek", model: "deepseek-flash", text: "", ...answers.shift()} as LLMResponse; }
  }) as never;
  const request = {results, file: "REPORT.md", module: "Review", description: "d", instruction: "Keep every finding.", signal: new AbortController().signal,
    progress: async (message: string) => { progress.push(message); }, spent: () => {}};
  const text = await synthesizeResults(llm([{text: "# Report\n- src/a.ts", error: "Model response stopped: length. No action was executed."}, {text: "# Report\n- src/a.ts:1"}]), model, request);
  assert.equal(text, "# Report\n- src/a.ts:1", "the cut-off text is never used");
  assert.equal(prompts.length, 2);
  assert.match(prompts[0]!, /Keep every finding\.\n\nUnless that says otherwise, keep it under 2,500 words\./, "an instruction of the flow's keeps the bound");
  assert.match(prompts[1]!, /ran over the output limit and was cut off\. Answer again at most half as long/);
  assert.match(progress[0]!, /deepseek-flash ran over its output limit/);
  await assert.rejects(synthesizeResults(llm([{error: "Anthropic response stopped: max_tokens."}, {error: "Anthropic response stopped: max_tokens."}]), model, request),
    /ran over its output limit, even when asked for one half as long\. Ask for a shorter REPORT\.md/);
  // An answer of reasoning only is asked for again, once.
  prompts.length = 0; progress.length = 0;
  assert.equal(await synthesizeResults(llm([{error: "The model returned no final answer (its response may contain only reasoning)."}, {text: "# Report"}]), model, request), "# Report");
  assert.match(prompts[1]!, /had no text, only reasoning\. Answer with the content itself\./);
  assert.match(progress[0]!, /answered with reasoning only: asking again/);
  await assert.rejects(synthesizeResults(llm([{error: "The model returned no final answer (its response may contain only reasoning)."}, {error: "The model returned no final answer (its response may contain only reasoning)."}]), model, request),
    /answered with reasoning only, twice/);
  // Any other error is not repeated.
  prompts.length = 0;
  await assert.rejects(synthesizeResults(llm([{error: "HTTP 401"}]), model, request), /deepseek-flash: HTTP 401/);
  assert.equal(prompts.length, 1);
});
