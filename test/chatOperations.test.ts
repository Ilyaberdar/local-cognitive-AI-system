import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { RuntimeManager } from "../src/app/RuntimeManager";
import { RemoteOperationError, type OperationContext } from "../src/remote/host/RemoteHost";
import { createChatOperations, createChatScrubber } from "../src/runtime/chatOperations";
import { createEventStreamOperations } from "../src/runtime/eventStreams";
import { OPERATIONS } from "../src/runtime/operationCatalog";
import type { RunService } from "../src/runtime/RunService";
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
  const runtime = { sessionSettingsStore: store, providerDescriptors: ["llamacpp", "ollama", "openai", "anthropic"].map(id => ({ id, name: id, configured: true, defaultModel: "" })) };
  const sessions: Record<string, { id: string; projectId?: string }> = { chat: { id: "chat" }, full: { id: "full" } };
  const calls: string[] = [];
  const runService = {
    start: async (_scope: string, request: { sessionId: string }) => { calls.push(`start ${request.sessionId}`); return { runId: RUN, status: "accepted" }; },
    get: (runId: string) => runId === RUN ? { runId, sessionId: "full", status: "waiting_approval" } : undefined,
    cancel: (runId: string) => { calls.push(`cancel ${runId}`); return { cancelled: true }; },
    resolveApproval: (_runId: string, _approvalId: string, approved: boolean) => { calls.push(`approval ${approved}`); return { accepted: true }; }
  };
  const ops = createChatOperations({
    runtimeManager: { getRuntime: () => runtime, getSettings: async () => ({ ui: {} }) } as unknown as RuntimeManager,
    sessionIndexStore: { get: async (id: string) => sessions[id], list: async () => Object.values(sessions) } as unknown as SessionIndexStore,
    runService: runService as unknown as RunService, journal: {} as EventJournal, scopeOf: () => "device"
  });
  // The host gave this chat full access (its own HTTP API, Telegram or MCP).
  await store.update("full", { defaultAccessMode: "full" });
  const call = <T = any>(op: string, payload?: unknown) => Promise.resolve(ops[op]!(payload, context)) as Promise<T>;
  return { root, store, call, calls, file: (id: string) => path.join(root, `${id}.json`) };
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

  const journal = { read: () => ({ events: [{ seq: 1, type: "approval.requested", payload: { details: `Delete ${output}/a.txt` } }] }), wait: async () => undefined } as unknown as EventJournal;
  const poll = createEventStreamOperations({ journal, requireSession: async () => undefined, scrubSession: async () => scrub })["events.poll"]!;
  const result = await poll({ streams: [{ streamId: "session:chat", epoch: "e", after: 0 }], waitMs: 0 }, context) as any;
  assert.equal(result.streams[0].events[0].payload.details, "Delete <output>/a.txt");
});
