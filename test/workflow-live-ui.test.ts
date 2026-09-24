import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync("public/assets/workflow-live.js", "utf8").replace("export function", "function");
class FakeSource {
  listeners = new Map<string, (event: { data: string }) => void>();
  closed = false;
  onerror?: () => void;
  static latest: FakeSource;
  constructor(readonly url: string) { FakeSource.latest = this; }
  addEventListener(name: string, callback: (event: { data: string }) => void) { this.listeners.set(name, callback); }
  emit(name: string, data: unknown) { this.listeners.get(name)?.({ data: JSON.stringify(data) }); }
  close() { this.closed = true; }
}
const harness = () => {
  const context = vm.createContext({ setTimeout, clearTimeout, EventSource: FakeSource });
  vm.runInContext(source, context);
  return context.watchWorkflowRun as (options: Record<string, unknown>) => { close: () => void; setDetail: (detail: unknown) => void };
};
const event = (sequence: number) => ({ sequence, runId: "run", message: `event ${sequence}` });

test("live UI merges replay/live, deduplicates, fences late fetches and reconnects with its cursor", async () => {
  const watch = harness();
  const observed: any[] = [];
  let resolve!: (value: unknown) => void;
  const detail = { run: { id: "run", status: "running" }, nodeRuns: [] };
  const subscription = watch({ runId: "run", detail, request: () => new Promise(done => { resolve = done; }), onChange: (value: unknown) => observed.push(value) });
  const stream = FakeSource.latest;
  stream.emit("history", { events: [event(1), event(2)], firstSequence: 1, lastSequence: 2, detail });
  stream.emit("update", event(2)); stream.emit("update", event(3));
  assert.deepEqual(Array.from(observed.at(-1).events, (row: any) => row.sequence), [1, 2, 3]);
  stream.onerror?.(); assert.equal(observed.at(-1).connection, "reconnecting");
  await new Promise(done => setTimeout(done, 150));
  subscription.close(); assert.ok(stream.closed);
  const count = observed.length;
  resolve({ run: { id: "run", status: "done" }, nodeRuns: [] });
  await new Promise(done => setTimeout(done, 5));
  stream.emit("update", event(4)); assert.equal(observed.length, count);
  const resumed = watch({ runId: "run", detail, cached: observed.at(-1), request: async () => detail, onChange: (value: unknown) => observed.push(value) });
  assert.match(FakeSource.latest.url, /after=3$/); resumed.close();
});

test("live UI caps retained rows and resets when the persisted sequence is newer or recreated", () => {
  const watch = harness(); let latest: any;
  const detail = { run: { id: "run" }, nodeRuns: [] };
  const subscription = watch({ runId: "run", detail, request: async () => detail, onChange: (value: unknown) => { latest = value; } });
  FakeSource.latest.emit("history", { events: Array.from({ length: 1200 }, (_, i) => event(i + 1)), firstSequence: 1, lastSequence: 1200, detail });
  assert.equal(latest.events.length, 1000); assert.equal(latest.events[0].sequence, 201); assert.ok(latest.truncated);
  FakeSource.latest.emit("history", { events: [event(1)], firstSequence: 1, lastSequence: 1, detail });
  assert.equal(latest.events.length, 1); assert.equal(latest.cursor, 1);
  subscription.close();
});

test("an older poll cannot revive a finished run or roll back node progress", () => {
  const watch = harness(); let latest: any;
  const detail = { run: { id: "run", status: "running", updatedAt: "2026-09-23T12:00:00.000Z" },
    nodeRuns: [{ id: "attempt", status: "running", progress: { at: "2026-09-23T12:00:02.000Z", label: "Generating" } }] };
  const subscription = watch({ runId: "run", detail, request: async () => detail, onChange: (value: unknown) => { latest = value; } });
  subscription.setDetail({ ...detail, nodeRuns: [{ id: "attempt", status: "running", progress: { at: "2026-09-23T12:00:01.000Z", label: "Loading" } }] });
  assert.equal(latest.nodeRuns[0].progress.label, "Generating");
  subscription.setDetail({ run: { ...detail.run, status: "done", updatedAt: "2026-09-23T12:00:03.000Z" }, nodeRuns: [{ id: "attempt", status: "ok", completedAt: "2026-09-23T12:00:03.000Z" }] });
  subscription.setDetail(detail);
  assert.equal(latest.run.status, "done"); assert.equal(latest.nodeRuns[0].status, "ok");
  subscription.close();
});
