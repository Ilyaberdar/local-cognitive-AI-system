import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync("public/assets/app.js", "utf8");
const fragment = (start: string, end: string) => {
  const offset = source.indexOf(start);
  const boundary = source.indexOf(end, offset);
  assert.ok(offset >= 0 && boundary > offset, `Missing UI fragment: ${start}`);
  return source.slice(offset, boundary);
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const file = (name: string, type = "text/plain", text = "attached content", size = text.length) => ({ name, type, size, text: async () => text });

test("attachment preparation keeps image pixels and extracted documents, with visible truncation", async () => {
  const calls: any[] = []; const toasts: string[] = [];
  const context: any = {
    Error, crypto: { randomUUID: () => `file-${Math.random()}` },
    fileToDataUrl: async (value: any) => `data:${value.type};base64,document`,
    prepareImageAttachment: async () => ({ dataUrl: "data:image/webp;base64,pixels", sizeBytes: 800000, mimeType: "image/webp" }),
    request: async (url: string, options: any) => { calls.push({ url, body: JSON.parse(options.body) }); return { textContent: "Parsed document", truncated: true, warning: "First 12,000 characters only." }; },
    pushToast: (message: string) => toasts.push(message)
  };
  vm.runInNewContext(fragment("function isTextAttachment", "function fileToDataUrl") + fragment("async function buildAttachments", "function cloneSessionSettings"), context);
  const result = await context.buildAttachments([file("photo.png", "image/png"), file("report.pdf", "application/pdf"), file("letter.docx", ""), file("notes.md", "text/plain", "x".repeat(15000))]);
  assert.equal(result.length, 4);
  assert.equal(result[0].kind, "image"); assert.equal(result[0].dataUrl, "data:image/webp;base64,pixels"); assert.equal(result[0].sizeBytes, 800000);
  assert.equal(result[1].kind, "text"); assert.equal(result[1].textContent, "Parsed document"); assert.equal(result[1].truncated, true); assert.match(result[1].warning, /12,000/);
  assert.equal(result[1].dataUrl, undefined);
  assert.equal(result[2].mimeType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(result[3].textContent.length, 12000); assert.equal(result[3].truncated, true); assert.match(result[3].warning, /12,000/);
  const [boundary] = await context.buildAttachments([file("boundary.ts", "text/plain", "x".repeat(12000))]);
  assert.equal(boundary.textContent.length, 12000); assert.equal(boundary.truncated, undefined); assert.equal(boundary.warning, undefined);
  assert.deepEqual(calls.map((call) => call.url), ["/attachments/extract", "/attachments/extract"]);
  assert.deepEqual(toasts, []);
});

test("unsupported or oversized files and scanned documents cannot become metadata-only attachments", async () => {
  const toasts: string[] = [];
  const context: any = { Error, fileToDataUrl: async () => "data:application/pdf;base64,scan", request: async () => ({ textContent: "", warning: "Scanned PDF: attach page images." }), pushToast: (message: string) => toasts.push(message) };
  vm.runInNewContext(fragment("function isTextAttachment", "function fileToDataUrl") + fragment("async function buildAttachments", "function cloneSessionSettings"), context);
  const result = await context.buildAttachments([file("legacy.doc"), file("vector.svg", "image/svg+xml"), file("large.png", "image/png", "", 5 * 1024 ** 2 + 1), file("scan.pdf", "application/pdf"), file("empty.txt", "text/plain", "")]);
  assert.equal(result.length, 0);
  assert.match(toasts.join("\n"), /Legacy .doc/); assert.match(toasts.join("\n"), /PNG, JPEG or WebP/);
  assert.match(toasts.join("\n"), /larger than 5 MB/); assert.match(toasts.join("\n"), /Scanned PDF/); assert.match(toasts.join("\n"), /no readable text/);
  const limited = await context.buildAttachments([file("one.txt"), file("two.txt")], 1);
  assert.equal(limited.length, 1); assert.match(toasts.at(-1) || "", /1 additional/);
});

test("image guidance blocks known text-only local General targets and keeps unknown agent capability explicit", () => {
  const context: any = { state: { bootstrap: { allManagedModels: [{ providerId: "llamacpp", id: "text", vision: false }, { providerId: "llamacpp", id: "vision", vision: true }], appSettings: { llm: { defaultProvider: "llamacpp" }, providers: { llamacpp: { model: "text" } } } } },
    isLocalProvider: (id: string) => ["llamacpp", "ollama", "lmstudio"].includes(id), getEffectiveSetupMode: (settings: any) => settings.mode || "general" };
  vm.runInNewContext(fragment("function buildChatAttachmentMetadata", "function updateAttachmentGuidance"), context);
  const images = [{ kind: "image" }];
  assert.equal(context.getImageAttachmentGuidance(images, {}).blocked, true);
  assert.equal(context.getImageAttachmentGuidance(images, { defaultTarget: { providerId: "llamacpp", model: "vision" } }).blocked, false);
  const remote = context.getImageAttachmentGuidance(images, { defaultTarget: { providerId: "openai", model: "unknown" } });
  assert.equal(remote.blocked, false); assert.match(remote.message, /image-capable/);
  const agents = context.getImageAttachmentGuidance(images, { mode: "code" });
  assert.equal(agents.blocked, false); assert.match(agents.message, /Each selected agent/);
  assert.equal(context.getImageAttachmentGuidance([{ kind: "text" }], {}).blocked, false);
});

test("historical images do not block text-only chat, while new attachments retain capability checks", () => {
  const image = (id: string) => ({ id, kind: "image", dataUrl: "data:image/png;base64,pixels" });
  const state: any = { activeSessionId: "a", messages: [
    { role: "user", attachments: [image("old")] },
    { role: "user", includePreviousAttachments: false, attachments: [image("after-barrier")] },
    { role: "assistant" }, { role: "user", attachments: [] }
  ], bootstrap: { allManagedModels: [{ id: "text", providerId: "llamacpp", vision: false }] } };
  const settings = { mode: "general", defaultTarget: { providerId: "llamacpp", model: "text" } };
  const context: any = { state, isLocalProvider: () => true, getEffectiveSetupMode: () => "general" };
  vm.runInNewContext(fragment("function buildChatAttachmentMetadata", "function updateAttachmentGuidance"), context);
  assert.equal(context.getImageAttachmentGuidance([], settings).blocked, false);
  assert.equal(context.getImageAttachmentGuidance([], settings).message, "");
  assert.equal(context.getImageAttachmentGuidance([{ kind: "text" }], settings).blocked, false);
  assert.equal(context.getImageAttachmentGuidance([image("explicit")], settings).blocked, true);
  assert.equal(context.buildChatAttachmentMetadata([]), undefined);
  assert.deepEqual(plain(context.buildChatAttachmentMetadata([image("explicit")])), { attachments: [image("explicit")] });
  assert.deepEqual(plain(context.buildChatAttachmentMetadata([], { path: "example.ts" })), { reviewSelection: { path: "example.ts" } });
  state.activeSessionId = "b";
  assert.equal(context.getImageAttachmentGuidance([], settings).blocked, false);
});

test("deferred attachment preparation follows the original chat and never revives a deleted session", async () => {
  const prepared = deferred<any[]>();
  const state: any = { activeSessionId: "a", attachmentImports: {}, draftAttachments: { b: [{ id: "b" }] }, bootstrap: { sessions: [{ id: "a" }, { id: "b" }] } };
  const context: any = { state, buildAttachments: () => prepared.promise, render() {}, pushToast() {} };
  vm.runInNewContext(fragment("async function addChatAttachments", "async function addTaskAttachments"), context);
  const pending = context.addChatAttachments([file("a.txt")], "a");
  state.activeSessionId = "b";
  prepared.resolve([{ id: "a-file" }]); await pending;
  assert.deepEqual(plain(state.draftAttachments.a), [{ id: "a-file" }]); assert.deepEqual(state.draftAttachments.b, [{ id: "b" }]);
  state.bootstrap.sessions = [{ id: "b" }]; delete state.draftAttachments.a;
  await context.addChatAttachments([], "a");
  assert.equal(state.draftAttachments.a, undefined); assert.deepEqual(state.attachmentImports, {});
});

test("task attachments save only after preparation and duplicate removal cannot overwrite a newer save", async () => {
  const prepared = deferred<any[]>(); const saved = deferred<void>(); const calls: any[] = [];
  const state: any = { attachmentImports: {}, taskDraftAttachments: [{ id: "new-task-file" }], bootstrap: { tasks: [{ id: "task-a", status: "todo", attachments: [{ id: "old" }] }] } };
  const context: any = { state, buildAttachments: () => prepared.promise, render() {}, pushToast() {}, refreshBootstrap: async () => {}, api: { updateTask: async (id: string, patch: any) => { calls.push({ id, patch }); state.bootstrap.tasks[0].attachments = patch.attachments; } } };
  vm.runInNewContext(fragment("async function addTaskAttachments", "function isTextAttachment"), context);
  const pending = context.addTaskAttachments([file("new.txt")], "task-a");
  assert.equal(state.attachmentImports["task:task-a"], true); assert.equal(calls.length, 0);
  prepared.resolve([{ id: "added" }]); await pending;
  assert.deepEqual(plain(calls[0]), { id: "task-a", patch: { attachments: [{ id: "old" }, { id: "added" }] } });
  context.api.updateTask = async (id: string, patch: any) => { calls.push({ id, patch }); await saved.promise; };
  const removing = context.removeTaskAttachment("task-a", "old");
  await context.removeTaskAttachment("task-a", "added");
  assert.equal(calls.length, 2); assert.deepEqual(plain(calls[1].patch.attachments), [{ id: "added" }]);
  saved.resolve(); await removing;
  assert.deepEqual(state.taskDraftAttachments, [{ id: "new-task-file" }]); assert.deepEqual(state.attachmentImports, {});
  for (const status of ["in_progress", "running", "waiting"]) {
    state.bootstrap.tasks[0].status = status;
    await context.addTaskAttachments([file("ignored.txt")], "task-a");
    await context.removeTaskAttachment("task-a", "added");
  }
  assert.equal(calls.length, 2, "Active workflows must keep the current attachment set");
});

test("new task submission includes prepared files and clears them only after successful creation", async () => {
  const saved = deferred<void>(); let handler!: (event: any) => Promise<void>; let payload: any;
  const attachments = [{ id: "diagram", kind: "image", dataUrl: "data:image/png;base64,pixels" }];
  const state: any = { attachmentImports: {}, taskDraftAttachments: attachments, activeSessionId: "chat-a" };
  const context = { state, FormData: class { get(key: string) { return ({ title: "Inspect diagram", description: "Explain attached diagram", workflowId: "review", priority: "normal" } as any)[key]; } },
    document: { querySelector: (selector: string) => selector === "#task-form" ? { addEventListener: (_: string, fn: typeof handler) => { handler = fn; }, reset() {} } : null },
    runAction: async (fn: () => Promise<void>) => fn(), refreshBootstrap: async () => {}, api: { createTask: async (value: any) => { payload = value; await saved.promise; } } };
  vm.runInNewContext(fragment('  document.querySelector("#task-form")?.addEventListener("submit"', '  const scheduleForm ='), context);
  const pending = handler({ preventDefault() {}, currentTarget: {} });
  assert.equal(payload.attachments, attachments); assert.equal(state.taskDraftAttachments, attachments);
  saved.resolve(); await pending;
  assert.deepEqual(plain(state.taskDraftAttachments), []);
});

test("catalog projector selection is explicit and its pinned path is included in download requests", async () => {
  const managerSource = fs.readFileSync("public/assets/model-manager.js", "utf8").replace(/^import .*\n/, "").replace("export function", "function").replace("return { render, bind, start, refresh, repaint, updateLiveView, dispose()", "return { test: { state, openDetail, perform, renderDetail }, render, bind, start, refresh, repaint, updateLiveView, dispose()");
  const projects = [{ path: "mmproj-f16.gguf", sizeBytes: 300 }, { path: "mmproj-Q8.gguf", sizeBytes: 150 }];
  let projectors = projects; const requests: any[] = [];
  const context: any = { icon: () => "", window: { setTimeout: () => 1, clearTimeout() {} }, URLSearchParams, setTimeout };
  vm.runInNewContext(managerSource, context);
  const manager = context.createModelManager({ request: async (url: string, options: any) => {
    if (url.startsWith("/local/catalog/model")) return { repoId: "owner/vision", revision: "pinned", projectors, variants: [{ id: "Q4", sizeBytes: 1000, files: [{ path: "main.gguf", sizeBytes: 1000 }], compatibility: { status: "compatible", estimatedMemoryBytes: 2000, requiredDiskBytes: 1050 } }] };
    if (url === "/local/downloads" && options?.method === "POST") requests.push(JSON.parse(options.body));
    return { models: [], downloads: [], runtime: {} };
  }, getContext: () => ({ models: [], settings: {} }), onLibraryChange() {}, notify() {}, isVisible: () => false });
  await manager.test.openDetail("owner/vision");
  assert.equal(manager.test.state.projectorPath, ""); assert.match(manager.test.renderDetail(), /Several adapters/);
  manager.test.state.projectorPath = projects[1].path;
  assert.match(manager.test.renderDetail(), /GGUF · Images/); assert.match(manager.test.renderDetail(), /Included files \(2\)/);
  assert.match(manager.test.renderDetail(), /Main-model disk estimate/); assert.match(manager.test.renderDetail(), /Vision adapter: 150 B additional disk space/);
  await manager.test.perform("download", "owner/vision");
  assert.deepEqual(requests[0], { repoId: "owner/vision", revision: "pinned", variantId: "Q4", projectorPath: "mmproj-Q8.gguf" });
  projectors = [projects[0]];
  await manager.test.openDetail("owner/vision");
  assert.equal(manager.test.state.projectorPath, projects[0].path);
  manager.test.state.projectorPath = "";
  assert.match(manager.test.renderDetail(), /GGUF · Text only/);
  assert.doesNotMatch(manager.test.renderDetail(), /Main-model disk estimate/);
  await manager.test.perform("download", "owner/vision");
  assert.equal(requests[1].projectorPath, undefined);
});
