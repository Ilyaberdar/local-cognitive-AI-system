import assert from "node:assert/strict";
import test from "node:test";
import { ProcessRunRegistry } from "../src/api/ProcessRunRegistry";
import { resolveAbortSignal } from "../src/llm/provider-utils";

test("process run registry reports progress and cancels the active signal", () => {
  const registry = new ProcessRunRegistry();
  const run = registry.start("run-1");

  registry.update("run-1", {
    phase: "agents",
    label: "Running agents",
    detail: "Waiting for @Nova",
    at: new Date().toISOString()
  });

  assert.equal(registry.get("run-1")?.progress?.phase, "agents");
  assert.equal(registry.cancel("run-1"), true);
  assert.equal(run.controller.signal.aborted, true);
  assert.equal(registry.get("run-1")?.status, "cancelled");
});

test("provider abort signal follows an external cancellation", () => {
  const controller = new AbortController();
  const signal = resolveAbortSignal(60_000, controller.signal);

  controller.abort();
  assert.equal(signal.aborted, true);
});
