import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { consentFilePath, liveConsent, readConsent, writeConsent } from "../src/diagnostics/consentFile";
import { rewriteAppFrames, scrubSentryEvent } from "../src/diagnostics/sentryScrub";
import { createDiagnosticsOperations } from "../src/runtime/diagnosticsOperations";
import { OPERATIONS } from "../src/runtime/operationCatalog";
import { parseServerArgs } from "../src/server/args";

test("a server's error reports are off until its owner turns them on; the running server sees the change", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "consent-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = consentFilePath(path.join(dir, "app"));
  assert.deepEqual(readConsent(file), { automatic: false, decidedAt: null });
  const live = liveConsent(file, 0);
  assert.equal(live(), false);
  writeConsent(file, true, new Date("2026-10-10T08:00:00Z"));
  assert.deepEqual(readConsent(file), { automatic: true, decidedAt: "2026-10-10T08:00:00.000Z" });
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(live(), true);
  fs.writeFileSync(file, "not json");
  assert.equal(readConsent(file).automatic, false, "an unreadable file is off");
});

test("the server's own files in a stack keep their source lines as app:/// paths; others are masked", () => {
  const event = { exception: { values: [{ type: "TypeError", value: "x", stacktrace: { frames: [
    { filename: "/opt/local-cognitive/app/dist/src/server/daemon.js", abs_path: "/opt/local-cognitive/app/dist/src/server/daemon.js", context_line: "run()", lineno: 3 },
    { filename: "/home/someone/.config/mcp/server.js", context_line: "secret()" }] } }] } };
  const scrubbed = scrubSentryEvent(rewriteAppFrames(event, "/opt/local-cognitive/app/"), true) as any;
  const [ours, theirs] = scrubbed.exception.values[0].stacktrace.frames;
  assert.deepEqual(ours, { filename: "app:///dist/src/server/daemon.js", abs_path: "app:///dist/src/server/daemon.js", context_line: "run()", lineno: 3 });
  assert.deepEqual(theirs, { filename: "<path>/server.js" });
  assert.equal(scrubSentryEvent(rewriteAppFrames(event, "/opt/local-cognitive/app"), false), null, "nothing without consent");
});

test("the owner turns the server's reports on and off from their computer; nobody else can", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "consent-op-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const consentFile = consentFilePath(dir);
  const ops = createDiagnosticsOperations({ runtimeManager: {} as never, owner: () => "owner", status: () => ({ phase: "running", activeWork: {} }), consentFile });
  const as = (accountId: string) => ({ accountId, deviceId: "d", signal: new AbortController().signal });
  for (const op of ["diagnostics.consent.get", "diagnostics.consent.set"]) assert.equal(OPERATIONS[op]?.kind, "request", op);
  assert.deepEqual(await ops["diagnostics.consent.get"]!({}, as("owner")), { available: true, automatic: false, decidedAt: null });
  const on = await ops["diagnostics.consent.set"]!({ automatic: true }, as("owner")) as { automatic: boolean };
  assert.equal(on.automatic, true);
  assert.equal(readConsent(consentFile).automatic, true);
  await assert.rejects(Promise.resolve().then(() => ops["diagnostics.consent.set"]!({ automatic: false }, as("someone"))), /owner/);
  await assert.rejects(Promise.resolve().then(() => ops["diagnostics.consent.set"]!({ automatic: "yes" }, as("owner"))), /not valid/);
  assert.equal(readConsent(consentFile).automatic, true);
});

test("error-reports: show by default, on or off; nothing else", () => {
  assert.equal(parseServerArgs(["error-reports", "--data-dir", "/srv/lc"], {}).errorReports, "show");
  assert.equal(parseServerArgs(["error-reports", "on", "--data-dir", "/srv/lc"], {}).errorReports, "on");
  assert.equal(parseServerArgs(["error-reports", "off", "--data-dir", "/srv/lc"], {}).errorReports, "off");
  assert.throws(() => parseServerArgs(["error-reports", "maybe", "--data-dir", "/srv/lc"], {}), /error-reports on/);
  assert.throws(() => parseServerArgs(["error-reports"], {}), /--data-dir/);
});
