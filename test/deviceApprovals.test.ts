import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { RuntimeManager } from "../src/app/RuntimeManager";
import { deviceApprovalRefusal } from "../src/remote/host/deviceApprovals";
import { RemoteOperationError, type OperationContext } from "../src/remote/host/RemoteHost";
import { createChatOperations } from "../src/runtime/chatOperations";
import type { EventJournal } from "../src/runtime/EventJournal";
import type { RunService } from "../src/runtime/RunService";
import type { SessionIndexStore } from "../src/session/SessionIndexStore";
import { SessionSettingsStore } from "../src/session/SessionSettingsStore";
import { FileTool } from "../src/tools/FileTool";
import type { ApprovalOperation, ExecutionContext, ToolExecutionRequest } from "../src/types";
import { WorkspaceResolver } from "../src/workspace/WorkspaceResolver";

const RUN = "4f1c1b0e-8d5a-4b8e-9c55-0a6b2f1e9d11", APPROVAL = "0b6a2f1e-9d11-4f1c-8d5a-4b8e9c550a6b";
const refused = (operation: Record<string, unknown>) => deviceApprovalRefusal(operation, "MacBook");

test("on a desktop a device approves file changes inside its own folders and public pages; commands, other files and anything unknown it may only decline", () => {
  assert.equal(refused({ tool: "file", operation: "delete", scope: "workspace" }), undefined, "a chat's file in its folder");
  assert.equal(refused({ tool: "file", operation: "file.write", scope: "workspace", summary: "file.write · notes.md" }), undefined, "an agent's or a workflow's file in its folder");
  assert.equal(refused({ url: "https://example.com/", approvalId: APPROVAL, permissionRequired: true }), undefined, "a public page for a workflow");
  for (const operation of [
    { tool: "command", operation: "command", scope: "outside" }, { tool: "command", operation: "command.run", scope: "workspace" },
    { permissionRequired: true, operation: "command", executable: "rm", args: ["-rf", "/"] },
    { tool: "file", operation: "write", scope: "outside" }, { tool: "file", operation: "read" },
    { permissionRequired: true, operation: "file_write", path: "/Users/me/.ssh/config", content: "x" },
    { url: "http://printer.local/", place: "local" }, { tool: "mcp", operation: "call" }, {}
  ]) assert.match(refused(operation) ?? "", /^Devices cannot approve this on MacBook: .*Decline it, or on MacBook allow devices to approve commands and files/, JSON.stringify(operation));
  assert.match(refused({ tool: "command", operation: "command" })!, /it runs a command on that computer/);
  assert.match(refused({ tool: "file", operation: "write", scope: "outside" })!, /it reaches files outside this chat's own folder/);
});

async function fileFixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lc-device-files-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output"), documents = path.join(root, "Documents");
  await fs.mkdir(output); await fs.mkdir(documents);
  const store = new SessionSettingsStore({ baseDir: path.join(root, "sessions") }, { providerId: "local" }, {});
  const settings = await store.update("chat", { defaultAccessMode: "default" });
  const asked: ApprovalOperation[] = [];
  const context = (metadata?: Record<string, unknown>): ExecutionContext => ({ actor: { sessionId: "chat", channel: "http" }, memory: [], conversation: [], providerId: "local",
    activeTarget: { providerId: "local" }, sessionSettings: structuredClone(settings),
    ...(metadata ? { requestMetadata: metadata } : {}), requestApproval: async operation => { asked.push(operation); return false; } });
  // The owner allowed Documents for their own chats in Settings.
  const file = new FileTool({ outputDir: output, allowedDirectories: [documents], accessMode: "restricted" });
  const request = (rawInput: string, metadata?: Record<string, unknown>): ToolExecutionRequest => ({ rawInput, title: "t", content: "hello", context: context(metadata),
    result: { response: "hello", provider: "local", model: "test" } });
  return { output, documents, file, request, asked };
}

test("a device's turn on a desktop reaches the app's output folder without asking, and the owner's allowed folders only through an approval marked outside", async t => {
  const f = await fileFixture(t);
  const device = { deviceRun: true, deviceOutputOnly: true };
  assert.equal((await f.file.execute(f.request(`Write file \`${f.documents}/mine.txt\``))).ok, true, "the owner's own chat writes there freely");
  assert.equal(f.asked.length, 0);
  const result = await f.file.execute(f.request(`Write file \`${f.documents}/theirs.txt\``, device));
  assert.equal(result.metadata?.cancelled, true);
  assert.deepEqual(f.asked.map(operation => [operation.operation, operation.scope]), [["write", "outside"]]);
  await assert.rejects(fs.access(path.join(f.documents, "theirs.txt")), "nothing was written");
  assert.equal((await f.file.execute(f.request("Write file `note.txt`", device))).ok, true, "its own output folder needs no approval");
  await fs.access(path.join(f.output, "note.txt"));
  assert.equal((await f.file.execute(f.request("Delete file `note.txt`", device))).metadata?.cancelled, true);
  assert.deepEqual(f.asked.at(-1)!.scope, "workspace", "a delete there asks, and a device may approve it");
});

test("an agent's workspace for a device's turn on a desktop is the output folder alone", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lc-device-workspace-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resolver = new WorkspaceResolver({ appDataDir: path.join(root, "app"), outputDir: path.join(root, "output"), filesystem: { allowedDirectories: ["/Users/me/Documents"] } } as never,
    {} as never, {} as never);
  assert.deepEqual((await resolver.forPluginChat("chat")).allowedDirectories, [path.join(root, "output"), "/Users/me/Documents"]);
  assert.deepEqual((await resolver.forPluginChat("chat", { outputOnly: true })).allowedDirectories, [path.join(root, "output")]);
});

test("a device's approval that the host keeps to itself is refused before it reaches the turn; declining always goes through", async () => {
  let pending: Record<string, unknown> = {};
  const decided: boolean[] = [];
  const runService = { get: () => ({ runId: RUN, sessionId: "chat", status: "waiting_approval" }), pendingApproval: () => ({ approvalId: APPROVAL, ...pending }),
    resolveApproval: (_run: string, _approval: string, approved: boolean) => { decided.push(approved); return { accepted: true }; } };
  const runtime = { sessionSettingsStore: { get: async () => ({ defaultAccessMode: "default", codeAgents: [], hypothesisAgents: [], subagents: [] }) }, projectStore: { get: async () => null } };
  const ops = createChatOperations({ runtimeManager: { getRuntime: () => runtime, getSettings: async () => ({ ui: {} }) } as unknown as RuntimeManager,
    sessionIndexStore: { get: async (id: string) => ({ id }) } as unknown as SessionIndexStore, runService: runService as unknown as RunService, journal: {} as EventJournal,
    scopeOf: () => "device", approvalPolicy: operation => refused(operation) });
  const context: OperationContext = { accountId: "a", deviceId: "d", signal: new AbortController().signal };
  const resolve = (approved: boolean) => Promise.resolve(ops["chat.approvals.resolve"]!({ runId: RUN, approvalId: APPROVAL, approved }, context));
  pending = { tool: "command", operation: "command", summary: "Run rm", details: "rm -rf ~", scope: "outside" };
  await assert.rejects(resolve(true), (error: unknown) => error instanceof RemoteOperationError && error.code === "approval_host_only" && /runs a command/.test(error.message));
  assert.deepEqual(await resolve(false), { accepted: true });
  pending = { tool: "file", operation: "delete", summary: "Delete note.txt", details: "", scope: "workspace" };
  assert.deepEqual(await resolve(true), { accepted: true });
  assert.deepEqual(decided, [false, true], "the refused approval never reached the turn");
});
