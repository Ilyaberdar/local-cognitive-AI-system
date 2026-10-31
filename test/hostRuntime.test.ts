import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { builtInHostOperations, createHostOperations } from "../src/remote/host/hostRuntime";
import { OPERATIONS } from "../src/runtime/operationCatalog";
import { startTestBackend } from "./fixtures/testBackend";

test("a host answers every operation of the catalog, and no other", { timeout: 60_000 }, async t => {
  const { backend, root } = await startTestBackend(t, "server");
  const host = createHostOperations({ backend, dataRoot: root });
  t.after(host.stop);
  const offered = Object.keys({ ...builtInHostOperations({ hostName: "h", kind: "server", status: () => ({}) }), ...host.operations }).sort();
  assert.deepEqual(offered, Object.keys(OPERATIONS).sort());
  assert.ok(fs.existsSync(path.join(root, "projects")), "the folder devices manage is made");
});

test("a host says what it is: its name, version, platform and kind", async () => {
  for (const kind of ["server", "desktop"] as const) {
    const info = await builtInHostOperations({ hostName: "MacBook", kind, status: () => ({ phase: "running" }) })["host.info"]!(undefined, {} as never) as Record<string, unknown>;
    assert.deepEqual({ name: info.name, platform: info.platform, kind: info.kind }, { name: "MacBook", platform: process.platform, kind });
    assert.equal(typeof info.version, "string");
  }
});

test("the desktop app opens the host services, so hosting can start without a restart; a test runtime does not", { timeout: 60_000 }, async t => {
  const desktop = await startTestBackend(t, "desktop");
  assert.ok(desktop.backend.host, "RunService, journal and ledger are open");
  assert.equal(desktop.backend.activeWork().chatRuns, 0);
  const host = createHostOperations({ backend: desktop.backend, dataRoot: desktop.root });
  t.after(host.stop);
  assert.ok(host.operations["chat.runs.start"]);
  const plain = await startTestBackend(t, "test");
  assert.equal(plain.backend.host, undefined);
});

test("a device learns from host.info whether it is trusted here, and no operation lets a device trust itself", async () => {
  const trusted = new Set(["phone"]);
  const info = (deviceId: string) => builtInHostOperations({ hostName: "MacBook", kind: "desktop", status: () => ({}), trusted: context => trusted.has(context.deviceId) })["host.info"]!(
    undefined, { accountId: "a", deviceId, signal: new AbortController().signal }) as Record<string, unknown>;
  assert.deepEqual(info("phone").device, { trusted: true });
  assert.deepEqual(info("laptop").device, { trusted: false });
  assert.deepEqual((builtInHostOperations({ hostName: "h", kind: "server", status: () => ({}) })["host.info"]!(undefined, {} as never) as Record<string, unknown>).device,
    { trusted: false }, "without a store, no device is");
  assert.deepEqual(Object.keys(OPERATIONS).filter(op => /trust/i.test(op)), [], "trust is set only on the host itself");
});
