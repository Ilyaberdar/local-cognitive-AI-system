import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PluginOperationExecutor } from "../src/tools/PluginOperationExecutor";
import { Tool } from "../src/tools/Tool.interface";
import { SessionSettingsStore } from "../src/session/SessionSettingsStore";
import { SubagentAccessMode, ToolExecutionRequest, ToolExecutionResult } from "../src/types";
import { NotionTool } from "../src/tools/NotionTool";

test("Notion requires a requested publishing action, not a product mention or explicit prohibition", () => {
  const tool = new NotionTool({ titleProperty: "Name", version: "2025-09-03" });
  for (const input of ["What is Notion?", "Compare Notion with local files", "Do not save this to Notion", "Не сохраняй результат в Notion"]) {
    assert.equal(tool.matchesIntent(input), false, input);
  }
  for (const input of ["Make a note in Notion: project findings", "Save this to Notion", "Сохрани результат в Notion"]) {
    assert.equal(tool.matchesIntent(input), true, input);
  }
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }, mode: SubagentAccessMode = "default") {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lcai-plugin-operation-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settings = await new SessionSettingsStore({ baseDir: path.join(directory, "sessions") }, { providerId: "local" }, {})
    .update("chat", { defaultAccessMode: mode });
  const workspace = { version: 1 as const, kind: "project" as const, rootPath: directory, outputDir: directory,
    allowedDirectories: [directory], memoryScope: "project:p", projectId: "p" };
  const request: ToolExecutionRequest = {
    rawInput: "Save the results to the note plugin", title: "Original title", content: "Original content",
    metadata: { noteTitle: "Original note title", noteContent: "Original note content" },
    result: { response: "Original answer", provider: "local", model: "test" },
    context: { actor: { sessionId: "chat", channel: "system" }, memory: [], conversation: [], providerId: "local",
      activeTarget: { providerId: "local" }, sessionSettings: settings, workspace,
      execution: { agentRunId: "workflow-run:node:invocation", workspace, accessMode: mode, pauseForApproval: true } }
  };
  const captured: ToolExecutionRequest[] = [];
  const tool: Tool = { name: "notes", description: "Creates a note", matchesIntent: () => true,
    execute: async input => { captured.push(input); return { tool: "notes", ok: true, output: "Created note" }; },
    toDescriptor() { return { name: this.name, description: this.description }; } };
  return { directory, request, tool, captured, executor: new PluginOperationExecutor(directory) };
}

test("Ask and Default pause external plugins, preserve exact payload across restart, and replay completed results", async t => {
  for (const mode of ["ask", "default"] as const) {
    const f = await fixture(t, mode);
    const first = await f.executor.execute(f.tool, f.request);
    assert.ok(first.pendingApproval);
    assert.match(first.pendingApproval.details, /Original note content/);
    assert.equal(f.captured.length, 0);
    const resumed = new PluginOperationExecutor(f.directory);
    f.request.title = "Changed title";
    f.request.content = "Changed content";
    f.request.metadata!.noteContent = "Changed metadata";
    f.request.result = { response: "Changed answer", provider: "local", model: "test" };
    f.request.context.execution!.approval = { id: "another-operation", approved: true };
    const stale = await resumed.execute(f.tool, f.request);
    assert.equal(stale.pendingApproval?.id, first.pendingApproval.id);
    assert.equal(f.captured.length, 0);
    f.request.context.execution!.approval = { id: first.pendingApproval.id, approved: true };
    const completed = await resumed.execute(f.tool, f.request);
    assert.equal(completed.result?.ok, true);
    assert.equal(f.captured.length, 1);
    assert.equal(f.captured[0].title, "Original title");
    assert.equal(f.captured[0].content, "Original content");
    assert.equal(f.captured[0].metadata?.noteContent, "Original note content");
    assert.deepEqual(f.captured[0].result, { response: "Original answer", provider: "local", model: "test" });
    const replay = await new PluginOperationExecutor(f.directory).execute(f.tool, f.request);
    assert.deepEqual(replay.result, completed.result);
    assert.equal(f.captured.length, 1);
  }
});

test("Full runs once, while requireApproval still gates and persists a rejection", async t => {
  const full = await fixture(t, "full");
  assert.equal((await full.executor.execute(full.tool, full.request)).result?.ok, true);
  assert.equal(full.captured.length, 1);
  const gated = await fixture(t, "full");
  gated.request.context.execution!.requireApproval = true;
  const pending = await gated.executor.execute(gated.tool, gated.request);
  assert.ok(pending.pendingApproval);
  gated.request.context.execution!.approval = { id: pending.pendingApproval.id, approved: false };
  const denied = await gated.executor.execute(gated.tool, gated.request);
  assert.equal(denied.result?.metadata?.cancelled, true);
  gated.request.context.execution!.approval.approved = true;
  assert.deepEqual((await new PluginOperationExecutor(gated.directory).execute(gated.tool, gated.request)).result, denied.result);
  assert.equal(gated.captured.length, 0);
});

test("HTTP approvals use the frozen proposal and no-handler execution does not implicitly grant permission", async t => {
  const f = await fixture(t);
  f.request.context.execution!.pauseForApproval = false;
  const unavailable = await f.executor.execute(f.tool, f.request);
  assert.equal(unavailable.result?.metadata?.permissionRequired, true);
  assert.equal(f.captured.length, 0);
  let approvalCount = 0;
  f.request.context.requestApproval = async operation => {
    approvalCount++;
    assert.equal(operation.operation, "plugin");
    assert.match(operation.details, /Original content/);
    f.request.title = "Mutated during review";
    f.request.content = "Mutated during review";
    f.request.metadata!.noteContent = "Mutated during review";
    return true;
  };
  assert.equal((await f.executor.execute(f.tool, f.request)).result?.ok, true);
  assert.equal(approvalCount, 1);
  assert.equal(f.captured[0].title, "Original title");
  assert.equal(f.captured[0].metadata?.noteContent, "Original note content");
});

test("loosening policy cannot bypass an existing pending plugin approval", async t => {
  const f = await fixture(t, "ask");
  const first = await f.executor.execute(f.tool, f.request);
  f.request.context.execution!.accessMode = "full";
  f.request.context.sessionSettings.defaultAccessMode = "full";
  assert.equal((await f.executor.execute(f.tool, f.request)).pendingApproval?.id, first.pendingApproval?.id);
  assert.equal(f.captured.length, 0);
});

test("a different actor, raw intent or workspace cannot reuse a saved plugin grant", async t => {
  const f = await fixture(t);
  const pending = await f.executor.execute(f.tool, f.request);
  f.request.context.execution!.approval = { id: pending.pendingApproval!.id, approved: true };
  const originalInput = f.request.rawInput;
  f.request.rawInput = "Send something else";
  await assert.rejects(f.executor.execute(f.tool, f.request), /identity or workspace/);
  f.request.rawInput = originalInput;
  f.request.context.actor.sessionId = "other-chat";
  await assert.rejects(f.executor.execute(f.tool, f.request), /identity or workspace/);
  f.request.context.actor.sessionId = "chat";
  f.request.context.execution!.workspace = { ...f.request.context.execution!.workspace, projectId: "other" };
  await assert.rejects(f.executor.execute(f.tool, f.request), /identity or workspace/);
  assert.equal(f.captured.length, 0);
});

test("executing markers recovered after restart stop as unknown and never repeat the connector", async t => {
  const f = await fixture(t);
  const pending = await f.executor.execute(f.tool, f.request);
  const saved = (await f.executor.store.get(pending.pendingApproval!.id))!;
  saved.status = "executing";
  await f.executor.store.save(saved);
  f.request.context.execution!.approval = { id: saved.id, approved: true };
  const replay = await new PluginOperationExecutor(f.directory).execute(f.tool, f.request);
  assert.equal(replay.result?.metadata?.unknown, true);
  assert.equal((await f.executor.store.get(saved.id))?.status, "unknown");
  assert.equal((await f.executor.execute(f.tool, f.request)).result?.metadata?.unknown, true);
  assert.equal(f.captured.length, 0);
});

test("connector exceptions and cancellation after a possible effect become unknown with no retry", async t => {
  for (const abort of [false, true]) {
    const f = await fixture(t, "full");
    const controller = new AbortController();
    f.request.context.signal = controller.signal;
    let effects = 0;
    f.tool.execute = async (): Promise<ToolExecutionResult> => {
      effects++;
      if (!abort) throw new Error("Connection closed after sending request");
      controller.abort();
      return { tool: "notes", ok: true, output: "Created" };
    };
    const unknown = await f.executor.execute(f.tool, f.request);
    assert.equal(unknown.result?.metadata?.unknown, true);
    f.request.context.signal = undefined;
    assert.equal((await new PluginOperationExecutor(f.directory).execute(f.tool, f.request)).result?.metadata?.unknown, true);
    assert.equal(effects, 1);
  }
});

test("completion-journal I/O failure preserves executing evidence and prevents replay after restart", async t => {
  const f = await fixture(t, "full");
  const write = f.executor.store.save.bind(f.executor.store);
  f.executor.store.save = async saved => {
    if (saved.status === "completed" || saved.status === "unknown") throw new Error("Disk full");
    await write(saved);
  };
  const first = await f.executor.execute(f.tool, f.request);
  assert.equal(first.result?.metadata?.unknown, true);
  const saved = await f.executor.store.get(String(first.result!.metadata!.operationId));
  assert.equal(saved?.status, "executing");
  assert.equal((await new PluginOperationExecutor(f.directory).execute(f.tool, f.request)).result?.metadata?.unknown, true);
  assert.equal(f.captured.length, 1);
});

test("concurrent calls through separate executors perform a plugin action once", async t => {
  const f = await fixture(t, "full");
  const results = await Promise.all([
    f.executor.execute(f.tool, f.request), new PluginOperationExecutor(f.directory).execute(f.tool, f.request)
  ]);
  assert.equal(results[0].result?.ok, true);
  assert.deepEqual(results[0].result, results[1].result);
  assert.equal(f.captured.length, 1);
});
