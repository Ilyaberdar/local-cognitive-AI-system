import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { RemoteClient } from "../src/remote/client/RemoteClient";
import { RemoteRuntime } from "../src/remote/client/RemoteRuntime";
import { memoryVault, remoteStackSkip, startCloud, startDaemon, until } from "./fixtures/remoteStack";

test("Synthesis on a server: a module made from a device in the server's Projects folder runs there, once per command, with no folder of the server in any answer",
  { skip: remoteStackSkip, timeout: 180_000 }, async t => {
  const cloud = await startCloud(t);
  const server = await startDaemon(t, cloud.origin);
  const alice = await cloud.account("auth0|alice");
  const mac = new RemoteClient({ cloudUrl: cloud.origin, vault: memoryVault(), account: async () => alice, deviceName: "Mac", platform: "macos", backoff: { baseMs: 50, maxMs: 300 } });
  t.after(() => mac.dispose());
  const paired = await mac.pair(server.connectKey());
  assert.ok(paired.capabilities?.includes("synthesis.runs.start"), "the server offers Synthesis");
  const runtime = new RemoteRuntime(mac);
  t.after(() => runtime.dispose());
  const received: unknown[] = [];
  const ask = async <T>(op: string, payload: unknown) => { const value = await runtime.request<T>(op, payload); received.push(value); return value; };
  const send = async <T>(op: string, payload: Record<string, unknown>) => { const value = await runtime.send<T>(op, payload); received.push(value); return value; };

  await runtime.request("fs.mkdir", { rootId: "projects", path: [], name: "calc" });
  const project = await send<{ id: string }>("projects.create", { name: "Calc", folder: { rootId: "projects", path: ["calc"] } });
  const module = await send<{ id: string; valid: boolean; specSource: string }>("synthesis.modules.create", { projectId: project.id, template: "calculator" });
  assert.equal(module.valid, true);
  assert.ok(fs.existsSync(path.join(server.root, "projects", "calc", "Synthesis", "Calculator", "Calculator.lcspec")), "the module is in the project's folder on the server");
  const listed = await ask<{ modules: Array<{ id: string }> }>("synthesis.modules.list", { projectId: project.id });
  assert.deepEqual(listed.modules.map(item => item.id), ["Calculator"]);

  const command = { projectId: project.id, moduleId: "Calculator", commandId: "synthesis-start-1" };
  const started = await ask<{ id: string }>("synthesis.runs.start", command);
  assert.equal((await runtime.request<{ id: string }>("synthesis.runs.start", command)).id, started.id, "a resend gets the same run");
  // This server has no local model: the run ends without a candidate, honestly.
  const ended = await until(() => ask<{ status: string; events: unknown[]; lastSequence: number }>("synthesis.runs.get", { runId: started.id }),
    run => !["queued", "running"].includes(run.status), 60_000);
  assert.notEqual(ended.status, "accepted");
  assert.ok(ended.events.length > 0);
  assert.deepEqual((await ask<{ events: unknown[] }>("synthesis.runs.get", { runId: started.id, after: ended.lastSequence })).events, []);
  assert.equal((await ask<{ runs: unknown[] }>("synthesis.runs.list", { projectId: project.id })).runs.length, 1);
  await ask("synthesis.runs.sources", { runId: started.id });
  await ask("synthesis.runs.diff", { runId: started.id });

  const everything = JSON.stringify(received);
  assert.equal(everything.includes(server.root), false, "no folder of the server reaches the device");
  assert.equal(everything.includes(path.dirname(server.root)), false);
});
