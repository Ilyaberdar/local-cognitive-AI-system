import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { RuntimeManager } from "../src/app/RuntimeManager";
import { RemoteOperationError, type OperationContext } from "../src/remote/host/RemoteHost";
import { createChatOperations, createChatScrubber } from "../src/runtime/chatOperations";
import { createEventStreamOperations } from "../src/runtime/eventStreams";
import { OPERATIONS } from "../src/runtime/operationCatalog";
import { RunServiceError, type RunService } from "../src/runtime/RunService";
import type { EventJournal } from "../src/runtime/EventJournal";
import type { SessionIndexStore } from "../src/session/SessionIndexStore";
import { SessionSettingsStore } from "../src/session/SessionSettingsStore";

const RUN = "4f1c1b0e-8d5a-4b8e-9c55-0a6b2f1e9d11", APPROVAL = "0b6a2f1e-9d11-4f1c-8d5a-4b8e9c550a6b";
const code = (expected: string) => (error: unknown) => error instanceof RemoteOperationError && error.code === expected;
const context: OperationContext = { accountId: "account", deviceId: "mac", signal: new AbortController().signal };

async function setup(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-ops-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionSettingsStore({ baseDir: root }, { providerId: "llamacpp", model: "qwen" }, { llamacpp: "qwen", openai: "gpt-4o-mini" });
  const forgotten: string[] = [];
  const runtime = { sessionSettingsStore: store, sessionIndexStore: { get: async (id: string) => ({ id }) }, projectStore: { get: async () => null },
    memoryService: { deleteSession: async (id: string) => { forgotten.push(`memory ${id}`); } }, providerDescriptors: ["llamacpp", "ollama", "openai", "anthropic"].map(id => ({ id, name: id, configured: true, defaultModel: "" })) };
  const sessions: Record<string, { id: string; title?: string; updatedAt?: string; projectId?: string }> = { chat: { id: "chat" }, full: { id: "full" }, busy: { id: "busy" } };
  const calls: string[] = [];
  const runService = {
    // A resent command ("resent-…") gets its first answer before anything is checked, as in RunService.
    start: async (_scope: string, request: { sessionId: string; commandId: string }, admit?: () => Promise<void>) => {
      if (request.commandId.startsWith("resent-")) return { runId: RUN, status: "accepted", replayed: true };
      await admit?.();
      calls.push(`start ${request.sessionId}`);
      return { runId: RUN, status: "accepted" };
    },
    get: (runId: string) => runId === RUN ? { runId, sessionId: "full", status: "waiting_approval" } : undefined,
    cancel: (runId: string) => { calls.push(`cancel ${runId}`); return { cancelled: true }; },
    resolveApproval: (_runId: string, _approvalId: string, approved: boolean) => { calls.push(`approval ${approved}`); return { accepted: true }; },
    forgetSession: (sessionId: string) => {
      if (sessionId === "busy") throw new RunServiceError("The chat is answering. Stop the answer first, then delete it.", "session_busy");
      forgotten.push(`turns ${sessionId}`);
    },
    forgotSession: (sessionId: string, deleted: boolean) => { forgotten.push(`done ${sessionId} ${deleted}`); }
  };
  const ops = createChatOperations({
    runtimeManager: { getRuntime: () => runtime, getSettings: async () => ({ ui: {} }) } as unknown as RuntimeManager,
    sessionIndexStore: { get: async (id: string) => sessions[id], list: async () => Object.values(sessions),
      rename: async (id: string, title: string) => sessions[id] ? Object.assign(sessions[id]!, { title, updatedAt: "now" }) : undefined,
      delete: async (id: string) => { const existed = Boolean(sessions[id]); delete sessions[id]; return existed; } } as unknown as SessionIndexStore,
    runService: runService as unknown as RunService, journal: {} as EventJournal, scopeOf: () => "device"
  });
  // The host gave this chat full access (its own HTTP API, Telegram or MCP).
  await store.update("full", { defaultAccessMode: "full" });
  const call = <T = any>(op: string, payload?: unknown) => Promise.resolve(ops[op]!(payload, context)) as Promise<T>;
  return { root, store, call, calls, forgotten, sessions, file: (id: string) => path.join(root, `${id}.json`) };
}

test("every chat operation is in the catalog", async t => {
  await setup(t);
  for (const op of ["sessions.setup.get", "sessions.settings.update", "chat.runs.start", "chat.approvals.resolve"]) assert.ok(OPERATIONS[op], op);
});

test("subagents, debate agents and the debate profile change from a device; agents take the chat's access mode", async t => {
  const f = await setup(t);
  const saved = await f.call("sessions.settings.update", { sessionId: "chat", patch: {
    mode: "hypothesis",
    codeAgents: [{ id: "agent-1", name: "Nova", providerId: "openai", model: "gpt-4.1" }, { id: "agent-2", name: "Atlas", providerId: "llamacpp" }],
    hypothesisAgents: [{ id: "s", name: "Support", role: "support", providerId: "llamacpp" }, { id: "a", name: "Attack", role: "attack", providerId: "openai", model: "gpt-4.1" },
      { id: "j", name: "Judge", role: "judge", providerId: "local" }, { id: "adv", name: "Skeptic", role: "advisor", providerId: "anthropic", model: "claude" }],
    debate: { profile: "security", attack: { providerId: "openai", model: "gpt-4.1" }, judge: { providerId: "local" } }
  } });
  assert.deepEqual(saved.codeAgents.map((agent: any) => [agent.name, agent.providerId, agent.model, agent.accessMode]),
    [["Nova", "openai", "gpt-4.1", "default"], ["Atlas", "llamacpp", "qwen", "default"]]);
  assert.deepEqual(saved.hypothesisAgents.map((agent: any) => agent.name), ["Support", "Attack", "Judge", "Skeptic"]);
  assert.deepEqual([saved.debate.enabled, saved.debate.profile, saved.debate.attack.model, saved.debate.judge.providerId], [true, "security", "gpt-4.1", "local"]);
  const view = await f.call("sessions.setup.get", { sessionId: "chat" });
  assert.deepEqual([view.access, view.limits, view.settings.codeAgents.length], [{ modes: ["ask", "default"] }, { subagents: 4, advisors: 5 }, 2]);
});

test("agents a device may not set are refused, and nothing is written", async t => {
  const f = await setup(t);
  await f.call("sessions.settings.update", { sessionId: "chat", patch: { language: "ru" } });
  const before = await fs.readFile(f.file("chat"), "utf8");
  const agent = (extra: Record<string, unknown> = {}) => ({ id: "a", name: "Nova", providerId: "openai", ...extra });
  const role = (name: string, value: string, providerId = "openai") => ({ id: name, name, role: value, providerId });
  const refused: unknown[] = [
    { codeAgents: [agent({ accessMode: "ask" })] }, { codeAgents: [agent({ providerId: "unknown" })] }, { codeAgents: [agent({ providerId: "local" })] },
    { codeAgents: [agent({ providerId: "toString" })] }, { codeAgents: [agent({ providerId: "__proto__" })] }, { codeAgents: [agent({ providerId: "constructor" })] },
    { codeAgents: [agent(), agent(), agent(), agent(), agent()] }, { codeAgents: [agent({ name: "line\nbreak" })] }, { codeAgents: [agent({ name: " " })] },
    { hypothesisAgents: [role("J1", "judge", "local"), role("J2", "judge", "local")] },
    { hypothesisAgents: ["A1", "A2", "A3", "A4", "A5", "A6"].map(name => role(name, "advisor")) },
    { hypothesisAgents: [role("X", "chair")] }, { debate: { enabled: false } }, { debate: { support: { providerId: "local" } } },
    { defaultTarget: { providerId: "local" } }, { defaultTarget: { providerId: "hasOwnProperty" } }, { defaultAccessMode: "none" }, { subagents: [agent()] }, { workspace: "/" }
  ];
  for (const patch of refused) await assert.rejects(f.call("sessions.settings.update", { sessionId: "chat", patch }), code("invalid_request"), JSON.stringify(patch));
  // Full access is given only on the server, and the answer says so.
  for (const patch of [{ defaultAccessMode: "full" }, { codeAgents: [agent({ accessMode: "full" })] }]) {
    await assert.rejects(f.call("sessions.settings.update", { sessionId: "chat", patch }), code("unsupported"), JSON.stringify(patch));
  }
  assert.equal(await fs.readFile(f.file("chat"), "utf8"), before, "the chat's settings are byte for byte the same");
});

test("a chat the host gave full access is used only there: a device may stop it or decline, never send, change or approve", async t => {
  const f = await setup(t);
  const before = await fs.readFile(f.file("full"), "utf8");
  const view = await f.call("sessions.setup.get", { sessionId: "full" });
  assert.match(view.access.hostOnly, /full access on the server/);
  await assert.rejects(f.call("chat.runs.start", { commandId: "command-1", sessionId: "full", input: "hi" }), code("unsupported"));
  await assert.rejects(f.call("sessions.settings.update", { sessionId: "full", patch: { language: "en" } }), code("unsupported"));
  await assert.rejects(f.call("chat.approvals.resolve", { runId: RUN, approvalId: APPROVAL, approved: true }), code("unsupported"));
  assert.deepEqual(await f.call("chat.approvals.resolve", { runId: RUN, approvalId: APPROVAL, approved: false }), { accepted: true });
  await f.call("chat.runs.cancel", { runId: RUN });
  assert.ok(await f.call("sessions.settings.get", { sessionId: "full" }));
  assert.equal(await fs.readFile(f.file("full"), "utf8"), before);
  assert.deepEqual(f.calls, ["approval false", `cancel ${RUN}`]);
  // An agent with full access makes the chat the host's too.
  await f.store.update("chat", { codeAgents: [{ id: "a", name: "Nova", providerId: "openai", accessMode: "full" }] });
  await assert.rejects(f.call("chat.runs.start", { commandId: "command-2", sessionId: "chat", input: "hi" }), code("unsupported"));
});

test("a device chooses ask or approve-for-me, and the chat's agents follow", async t => {
  const f = await setup(t);
  await f.call("sessions.settings.update", { sessionId: "chat", patch: { codeAgents: [{ id: "a", name: "Nova", providerId: "openai" }] } });
  const asked = await f.call("sessions.settings.update", { sessionId: "chat", patch: { defaultAccessMode: "ask" } });
  assert.deepEqual([asked.defaultAccessMode, asked.codeAgents[0].accessMode], ["ask", "ask"]);
});

test("the server's folders are replaced in what a device receives about a chat", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-scrub-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, "out"), allowed = path.join(root, "shared"), data = path.join(root, "data");
  const scrub = await createChatScrubber({ runtimeManager: { getSettings: async () => ({ filesystem: { outputDir: output, allowedDirectories: [allowed] } }) } as unknown as RuntimeManager,
    hostDirectories: [data] })();
  const value = { details: `Write ${output}/report.md\nWorking directory: ${allowed}/repo`, text: `Log in ${data}/app/logs and /etc/hosts` };
  assert.deepEqual(scrub(value), { details: "Write <output>/report.md\nWorking directory: <folder>/repo", text: "Log in <server>/app/logs and /etc/hosts" });

  assert.deepEqual(scrub({ near: `${output}box/a and ${data}2/b`, quoted: `"${output}"` }), { near: `${output}box/a and ${data}2/b`, quoted: '"<output>"' }, "only whole folders");
  assert.deepEqual(scrub({ lines: `Saved:\n${output}/a\t${data}/b`, [`${output}/key`]: 1 }), { lines: "Saved:\n<output>/a\t<server>/b", "<output>/key": 1 },
    "a folder after an escaped character in JSON is still replaced");

  // Events from before chats were scrubbed as written: scrubbed as read, and a streamed part that would change sends the device to reload.
  const legacy = [{ seq: 1, type: "approval.requested", payload: { details: `Delete ${output}/a.txt` } }, { seq: 2, type: "message.delta", payload: { offset: 0, text: "ok" } }];
  const journal = (events: unknown[]) => ({ read: () => ({ events, head: 2, epoch: "e" }), wait: async () => undefined }) as unknown as EventJournal;
  const poll = (events: unknown[]) => createEventStreamOperations({ journal: journal(events), requireSession: async () => undefined, scrubSession: async () => scrub })["events.poll"]!(
    { streams: [{ streamId: "session:chat", epoch: "e", after: 0 }], waitMs: 0 }, context) as Promise<any>;
  assert.equal((await poll(legacy)).streams[0].events[0].payload.details, "Delete <output>/a.txt");
  assert.equal((await poll([{ seq: 1, type: "message.delta", payload: { offset: 0, text: `in ${output}/a` } }])).streams[0].resync, "redacted");
});

test("a device renames a server chat, and deletes one with its settings, memory, turns and events", async t => {
  const f = await setup(t);
  assert.deepEqual(await f.call("sessions.rename", { sessionId: "chat", title: "  Plans  " }), { id: "chat", title: "Plans", updatedAt: "now" });
  for (const title of ["", "   ", "a\nb", "x".repeat(201)]) await assert.rejects(f.call("sessions.rename", { sessionId: "chat", title }), code("invalid_request"), JSON.stringify(title));
  await assert.rejects(f.call("sessions.rename", { sessionId: "full", title: "Mine" }), code("unsupported"), "a chat that is the server's alone is renamed there");

  await assert.rejects(f.call("sessions.delete", { sessionId: "busy" }), code("session_busy"));
  assert.ok(f.sessions.busy, "a chat that is answering is kept");
  assert.deepEqual(await f.call("sessions.delete", { sessionId: "full" }), { deleted: true }, "a device may always delete");
  assert.deepEqual(f.forgotten, ["turns full", "memory full", "done full true"], "turns first, the index last, then followers learn");
  assert.equal(f.sessions.full, undefined);
  await assert.rejects(fs.access(f.file("full")), "its settings are gone");
  await assert.rejects(f.call("sessions.delete", { sessionId: "full" }), code("session_unknown"));
});

test("agent ids and names must be usable and unique; agents saved on the host are taken as they are", async t => {
  const f = await setup(t);
  const agent = (id: string, name: string) => ({ id, name, providerId: "openai" });
  for (const codeAgents of [[agent("main-model", "Nova")], [agent("a>>>b", "Nova")], [agent("a", "two words")], [agent("a", "Nova"), agent("a", "Atlas")],
    [agent("a", "Nova"), agent("b", "nova")]]) {
    await assert.rejects(f.call("sessions.settings.update", { sessionId: "chat", patch: { codeAgents } }), code("invalid_request"), JSON.stringify(codeAgents));
  }
  await f.store.update("chat", { codeAgents: [{ id: "host", name: "Host helper", providerId: "gone", accessMode: "default" }] });
  const saved = await f.call("sessions.settings.update", { sessionId: "chat", patch: { codeAgents: [{ id: "host", name: "Host helper", providerId: "gone" }, agent("b", "Nova")] } });
  assert.deepEqual(saved.codeAgents.map((item: any) => item.name), ["Host helper", "Nova"], "the host's own agent does not block a change");
});

test("a resent send gets its first answer even after the chat became the host's", async t => {
  const f = await setup(t);
  assert.deepEqual(await f.call("chat.runs.start", { commandId: "resent-command-1", sessionId: "full", input: "hi" }), { runId: RUN, status: "accepted", replayed: true });
  await assert.rejects(f.call("chat.runs.start", { commandId: "new-command-1", sessionId: "full", input: "hi" }), code("unsupported"));
});

test("chat settings saved at the same time keep both changes, and no partial file is ever read", async t => {
  const f = await setup(t);
  await Promise.all([f.store.update("chat", { language: "ru" }), f.store.update("chat", { outputStyle: "detailed" }), f.store.update("chat", { mode: "code" })]);
  const settings = await f.store.get("chat");
  assert.deepEqual([settings.language, settings.outputStyle, settings.mode], ["ru", "detailed", "code"]);
  assert.deepEqual((await fs.readdir(f.root)).filter(name => name.endsWith(".tmp")), [], "no temporary file is left");
});

test("a device reads a chat's files by the paths it was shown: in the chat's own folder or ones the chat touched", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "chat-files-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, "out"), shared = path.join(root, "shared"), elsewhere = path.join(root, "elsewhere");
  for (const dir of [output, shared, elsewhere]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(output, "report.md"), "# Report\n");
  await fs.writeFile(path.join(output, "other.md"), "not written by this chat");
  await fs.writeFile(path.join(shared, "notes.txt"), "shared notes");
  await fs.writeFile(path.join(elsewhere, "secret.txt"), "secret");
  await fs.writeFile(path.join(output, "image.bin"), Buffer.from([1, 0, 2, 3]));
  const big = Buffer.alloc(600 * 1024, 7);
  await fs.writeFile(path.join(output, "big.bin"), big);
  const written: unknown[] = ["report.md", "image.bin", "big.bin", "swapped.md"].map(name => ({ tool: "file.write", ok: true, metadata: { filePath: path.join(output, name) } }));
  // A delete names a path, but grants nothing: a file made there later is not this chat's.
  written.push({ tool: "file", ok: true, metadata: { path: path.join(output, "deleted.md") } });
  await fs.writeFile(path.join(output, "deleted.md"), "made later by someone else");
  // A file the chat wrote, replaced since by a link to a file outside.
  await fs.symlink(path.join(elsewhere, "secret.txt"), path.join(output, "swapped.md"));
  const store = new SessionSettingsStore({ baseDir: path.join(root, "settings") }, { providerId: "openai" }, {});
  await store.update("full", { defaultAccessMode: "full" });
  const runtime = { sessionSettingsStore: store, providerDescriptors: [], config: { filesystem: { allowedDirectories: [shared] } },
    sessionIndexStore: { get: async (id: string) => ({ id }) }, projectStore: { get: async () => null },
    memoryService: { recent: async ({ actor }: any) => actor.sessionId === "chat" ? [{ metadata: { tools: written } }] : [] } };
  const ops = createChatOperations({
    runtimeManager: { getRuntime: () => runtime, getSettings: async () => ({ memory: { localProfileId: "me" }, filesystem: { outputDir: output, allowedDirectories: [shared] } }) } as unknown as RuntimeManager,
    sessionIndexStore: { get: async (id: string) => ({ id }) } as unknown as SessionIndexStore,
    runService: {} as RunService, journal: {} as EventJournal, scopeOf: () => "device", hostDirectories: [root]
  });
  const call = <T = any>(op: string, payload: unknown) => Promise.resolve(ops[op]!(payload, context)) as Promise<T>;

  const report = await call("files.read", { sessionId: "chat", path: "<output>/report.md", as: "text" });
  assert.deepEqual({ ...report, version: typeof report.version }, { path: "<output>/report.md", name: "report.md", sizeBytes: 9, content: "# Report\n", version: "string" });
  // Neither the output folder plain chats share nor a folder file tools may use is readable as a
  // whole; another chat's file, a missing one and one outside alike get one answer.
  for (const [sessionId, ref] of [["chat", "<output>/deleted.md"], ["chat", "<output>/swapped.md"], ["chat", "<output>/other.md"], ["other", "<output>/report.md"], ["chat", "<folder>/notes.txt"], ["chat", `${elsewhere}/secret.txt`], ["chat", "<output>/../elsewhere/secret.txt"], ["chat", "report.md"],
    ["chat", "<output>/gone.md"], ["chat", `${elsewhere}/missing.txt`], ["chat", "/etc/hosts"]]) {
    await assert.rejects(call("files.read", { sessionId, path: ref, as: "text" }), code("file_unavailable"), `${sessionId} ${ref}`);
  }
  await assert.rejects(call("files.read", { sessionId: "full", path: "<output>/report.md", as: "text" }), code("unsupported"), "a chat with full access keeps its files on the server");
  await assert.rejects(call("files.read", { sessionId: "chat", path: "<output>/image.bin", as: "text" }), code("binary_file"));

  const stat = await call("files.stat", { sessionId: "chat", path: "<output>/big.bin" });
  assert.deepEqual([stat.path, stat.sizeBytes, stat.sha256], ["<output>/big.bin", big.length, createHash("sha256").update(big).digest("hex")]);
  const first = await call("files.read", { sessionId: "chat", path: "<output>/big.bin", as: "base64" });
  const second = await call("files.read", { sessionId: "chat", path: "<output>/big.bin", as: "base64", offset: 512 * 1024 });
  assert.deepEqual([first.eof, second.eof], [false, true]);
  assert.ok(Buffer.concat([Buffer.from(first.data, "base64"), Buffer.from(second.data, "base64")]).equals(big));
  assert.equal(JSON.stringify([report, stat, first]).includes(root), false, "no folder of the server in an answer");
});

test("project chats: seen and used from a device only in a project it may use; a project set up on the server keeps its chats there", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-projects-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionSettingsStore({ baseDir: root }, { providerId: "openai" }, {});
  const sessions: Record<string, { id: string; title: string; updatedAt: string; projectId?: string }> = {
    "in-site": { id: "in-site", title: "Site chat", updatedAt: "t", projectId: "site" }, "in-host": { id: "in-host", title: "Host chat", updatedAt: "t", projectId: "host" } };
  const started: string[] = [];
  const ops = createChatOperations({
    runtimeManager: { getRuntime: () => ({ sessionSettingsStore: store, sessionIndexStore: { get: async (id: string) => sessions[id] }, projectStore: { get: async () => null } }),
      getSettings: async () => ({ ui: {}, filesystem: {} }) } as unknown as RuntimeManager,
    sessionIndexStore: { get: async (id: string) => sessions[id], list: async () => Object.values(sessions),
      create: async (title: string, _channel: string, projectId?: string) => (sessions.created = { id: "created", title, updatedAt: "t", ...(projectId ? { projectId } : {}) }) } as unknown as SessionIndexStore,
    runService: { start: async (_scope: string, request: { sessionId: string }, admit?: () => Promise<unknown>) => { await admit?.(); started.push(request.sessionId); return { status: "accepted" }; },
      activeRun: () => undefined, unfinishedTurns: () => [] } as unknown as RunService,
    journal: { head: () => ({ epoch: "e", head: 0 }) } as unknown as EventJournal, scopeOf: () => "device",
    projects: { visible: async (projectId: string) => projectId !== "host",
      usable: async (projectId: string) => projectId === "site" ? { project: {} as never } : { project: {} as never, reason: "The project is archived. Restore it to use its chats." } }
  });
  const call = <T = any>(op: string, payload?: unknown) => Promise.resolve(ops[op]!(payload, context)) as Promise<T>;
  sessions["in-archived"] = { id: "in-archived", title: "Old chat", updatedAt: "t", projectId: "archived" };
  assert.deepEqual((await call("sessions.list")).map((item: any) => [item.id, item.projectId]), [["in-site", "site"], ["in-archived", "archived"]], "a host project's chats are not listed");
  assert.equal((await call("sessions.create", { title: "New chat", projectId: "site" })).projectId, "site");
  await assert.rejects(call("sessions.create", { title: "New chat", projectId: "host" }), code("unsupported"));
  await call("chat.runs.start", { commandId: "command-1", sessionId: "in-site", input: "hi" });
  for (const [op, payload] of [["chat.runs.start", { commandId: "command-2", sessionId: "in-host", input: "hi" }], ["sessions.messages.list", { sessionId: "in-host" }],
    ["sessions.settings.get", { sessionId: "in-host" }], ["sessions.delete", { sessionId: "in-host" }], ["files.read", { sessionId: "in-host", path: "<workspace>/a", as: "text" }]] as const) {
    await assert.rejects(call(op, payload), code("session_unknown"), op);
  }
  // An archived project's chats are readable, not usable.
  assert.match((await call("sessions.setup.get", { sessionId: "in-archived" })).access.hostOnly, /archived/);
  await assert.rejects(call("sessions.settings.update", { sessionId: "in-archived", patch: { language: "en" } }), code("unsupported"));
  assert.deepEqual(started, ["in-site"]);
});

test("a project chat's folder is <workspace> in what a device receives", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "chat-workspace-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "site");
  await fs.mkdir(project);
  const runtimeManager = { getSettings: async () => ({ filesystem: {} }), getRuntime: () => ({
    sessionIndexStore: { get: async (id: string) => ({ id, projectId: id === "in-project" ? "p1" : undefined }) },
    projectStore: { get: async (id: string) => id === "p1" ? { id, rootPath: project } : null } }) } as unknown as RuntimeManager;
  const scrubbers = createChatScrubber({ runtimeManager, hostDirectories: [path.join(root, "data")] });
  assert.equal((await scrubbers("in-project"))(`Wrote ${project}/index.html`), "Wrote <workspace>/index.html");
  assert.equal((await scrubbers("plain"))(`Wrote ${project}/index.html`), `Wrote ${project}/index.html`, "only a project chat's own folder");
});
