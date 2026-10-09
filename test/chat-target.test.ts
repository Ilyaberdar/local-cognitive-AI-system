import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

// The module's pure parts, loaded without a browser (icons are stubbed).
const load = () => {
  const source = fs.readFileSync("public/assets/chat-target.js", "utf8").replace(/^import .*\n/m, "").replace(/^export /gm, "");
  const context: any = { icon: (name: string) => `<svg data-icon="${name}"></svg>`, FormData: class {}, console };
  vm.runInNewContext(`${source}\nthis.api = { remoteSettingsPatch, reduceSessionEvents, runProgress, remoteModelOptions, createChatTarget, renderTargetSwitch, renderTargetBanner };`, context);
  return context.api;
};
/** Values from the vm realm, as plain objects of this one (strict equality compares prototypes). */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const delta = (seq: number, offset: number, text: string, extra = {}) => ({ seq, type: "message.delta", occurredAt: "t", payload: { runId: "r1", offset, text, ...extra } });

test("server chats save only the supported settings that changed", () => {
  const { remoteSettingsPatch } = load();
  const current = { mode: "general", language: "auto", reasoningEffort: "medium", defaultTarget: { providerId: "llamacpp", model: "qwen" } };
  assert.deepEqual(plain(remoteSettingsPatch({ ...current, codeAgents: [{ id: "a" }], defaultAccessMode: "full", debate: { enabled: true } }, current)), {},
    "agents, access and debate are never sent; nothing changed");
  assert.deepEqual(plain(remoteSettingsPatch({ ...current, language: "en", defaultTarget: { providerId: "llamacpp", model: "llama" } }, current)),
    { language: "en", defaultTarget: { providerId: "llamacpp", model: "llama" } });
  assert.deepEqual(plain(remoteSettingsPatch({ reasoningEffort: "high" }, current)), { reasoningEffort: "high" });
  assert.deepEqual(plain(remoteSettingsPatch({ defaultTarget: { providerId: "" } }, current)), {});
});

test("a server that offers agent setup gets the agents and debate that changed, without access modes", () => {
  const { remoteSettingsPatch } = load();
  const current = { mode: "code", defaultTarget: { providerId: "llamacpp", model: "qwen" }, defaultAccessMode: "default",
    codeAgents: [{ id: "a1", name: "Nova", providerId: "llamacpp", model: "qwen", accessMode: "default" }],
    hypothesisAgents: [{ id: "s", name: "Support", role: "support", providerId: "llamacpp", model: "qwen" }],
    debate: { enabled: false, profile: "general", support: { providerId: "llamacpp", model: "qwen" }, attack: { providerId: "llamacpp" }, judge: { providerId: "local" } } };
  const same = { ...current, subagents: current.codeAgents, debate: { ...current.debate, enabled: true } };
  assert.deepEqual(plain(remoteSettingsPatch(same, current, { agents: true })), {}, "the alias and debate.enabled are never sent; nothing changed");
  const next = { ...current, codeAgents: [{ ...current.codeAgents[0], accessMode: "full", providerId: "openai", model: "gpt-4.1" }],
    debate: { ...current.debate, profile: "security", judge: { providerId: "local", model: "ignored" } } };
  assert.deepEqual(plain(remoteSettingsPatch(next, current, { agents: true })), {
    codeAgents: [{ id: "a1", name: "Nova", providerId: "openai", model: "gpt-4.1" }], debate: { profile: "security", support: { providerId: "llamacpp", model: "qwen" },
      attack: { providerId: "llamacpp" }, judge: { providerId: "local" } } });
  assert.deepEqual(plain(remoteSettingsPatch(next, current)), {}, "an older server is sent no agents");
});

test("stream events rebuild the answer at offsets, ignore replays and ask for a resync on a gap", () => {
  const { reduceSessionEvents, runProgress } = load();
  const view: any = { lastSeq: 4, run: { runId: "r1", input: "hi", answer: "" } };
  let result = reduceSessionEvents(view, [delta(3, 0, "old"), delta(5, 0, "Hel"), delta(6, 3, "lo")]);
  assert.equal(view.run.answer, "Hello", "seq 3 is before the cursor");
  assert.ok(result.effects.has("progress"));
  reduceSessionEvents(view, [delta(5, 0, "Hel"), delta(6, 3, "lo")]);
  assert.equal(view.run.answer, "Hello", "a replayed batch changes nothing");
  reduceSessionEvents(view, [delta(7, 2, "y!")]);
  assert.equal(view.run.answer, "Hey!", "an overlapping delta rewrites from its offset");
  reduceSessionEvents(view, [delta(8, 0, "Rewritten", { replace: true })]);
  assert.equal(view.run.answer, "Rewritten");
  result = reduceSessionEvents(view, [delta(9, 50, "lost")]);
  assert.ok(result.effects.has("resync"), "a missing delta means the view is behind");
  assert.equal(runProgress(view.run).answer, "Rewritten");

  result = reduceSessionEvents(view, [{ seq: 10, type: "approval.requested", occurredAt: "t", payload: { runId: "r1", approvalId: "a1", tool: "shell", operation: "rm", summary: "Remove", details: "rm x" } }]);
  assert.deepEqual(plain(view.run.approval), { id: "a1", tool: "shell", operation: "rm", summary: "Remove", details: "rm x" });
  assert.ok(result.effects.has("approval"));
  result = reduceSessionEvents(view, [{ seq: 11, type: "run.cancelled", occurredAt: "t", payload: { runId: "r1" } }]);
  assert.deepEqual(plain(result.terminal), { runId: "r1", status: "cancelled" });
  assert.equal(view.run, undefined);
  assert.ok(result.effects.has("reload"));

  const other: any = { lastSeq: 0 };
  result = reduceSessionEvents(other, [{ seq: 1, type: "message.accepted", occurredAt: "t", payload: { runId: "r9", message: { content: "from the phone", createdAt: "c" } } }]);
  assert.equal(other.run.input, "from the phone", "a turn sent from another device appears");
  assert.ok(result.effects.has("render"));
  reduceSessionEvents(other, [delta(2, 0, "x", { runId: "r8" })]);
  assert.equal(other.run.answer, "", "deltas of another run are ignored");
});

test("server chat keys are stable, unique and accepted by voice input", async () => {
  const { createChatTarget } = load();
  const responses: Record<string, unknown> = { "sessions.list": [{ id: "6f1c2c3e-58a4-4c55-9a0e-3c7f5b1d2e90", title: "A" }, { id: "x/../y", title: "B" }] };
  const bridge = { onChange() {}, status: async () => ({ ok: true, value: { state: "online", hostId: "h1" } }), hosts: async () => ({ ok: true, value: [] }),
    connect: async () => ({ ok: true, value: { state: "online", hostId: "h1" } }),
    runtime: { request: async (op: string) => ({ ok: true, value: responses[op] }), send: async () => ({ ok: true, value: {} }), subscribe() {}, unsubscribe() {}, onEvent() {} } };
  const target = createChatTarget({ bridge, account: { get: () => ({ state: "signed-in" }), subscribe() {} } });
  await target.select("h1");
  const sessions = await target.refreshSessions();
  for (const session of sessions) {
    assert.match(session.id, /^[a-zA-Z0-9-]{1,100}$/);
    assert.ok(target.owns(session.id));
  }
  assert.notEqual(sessions[0].id, sessions[1].id);
  assert.equal(target.serverSessionId(sessions[1].id), "x/../y");
  assert.equal((await target.refreshSessions())[0].id, sessions[0].id, "the same chat keeps its key");
  assert.equal(target.owns("11111111-1111-4111-8111-111111111111"), false, "local ids are never server chats");
});

test("server names and states are escaped in the switch and the banner", async () => {
  const { createChatTarget, renderTargetSwitch, renderTargetBanner } = load();
  const evil = "<img src=x onerror=alert(1)>";
  const bridge = { onChange() {}, status: async () => ({ ok: true, value: { state: "reconnecting", hostId: "h1", hostName: evil } }),
    hosts: async () => ({ ok: true, value: [{ hostId: "h1", name: evil, online: true, paired: true }] }), connect: async () => ({ ok: true, value: { state: "reconnecting", hostId: "h1", hostName: evil } }),
    runtime: { request: async () => ({ ok: true, value: [] }), send: async () => ({ ok: true }), subscribe() {}, unsubscribe() {}, onEvent() {} } };
  const target = createChatTarget({ bridge, account: { get: () => ({ state: "signed-in" }), subscribe() {} } });
  await target.refreshHosts();
  await target.select("h1");
  const html = renderTargetSwitch(target) + renderTargetBanner(target);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.match(renderTargetBanner(target), /Nothing is sent; your draft is kept/);
  assert.equal(target.blocksSend(), true);
});
