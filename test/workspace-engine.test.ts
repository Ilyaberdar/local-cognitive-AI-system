import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import type { Request, Response } from "express";
import { createApiRouter } from "../src/api/routes";
import { RuntimeManager } from "../src/app/RuntimeManager";
import { CodeAgentCoordinator } from "../src/agents/code/CodeAgentCoordinator";
import { AgentLoopRunner } from "../src/agents/runtime/AgentLoopRunner";
import { CognitiveEngine } from "../src/core/CognitiveEngine";
import { ModeDetector } from "../src/core/ModeDetector";
import { Router } from "../src/core/Router";
import { ToolRequestBuilder } from "../src/core/ToolRequestBuilder";
import { LLMRegistry } from "../src/llm/LLMRegistry";
import { LLMService } from "../src/llm/LLMService";
import { OutputSanitizer } from "../src/llm/OutputSanitizer";
import { LocalJsonMemoryAdapter } from "../src/memory/LocalJsonMemoryAdapter";
import { MemoryService } from "../src/memory/MemoryService";
import { VectorStore } from "../src/memory/VectorStore";
import { ProjectStore } from "../src/projects/ProjectStore";
import { SessionIndexStore } from "../src/session/SessionIndexStore";
import { SessionSettingsStore } from "../src/session/SessionSettingsStore";
import { NotionTool } from "../src/tools/NotionTool";
import { OperationExecutor } from "../src/tools/OperationExecutor";
import { PluginOperationExecutor } from "../src/tools/PluginOperationExecutor";
import { Tool } from "../src/tools/Tool.interface";
import { ToolRegistry } from "../src/tools/ToolRegistry";
import { ActorContext, ExecutionContext, LLMRequest, ProcessInput, ToolExecutionRequest } from "../src/types";
import { Logger } from "../src/utils/Logger";
import { WorkspaceResolver } from "../src/workspace/WorkspaceResolver";

const final = (text: string) => ({ type: "final", text });
const action = (tool: string, args: Record<string, unknown>) => ({ type: "tool_call", tool, arguments: args });
type Script = (request: LLMRequest) => Record<string, unknown> | Promise<Record<string, unknown>>;

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lcai-workspace-engine-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appDataDir = path.join(root, "data");
  const aRoot = path.join(root, "project-a");
  const bRoot = path.join(root, "project-b");
  await Promise.all([fs.mkdir(aRoot), fs.mkdir(bRoot)]);
  const projects = new ProjectStore(appDataDir);
  const a = await projects.create({ name: "A", rootPath: aRoot });
  const b = await projects.create({ name: "B", rootPath: bRoot });
  const sessions = new SessionIndexStore(appDataDir);
  const a1 = await sessions.create("First A", "http", a.id);
  const a2 = await sessions.create("Second A", "http", a.id);
  const b1 = await sessions.create("First B", "http", b.id);
  const ordinary = await sessions.create("Ordinary");
  const resolver = new WorkspaceResolver({ appDataDir }, projects, sessions);
  const settings = new SessionSettingsStore({ baseDir: path.join(appDataDir, "settings") },
    { providerId: "scripted", model: "fixture" }, {});
  for (const session of [a1, a2, b1, ordinary]) {
    await settings.update(session.id, { mode: "general", language: "en", defaultAccessMode: "default" });
  }
  const logger = new Logger();
  t.mock.method(logger, "log", () => {});
  const memory = new MemoryService(new LocalJsonMemoryAdapter({ baseDir: path.join(appDataDir, "memory"), topK: 50 },
    new VectorStore(), logger));
  const calls: LLMRequest[] = [];
  let script: Script = () => { throw new Error("Unexpected provider call"); };
  const providers = new LLMRegistry();
  providers.register({
    id: "scripted", name: "Scripted test provider", defaultModel: "fixture", isConfigured: () => true,
    getDescriptor: () => ({ id: "scripted", name: "Scripted test provider", defaultModel: "fixture", configured: true }),
    generateText: async request => {
      assert.equal(request.outputPurpose, "agent-action");
      calls.push(request);
      return { provider: "scripted", model: "fixture", text: JSON.stringify(await script(request)), usage: { totalTokens: 5 } };
    }
  });
  const llm = new LLMService(providers, "scripted", logger, new OutputSanitizer());
  const legacyCalls: ExecutionContext[] = [];
  const router = new Router();
  for (const mode of ["general", "code", "hypothesis"] as const) router.register(mode, async (_input, context) => {
    assert.equal(context.workspace, undefined, "Project requests must reach the actual coordinator instead of the legacy handler.");
    legacyCalls.push(context);
    return { response: "Legacy response", provider: "scripted", model: "fixture" };
  });
  const tools = new ToolRegistry();
  const legacyToolCalls: string[] = [];
  for (const name of ["file", "command"]) tools.register({
    name, description: `Old ${name} executor`, matchesIntent: input => /^Read\b/.test(input),
    execute: async () => { legacyToolCalls.push(name); return { tool: name, ok: true, output: "Legacy effect" }; },
    toDescriptor: () => ({ name, description: `Old ${name} executor` })
  });
  const pluginConfiguration = { destination: "original-page" };
  const pluginCalls: ToolExecutionRequest[] = [];
  const pluginIntentInputs: string[] = [];
  const plugin: Tool = {
    name: "notes", description: "Publish a note", approvalFingerprint: () => pluginConfiguration.destination,
    matchesIntent: input => { pluginIntentInputs.push(input); return /publish note/i.test(input); },
    execute: async request => { pluginCalls.push(request); return { tool: "notes", ok: true, output: "Published note" }; },
    toDescriptor: () => ({ name: "notes", description: "Publish a note" })
  };
  tools.register(plugin);
  const makeEngine = () => {
    const plugins = new PluginOperationExecutor(appDataDir);
    const runner = new AgentLoopRunner(llm, new OperationExecutor(appDataDir), appDataDir);
    const engine = new CognitiveEngine(new ModeDetector(), router, memory, settings, tools, new ToolRequestBuilder(), logger,
      "scripted", () => false, resolver, new CodeAgentCoordinator(runner), plugins);
    return { engine, plugins, runner };
  };
  const actor = (id: string): ActorContext => ({ sessionId: id, userId: "owner", channel: "http" });
  const seed = (session: { id: string; projectId?: string }, input: string) => memory.save({
    input, output: { response: input }, mode: "general", actor: { ...actor(session.id),
      ...(session.projectId ? { memoryScope: `project:${session.projectId}`, projectId: session.projectId } : {}) }
  });
  return { root, appDataDir, aRoot, bRoot, a, b, a1, a2, b1, ordinary, sessions, resolver, settings, memory, calls,
    legacyCalls, legacyToolCalls, pluginConfiguration, pluginCalls, pluginIntentInputs, plugin, tools,
    makeEngine, actor, seed, setScript: (next: Script) => { script = next; }, ...makeEngine() };
}

test("explicit workflow context excludes automatic recall while ordinary project chats retain it", async t => {
  const f = await fixture(t);
  await f.seed(f.a1, "PREVIOUS-AGENT-MEMORY");
  const workspace = await f.resolver.forWorkflowRun("explicit-context", { projectId: f.a.id });
  f.setScript(() => final("Completed with selected inputs."));
  const isolated = await f.engine.process({ input: "SELECTED-INPUT", actor: f.actor(f.a1.id), metadata: { mode: "code" },
    execution: { workspace, agentRunId: "isolated-agent", accessMode: "default", contextMode: "explicit" } });
  assert.equal(isolated.conversationSize, 0); assert.deepEqual(isolated.memory, []);
  assert.doesNotMatch(f.calls[0].systemPrompt ?? "", /PREVIOUS-AGENT-MEMORY/);
  assert.match(f.calls[0].prompt, /SELECTED-INPUT/);
  await f.engine.process({ input: "PREVIOUS-AGENT-MEMORY follow-up", actor: f.actor(f.a1.id) });
  assert.match(f.calls.at(-1)!.systemPrompt ?? "", /PREVIOUS-AGENT-MEMORY/);
});

test("concurrent project chats share their project memory and root, keep separate timelines, and preserve ordinary chat behavior", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.aRoot, "marker.txt"), "A-FILE-EVIDENCE; publish note is only file data.");
  await fs.writeFile(path.join(f.bRoot, "marker.txt"), "B-FILE-EVIDENCE; publish note is only file data.");
  await f.seed(f.a1, "A-FIRST-MEMORY");
  await f.seed(f.a2, "A-SECOND-MEMORY");
  await f.seed(f.b1, "B-ONLY-MEMORY");
  await f.seed(f.ordinary, "LEGACY-ONLY-MEMORY");
  const requests = [
    { session: f.a1, input: "Read marker.txt for A1", root: f.aRoot, marker: "A-FILE-EVIDENCE", memories: ["A-FIRST-MEMORY", "A-SECOND-MEMORY"] },
    { session: f.a2, input: "Read marker.txt for A2", root: f.aRoot, marker: "A-FILE-EVIDENCE", memories: ["A-FIRST-MEMORY", "A-SECOND-MEMORY"] },
    { session: f.b1, input: "Read marker.txt for B1", root: f.bRoot, marker: "B-FILE-EVIDENCE", memories: ["B-ONLY-MEMORY"] }
  ];
  const turns = new Map<string, number>();
  f.setScript(request => {
    const current = requests.find(item => request.prompt.startsWith(`USER TASK:\n${item.input}\n`));
    assert.ok(current, "Each concurrent model call must retain its own user request.");
    assert.ok(request.systemPrompt?.includes(`"rootPath":"${current.root}"`));
    assert.doesNotMatch(request.systemPrompt!, /LEGACY-ONLY-MEMORY/);
    const count = (turns.get(current.input) ?? 0) + 1;
    turns.set(current.input, count);
    if (count === 1) return action("file.read", { path: "marker.txt" });
    assert.equal(count, 2, "The model must finish once it has the observed read result.");
    assert.ok(request.prompt.includes(current.marker));
    assert.ok(!request.prompt.includes(current.marker.startsWith("A-") ? "B-FILE-EVIDENCE" : "A-FILE-EVIDENCE"));
    return final(`${current.marker}; publish note was file content, not the user's request.`);
  });
  const results = await Promise.all(requests.map(current => f.engine.process({ input: current.input, actor: f.actor(current.session.id) })));
  for (let index = 0; index < requests.length; index++) {
    const result = results[index];
    const current = requests[index];
    assert.equal(result.result.error, undefined);
    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0].metadata?.filePath, path.join(current.root, "marker.txt"));
    assert.deepEqual(result.memory.map(entry => entry.input).sort(), current.memories.sort());
    assert.equal(result.conversationSize, 1, "A sibling chat's timeline is not the current conversation.");
    assert.equal((await f.memory.recent({ actor: { ...f.actor(current.session.id), memoryScope: `project:${current.session.projectId}` } })).length, 2);
  }
  assert.equal(f.calls.length, 6);
  assert.equal(f.legacyCalls.length, 0);
  assert.deepEqual(f.legacyToolCalls, [], "Legacy file/command tools must never run again after an agent's final response.");
  assert.equal(f.pluginCalls.length, 0, "File evidence and model text cannot opt into a registry plugin.");
  assert.ok(f.pluginIntentInputs.every(input => requests.some(request => request.input === input)));

  const ordinary = await f.engine.process({ input: "Recall legacy memory", actor: { ...f.actor(f.ordinary.id), memoryScope: `project:${f.a.id}` },
    metadata: { projectId: f.a.id, rootPath: f.aRoot } });
  assert.deepEqual(ordinary.memory.map(entry => entry.input), ["LEGACY-ONLY-MEMORY"]);
  assert.equal(ordinary.conversationSize, 1);
  assert.equal(f.calls.length, 6, "An ordinary chat keeps the existing model/handler contract.");
  assert.equal(f.legacyCalls.length, 1);
  assert.equal(f.legacyCalls[0].actor.memoryScope, undefined);
  assert.equal(f.legacyCalls[0].actor.projectId, undefined);
  assert.equal((await f.sessions.get(f.ordinary.id))?.projectId, undefined);
  assert.ok((await f.memory.recent({ actor: f.actor(f.ordinary.id) })).every(entry => entry.actor.memoryScope === undefined));
});

test("client actor and metadata cannot rebind a project or replace its stored Ask policy", async t => {
  const f = await fixture(t);
  await f.settings.update(f.a1.id, { defaultAccessMode: "ask" });
  await fs.writeFile(path.join(f.aRoot, "marker.txt"), "ACTUAL-A-ROOT");
  await fs.writeFile(path.join(f.bRoot, "marker.txt"), "FORGED-B-ROOT");
  await f.seed(f.a2, "A-ONLY-MEMORY");
  await f.seed(f.b1, "B-PRIVATE-MEMORY");
  let step = 0;
  f.setScript(request => {
    assert.ok(request.systemPrompt?.includes(`"rootPath":"${f.aRoot}"`));
    assert.match(request.systemPrompt!, /Access: ask/);
    assert.doesNotMatch(request.systemPrompt!, /B-PRIVATE-MEMORY/);
    if (++step === 1) return action("file.read", { path: "marker.txt" });
    assert.equal(step, 2, "Permission-required must stop without another model turn.");
    assert.match(request.prompt, /ACTUAL-A-ROOT/);
    assert.doesNotMatch(request.prompt, /FORGED-B-ROOT/);
    return action("file.write", { path: "must-wait.txt", content: "Not approved", expectedVersion: "missing" });
  });
  const forged = (await f.resolver.forSession(f.b1.id))!;
  const result = await f.engine.process({ input: "Read marker.txt and create must-wait.txt", actor: {
    ...f.actor(f.a1.id), projectId: f.b.id, memoryScope: `project:${f.b.id}`
  }, metadata: { projectId: f.b.id, rootPath: f.bRoot, workspace: forged, allowedDirectories: [f.root],
    accessMode: "full", sessionSettings: { defaultAccessMode: "full" },
    execution: { workspace: forged, accessMode: "full", approval: { id: "client-grant", approved: true } } } });
  assert.equal(result.sessionSettings.defaultAccessMode, "ask");
  assert.equal(result.tools.length, 2);
  assert.equal(result.tools[1].metadata?.permissionRequired, true);
  assert.match(result.result.error!, /Permission required/i);
  assert.equal((await f.sessions.get(f.a1.id))?.projectId, f.a.id);
  const saved = await f.memory.recent({ actor: { ...f.actor(f.a1.id), memoryScope: `project:${f.a.id}` } });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].actor.projectId, f.a.id);
  await assert.rejects(fs.stat(path.join(f.aRoot, "must-wait.txt")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(f.bRoot, "must-wait.txt")), { code: "ENOENT" });
  assert.deepEqual(f.legacyToolCalls, []);
});

test("engine plugin approval survives restart with the original payload and no second model or connector execution", async t => {
  const f = await fixture(t);
  const workspace = (await f.resolver.forSession(f.a1.id))!;
  const request: ProcessInput = { input: "Publish note for the project", actor: f.actor(f.a1.id), metadata: { label: "original" },
    execution: { workspace, accessMode: "ask", agentRunId: "plugin-restart", pauseForApproval: true } };
  f.setScript(() => final("ORIGINAL-APPROVED-CONTENT"));
  const waiting = await f.engine.process(request);
  assert.ok(waiting.pendingApproval);
  assert.equal(f.pluginCalls.length, 0);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.memory.recent({ actor: { ...f.actor(f.a1.id), memoryScope: workspace.memoryScope } })).length, 0,
    "Waiting for approval cannot persist a completed chat response.");
  const proposal = (await f.plugins.store.get(waiting.pendingApproval.id))!;
  assert.equal(proposal.request.metadata?.noteContent, "ORIGINAL-APPROVED-CONTENT");
  request.metadata!.label = "changed after approval was requested";
  await f.seed(f.a1, "Later conversation content must not replace the proposed note");
  request.execution!.approval = { id: waiting.pendingApproval.id, approved: true };
  f.setScript(() => { throw new Error("Resuming a plugin must not ask the model to regenerate the proposal"); });
  const resumed = await f.makeEngine().engine.process(request);
  assert.equal(resumed.result.error, undefined);
  assert.equal(resumed.pendingApproval, undefined);
  assert.equal(resumed.tools.at(-1)?.ok, true);
  assert.equal(f.pluginCalls.length, 1);
  assert.equal(f.pluginCalls[0].metadata?.noteContent, "ORIGINAL-APPROVED-CONTENT");
  assert.equal(f.pluginCalls[0].context.requestMetadata?.label, "original");
  assert.deepEqual(f.pluginCalls[0].context.conversation, []);
  assert.equal(f.pluginCalls[0].content, proposal.request.content);
  const replay = await f.makeEngine().engine.process(request);
  assert.deepEqual(replay.tools, resumed.tools);
  assert.equal(f.pluginCalls.length, 1);
  assert.equal(f.calls.length, 1);
});

test("changed plugin destinations are blocked both after a restart and while a live approval is waiting", async t => {
  for (const scenario of ["restart", "live approval"] as const) await t.test(scenario, async child => {
    const f = await fixture(child);
    const workspace = (await f.resolver.forSession(f.a1.id))!;
    f.setScript(() => final("Proposed note content"));
    const request: ProcessInput = { input: "Publish note for the project", actor: f.actor(f.a1.id),
      execution: { workspace, accessMode: "ask", agentRunId: `plugin-config-${scenario}`, pauseForApproval: scenario === "restart" } };
    let result;
    if (scenario === "restart") {
      const waiting = await f.engine.process(request);
      assert.ok(waiting.pendingApproval);
      f.pluginConfiguration.destination = "different-page";
      request.execution!.approval = { id: waiting.pendingApproval.id, approved: true };
      result = await f.makeEngine().engine.process(request);
    } else {
      request.requestApproval = async proposal => {
        assert.equal(proposal.operation, "plugin");
        assert.match(proposal.details, /Proposed note content/);
        f.pluginConfiguration.destination = "different-page";
        return true;
      };
      result = await f.engine.process(request);
    }
    assert.equal(result.tools.at(-1)?.metadata?.permissionRequired, true);
    assert.match(result.result.error!, /configuration changed/);
    assert.ok("response" in result.result);
    assert.match(result.result.response, /configuration changed/);
    assert.equal(f.pluginCalls.length, 0);
    assert.equal(f.calls.length, 1);
  });
});

test("uncertain plugin effects stop the engine before any later plugin and remain stopped after restart", async t => {
  const f = await fixture(t);
  const workspace = (await f.resolver.forSession(f.a1.id))!;
  let effects = 0;
  let laterEffects = 0;
  f.plugin.execute = async () => { effects++; throw new Error("Connection closed after a possible remote effect"); };
  f.tools.register({ name: "later", description: "Another explicitly requested plugin", matchesIntent: () => true,
    execute: async () => { laterEffects++; return { tool: "later", ok: true, output: "Executed" }; },
    toDescriptor: () => ({ name: "later", description: "Another explicitly requested plugin" }) });
  f.setScript(() => final("Proposed note content"));
  const request: ProcessInput = { input: "Publish note for the project", actor: f.actor(f.a1.id),
    execution: { workspace, accessMode: "full", agentRunId: "plugin-unknown" } };
  const first = await f.engine.process(request);
  assert.equal(first.tools.at(-1)?.metadata?.unknown, true);
  assert.match(first.result.error!, /unknown/);
  const replay = await f.makeEngine().engine.process(request);
  assert.equal(replay.tools.at(-1)?.metadata?.unknown, true);
  assert.equal(effects, 1);
  assert.equal(laterEffects, 0);
  assert.equal(f.calls.length, 1);
});

test("declining a plugin approval replaces the model's success claim and returns failure to its workflow caller", async t => {
  const f = await fixture(t);
  const workspace = (await f.resolver.forSession(f.a1.id))!;
  f.setScript(() => final("The note was saved successfully."));
  let laterEffects = 0;
  f.tools.register({ name: "later", description: "Another requested plugin", matchesIntent: () => true,
    execute: async () => { laterEffects++; return { tool: "later", ok: true, output: "Executed" }; },
    toDescriptor: () => ({ name: "later", description: "Another requested plugin" }) });
  const request: ProcessInput = { input: "Publish note for the project", actor: f.actor(f.a1.id),
    execution: { workspace, accessMode: "ask", agentRunId: "plugin-declined", pauseForApproval: true } };
  const waiting = await f.engine.process(request);
  assert.ok(waiting.pendingApproval);
  request.execution!.approval = { id: waiting.pendingApproval.id, approved: false };
  const declined = await f.makeEngine().engine.process(request);
  assert.equal(declined.pendingApproval, undefined, "A rejected plugin ends this invocation before asking to run another plugin.");
  assert.equal(declined.tools.at(-1)?.metadata?.cancelled, true);
  assert.match(declined.result.error!, /Cancelled/);
  assert.ok("response" in declined.result);
  assert.match(declined.result.response, /Cancelled/);
  assert.doesNotMatch(declined.result.response, /saved successfully/);
  assert.equal(f.pluginCalls.length, 0);
  assert.equal(laterEffects, 0);
  request.execution!.approval.approved = true;
  const replay = await f.makeEngine().engine.process(request);
  assert.equal(replay.result.error, declined.result.error);
  assert.equal(f.pluginCalls.length, 0);
  assert.equal(f.calls.length, 1);
});

test("Notion approval identity changes with its actual destination and credential configuration without exposing their values", () => {
  const options = { apiKey: "fixture-secret-token", parentPageId: "original-page", titleProperty: "Name", version: "2026-03-11" };
  const tool = new NotionTool(options);
  const original = tool.approvalFingerprint();
  assert.match(original, /^[a-f0-9]{64}$/);
  assert.equal(new NotionTool({ ...options }).approvalFingerprint(), original);
  for (const changed of [{ parentPageId: "new-page" }, { apiKey: "new-secret" }, { titleProperty: "Title" }, { dataSourceId: "data-source" }]) {
    assert.notEqual(new NotionTool({ ...options, ...changed }).approvalFingerprint(), original);
  }
  options.parentPageId = "new-page";
  assert.notEqual(tool.approvalFingerprint(), original);
});

test("workflow agent trace includes a waiting adviser before the main agent starts and excludes another run's records", async t => {
  const f = await fixture(t);
  await f.settings.update(f.a1.id, { mode: "code", codeAgents: [
    { id: "reader", name: "Reader", providerId: "scripted", model: "adviser", accessMode: "default" }
  ] });
  const outside = path.join(f.root, "outside.txt");
  await fs.writeFile(outside, "External evidence needs approval");
  const workspace = (await f.resolver.forSession(f.a1.id))!;
  const baseId = "workflow-owned:research:invocation";
  f.setScript(request => {
    assert.equal(request.model, "adviser", "The main agent must not start while its adviser is waiting.");
    return action("file.read", { path: outside });
  });
  const waiting = await f.engine.process({ input: "@Reader Read external evidence", actor: f.actor(f.a1.id),
    execution: { workspace, accessMode: "default", agentRunId: baseId, pauseForApproval: true } });
  assert.ok(waiting.pendingApproval);
  assert.equal(await f.runner.store.get(`${baseId}:agent:main`), undefined);
  const adviser = (await f.runner.store.get(`${baseId}:agent:reader`))!;
  assert.equal(adviser.status, "waiting");
  const foreignId = "another-workflow:agent:private";
  await f.runner.store.save({ ...adviser, id: foreignId, turns: [{ type: "result", content: "FOREIGN-PRIVATE-EVIDENCE" }] });
  const budget = (await f.runner.store.getBudget(baseId))!;
  await f.runner.store.saveBudget({ ...budget, memberIds: [...budget.memberIds, foreignId] });
  const manager = { getRuntime: () => ({
    agentLoopRunner: f.runner,
    taskService: { getRunDetail: async (runId: string) => runId === "owned" ? { nodeRuns: [{ agentRunId: baseId }] } : null }
  }) } as unknown as RuntimeManager;
  const api = createApiRouter(manager, f.sessions);
  // Exercise Express path matching and decoding without requiring an OS listening socket.
  const read = (runId: string, agentId: string) => new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    let status = 200;
    const url = `/workflow-runs/${runId}/agent-runs/${encodeURIComponent(agentId)}`;
    const request = { method: "GET", url, originalUrl: url, headers: {} } as Request;
    const response = { status(code: number) { status = code; return this; }, json(body: unknown) { resolve({ status, body }); return this; } };
    api(request, response as Response, error => error ? reject(error) : resolve({ status: 404, body: undefined }));
  });
  const response = await read("owned", baseId);
  assert.equal(response.status, 200);
  const body = response.body as { id: string; agents: Array<{ id: string; status: string }>; turns: Array<{ content: string }> };
  assert.equal(body.id, baseId);
  assert.deepEqual(body.agents.map(agent => [agent.id, agent.status]), [[adviser.id, "waiting"]]);
  assert.match(body.turns[0].content, /^\[reader\]/);
  assert.doesNotMatch(JSON.stringify(body), /FOREIGN-PRIVATE-EVIDENCE/);
  assert.equal((await read("owned", adviser.id)).status, 200);
  assert.equal((await read("owned", foreignId)).status, 404);
  assert.equal((await read("other", baseId)).status, 404);
});
