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

test("progress retains participant states through final phases and cancellation cannot become complete", () => {
  const registry = new ProcessRunRegistry(); registry.start("progress");
  registry.update("progress", { phase: "agents", label: "Working", at: new Date().toISOString(), agents: [
    { id: "atlas", name: "Atlas", role: "advisor", provider: "ollama", status: "completed", phase: "Complete" },
    { id: "nova", name: "Nova", role: "advisor", provider: "ollama", status: "running", phase: "Working" }
  ] });
  registry.update("progress", { phase: "synthesis", label: "Synthesizing", at: new Date().toISOString() });
  assert.equal(registry.get("progress")?.progress?.agents?.length, 2);
  registry.cancel("progress"); registry.complete("progress");
  assert.equal(registry.get("progress")?.status, "cancelled");
  assert.deepEqual(registry.get("progress")?.progress?.agents?.map((agent) => agent.status), ["completed", "cancelled"]);
  assert.throws(() => registry.start("progress"), /already exists/);
});
