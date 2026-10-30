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
  // The owner's output folder is their home here (Settings allow any folder), and they allowed Documents.
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lc-device-files-")));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const documents = path.join(home, "Documents"), appData = path.join(home, "Library", "Local Cognitive", "app");
  await fs.mkdir(documents); await fs.mkdir(appData, { recursive: true });
  const resolver = new WorkspaceResolver({ appDataDir: appData, outputDir: home, filesystem: { allowedDirectories: [documents] } } as never, {} as never, {} as never);
  const store = new SessionSettingsStore({ baseDir: path.join(home, "sessions") }, { providerId: "local" }, {});
  const settings = await store.update("chat", { defaultAccessMode: "default" });
  const asked: ApprovalOperation[] = [];
  const context = (extra: Partial<ExecutionContext> = {}): ExecutionContext => ({ actor: { sessionId: "chat", channel: "http" }, memory: [], conversation: [], providerId: "local",
    activeTarget: { providerId: "local" }, sessionSettings: structuredClone(settings), requestApproval: async operation => { asked.push(operation); return false; }, ...extra });
  const file = new FileTool({ outputDir: home, allowedDirectories: [documents], accessMode: "restricted" });
  const request = (rawInput: string, extra: Partial<ExecutionContext> = {}): ToolExecutionRequest => ({ rawInput, title: "t", content: "hello", context: context(extra),
    result: { response: "hello", provider: "local", model: "test" } });
  return { home, documents, resolver, file, request, asked };
}

test("a device's turn on a desktop keeps its files in its chat's own folder, and reaches the owner's home or allowed folders only through an approval marked outside", async t => {
  const f = await fileFixture(t);
  assert.equal((await f.file.execute(f.request(`Write file \`${f.documents}/mine.txt\``))).ok, true, "the owner's own chat writes there freely");
  assert.equal(f.asked.length, 0);
  const workspace = await f.resolver.forDeviceChat("chat");
  assert.equal(workspace.rootPath.startsWith(path.join(f.home, "Library", "Local Cognitive", "app", "workspaces", "devices")), true);
  const device = { requestMetadata: { deviceRun: true, deviceOutputOnly: true }, workspace };
  for (const target of [`${f.documents}/theirs.txt`, `${f.home}/.zshrc`]) {
    assert.equal((await f.file.execute(f.request(`Write file \`${target}\``, device))).metadata?.cancelled, true, target);
    await assert.rejects(fs.access(target), "nothing was written");
  }
  assert.deepEqual(f.asked.map(operation => [operation.operation, operation.scope]), [["write", "outside"], ["write", "outside"]]);
  assert.equal((await f.file.execute(f.request("Write file `note.txt`", device))).ok, true, "its own folder needs no approval");
  await fs.access(path.join(workspace.rootPath, "note.txt"));
  assert.equal((await f.file.execute(f.request("Delete file `note.txt`", device))).metadata?.cancelled, true);
  assert.equal(f.asked.at(-1)!.scope, "workspace", "a delete there asks, and a device may approve it");
  const lost = await f.file.execute(f.request("Write file `note.txt`", { requestMetadata: { deviceRun: true, deviceOutputOnly: true } }));
  assert.deepEqual([lost.ok, lost.output], [false, "Files are not available in this chat from a device."], "no folder of its own, no files");
});

test("a device's chat folder is its own, in the app's data, and a link put in its place is refused", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lc-device-workspace-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appData = path.join(root, "app");
  const resolver = new WorkspaceResolver({ appDataDir: appData, outputDir: root, filesystem: { allowedDirectories: [root] } } as never, {} as never, {} as never);
  const first = await resolver.forDeviceChat("chat-1"), second = await resolver.forDeviceChat("chat-2");
  assert.notEqual(first.rootPath, second.rootPath);
  assert.deepEqual(first.allowedDirectories, [first.rootPath]);
  assert.equal(first.outputDir, first.rootPath);
  assert.equal(path.dirname(first.rootPath), await fs.realpath(path.join(appData, "workspaces", "devices")));
  const planted = resolver.deviceChatFolder("chat-3");
  await fs.symlink(root, planted);
  await assert.rejects(resolver.forDeviceChat("chat-3"), /changed while being created/);
});

test("on a desktop a device opens a chat's files only from its places, whatever the owner's turns in that chat read", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lc-device-reads-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const mine = path.join(root, "ssh-config"), theirs = path.join(root, "device", "note.txt");
  await fs.mkdir(path.dirname(theirs)); await fs.writeFile(mine, "secret"); await fs.writeFile(theirs, "hello");
  const tools = [mine, theirs].map(filePath => ({ tool: "file", ok: true, metadata: { filePath } }));
  const runtime = { sessionSettingsStore: { get: async () => ({ defaultAccessMode: "default", codeAgents: [], hypothesisAgents: [], subagents: [] }) }, projectStore: { get: async () => null },
    memoryService: { recent: async () => [{ metadata: { tools } }] }, sessionIndexStore: { get: async (id: string) => ({ id }) } };
  const ops = createChatOperations({ runtimeManager: { getRuntime: () => runtime, getSettings: async () => ({ ui: {}, memory: { localProfileId: "p" } }) } as unknown as RuntimeManager,
    sessionIndexStore: { get: async (id: string) => ({ id }) } as unknown as SessionIndexStore, runService: {} as RunService, journal: {} as EventJournal,
    scopeOf: () => "device", deviceFileRoots: async () => [path.dirname(theirs)] });
  const context: OperationContext = { accountId: "a", deviceId: "d", signal: new AbortController().signal };
  const read = (file: string) => Promise.resolve(ops["files.read"]!({ sessionId: "chat", path: file, as: "text" }, context)) as Promise<{ content: string }>;
  assert.equal((await read(theirs)).content, "hello");
  await assert.rejects(read(mine), (error: unknown) => error instanceof RemoteOperationError && error.code === "file_unavailable", "the owner's file stays on the computer");
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
