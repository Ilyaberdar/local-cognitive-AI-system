import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { createSentry } = require(path.resolve("electron/sentry.cjs"));
const rules = require(path.resolve("dist/src/diagnostics/sentryScrub.js"));

// A stand-in SDK that records what the app asks of it.
const fakeSdk = () => {
  const calls: Array<[string, ...unknown[]]> = [];
  const integration = (name: string) => () => ({ name });
  const sdk = {
    calls,
    IPCMode: { Classic: 1, Protocol: 2, Both: 3 },
    init: (options: Record<string, unknown>) => { calls.push(["init", options]); },
    getClient: () => ({ addIntegration: (item: unknown) => calls.push(["addIntegration", item]), on: () => undefined }),
    addEventProcessor: () => undefined,
    addBreadcrumb: (crumb: unknown) => { calls.push(["addBreadcrumb", crumb]); },
    captureException: () => { calls.push(["captureException"]); return "e1"; },
    captureFeedback: (feedback: unknown) => { calls.push(["captureFeedback", feedback]); return "f1"; },
    flush: async () => true,
    ...Object.fromEntries(["sentryMinidumpIntegration", "onUncaughtExceptionIntegration", "onUnhandledRejectionIntegration", "childProcessIntegration",
      "eventFiltersIntegration", "functionToStringIntegration", "linkedErrorsIntegration", "contextLinesIntegration", "nodeContextIntegration",
      "electronContextIntegration", "additionalContextIntegration", "gpuContextIntegration", "mainProcessSessionIntegration", "normalizePathsIntegration"]
      .map(name => [name, integration(name)]))
  };
  return sdk;
};
const fakeLog = () => {
  const listeners: Array<(entry: { event: string; fields: Record<string, unknown>; at: string }) => void> = [];
  return { onRecord: (listener: (typeof listeners)[number]) => { listeners.push(listener); },
    record: (event: string, fields: Record<string, unknown> = {}) => listeners.forEach(listener => listener({ event, fields, at: new Date().toISOString() })) };
};
const setup = (consent?: { automatic: boolean }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lc-sentry-"));
  if (consent) fs.writeFileSync(path.join(dir, "diagnostics-consent.json"), JSON.stringify({ ...consent, decidedAt: "2026-10-29T00:00:00.000Z" }));
  const sdk = fakeSdk();
  let loads = 0;
  const app = { getPath: () => dir, getVersion: () => "0.1.11", isPackaged: true };
  const sentry = createSentry({ app, load: () => { loads++; return sdk; }, scrub: () => rules });
  return { sentry, sdk, loads: () => loads, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

test("without consent the error-report SDK is not loaded at launch; a bug report starts it with the technical log kept so far", async () => {
  const { sentry, sdk, loads, cleanup } = setup();
  try {
    const log = fakeLog();
    sentry.attachLog(log);
    for (let index = 0; index < 60; index++) log.record("ui.open", { index });
    sentry.rendererError({ name: "TypeError", message: "x" }, log);
    assert.equal(loads(), 0, "nothing loads the SDK before it is needed");
    assert.deepEqual(sentry.consent(), { automatic: false, decidedAt: null, available: true });

    assert.equal(await sentry.sendFeedback({ message: "It broke", tags: {}, contexts: {}, attachments: [] }), "f1");
    assert.equal(loads(), 1);
    const init = sdk.calls.find(call => call[0] === "init")![1] as { integrations: Array<{ name: string }>; ipcMode: number };
    assert.equal(init.ipcMode, 1, "the window has no SDK: no protocol, so it can start after the app is ready");
    assert.ok(!init.integrations.some(item => item.name === "sentryMinidumpIntegration"), "no crash reports without consent");
    const crumbs = sdk.calls.filter(call => call[0] === "addBreadcrumb");
    assert.equal(crumbs.length, 50, "as many log events as the SDK keeps, the latest");
    assert.equal(((crumbs.at(-1)![1] as { message: string }).message), "renderer.error");
    assert.ok(sdk.calls.findIndex(call => call[0] === "addBreadcrumb") < sdk.calls.findIndex(call => call[0] === "captureFeedback"), "the log goes with the report");
    assert.ok(!sdk.calls.some(call => call[0] === "captureException"), "a window's error is not reported without consent");

    log.record("ui.close");
    assert.equal(sdk.calls.filter(call => call[0] === "addBreadcrumb").length, 51, "once started, events go to the SDK at once");
    await sentry.sendFeedback({ message: "Again", tags: {}, contexts: {}, attachments: [] });
    assert.equal(loads(), 1, "started once");
  } finally { cleanup(); }
});

test("consent given during a run starts the SDK with crash reports; consent given before starts it at launch", () => {
  const off = setup();
  try {
    assert.deepEqual({ ...off.sentry.setConsent(true), decidedAt: null }, { automatic: true, decidedAt: null, available: true });
    assert.equal(off.loads(), 1);
    const init = off.sdk.calls.find(call => call[0] === "init")![1] as { integrations: Array<{ name: string }> };
    assert.ok(init.integrations.some(item => item.name === "sentryMinidumpIntegration"));
    off.sentry.rendererError({ name: "TypeError", message: "x" });
    assert.ok(off.sdk.calls.some(call => call[0] === "captureException"), "a window's error is reported with consent");
  } finally { off.cleanup(); }

  const on = setup({ automatic: true });
  try { assert.equal(on.loads(), 1, "with consent the crash handler starts before the app is ready"); }
  finally { on.cleanup(); }
});
