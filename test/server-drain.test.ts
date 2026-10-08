import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createDrainGate } from "../src/api/drainGate";
import type { ActiveWork, BackendHandle } from "../src/index";
import { drainBackend } from "../src/server/drain";

test("while draining, new work is refused but accepted work can be reviewed, cancelled or freed", async t => {
  let draining = false;
  const app = express();
  app.use(createDrainGate(() => draining));
  app.all("*", (_req, res) => { res.json({ ok: true }); });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const status = (method: string, url: string) => fetch(`${base}${url}`, { method }).then(response => response.status);
  assert.equal(await status("POST", "/sessions"), 200);
  draining = true;
  assert.equal(await status("POST", "/sessions"), 503);
  assert.equal(await status("POST", "/chat"), 503);
  for (const url of ["/process-runs/r1/cancel", "/process-runs/r1/review", "/workflow-runs/w1/cancel", "/local/downloads/d1/pause", "/local/models/unload"]) {
    assert.equal(await status("POST", url), 200, url);
  }
  assert.equal(await status("GET", "/sessions"), 200);
});

const fakeHandle = (counts: number[]) => {
  const calls = { stopped: 0, interrupted: 0 };
  let index = 0;
  const work = (): ActiveWork => ({ processRuns: counts[Math.min(index, counts.length - 1)]!, workflowRuns: 0, inferenceBusy: false, inferenceQueued: 0, scheduleTick: false,
    total: counts[Math.min(index++, counts.length - 1)]! });
  const handle = { activeWork: work, stopAcceptingWork: () => { calls.stopped++; }, interruptActiveWork: () => { calls.interrupted++; return 1; } } as unknown as BackendHandle;
  return { handle, calls };
};

test("drain stops intake, waits for accepted work and interrupts only after the deadline", async () => {
  const finishing = fakeHandle([2, 1, 0]);
  const progress: number[] = [];
  const done = await drainBackend(finishing.handle, { timeoutMs: 10_000, onProgress: active => progress.push(active) });
  assert.equal(done.drained, true);
  assert.equal(finishing.calls.stopped, 1);
  assert.equal(finishing.calls.interrupted, 0);
  assert.deepEqual(progress, [2, 1]);

  const stuck = fakeHandle([3]);
  const timedOut = await drainBackend(stuck.handle, { timeoutMs: 600 });
  assert.equal(timedOut.drained, false);
  assert.equal(timedOut.remaining, 3);
  assert.equal(stuck.calls.interrupted, 1);
});
