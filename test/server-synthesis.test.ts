import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const importModule = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
const HOST = "6f1c2c3e-58a4-4c55-9a0e-3c7f5b1d2e90";

function server() {
  const calls: unknown[][] = [];
  let events = [{ sequence: 1, step: "load", message: "Loading" }];
  const handlers: Record<string, (payload: any) => unknown> = {
    "synthesis.runs.list": () => ({ runs: [{ id: "r1", status: "running" }] }),
    "synthesis.runs.get": payload => ({ id: "r1", status: "running", events: events.filter(event => event.sequence > (payload.after ?? 0)), lastSequence: events.at(-1)!.sequence }),
    "synthesis.runs.diff": () => ({ canApply: true, files: [{ path: "a.js", before: null, after: "x", beforeBytes: null, afterBytes: 1 },
      { path: "big.js", omitted: true, beforeBytes: 900000, afterBytes: 900000 }] }),
    "synthesis.runs.file": payload => ({ content: `${payload.side}:${payload.path}` })
  };
  const runtime = { request: async (op: string, payload: unknown, host: string) => { calls.push([op, payload, host]); return { ok: true, value: handlers[op]!(payload) }; },
    send: async () => ({ ok: false }) };
  const target = { isRemote: () => true, hostId: () => HOST, generation: () => 1, online: () => true, hostName: () => "fedora",
    status: () => ({ state: "online", hostId: HOST, capabilities: ["synthesis.modules.list"] }), supports: () => true };
  return { calls, runtime, target, addEvent: (event: any) => { events = [...events, event]; } };
}

test("a server's Synthesis transport follows a run's events with a cursor, lists runs as the screen reads them and fetches large files on their own", async () => {
  const { createServerSynthesis } = await importModule(pathToFileURL(path.resolve("public/assets/server-synthesis.js")).href);
  const f = server();
  const synthesis = createServerSynthesis({ target: f.target, bridge: { runtime: f.runtime } });
  const transport = synthesis.transport();
  assert.equal(transport.remote.hostName, "fedora");
  assert.deepEqual(await transport.request("/projects/p1/runs"), [{ id: "r1", status: "running", events: [] }]);
  const first = await transport.request("/runs/r1");
  assert.deepEqual(first.events.map((event: any) => event.sequence), [1]);
  f.addEvent({ sequence: 2, step: "revise", message: "Writing" });
  const second = await transport.request("/runs/r1");
  assert.deepEqual(second.events.map((event: any) => event.sequence), [1, 2], "the events so far, the new ones added");
  assert.equal("lastSequence" in second, false);
  const runReads = f.calls.filter(call => call[0] === "synthesis.runs.get").map(call => call[1]);
  assert.deepEqual(runReads, [{ runId: "r1" }, { runId: "r1", after: 1 }], "only what came after is asked");
  const diff = await transport.request("/runs/r1/diff");
  assert.deepEqual(diff.files, [{ path: "a.js", before: null, after: "x" }, { path: "big.js", before: "before:big.js", after: "after:big.js" }]);
  assert.ok(f.calls.every(call => call[2] === HOST), "every call names the server");
  assert.equal(synthesis.unsupported(), false);
});

test("the transport keeps the events of the runs read most recently; an older run is read whole again", async () => {
  const { createServerSynthesis } = await importModule(pathToFileURL(path.resolve("public/assets/server-synthesis.js")).href);
  const f = server();
  const transport = createServerSynthesis({ target: f.target, bridge: { runtime: f.runtime } }).transport();
  for (let index = 0; index <= 20; index++) await transport.request(`/runs/run-${index}`);
  await transport.request("/runs/run-20");
  await transport.request("/runs/run-0");
  const reads = f.calls.filter(call => call[0] === "synthesis.runs.get").map(call => call[1]);
  assert.deepEqual(reads.slice(-2), [{ runId: "run-20", after: 1 }, { runId: "run-0" }]);
});

test("a module made at the project's root asks for the root, not the server's default folder", async () => {
  const { SYNTHESIS_ROUTES } = await importModule(pathToFileURL(path.resolve("public/assets/runtime-routes.js")).href);
  const route = SYNTHESIS_ROUTES.find((item: any) => item.op === "synthesis.modules.create");
  const payload = (body: unknown) => route.payload(route.pattern.exec("/projects/p1/modules"), new URLSearchParams(), body);
  assert.deepEqual(payload({ name: "Dash", template: "empty", directory: "" }), { projectId: "p1", name: "Dash", template: "empty", directory: "" });
  assert.deepEqual(payload({ name: "Dash", template: "empty" }), { projectId: "p1", name: "Dash", template: "empty" });
});
