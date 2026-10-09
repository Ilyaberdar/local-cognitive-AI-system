import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { EventJournal, type JournalEvent } from "../src/runtime/EventJournal";
import { RunService, RunServiceError, streamOf, type ExecuteHooks } from "../src/runtime/RunService";
import { HostDatabase } from "../src/runtime/db/HostDatabase";
import { hostMigrations } from "../src/runtime/db/hostSchema";
import { pathScrubber, type Scrubber } from "../src/runtime/orchestrationDto";

const at = () => new Date().toISOString();
const until = async (check: () => boolean) => { for (let index = 0; index < 200 && !check(); index++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check(), "condition not reached"); };

/** A scripted engine: each run waits for `release(runId)` unless told to finish at once. */
function engine() {
  const calls: Array<{ runId: string; sessionId: string; input: string; hooks: ExecuteHooks }> = [];
  const gates = new Map<string, (result: { error?: string }) => void>();
  const execute = (run: { runId: string; sessionId: string; input: string }, hooks: ExecuteHooks) => new Promise<{ error?: string }>((resolve, reject) => {
    calls.push({ ...run, hooks });
    gates.set(run.runId, resolve);
    hooks.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  return { calls, execute, finish: (runId: string, result: { error?: string } = {}) => gates.get(runId)?.(result) };
}

function setup(t: TestContext, file?: string, scrubber?: () => Promise<Scrubber>) {
  const directory = file ? path.dirname(file) : fs.mkdtempSync(path.join(os.tmpdir(), "run-service-"));
  if (!file) t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const host = HostDatabase.open(file ?? path.join(directory, "host.db"), hostMigrations);
  const journal = new EventJournal(host), script = engine();
  const service = new RunService({ host, journal, execute: script.execute, sessionExists: async id => id.startsWith("s"), ...(scrubber ? { scrubber } : {}),
    completedTurn: async (_sessionId, runId) => [{ id: `${runId}:user`, role: "user", content: "hi", createdAt: at() }] });
  t.after(async () => { await service.dispose(); host.close(); });
  const events = (sessionId: string) => {
    const read = journal.read(streamOf(sessionId), { epoch: journal.epoch, after: 0 });
    return "events" in read ? read.events : [];
  };
  return { host, journal, service, script, events, file: file ?? path.join(directory, "host.db") };
}
const text = (events: JournalEvent[]) => events.filter(event => event.type === "message.delta").reduce((value, event) => {
  const { offset, text: chunk, replace } = event.payload as { offset: number; text: string; replace?: boolean };
  return replace ? chunk : value.slice(0, offset) + chunk;
}, "");

test("a command is accepted once per key; the same key replays and another payload conflicts", async t => {
  const f = setup(t);
  const first = await f.service.start("remote:a:d1", { commandId: "c1", sessionId: "s1", input: "hello" });
  assert.equal(first.status, "accepted");
  const again = await f.service.start("remote:a:d1", { commandId: "c1", sessionId: "s1", input: " hello " });
  assert.deepEqual({ ...again, replayed: undefined }, { ...first, replayed: undefined });
  assert.equal(again.replayed, true);
  await assert.rejects(f.service.start("remote:a:d1", { commandId: "c1", sessionId: "s1", input: "other" }), (error: unknown) => (error as RunServiceError).code === "idempotency_conflict");
  const busy = await f.service.start("remote:a:d2", { commandId: "c1", sessionId: "s1", input: "hello" });
  assert.deepEqual(busy, { commandId: "c1", status: "rejected", code: "session_busy", activeRunId: first.runId });
  assert.deepEqual(await f.service.start("remote:a:d2", { commandId: "c1", sessionId: "s1", input: "hello" }), { ...busy, replayed: true }, "a rejection replays too");
  await assert.rejects(f.service.start("remote:a:d1", { commandId: "c2", sessionId: "x1", input: "hi" }), (error: unknown) => (error as RunServiceError).code === "session_unknown");
  await until(() => f.script.calls.length === 1);
  assert.equal(f.script.calls.length, 1, "one execution for all of it");
});

test("the answer is journaled as deltas and progress, then completed with the turn from memory", async t => {
  const f = setup(t);
  const ack = await f.service.start("local:p", { commandId: "c1", sessionId: "s1", input: "hello" });
  await until(() => f.script.calls.length === 1);
  const { hooks } = f.script.calls[0]!;
  for (const answer of ["Hel", "Hello", "Hello wor", "Hello world"]) hooks.onProgress({ phase: "generating", label: "Writing", answer, at: at() });
  hooks.onProgress({ phase: "rewrite", label: "Rewriting", answer: "Hi world", at: at() });
  await until(() => f.service.activeRun("s1")?.partialText === "Hi world");
  f.script.finish(ack.runId!);
  await until(() => f.service.get(ack.runId!)?.status === "completed");
  const events = f.events("s1");
  assert.deepEqual(events.map(event => event.seq), events.map((_event, index) => index + 1), "dense sequences");
  assert.equal(events[0]!.type, "message.accepted");
  assert.equal(events[1]!.type, "run.started");
  assert.equal(text(events), "Hi world", "deltas rebuild the answer, including a rewrite");
  assert.ok(events.some(event => event.type === "run.progress"));
  const completed = events.find(event => event.type === "message.completed")!;
  assert.equal((completed.payload as { text: string }).text, "Hi world");
  assert.equal((completed.payload as { messages: unknown[] }).messages.length, 1);
  assert.equal(events.at(-1)!.type, "run.completed");
  assert.equal(f.service.activeRun("s1"), undefined);
  assert.deepEqual(f.service.unfinishedTurns("s1"), [], "completed turns come from memory, not from here");
});

test("cancel is explicit, keeps the partial answer and frees the session", async t => {
  const f = setup(t);
  const ack = await f.service.start("local:p", { commandId: "c1", sessionId: "s1", input: "hello" });
  await until(() => f.script.calls.length === 1);
  f.script.calls[0]!.hooks.onProgress({ phase: "generating", label: "Writing", answer: "Partial", at: at() });
  f.service.cancel(ack.runId!);
  await until(() => f.service.get(ack.runId!)?.status === "cancelled");
  const turns = f.service.unfinishedTurns("s1");
  assert.deepEqual(turns.map(turn => [turn.role, turn.content, turn.runStatus]), [["user", "hello", "cancelled"], ["assistant", "Partial", "cancelled"]]);
  assert.equal(f.events("s1").at(-1)!.type, "run.cancelled");
  assert.equal(f.service.cancel(ack.runId!).status, "cancelled", "cancelling again just reports");
  assert.equal((await f.service.start("local:p", { commandId: "c2", sessionId: "s1", input: "next" })).status, "accepted");
});

test("approvals wait for the matching decision and a provider error fails the run", async t => {
  const f = setup(t);
  const ack = await f.service.start("local:p", { commandId: "c1", sessionId: "s1", input: "delete it" });
  await until(() => f.script.calls.length === 1);
  const decision = f.script.calls[0]!.hooks.requestApproval({ tool: "shell", operation: "rm", summary: "Remove a file", details: "rm x" });
  await until(() => f.service.get(ack.runId!)?.status === "waiting_approval");
  const pending = f.service.activeRun("s1")!.pendingApproval!;
  assert.match(pending.digest, /^[0-9a-f]{64}$/);
  assert.throws(() => f.service.resolveApproval(ack.runId!, "other", true), (error: unknown) => (error as RunServiceError).code === "approval_stale");
  f.service.resolveApproval(ack.runId!, pending.approvalId, true);
  assert.equal(await decision, true);
  assert.throws(() => f.service.resolveApproval(ack.runId!, pending.approvalId, true), (error: unknown) => (error as RunServiceError).code === "approval_stale", "decided once");
  assert.equal(f.service.get(ack.runId!)?.status, "running");
  f.script.finish(ack.runId!, { error: "Provider unavailable" });
  await until(() => f.service.get(ack.runId!)?.status === "failed");
  assert.deepEqual(f.events("s1").at(-1)!.payload, { runId: ack.runId, error: "Provider unavailable" });
});

test("after a crash, active runs are interrupted with their partial answers and never run again", async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "run-service-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const file = path.join(base, "host.db");
  const before = setup(t, file);
  const plain = await before.service.start("local:p", { commandId: "c1", sessionId: "s1", input: "write" });
  const tooling = await before.service.start("local:p", { commandId: "c2", sessionId: "s2", input: "run a command" });
  await until(() => before.script.calls.length === 2);
  before.script.calls[0]!.hooks.onProgress({ phase: "generating", label: "Writing", answer: "Half an answer", at: at() });
  before.script.calls[1]!.hooks.onProgress({ phase: "tools", label: "Running a command", at: at() });
  await until(() => before.service.activeRun("s1")?.partialText === "Half an answer");
  // A crash: the process is gone; nothing records the end of these runs.
  (before.service as unknown as { disposed: boolean }).disposed = true;
  before.host.close();

  const after = setup(t, file);
  assert.equal(after.service.recover(), 2);
  assert.equal(after.service.get(plain.runId!)?.status, "interrupted");
  assert.equal(after.service.get(tooling.runId!)?.status, "needs_review", "a tool step may have changed something");
  assert.deepEqual(after.service.unfinishedTurns("s1").map(turn => turn.content), ["write", "Half an answer"]);
  assert.equal(after.events("s1").at(-1)!.type, "run.interrupted");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(after.script.calls.length, 0, "nothing is executed again");
  assert.equal(after.service.recover(), 0);
});

test("a shutdown interrupts running turns; a draining service refuses new ones", async t => {
  const f = setup(t);
  const ack = await f.service.start("local:p", { commandId: "c1", sessionId: "s1", input: "hello" });
  await until(() => f.script.calls.length === 1);
  f.service.stopAccepting();
  await assert.rejects(f.service.start("local:p", { commandId: "c2", sessionId: "s2", input: "hi" }), (error: unknown) => (error as RunServiceError).code === "host_draining");
  assert.equal((await f.service.start("local:p", { commandId: "c1", sessionId: "s1", input: "hello" })).runId, ack.runId, "a replay still answers while draining");
  assert.equal(f.service.interruptAll(), 1);
  await until(() => f.service.get(ack.runId!)?.status === "interrupted");
  assert.equal(f.service.activeCount(), 0);
});

test("journal cursors resync on another epoch or a cursor ahead, and waits wake on publish", async t => {
  const f = setup(t);
  const appended = f.host.transaction(db => [f.journal.append(db, "session:s1", { type: "test", payload: { n: 1 } }), f.journal.append(db, "session:s1", { type: "test", payload: { n: 2 } })]);
  f.journal.publish(appended);
  const read = f.journal.read("session:s1", { epoch: f.journal.epoch, after: 1 });
  assert.ok("events" in read);
  assert.deepEqual(read.events.map(event => event.payload), [{ n: 2 }]);
  assert.deepEqual(f.journal.read("session:s1", { epoch: "other", after: 0 }), { resync: "epoch_changed", head: 2, epoch: f.journal.epoch });
  assert.deepEqual(f.journal.read("session:s1", { epoch: f.journal.epoch, after: 9 }), { resync: "cursor_ahead", head: 2, epoch: f.journal.epoch });
  f.host.db.prepare("UPDATE event_streams SET first_retained_sequence = 3 WHERE stream_id = 'session:s1'").run();
  assert.equal((f.journal.read("session:s1", { epoch: f.journal.epoch, after: 0 }) as { resync: string }).resync, "cursor_expired");

  const woke = f.journal.wait(["session:s2"], 5_000);
  f.journal.publish(f.host.transaction(db => [f.journal.append(db, "session:s2", { type: "test", payload: {} })]));
  await woke;
  const controller = new AbortController();
  const aborted = f.journal.wait(["session:s3"], 5_000, controller.signal);
  controller.abort();
  await aborted;
});

test("devices see a short error without server paths; the host log keeps the full text", async t => {
  const { publicError } = await import("../src/runtime/publicError");
  assert.equal(publicError("Local runtime exited (1).\nllama_model_load: /srv/local-cognitive/models/a/x.gguf: bad magic"), "Local runtime exited (1).");
  assert.equal(publicError("Cannot open /srv/local-cognitive/models/a/x.gguf for reading"), "Cannot open <path> for reading");
  assert.equal(publicError("Failed: C:\\Users\\me\\models\\x.gguf"), "Failed: <path>");
  assert.equal(publicError("x".repeat(400)).length, 300);
  assert.equal(publicError(""), "The operation failed on the server.");
  assert.equal(publicError("Provider unavailable"), "Provider unavailable");

  const f = setup(t);
  const ack = await f.service.start("local:p", { commandId: "c1", sessionId: "s1", input: "hello" });
  await until(() => f.script.calls.length === 1);
  f.script.finish(ack.runId!, { error: "Local runtime exited (1).\n" + "/srv/local-cognitive/models/secret-name.gguf ".repeat(2000) });
  await until(() => f.service.get(ack.runId!)?.status === "failed");
  const visible = JSON.stringify([f.service.get(ack.runId!), f.service.unfinishedTurns("s1"), f.events("s1")]);
  assert.equal(visible.includes("/srv/"), false);
  assert.equal(f.service.get(ack.runId!)?.error, "Local runtime exited (1).");
});

test("a device sees the answer without the server's folders, with offsets that add up, even when a folder is split between updates", async t => {
  const f = setup(t, undefined, async () => pathScrubber([["/srv/lc/output", "<output>"], ["/srv/lc", "<server>"]]));
  const ack = await f.service.start("remote:a:d1", { commandId: "c1", sessionId: "s1", input: "where?" });
  await until(() => f.script.calls.length === 1);
  const { hooks } = f.script.calls[0]!;
  for (const answer of ["Saved to /srv/l", "Saved to /srv/lc/out", "Saved to /srv/lc/output/report.md and /srv/lc/outbox/x.", "Saved to /srv/lc/output/report.md and /srv/lc/outbox/x. Done."]) {
    hooks.onProgress({ phase: "generating", label: "Writing", answer, at: at() });
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  void hooks.requestApproval({ tool: "file", operation: "write", summary: "Write the report", details: "Write /srv/lc/output/report.md" }).catch(() => undefined);
  await until(() => Boolean(f.service.activeRun("s1")?.pendingApproval));
  assert.equal(f.service.activeRun("s1")!.pendingApproval!.details, "Write <output>/report.md");
  f.script.finish(ack.runId!, { error: "Disk full at /srv/lc/output" });
  await until(() => f.service.get(ack.runId!)?.status === "failed");
  const events = f.events("s1");
  assert.equal(text(events), "Saved to <output>/report.md and <server>/outbox/x. Done.", "the deltas rebuild the scrubbed answer");
  assert.equal(JSON.stringify(events).includes("/srv/lc"), false, "no part of a folder went out");
  assert.equal(f.service.get(ack.runId!)!.error, "Disk full at <output>");
});

test("deleting a chat refuses new turns while it goes, and removes its turns, commands and journal", async t => {
  const f = setup(t);
  const ack = await f.service.start("remote:a:d1", { commandId: "c1", sessionId: "s1", input: "secret input" });
  await until(() => f.script.calls.length === 1);
  assert.throws(() => f.service.forgetSession("s1"), (error: unknown) => (error as RunServiceError).code === "session_busy");
  f.script.finish(ack.runId!);
  await until(() => f.service.get(ack.runId!)?.status === "completed");
  f.service.forgetSession("s1");
  await assert.rejects(f.service.start("remote:a:d1", { commandId: "c2", sessionId: "s1", input: "again" }), (error: unknown) => (error as RunServiceError).code === "session_unknown");
  for (const table of ["messages", "runs", "commands", "events", "event_streams"]) {
    assert.equal(JSON.stringify(f.host.db.prepare(`SELECT * FROM ${table}`).all()).includes("s1"), false, `${table} keeps nothing of the chat`);
  }
  f.service.forgotSession("s1", false);
  assert.equal((await f.service.start("remote:a:d1", { commandId: "c3", sessionId: "s1", input: "kept" })).status, "accepted", "a delete that failed leaves the chat usable");
});

test("a turn whose scrubber cannot be built fails instead of writing what a device may not see", async t => {
  const f = setup(t, undefined, async () => { throw new Error("settings unreadable"); });
  const ack = await f.service.start("remote:a:d1", { commandId: "c1", sessionId: "s1", input: "hi" });
  await until(() => f.service.get(ack.runId!)?.status === "failed");
  assert.equal(f.script.calls.length, 0, "the engine never ran");
});

test("a device's turn is marked as one, carries its attachments and uses no plugin of the host", async () => {
  const { deviceRunMetadata } = await import("../src/index");
  const { parsePluginSelection } = await import("../src/plugins/PluginSelection");
  const metadata = deviceRunMetadata({ runId: "r1" });
  assert.deepEqual(metadata, { chatRunId: "r1", deviceRun: true, pluginIds: [] });
  assert.deepEqual(parsePluginSelection(metadata.pluginIds), [], "an empty selection, not automatic discovery");
  const file = { id: "a", name: "a.txt", mimeType: "text/plain", sizeBytes: 1, kind: "text" as const, textContent: "a" };
  assert.deepEqual(deviceRunMetadata({ runId: "r2", attachments: [file] }).attachments, [file]);
});

test("a resend that loses the race for its attachments gets the first attempt's answer", async t => {
  const f = setup(t);
  let taken = false;
  const admit = async () => { if (taken) throw new RunServiceError("An attachment is no longer on the server.", "attachment_unknown"); taken = true; return { attachments: [] }; };
  const request = { commandId: "c1", sessionId: "s1", input: "with a file", attachmentIds: ["4f1c1b0e-8d5a-4b8e-9c55-0a6b2f1e9d11"] };
  const first = await f.service.start("remote:a:d1", request, admit);
  const again = await f.service.start("remote:a:d1", request, admit);
  assert.equal(again.runId, first.runId);
  assert.equal(again.replayed, true);
});
