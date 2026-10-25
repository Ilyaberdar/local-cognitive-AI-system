import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { PROTECTED_REASON, protectedPathReason, protectedPathsFor, setProtectedPaths, setProtectedPathsPlatform } from "../src/security/protectedPaths";
import { FileTool } from "../src/tools/FileTool";
import { WorkspaceFileService } from "../src/tools/WorkspaceFileService";
import { OperationExecutor } from "../src/tools/OperationExecutor";
import { WorkflowPathPolicy } from "../src/workflows/nodes/WorkflowPathPolicy";
import { FileSearchNodeExecutor } from "../src/workflows/nodes/FileSearchNodeExecutor";
import type { NodeExecutionContext } from "../src/workflows/nodes/NodeExecutor";
import { containedPath } from "../src/synthesis/paths";
import { discoverModules } from "../src/synthesis/modules";
import { SynthesisFileTools } from "../src/synthesis/agents/SynthesisFileTools";
import { emptyModuleTemplate } from "../src/synthesis/templates";
import { validateSettingsPatch } from "../src/app/settingsValidation";
import { projectDirectory } from "../src/projects/ProjectStore";
import { resolveReviewPath } from "../src/api/workspaceReview";
import { createChatOperations } from "../src/runtime/chatOperations";
import { RemoteOperationError, type OperationContext } from "../src/remote/host/RemoteHost";
import { SessionSettingsStore } from "../src/session/SessionSettingsStore";
import type { RuntimeManager } from "../src/app/RuntimeManager";
import type { RunService } from "../src/runtime/RunService";
import type { EventJournal } from "../src/runtime/EventJournal";
import type { SessionIndexStore } from "../src/session/SessionIndexStore";
import type { ExecutionContext, SessionSettings } from "../src/types";
import type { WorkspaceSnapshot } from "../src/workspace/types";

const PROTECTED = /app's own data folder/;

/** A checkout of this app with its data folder inside (as a source run keeps it), a folder of the
 * user's beside it, and a link from that folder into the app's data. */
async function layout(t: TestContext) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lc-protect-")));
  const repo = path.join(temp, "repo"), data = path.join(repo, "data"), appData = path.join(data, "app");
  const output = path.join(data, "output"), task = path.join(appData, "workspaces", "tasks", "t1", "workspace"), work = path.join(temp, "work");
  for (const dir of [appData, path.join(data, "sessions"), path.join(data, "memory"), output, task, path.join(repo, "src"), work]) await fs.mkdir(dir, { recursive: true });
  const settingsFile = path.join(appData, "settings.json");
  await fs.writeFile(settingsFile, '{"marker":"SETTINGS_MARKER"}');
  await fs.writeFile(path.join(appData, "workspaces", "managed.json"), "{}");
  await fs.writeFile(path.join(data, "sessions", "s.json"), "SESSION_MARKER in a chat");
  await fs.writeFile(path.join(repo, "src", "index.ts"), "// SESSION_MARKER in the code\n");
  await fs.writeFile(path.join(repo, ".env"), "OPENAI_API_KEY=not-a-real-key\n");
  await fs.writeFile(path.join(output, "report.md"), "# Report\n");
  // A junction needs no privilege on Windows; a link to a file that does not exist may, so it is optional.
  await fs.symlink(appData, path.join(work, "link"), "junction");
  const dangling = await fs.symlink(path.join(appData, "created.txt"), path.join(work, "dangling"), "file").then(() => [path.join(work, "dangling")], () => [] as string[]);
  setProtectedPaths("test", protectedPathsFor({ appDataDir: appData, outputDir: output, sessions: { baseDir: path.join(data, "sessions") }, memory: { baseDir: path.join(data, "memory") } }, { env: {}, cwd: repo }));
  t.after(async () => { setProtectedPaths("test", undefined); await fs.rm(temp, { recursive: true, force: true }); });
  return { temp, repo, data, appData, output, task, work, settingsFile, dangling };
}

const settings = (mode: SessionSettings["defaultAccessMode"]) => ({ mode: "code", language: "en", outputStyle: "balanced", defaultTarget: { providerId: "local" },
  defaultAccessMode: mode, codeAgents: [], hypothesisAgents: [], debate: { enabled: false, profile: "general", support: { providerId: "local" }, attack: { providerId: "local" }, judge: { providerId: "local" } } }) as unknown as SessionSettings;

test("the app's data folder is refused however the path reaches it; its output and task folders are not", async t => {
  const f = await layout(t);
  for (const target of [f.settingsFile, f.appData, path.join(f.work, "..", "repo", "data", "app", "settings.json"), path.join(f.work, "link", "settings.json"),
    path.join(f.appData, "new", "made-later.txt"), ...f.dangling, path.join(f.data, "sessions", "s.json"), path.join(f.appData, "workspaces", "managed.json"),
    path.join(f.repo, ".env"), f.data]) {
    assert.equal(protectedPathReason(target), PROTECTED_REASON, target);
  }
  const upper = path.join(f.repo, "DATA", "App", "settings.json");
  if (fsSync.existsSync(upper)) assert.equal(protectedPathReason(upper), PROTECTED_REASON, "another letter case on a file system that ignores case");
  else t.diagnostic("case-sensitive file system: the other-case spelling is another file");
  for (const target of [path.join(f.output, "report.md"), path.join(f.task, "notes.md"), path.join(f.repo, "src", "index.ts"), f.repo, f.temp, path.join(f.work, "mine.txt")]) {
    assert.equal(protectedPathReason(target), undefined, target);
  }
  setProtectedPathsPlatform("win32");
  try { assert.match(String(protectedPathReason(path.join(f.output, "report.md:hidden"))), /alternate data stream/); }
  finally { setProtectedPathsPlatform(undefined); }
});

test("the built-in file tool refuses the app's own files in every access mode, before asking", async t => {
  const f = await layout(t);
  for (const mode of ["default", "ask", "full"] as const) {
    const tool = new FileTool({ outputDir: f.output, accessMode: "restricted", allowedDirectories: [f.repo, f.work] });
    const context = { actor: { sessionId: "s", channel: "http" }, memory: [], conversation: [], providerId: "local", activeTarget: { providerId: "local" },
      sessionSettings: settings(mode), requestApproval: async () => { throw new Error("no approval may be asked for the app's own files"); } } as unknown as ExecutionContext;
    const run = (rawInput: string) => tool.execute({ rawInput, title: "t", content: "c", context, result: { response: "NEW CONTENT", provider: "local", model: "m" } as never });
    for (const rawInput of [`read file \`${f.settingsFile}\``, `list files in \`${f.appData}\``, `delete file \`${f.settingsFile}\``, `write file \`${path.join(f.appData, "x.md")}\``,
      `read file \`${path.join(f.work, "link", "settings.json")}\``, ...f.dangling.map(link => `write file \`${link}\``)]) {
      const result = await run(rawInput);
      assert.equal(result.ok, false, `${mode}: ${rawInput}`);
      assert.match(result.output, PROTECTED, `${mode}: ${rawInput}`);
      assert.doesNotMatch(result.output, /SETTINGS_MARKER/);
    }
    if (mode === "full") assert.equal((await run(`read file \`${path.join(f.output, "report.md")}\``)).ok, true, "the output folder is read");
  }
  assert.equal(await fs.readFile(f.settingsFile, "utf8"), '{"marker":"SETTINGS_MARKER"}');
  assert.equal(fsSync.existsSync(path.join(f.appData, "x.md")) || fsSync.existsSync(path.join(f.appData, "created.txt")), false);
});

test("agents' file tools: refused in full access, through a link, for a version check; a search from the checkout skips the data folder", async t => {
  const f = await layout(t);
  const workspace: WorkspaceSnapshot = { version: 1, kind: "project", rootPath: f.repo, outputDir: f.repo, allowedDirectories: [f.repo], memoryScope: "project:p" };
  const files = new WorkspaceFileService();
  await assert.rejects(files.prepare({ tool: "file.read", arguments: { path: "data/app/settings.json", startLine: 1 } }, workspace), PROTECTED);
  await assert.rejects(files.prepare({ tool: "file.list", arguments: { path: "data", limit: 10 } }, workspace), PROTECTED);
  await assert.rejects(files.prepare({ tool: "file.write", arguments: { path: path.join(f.work, "link", "x.md"), content: "", expectedVersion: "missing" } }, workspace), PROTECTED);
  const found = await files.execute({ tool: "file.search", arguments: { path: f.repo, query: "SESSION_MARKER", limit: 50, maxFiles: 1000 } }, workspace);
  assert.deepEqual((found.metadata?.results as Array<{ path: string }>).map(item => item.path), ["src/index.ts"]);
  const all = await files.execute({ tool: "file.search", arguments: { path: f.repo, query: "", limit: 200, maxFiles: 1000 } }, workspace);
  assert.deepEqual((all.metadata?.results as Array<{ path: string }>).map(item => item.path).filter(item => item.startsWith("data") || item === ".env"), []);
  const listed = await files.execute({ tool: "file.list", arguments: { path: f.repo, limit: 100 } }, workspace);
  assert.ok((listed.metadata?.entries as Array<{ name: string }>).some(entry => entry.name === "data"), "a folder holding the data folder lists it by name");

  const operations = new OperationExecutor(path.join(f.temp, "operations"));
  const run = (tool: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    operations.execute({ id: `${tool}-${Math.random()}`, agentRunId: "agent", workspace, accessMode: "full", tool, arguments: args, ...extra });
  await assert.rejects(run("file.read", { path: "data/app/settings.json" }), PROTECTED);
  await assert.rejects(run("file.write", { path: "data/app/settings.json", content: "{}" }, { captureVersion: true }), PROTECTED);
  await assert.rejects(run("file.delete", { path: "data/app/settings.json", expectedVersion: "missing" }), PROTECTED);
  assert.equal((await run("file.read", { path: "src/index.ts" })).result?.ok, true);
  assert.equal(fsSync.existsSync(f.settingsFile), true);

  const policy = new WorkflowPathPolicy("full", [], f.repo);
  await assert.rejects(policy.resolve("data/app/settings.json"), PROTECTED);
  await assert.rejects(policy.resolve(path.join(f.work, "link", "new.md")), PROTECTED);
  assert.equal(await policy.resolve("src/index.ts"), path.join(f.repo, "src", "index.ts"));
  const step = { workflow: { id: "w", name: "W", version: 1, entryNodeId: "s", nodes: [], transitions: [], createdAt: "", updatedAt: "" },
    run: { id: "r", workflowId: "w", workflowVersion: 1, status: "running", state: {}, createdAt: "", updatedAt: "" },
    node: { id: "s", type: "file_search", label: "Search", position: { x: 0, y: 0 }, config: { root: ".", queryTemplate: "SESSION_MARKER" } }, previousNodeRuns: [] } as unknown as NodeExecutionContext;
  const searched = await new FileSearchNodeExecutor({ accessMode: "full", allowedDirectories: [], workspaceDir: f.repo }).execute(step);
  assert.deepEqual((searched.data.results as Array<{ path: string }>).map(item => item.path), ["src/index.ts"], "a workflow's file search leaves the data folder out");
});

test("a Synthesis project at a checkout of this app neither reads nor lists the app's data", async t => {
  const f = await layout(t);
  const sources = emptyModuleTemplate("Hidden");
  for (const folder of [path.join(f.appData, "mods"), path.join(f.repo, "src")]) {
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, `${folder.endsWith("src") ? "Shown" : "Hidden"}.lcspec`), sources.spec);
    await fs.writeFile(path.join(folder, `${folder.endsWith("src") ? "Shown" : "Hidden"}.lcflow`), sources.flow);
  }
  await assert.rejects(containedPath(f.repo, "data/app/settings.json"), PROTECTED);
  assert.deepEqual(await discoverModules(f.repo), ["file:src/Shown"]);
  const tools = new SynthesisFileTools(path.join(f.temp, "synthesis"), { root: f.repo, files: {}, baseline: {}, removed: [], writable: () => undefined, hidden: () => false, changed: () => undefined },
    { read: ["**"], write: [], delete: [] });
  const readable = await tools.readable(400);
  assert.ok(readable.includes("src/index.ts"));
  assert.deepEqual(readable.filter(file => file.startsWith("data/") || file === ".env"), []);
  const input = (tool: string, args: Record<string, unknown>) => ({ id: "op", agentRunId: "agent", workspace: { version: 1, kind: "project", rootPath: ".", outputDir: ".", allowedDirectories: ["."], memoryScope: "m" } as WorkspaceSnapshot,
    accessMode: "full" as const, tool, arguments: args });
  await assert.rejects(tools.execute(input("file.read", { path: "data/app/settings.json" })), PROTECTED);
  await assert.rejects(tools.execute(input("file.list", { path: "data/app" })), PROTECTED);
});

test("Settings and Projects refuse a folder inside the app's data, and accept one that holds it", async t => {
  const f = await layout(t);
  assert.throws(() => validateSettingsPatch({ filesystem: { allowedDirectories: [f.repo, f.appData] } } as never), /inside the app's own data folder/);
  assert.throws(() => validateSettingsPatch({ filesystem: { outputDir: path.join(f.appData, "integrations") } } as never), /inside the app's own data folder/);
  validateSettingsPatch({ filesystem: { allowedDirectories: [f.repo, f.temp, f.output, f.task] } } as never);
  await assert.rejects(projectDirectory(f.appData), /inside the app's own data folder/);
  await assert.rejects(projectDirectory(path.join(f.work, "link")), /inside the app's own data folder/);
  assert.equal(await projectDirectory(f.repo), f.repo);
  assert.equal(await projectDirectory(f.task), f.task);
});

test("Review's file view and a device's chat files never open the app's own files", async t => {
  const f = await layout(t);
  const manager = { getRuntime: () => ({ config: { filesystem: { allowedDirectories: [f.repo] } } }) } as unknown as RuntimeManager;
  await assert.rejects(resolveReviewPath(manager, f.settingsFile), (error: { statusCode?: number; message: string }) => error.statusCode === 403 && PROTECTED.test(error.message));
  assert.equal(await resolveReviewPath(manager, path.join(f.repo, "src", "index.ts")), path.join(f.repo, "src", "index.ts"));

  // A chat whose file action named a file of the app's data (an older version, or a full-access chat's command).
  const written = [f.settingsFile, path.join(f.output, "report.md")].map(filePath => ({ tool: "file.read", ok: true, metadata: { filePath } }));
  const store = new SessionSettingsStore({ baseDir: path.join(f.temp, "session-settings") }, { providerId: "openai" }, {});
  const runtime = { sessionSettingsStore: store, providerDescriptors: [], config: { filesystem: { allowedDirectories: [] } },
    sessionIndexStore: { get: async (id: string) => ({ id }) }, projectStore: { get: async () => null },
    memoryService: { recent: async () => [{ metadata: { tools: written } }] } };
  const ops = createChatOperations({
    runtimeManager: { getRuntime: () => runtime, getSettings: async () => ({ memory: { localProfileId: "me" }, filesystem: { outputDir: f.output, allowedDirectories: [] } }) } as unknown as RuntimeManager,
    sessionIndexStore: { get: async (id: string) => ({ id }) } as unknown as SessionIndexStore,
    runService: {} as RunService, journal: {} as EventJournal, scopeOf: () => "device", hostDirectories: [f.temp]
  });
  const context: OperationContext = { accountId: "account", deviceId: "mac", signal: new AbortController().signal };
  const read = (ref: string) => Promise.resolve(ops["files.read"]!({ sessionId: "chat", path: ref, as: "text" }, context)) as Promise<{ content?: string }>;
  assert.equal((await read("<output>/report.md")).content, "# Report\n");
  await assert.rejects(read(f.settingsFile), (error: unknown) => error instanceof RemoteOperationError && error.code === "file_unavailable");
});
