import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, defaultBootstrap, SESSION_ID } from "./fixtures/appHarness";

test("a turn this window did not start shows its question and progress while it runs, then its answer", async () => {
  let running = true;
  const at = "2026-10-09T13:40:00.000Z";
  const h = await bootApp({ route: (_method, url) => {
    if (url === "/process-runs?status=running") return { runs: running ? [{ id: "api-run", sessionId: SESSION_ID, status: "running",
      input: "Build a house in Blender", startedAt: at, progress: { phase: "tools", label: "mcp.call", detail: "blender · execute_blender_code", at } }] : [] };
    if (url === "/process-runs/api-run") return running ? { id: "api-run", sessionId: SESSION_ID, status: "running", progress: { phase: "tools", label: "mcp.call", at } }
      : { id: "api-run", sessionId: SESSION_ID, status: "completed" };
    if (url === `/sessions/${SESSION_ID}/messages`) return running ? [] : [
      { id: "u", role: "user", content: "Build a house in Blender", createdAt: at },
      { id: "a", role: "assistant", content: "The house is built.", createdAt: at }];
    return undefined;
  } });
  try {
    await h.tick(1500);
    const chat = () => h.document.querySelector(".chat-shell")?.textContent ?? h.document.body.textContent;
    assert.match(chat(), /Build a house in Blender/, "the question shows while the turn runs");
    assert.ok(h.document.querySelector(".message.pending"), "with the turn in progress");
    running = false;
    await h.poll();
    assert.match(chat(), /The house is built\./, "the answer once it ends");
    assert.equal(h.document.querySelector(".message.pending"), null);
    await h.tick(1500);
    assert.equal(h.requests.filter(request => request === "GET /process-runs/api-run").length, 1, "an ended turn is not followed again");
  } finally { h.close(); }
});

test("on a computer that hosts, a chat a paired device starts shows in the list, one answering a device says so, and each shows its answer once it ends", async () => {
  // A Mac chatted on a Windows PC whose own window listed nothing new until it was reloaded (2026-10-31).
  const at = "2026-10-31T13:40:00.000Z";
  const ok = (value: unknown) => ({ ok: true, value });
  const host = { status: async () => ok({ available: true, enabled: true, state: "online", hostName: "PC", devices: [] }), folders: async () => ok([]), onChange() {} };
  let active: Array<Record<string, unknown>> = [], changed: Array<Record<string, unknown>> = [], sessions = [{ id: SESSION_ID, title: "First chat", updatedAt: at }];
  let answered = false;
  // Dictation sets the send button too, on every render.
  const voice = { onStopCapture() {}, status: async () => ({}) };
  const h = await bootApp({ host, voice, bootstrap: () => ({ ...defaultBootstrap(), sessions }), route: (_method, url) => {
    if (url === "/device-turns") return { active, changed };
    if (url === `/sessions/${SESSION_ID}/messages`) return answered ? [
      { id: "u", role: "user", content: "What is on my calendar?", createdAt: at }, { id: "a", role: "assistant", content: "Nothing today.", createdAt: at }] : [];
    if (url.startsWith("/device-turns/")) return { ok: true };
    return undefined;
  } });
  const chat = () => String(h.document.querySelector(".chat-shell")?.textContent ?? "").replace(/\s+/g, " ");
  const send = () => h.document.querySelector("#chat-form button[type='submit']");
  try {
    await h.tick(1500);
    // The phone starts a chat of its own.
    sessions = [{ id: "phone-chat", title: "Plan a trip", updatedAt: at }, ...sessions];
    active = [{ runId: "run-1", sessionId: "phone-chat", status: "running", startedAt: at, device: "iPhone" }];
    changed = [{ sessionId: "phone-chat", updatedAt: at }];
    await h.tick(1500);
    assert.match(h.document.querySelector(".sidebar, aside")?.textContent ?? "", /Plan a trip/, "the device's chat is listed");
    assert.equal(h.document.querySelector("[data-device-turn]"), null, "the open chat answers nobody");
    assert.equal(send()?.disabled, false);

    // Then it asks in the chat open here.
    active = [...active, { runId: "run-2", sessionId: SESSION_ID, status: "running", startedAt: at, device: "iPhone" }];
    await h.tick(1500);
    assert.match(chat(), /Answering a message from iPhone on this computer\. The answer shows here when it ends\./);
    assert.equal(send()?.disabled, true, "this window sends nothing into it meanwhile");
    // Other parts of the window set the send button too: the session's settings, attachments, models.
    h.document.querySelector("#session-settings-form input")!.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    assert.equal(send()?.disabled, true, "still, after the session's settings changed");
    active = active.map(turn => turn.runId === "run-2" ? { ...turn, status: "waiting_approval" } : turn);
    await h.tick(1500);
    assert.match(chat(), /Answering a message from iPhone on this computer: waiting for iPhone to approve a step\./);
    (h.document.querySelector("[data-action='stop-device-turn']") as any).click();
    await h.tick(1);
    assert.ok(h.requests.includes("POST /device-turns/run-2/cancel"), "Stop the answer stops the device's turn");

    // The answer ends: the chat shows it, and this window may send again.
    answered = true;
    active = active.filter(turn => turn.runId !== "run-2");
    changed = [{ sessionId: SESSION_ID, updatedAt: "2026-10-31T13:41:00.000Z" }, ...changed];
    await h.tick(1500);
    assert.match(chat(), /Nothing today\./);
    assert.equal(h.document.querySelector("[data-device-turn]"), null);
    assert.equal(send()?.disabled, false);

    // A turn that began and ended between two looks still brings the chat up to date.
    const reads = () => h.requests.filter(request => request === `GET /sessions/${SESSION_ID}/messages`).length;
    const before = reads();
    changed = [{ sessionId: SESSION_ID, updatedAt: "2026-10-31T13:42:00.000Z" }, ...changed.slice(1)];
    await h.tick(1500);
    assert.equal(reads(), before + 1);
    await h.tick(1500);
    assert.equal(reads(), before + 1, "nothing changed, nothing read again");
  } finally { h.close(); }
});

test("a computer that does not host asks nothing about devices' turns", async () => {
  const h = await bootApp();
  try {
    await h.tick(1500);
    assert.equal(h.requests.some(request => request.includes("/device-turns")), false);
  } finally { h.close(); }
});

test("in this computer's window a device's turn that did not complete says how it ended here, not on a server", async () => {
  const at = "2026-10-31T13:40:00.000Z";
  const host = { status: async () => ({ ok: true, value: { available: true, enabled: true, state: "online", hostName: "PC", devices: [] } }), folders: async () => ({ ok: true, value: [] }), onChange() {} };
  const h = await bootApp({ host, route: (_method, url) => url === `/sessions/${SESSION_ID}/messages` ? [
    { id: "u1", role: "user", content: "Write a long poem", createdAt: at, runId: "r1", runStatus: "cancelled" }, { id: "a1", role: "assistant", content: "", createdAt: at, runId: "r1", runStatus: "cancelled" },
    { id: "u2", role: "user", content: "And another", createdAt: at, runId: "r2", runStatus: "interrupted" }, { id: "a2", role: "assistant", content: "Roses", createdAt: at, runId: "r2", runStatus: "interrupted" }] : undefined });
  try {
    const chat = String(h.document.querySelector(".chat-shell")?.textContent ?? "").replace(/\s+/g, " ");
    assert.match(chat, /Write a long poem.*Stopped\..*And another.*Interrupted: this computer stopped while answering\./);
    assert.doesNotMatch(chat, /server/);
  } finally { h.close(); }
});
