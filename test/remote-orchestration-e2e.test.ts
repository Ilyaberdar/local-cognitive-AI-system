import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RemoteClient } from "../src/remote/client/RemoteClient";
import { RemoteRuntime, type StreamEvent, type StreamUpdate } from "../src/remote/client/RemoteRuntime";
import { memoryVault, remoteStackSkip, startCloud, startDaemon, until } from "./fixtures/remoteStack";

const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
/** entry → human review → a command (asks for approval) → done. */
const flow = (id: string, script: string) => ({ id, name: id, version: 1, entryNodeId: "entry", createdAt: "", updatedAt: "",
  nodes: [node("entry", "entry"), node("review", "human_review"),
    node("work", "command", { executable: process.execPath, args: ["-e", script], timeoutMs: 120_000, approval: "inherit" }), node("done", "terminal", { runStatus: "done" })],
  transitions: [{ id: "a", from: "entry", to: "review", priority: 1, guard: { type: "always" } },
    { id: "b", from: "review", to: "work", priority: 1, guard: { type: "status", equals: "ok" } },
    { id: "c", from: "work", to: "done", priority: 1, guard: { type: "status", equals: "ok" } }] });
const ticks = (marker: string, count: number, everyMs: number) =>
  `const fs=require('fs');let i=0;const t=setInterval(()=>{i++;console.log('tick '+i);fs.appendFileSync(${JSON.stringify(marker)},'x\\n');if(i>=${count})clearInterval(t)},${everyMs})`;
const lines = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;

test("Tasks & workflows on the server through the relay: a run followed across a disconnect, cancel, tasks, schedules, a drain and a crash",
  { skip: remoteStackSkip, timeout: 240_000 }, async t => {
    const cloud = await startCloud(t);
    const server = await startDaemon(t, cloud.origin);
    const alice = await cloud.account("auth0|alice");
    const mac = new RemoteClient({ cloudUrl: cloud.origin, vault: memoryVault(), account: async () => alice, deviceName: "Mac", platform: "macos", backoff: { baseMs: 50, maxMs: 300 } });
    t.after(() => mac.dispose());
    const paired = await mac.pair(server.connectKey());
    assert.equal(paired.state, "online", JSON.stringify(paired));
    const hostId = paired.hostId!;
    assert.ok(paired.capabilities?.includes("workflows.runs.start"));
    const runtime = new RemoteRuntime(mac, { resendWindowMs: 20_000 });
    t.after(() => runtime.dispose());
    const markers = fs.mkdtempSync(path.join(os.tmpdir(), "lc-markers-"));
    t.after(() => fs.rmSync(markers, { recursive: true, force: true }));

    const received: unknown[] = [];
    const call = async <T = any>(op: string, payload?: unknown): Promise<T> => { const value = await runtime.request<T>(op, payload, { hostId }); received.push(value); return value; };
    const send = async <T = any>(op: string, payload: Record<string, unknown>): Promise<T> => { const value = await runtime.send<T>(op, payload, { hostId }); received.push(value); return value; };
    const updates: StreamUpdate[] = [];
    runtime.on("update", (update: StreamUpdate) => { updates.push(update); received.push(update); });
    const detailWhen = (runId: string, done: (detail: any) => boolean, timeoutMs = 30_000) =>
      until(() => call("workflows.runs.get", { runId }).catch(() => undefined), detail => Boolean(detail && done(detail)), timeoutMs);
    /** Answers the run's waiting step: the human review, or the command's approval. */
    const answer = async (runId: string) => {
      const detail = await detailWhen(runId, value => value.run.status === "waiting");
      const step = detail.nodeRuns.filter((item: { status: string }) => item.status === "waiting").at(-1);
      const data = step.output?.data ?? {};
      return send("workflows.runs.review", { runId, approved: true, ...(data.permissionRequired ? { approvalId: data.approvalId } : { waitingNodeRunId: step.id }) });
    };

    // 1. Save, then start: a resent start is the same run; the same id for another start is refused.
    const markerA = path.join(markers, "a.txt");
    const saved = await send("workflows.save", { workflow: flow("ticks", ticks(markerA, 15, 100)), expectedUpdatedAt: null });
    const first = await call("workflows.runs.start", { commandId: "fixed-start-001", workflow: saved, options: {} });
    assert.equal((await call("workflows.runs.start", { commandId: "fixed-start-001", workflow: saved, options: {} })).id, first.id);
    await assert.rejects(call("workflows.runs.start", { commandId: "fixed-start-001", workflow: { ...saved, name: "Other" }, options: {} }),
      (error: { code?: string }) => error.code === "idempotency_conflict");

    // 2. Followed live across a disconnect: every event once, in order.
    const history = await call("workflows.runs.events", { runId: first.id });
    const seen = new Map<number, StreamEvent>(history.events.map((event: { sequence: number }) => [event.sequence, event]));
    const live = () => updates.flatMap(update => "events" in update && update.streamId === `workflow-run:${first.id}` ? update.events : []);
    runtime.subscribe(history.cursor, { hostId });
    await answer(first.id);
    await answer(first.id);
    await until(() => lines(markerA), count => count >= 3);
    mac.disconnect();
    await until(() => updates.some(update => "resync" in update), Boolean);
    for (const event of live()) seen.set(event.seq, event);
    const before = Math.max(...seen.keys());
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal((await mac.connect(hostId)).state, "online");
    const missed = await call("workflows.runs.events", { runId: first.id, after: before });
    assert.ok(missed.events.every((event: { sequence: number }) => event.sequence > before));
    for (const event of missed.events) seen.set(event.sequence, event);
    updates.length = 0;
    runtime.subscribe(missed.cursor, { hostId });
    await detailWhen(first.id, value => value.run.status === "done");
    const finalCursor = (await call("workflows.runs.events", { runId: first.id, after: 0 })).lastSequence;
    await until(() => live().length ? Math.max(...live().map(event => event.seq)) : missed.cursor.after, last => last >= finalCursor, 10_000);
    for (const event of live()) { assert.ok(!seen.has(event.seq) || event.seq > missed.cursor.after, `event ${event.seq} came twice`); seen.set(event.seq, event); }
    assert.deepEqual([...seen.keys()].sort((a, b) => a - b), Array.from({ length: finalCursor }, (_value, index) => index + 1), "no event lost");
    runtime.unsubscribe(`workflow-run:${first.id}`);
    assert.equal(lines(markerA), 15);

    // 3. Cancel stops the command.
    const markerB = path.join(markers, "b.txt");
    const longer = await send("workflows.save", { workflow: flow("long", ticks(markerB, 200, 100)), expectedUpdatedAt: null });
    const cancelled = await send("workflows.runs.start", { workflow: longer, options: {} });
    await answer(cancelled.id);
    await answer(cancelled.id);
    await until(() => lines(markerB), count => count >= 3);
    assert.equal((await call("workflows.runs.cancel", { runId: cancelled.id })).status, "cancelled");
    await new Promise(resolve => setTimeout(resolve, 600));
    const stopped = lines(markerB);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(lines(markerB), stopped, "the command stopped");

    // 4. Tasks and schedules: a resent run is the same run.
    const task = await send("tasks.create", { title: "Weekly report", description: "Summarise", workflowId: "ticks" });
    const run = await call("tasks.run", { commandId: "fixed-task-run-001", taskId: task.id });
    assert.equal((await call("tasks.run", { commandId: "fixed-task-run-001", taskId: task.id })).runId, run.runId);
    await call("workflows.runs.cancel", { runId: run.runId });
    const schedule = await send("schedules.create", { title: "Every morning", workflowId: "ticks", time: "09:00", timezone: "UTC" });
    assert.equal((await call("schedules.update", { scheduleId: schedule.id, patch: { enabled: false } })).enabled, false);
    const lists = await call("orchestration.snapshot", {});
    assert.ok(lists.tasks.some((item: { id: string }) => item.id === task.id) && lists.schedules.some((item: { id: string }) => item.id === schedule.id));
    assert.deepEqual(await call("schedules.delete", { scheduleId: schedule.id }), { deleted: true });

    // 5. A drain lets a running command finish; the device sees the run done afterwards.
    const drained = await send("workflows.save", { workflow: flow("drained", "console.log('START');setTimeout(()=>console.log('END'),2000)"), expectedUpdatedAt: null });
    const finishing = await send("workflows.runs.start", { workflow: drained, options: {} });
    await answer(finishing.id);
    await answer(finishing.id);
    await detailWhen(finishing.id, value => value.nodeRuns.some((step: { nodeId: string; status: string }) => step.nodeId === "work" && step.status === "running"));
    await server.restart("SIGTERM");
    await until(() => mac.status().state, state => state === "online", 30_000);
    assert.equal((await detailWhen(finishing.id, value => ["done", "interrupted", "failed"].includes(value.run.status))).run.status, "done");

    // 6. A crash mid-command: the run is interrupted, and Resume never runs the command again.
    const markerC = path.join(markers, "c.txt");
    const crashing = await send("workflows.save", { workflow: flow("crash", `require('fs').appendFileSync(${JSON.stringify(markerC)},'x\\n');setTimeout(()=>{},20000)`),
      expectedUpdatedAt: null });
    const crashed = await send("workflows.runs.start", { workflow: crashing, options: {} });
    await answer(crashed.id);
    await answer(crashed.id);
    await until(() => lines(markerC), count => count === 1);
    await server.restart("SIGKILL");
    await until(() => mac.status().state, state => state === "online", 30_000);
    assert.equal((await detailWhen(crashed.id, value => value.run.status !== "running")).run.status, "interrupted");
    await send("workflows.runs.resume", { runId: crashed.id });
    const after = await detailWhen(crashed.id, value => !["queued", "running"].includes(value.run.status));
    assert.equal(after.run.status, "blocked", "an uncertain command is not repeated");
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(lines(markerC), 1);

    const exposed = JSON.stringify(received);
    for (const directory of [server.root, path.dirname(server.root)]) assert.equal(exposed.includes(directory), false, `${directory} reached the device`);
  });
