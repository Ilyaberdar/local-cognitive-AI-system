import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { Request, Response } from "express";
import { FileTool } from "../src/tools/FileTool";
import { SessionSettingsStore } from "../src/session/SessionSettingsStore";
import { RuntimeManager } from "../src/app/RuntimeManager";
import { createReadWorkspaceFileController, openWorkspaceEditor, resolveReviewPath, textEditorCommand } from "../src/api/workspaceReview";
import { ToolExecutionRequest } from "../src/types";
import { CognitiveEngine } from "../src/core/CognitiveEngine";
import { ModeDetector } from "../src/core/ModeDetector";
import { Router } from "../src/core/Router";
import { ToolRegistry } from "../src/tools/ToolRegistry";
import { ToolRequestBuilder } from "../src/core/ToolRequestBuilder";
import { MemoryService } from "../src/memory/MemoryService";
import { Logger } from "../src/utils/Logger";
import { buildTextPrompt } from "../src/prompts/common";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lcai-review-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"); await fs.mkdir(workspace);
  const store = new SessionSettingsStore({ baseDir: path.join(root, "sessions") }, { providerId: "local" }, {});
  const settings = await store.update("chat", { defaultAccessMode: "default" });
  const filePath = path.join(workspace, "file with spaces.py");
  const prefix = "# Surrounding source must remain intact\r\n".repeat(200) + "def f():\r\n";
  const selected = "    return 1\r\n";
  const suffix = "\r\nprint(f())  \r\n\r\n";
  const before = prefix + selected + suffix;
  await fs.writeFile(filePath, before);
  const selection = { path: filePath, version: hash(before), startOffset: prefix.length, endOffset: prefix.length + selected.length, text: selected };
  const rawInput = `File: ${JSON.stringify(filePath)} (lines 202–203)\n\nUpdate this file: replace \`return 1\` with \`return 2\`.`;
  const context: ToolExecutionRequest["context"] = { actor: { sessionId: "chat", channel: "http" }, memory: [], conversation: [], providerId: "local",
    activeTarget: { providerId: "local" }, sessionSettings: settings, requestMetadata: { reviewSelection: selection } };
  const request: ToolExecutionRequest = { rawInput, context, title: "Edit selection", content: "", result: { response: JSON.stringify({ replacement: "    return 2\r\n" }), provider: "local", model: "test" } };
  const file = new FileTool({ outputDir: workspace, allowedDirectories: [workspace], accessMode: "restricted" });
  return { root, workspace, store, filePath, before, prefix, suffix, selection, request, file };
}

test("Review edits preserve a large file, CRLF, indentation and trailing bytes; comment backticks cannot change its target", async (t) => {
  const f = await fixture(t);
  assert.ok(f.before.length > 5800);
  const result = await f.file.execute(f.request);
  const after = await fs.readFile(f.filePath, "utf8");
  assert.equal(after, f.prefix + "    return 2\r\n" + f.suffix);
  assert.equal(result.metadata?.afterHash, hash(after));
  assert.deepEqual(await fs.readdir(f.workspace), [path.basename(f.filePath)]);
});

test("Review refuses stale or malformed edits, including a change made while awaiting approval", async (t) => {
  const f = await fixture(t);
  f.request.result = { response: "Here is some code", provider: "local", model: "test" };
  await assert.rejects(f.file.execute(f.request), /valid Review edit/);
  assert.equal(await fs.readFile(f.filePath, "utf8"), f.before);
  f.request.result = { response: '{"replacement":"    return 2"}', provider: "local", model: "test" };
  f.request.context.sessionSettings.defaultAccessMode = "ask";
  f.request.context.requestApproval = async () => { await fs.writeFile(f.filePath, "External edit\n"); return true; };
  await assert.rejects(f.file.execute(f.request), /changed while awaiting approval/);
  assert.equal(await fs.readFile(f.filePath, "utf8"), "External edit\n");
  await assert.rejects(f.file.execute(f.request), /changed since this selection/);
});

test("action words in a Review file name or edit instruction cannot turn replacement into read, append or delete", async (t) => {
  const f = await fixture(t);
  for (const name of ["read-file.py", "append-file.py", "delete-file.py"]) {
    const target = path.join(f.workspace, name); await fs.writeFile(target, f.before);
    f.request.context.requestMetadata = { reviewSelection: { ...f.selection, path: target } };
    f.request.rawInput = `File: ${JSON.stringify(target)} (lines 202–203)\n\nChange this code to read a file`;
    const result = await f.file.execute(f.request);
    assert.equal(result.metadata?.operation, "write");
    assert.equal(await fs.readFile(target, "utf8"), f.prefix + "    return 2\r\n" + f.suffix);
  }
});

test("the engine passes structured selection metadata into the file tool and retains Ask cancellation", async (t) => {
  const f = await fixture(t);
  const router = new Router();
  router.register("general", async () => f.request.result);
  router.register("code", async () => f.request.result);
  const registry = new ToolRegistry(); registry.register(f.file);
  const memory = { retrieve: async () => [], recent: async () => [], save: async () => ({}) } as unknown as MemoryService;
  const engine = new CognitiveEngine(new ModeDetector(), router, memory, f.store, registry, new ToolRequestBuilder(), new Logger(), "local");
  await f.store.update("chat", { defaultAccessMode: "ask" });
  let approvals = 0;
  const result = await engine.process({ input: f.request.rawInput, actor: { sessionId: "chat", channel: "http" }, metadata: f.request.context.requestMetadata,
    requestApproval: async () => { approvals++; return false; } });
  assert.equal(approvals, 1);
  assert.equal(result.tools[0].metadata?.cancelled, true);
  assert.equal(await fs.readFile(f.filePath, "utf8"), f.before);
});

test("Review edits with short English and Russian comments require replacement JSON, while questions stay read-only", async (t) => {
  const f = await fixture(t);
  for (const comment of ["Change 1 to 2", "Замени 1 на 2", "Please fix this indentation"]) {
    const input = `File: ${JSON.stringify(f.filePath)} (lines 202–203)\n\n${comment}`;
    assert.equal(f.file.matchesIntent(input), true);
    assert.match(buildTextPrompt("code", input, "", "ru", "compact"), /"replacement"/);
  }
  assert.equal(f.file.matchesIntent(`File: ${JSON.stringify(f.filePath)} (lines 202–203)\n\nExplain this function`), false);
  const question = 'File: "/workspace/edit-files/write-file.py" (lines 2–2)\n\nExplain this function';
  assert.equal(f.file.matchesIntent(question), false);
  assert.doesNotMatch(buildTextPrompt("code", question, "", "ru", "compact"), /"replacement"/);
});

test("Review API resolves symlinks and grants external reads only for successful file results in that chat", async (t) => {
  const f = await fixture(t);
  const external = path.join(f.root, "external.txt"); await fs.writeFile(external, "outside");
  const link = path.join(f.workspace, "link.txt"); await fs.symlink(external, link);
  let allowedSession = false;
  const manager = { getSettings: async () => ({ memory: { localProfileId: "test" } }), getRuntime: () => ({ config: { filesystem: { allowedDirectories: [f.workspace] } },
    memoryService: { recent: async ({ actor }: any) => allowedSession && actor.sessionId === "chat" ? [{ metadata: { tools: [{ tool: "file", ok: true, metadata: { filePath: external } }] } }] : [] } }) } as unknown as RuntimeManager;
  await assert.rejects(resolveReviewPath(manager, link, "chat"), /outside the workspace/);
  allowedSession = true;
  assert.equal(await resolveReviewPath(manager, link, "chat"), external);
  await assert.rejects(resolveReviewPath(manager, external, "other"), /outside the workspace/);
  let data: any;
  const res = { json(value: unknown) { data = value; }, status() { return this; } };
  await createReadWorkspaceFileController(manager)({ query: { path: f.filePath, sessionId: "chat" } } as unknown as Request, res as unknown as Response, (e) => { throw e; });
  assert.equal(data.content, f.before); assert.equal(data.version, hash(f.before));
  await fs.writeFile(f.filePath, Buffer.from([1, 0, 2]));
  await createReadWorkspaceFileController(manager)({ query: { path: f.filePath } } as unknown as Request, res as unknown as Response, (e) => { throw e; });
  assert.match(data.error, /text files/);
  assert.deepEqual(textEditorCommand('/tmp/test; rm -rf.txt', "darwin"), ["/usr/bin/open", ["-t", '/tmp/test; rm -rf.txt']]);
});

test("Review keeps file state per chat, ignores late opens and reloads current contents on reopen", async () => {
  const source = (await fs.readFile("public/assets/review-panel.js", "utf8")).replace(/export /g, "");
  const context: any = { crypto: webcrypto, TextEncoder, Map }; vm.runInNewContext(source, context);
  let id = "A"; let content = "first"; let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  let hold = true;
  const panel = context.createReviewPanel({ sessionId: () => id, beforeOpen: async () => {}, changed() {}, icon: () => "", busy: () => false, findChange: () => null,
    readFile: async (p: string) => { if (hold) await gate; return { path: p, name: "file.py", content, version: content }; } });
  const pending = panel.open("/file.py"); await Promise.resolve(); id = "B"; release(); await pending;
  assert.equal(panel.isOpen(), false);
  id = "A"; assert.equal(panel.isOpen(), false);
  hold = false; await panel.open("/file.py"); assert.match(panel.render(), /first/);
  content = "second"; await panel.open("/file.py"); assert.match(panel.render(), /second/);
  id = "B"; assert.equal(panel.render(), null);
});

test("Open in editor prefers VS Code and passes the path literally without a shell", async () => {
  const filePath = '/tmp/file with spaces; $(touch sentinel).py';
  const calls: Array<[string, string[], NodeJS.Platform]> = [];
  const editor = await openWorkspaceEditor(filePath, "darwin", async (...args) => { calls.push(args); });
  assert.equal(editor, "vscode");
  assert.deepEqual(calls, [["/usr/bin/open", ["-b", "com.microsoft.VSCode", filePath], "darwin"]]);
});

test("Open in editor falls back to a text editor when VS Code cannot launch", async () => {
  for (const platform of ["darwin", "win32", "linux"] as const) {
    const filePath = platform === "win32" ? "C:\\workspace\\demo.py" : "/tmp/demo.py";
    const fallback = textEditorCommand(filePath, platform);
    const calls: Array<[string, string[]]> = [];
    const editor = await openWorkspaceEditor(filePath, platform, async (command, args) => {
      calls.push([command, args]);
      if (command !== fallback[0] || args[0] !== fallback[1][0]) throw Object.assign(new Error("Editor unavailable"), { code: "ENOENT" });
    });
    assert.equal(editor, "text");
    assert.ok(calls.length >= 2);
    assert.deepEqual(calls.at(-1), fallback);
  }
});

test("Open in editor reports unavailable editors separately from missing files", async () => {
  await assert.rejects(openWorkspaceEditor("/tmp/demo.py", "darwin", async () => {
    throw Object.assign(new Error("No editor"), { code: "ENOENT" });
  }), (error: any) => error.status === 503 && /Unable to open an editor/.test(error.message));
});
