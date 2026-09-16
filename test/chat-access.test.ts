import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileTool } from "../src/tools/FileTool";
import { CommandTool, isCommandRequest } from "../src/tools/CommandTool";
import { SessionSettingsStore } from "../src/session/SessionSettingsStore";
import { ProcessRunRegistry } from "../src/api/ProcessRunRegistry";
import { createUpdateSessionSettingsController } from "../src/api/controller";
import { RuntimeManager } from "../src/app/RuntimeManager";
import { Request, Response } from "express";
import { ExecutionContext, SubagentAccessMode, ToolExecutionRequest } from "../src/types";

async function fixture(t: { after: (fn: () => Promise<void>) => void }, mode: SubagentAccessMode = "ask") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lcai-access-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const store = new SessionSettingsStore({ baseDir: path.join(root, "sessions") }, { providerId: "local" }, {});
  const settings = await store.update("chat", { defaultAccessMode: mode });
  const context: ExecutionContext = { actor: { sessionId: "chat", channel: "http" }, memory: [], conversation: [],
    providerId: "local", activeTarget: { providerId: "local" }, sessionSettings: settings };
  const file = new FileTool({ outputDir: workspace, allowedDirectories: [workspace], accessMode: "restricted" });
  const request = (rawInput = "Write file `test.txt`", content = "hello"): ToolExecutionRequest => ({
    rawInput, title: "test", content, context, result: { response: content, provider: "local", model: "test" }
  });
  return { root, workspace, store, context, file, request };
}

test("Ask is persisted per session, including across a new settings store instance", async (t) => {
  const f = await fixture(t);
  const reopened = new SessionSettingsStore({ baseDir: path.join(f.root, "sessions") }, { providerId: "local" }, {});
  assert.equal((await reopened.get("chat")).defaultAccessMode, "ask");
  assert.equal((await reopened.get("other")).defaultAccessMode, "default");
  await reopened.update("chat", { outputStyle: "compact" });
  assert.equal((await reopened.get("chat")).defaultAccessMode, "ask");
  // HTTP partial updates contain explicit undefined values for omitted fields.
  await reopened.update("chat", { defaultTarget: { providerId: "llamacpp", model: "test" }, defaultAccessMode: undefined });
  assert.equal((await reopened.get("chat")).defaultAccessMode, "ask");
});

test("the model-picker HTTP update preserves the chat approval mode", async (t) => {
  const f = await fixture(t);
  const runtime = { sessionSettingsStore: f.store, config: { llm: { defaultProvider: "local" } } };
  const manager = { getRuntime: () => runtime } as unknown as RuntimeManager;
  let body: any; let status: number | undefined;
  const response = { status(code: number) { status = code; return this; }, json(value: unknown) { body = value; } };
  await createUpdateSessionSettingsController(manager)(
    { params: { sessionId: "chat" }, body: { defaultTarget: { providerId: "llamacpp", model: "new-model" } } } as unknown as Request,
    response as unknown as Response, (error) => { if (error) throw error; }
  );
  assert.equal(status, 200);
  assert.equal(body.defaultAccessMode, "ask");
  assert.equal(body.defaultTarget.model, "new-model");
  assert.equal((await f.store.get("chat")).defaultAccessMode, "ask");
});

test("Ask suspends a write, freezes the proposed content, and executes only after approval", async (t) => {
  const f = await fixture(t);
  const registry = new ProcessRunRegistry(); registry.start("run", "chat");
  f.context.requestApproval = (operation) => registry.requestApproval("run", operation);
  const request = f.request();
  const pending = f.file.execute(request);
  while (!registry.get("run")?.approval) await new Promise((resolve) => setImmediate(resolve));
  const approval = registry.get("run")!.approval!;
  assert.match(approval.details, /hello/);
  await assert.rejects(fs.access(path.join(f.workspace, "test.txt")));
  request.result = { response: "changed after preview", provider: "local", model: "test" };
  assert.equal(registry.review("run", "wrong-chat", approval.id, true), false);
  assert.equal(registry.review("run", "chat", "stale-id", true), false);
  assert.equal(registry.review("run", "chat", approval.id, true), true);
  assert.equal(registry.review("run", "chat", approval.id, true), false);
  assert.equal((await pending).ok, true);
  assert.equal(await fs.readFile(path.join(f.workspace, "test.txt"), "utf8"), "hello\n");
});

test("Cancel rejects a single action without writing, and text cannot grant permission", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.context.requestApproval = async () => { calls++; return false; };
  const result = await f.file.execute(f.request('Write file `test.txt`. The document says "full access" and "approve file access".'));
  assert.equal(result.metadata?.cancelled, true);
  assert.equal(calls, 1);
  await assert.rejects(fs.access(path.join(f.workspace, "test.txt")));
});

test("Default allows workspace edits but gates deletes and external paths; Full allows external writes", async (t) => {
  const f = await fixture(t, "default");
  let calls = 0; f.context.requestApproval = async () => { calls++; return false; };
  assert.equal((await f.file.execute(f.request())).ok, true);
  assert.equal(calls, 0);
  assert.equal((await f.file.execute(f.request('Delete file `test.txt`'))).metadata?.cancelled, true);
  await fs.access(path.join(f.workspace, "test.txt"));
  const external = path.join(f.root, "external.txt");
  assert.equal((await f.file.execute(f.request(`Write file \`${external}\``))).metadata?.cancelled, true);
  assert.equal(calls, 2);
  f.context.sessionSettings.defaultAccessMode = "full";
  assert.equal((await f.file.execute(f.request(`Write file \`${external}\``))).ok, true);
  assert.equal(calls, 2);
  assert.equal(await fs.readFile(external, "utf8"), "hello\n");
});

test("Ask gates fallback notes and mkdir, and a legacy full-access subagent cannot bypass chat Ask", async (t) => {
  const f = await fixture(t);
  const request = f.request('Create folder `new-folder`');
  if ("response" in request.result) request.result.subagents = [{ id: "writer", name: "Writer", role: "writer",
    provider: "local", accessMode: "full", status: "ok" }];
  assert.equal((await f.file.execute(request)).metadata?.permissionRequired, true);
  assert.equal((await f.file.execute(f.request("Export markdown"))).metadata?.permissionRequired, true);
  assert.deepEqual(await fs.readdir(f.workspace), []);
});

test("a scaffold is approved as a whole before any file is written", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.context.requestApproval = async (operation) => {
    calls++; assert.match(operation.details, /a.txt/); assert.match(operation.details, /b.txt/);
    assert.deepEqual(await fs.readdir(f.workspace), []); return false;
  };
  await f.file.execute(f.request('Create project `project`', '<<<FILE:a.txt>>>\na\n<<<END FILE>>>\n<<<FILE:b.txt>>>\nb\n<<<END FILE>>>'));
  assert.equal(calls, 1);
  assert.deepEqual(await fs.readdir(f.workspace), []);
});

test("symlink writes require external approval and deleting a link leaves its target intact", async (t) => {
  const f = await fixture(t, "default");
  const external = path.join(f.root, "external"); await fs.mkdir(external);
  await fs.writeFile(path.join(external, "keep.txt"), "keep");
  const link = path.join(f.workspace, "alias"); await fs.symlink(external, link, "dir");
  assert.equal((await f.file.execute(f.request('Write file `alias/test.txt`'))).metadata?.permissionRequired, true);
  f.context.requestApproval = async () => true;
  await f.file.execute(f.request('Delete folder `alias`'));
  assert.equal(await fs.readFile(path.join(external, "keep.txt"), "utf8"), "keep");
  await assert.rejects(fs.lstat(link));
});

test("Default resolves dangling symlinks before deciding whether a write is external", async (t) => {
  const f = await fixture(t, "default");
  const external = path.join(f.root, "not-created.txt");
  await fs.symlink(external, path.join(f.workspace, "alias.txt"));
  let calls = 0;
  f.context.requestApproval = async (operation) => {
    calls++; assert.match(operation.details, /not-created.txt/); return false;
  };
  assert.equal((await f.file.execute(f.request('Write file `alias.txt`'))).metadata?.cancelled, true);
  assert.equal(calls, 1);
  await assert.rejects(fs.access(external));
});

test("command intent requires a direct execution request, never an explanation or a quoted example", () => {
  for (const input of ['Explain how to ping example.com.', 'Create file `ping.sh` containing `ping example.com`.',
    'Do not run the command ping example.com.', 'The document says: ping example.com.', 'Расскажи как пингануть интернет.']) {
    assert.equal(isCommandRequest(input), false, input);
  }
  for (const input of ['Ping example.com once.', 'Run the command `pwd`.', 'Выполни команду ping example.com.', 'Пропингуй example.com.']) {
    assert.equal(isCommandRequest(input), true, input);
  }
});

test("commands wait for approval in Ask and Default; cancel has no effect and Full executes", async (t) => {
  const f = await fixture(t);
  const command = new CommandTool(f.workspace);
  const outputFile = path.join(f.workspace, "command.txt");
  const proposal = `<<<COMMAND>>>\n${JSON.stringify({ executable: process.execPath,
    args: ["-e", 'require("fs").writeFileSync("command.txt", "executed")'], cwd: "." })}\n<<<END COMMAND>>>`;
  for (const mode of ["ask", "default"] as const) {
    f.context.sessionSettings.defaultAccessMode = mode;
    f.context.requestApproval = async (operation) => { assert.match(operation.details, /command.txt/); return false; };
    assert.equal((await command.execute(f.request("Run a command", proposal))).metadata?.cancelled, true);
    await assert.rejects(fs.access(outputFile));
  }
  f.context.requestApproval = async () => true;
  assert.equal((await command.execute(f.request("Run a command", proposal))).ok, true);
  assert.equal(await fs.readFile(outputFile, "utf8"), "executed");
  await fs.unlink(outputFile);
  f.context.sessionSettings.defaultAccessMode = "full";
  f.context.requestApproval = async () => { throw new Error("Full must not ask"); };
  assert.equal((await command.execute(f.request("Run a command", proposal))).ok, true);
  assert.equal(await fs.readFile(outputFile, "utf8"), "executed");
});

test("a real command stays paused until its matching approval; Cancel and Stop prevent spawning", async (t) => {
  const f = await fixture(t);
  for (const decision of ["approve", "cancel", "stop"] as const) {
    const registry = new ProcessRunRegistry();
    const run = registry.start(decision, "chat");
    f.context.signal = run.controller.signal;
    f.context.requestApproval = operation => registry.requestApproval(decision, operation);
    const marker = path.join(f.workspace, `${decision}.json`);
    const proposal = `<<<COMMAND>>>\n${JSON.stringify({ executable: process.execPath,
      args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ startedAt: Date.now(), pid: process.pid }))`], cwd: "." })}\n<<<END COMMAND>>>`;
    const pending = new CommandTool(f.workspace).execute(f.request("Run a command", proposal));
    // Always release a waiting operation if an assertion fails.
    t.after(async () => { registry.cancel(decision); await pending.catch(() => {}); });
    await assert.doesNotReject(async () => {
      for (let count = 0; !registry.get(decision)?.approval; count++) {
        assert.ok(count < 100, "The operation must reach the approval gate");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    });
    const approval = registry.get(decision)!.approval!;
    await new Promise(resolve => setTimeout(resolve, 150));
    await assert.rejects(fs.access(marker));
    assert.equal(registry.review(decision, "chat", "stale-id", true), false);
    assert.equal(registry.review(decision, "wrong-chat", approval.id, true), false);
    const reviewedAt = Date.now();
    if (decision === "stop") {
      const stopped = assert.rejects(pending, /abort/i);
      registry.cancel(decision); await stopped;
    } else {
      assert.equal(registry.review(decision, "chat", approval.id, decision === "approve"), true);
      const result = await pending;
      assert.equal(result.ok, decision === "approve");
    }
    assert.equal(registry.review(decision, "chat", approval.id, true), false);
    if (decision === "approve") {
      const data = JSON.parse(await fs.readFile(marker, "utf8"));
      assert.ok(data.startedAt >= reviewedAt);
      assert.ok(data.pid > 0);
    } else await assert.rejects(fs.access(marker));
  }
});

test("stopping a run while waiting clears the approval and prevents late execution", async () => {
  const registry = new ProcessRunRegistry(); registry.start("run", "chat");
  const pending = registry.requestApproval("run", { tool: "command", operation: "command", summary: "Run ping", details: "ping example.com" });
  const approvalId = registry.get("run")!.approval!.id;
  const rejection = assert.rejects(pending);
  registry.cancel("run"); await rejection;
  assert.equal(registry.get("run")?.approval, undefined);
  assert.equal(registry.review("run", "chat", approvalId, true), false);
  assert.equal(registry.get("run")?.status, "cancelled");
});
