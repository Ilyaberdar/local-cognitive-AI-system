import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require("jsdom");
const shellBundle = buildSync({ entryPoints: ["public/assets/settings-shell.js"], bundle: true, write: false, format: "iife", globalName: "SettingsShell" }).outputFiles[0].text;
const forwardingBundle = buildSync({ entryPoints: ["public/assets/error-forwarding.js"], bundle: true, write: false, format: "iife" }).outputFiles[0].text;

async function until(check: () => boolean, label: string) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > 2000) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test("Data & Privacy: error reports are off until the user turns them on, and the switch is remembered", async t => {
  const dom = new JSDOM('<main><div id="root"></div></main>', { url: "http://localhost/#/chat", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const calls: unknown[] = [];
  let consent = { automatic: false, decidedAt: null as string | null, available: true };
  dom.window.desktopDiagnostics = {
    consent: async () => consent,
    setConsent: async (value: boolean) => { calls.push(value); consent = { automatic: value, decidedAt: "2026-10-10T00:00:00.000Z", available: true }; return consent; }
  };
  dom.window.eval(`${shellBundle}\nwindow.SettingsShell = SettingsShell;`);
  const shell = dom.window.SettingsShell.createSettingsShell({ app: dom.window.document.getElementById("root"), getContext: () => ({ appSettings: { memory: {}, profile: {} } }),
    data: { integrations: [] }, captureScroll: () => ({}), restoreScroll() {}, onReturn() {} });
  shell.route("#/settings/data");
  const toggle = () => dom.window.document.querySelector("[data-error-reports]") as HTMLInputElement | null;
  await until(() => Boolean(toggle()), "consent switch");
  assert.equal(toggle()!.checked, false, "off by default");
  assert.match(dom.window.document.body.textContent, /Chats, prompts, model answers, keys, file contents and paths are not included/);
  assert.match(dom.window.document.body.textContent, /crash dump .* may contain fragments/);
  toggle()!.checked = true;
  toggle()!.dispatchEvent(new dom.window.Event("change"));
  await until(() => calls.length === 1, "saved");
  assert.deepEqual(calls, [true]);
});

test("the window's uncaught errors go to the main process; other sites' scripts do not", () => {
  const dom = new JSDOM("<main></main>", { url: "http://127.0.0.1:5000/", runScripts: "outside-only" });
  const reports: any[] = [];
  dom.window.desktopDiagnostics = { reportError: (report: unknown) => reports.push(report) };
  dom.window.eval(forwardingBundle);
  const error = new dom.window.TypeError("Cannot read properties of undefined");
  dom.window.dispatchEvent(new dom.window.ErrorEvent("error", { error, message: error.message, filename: "http://127.0.0.1:5000/assets/app.js" }));
  dom.window.dispatchEvent(new dom.window.ErrorEvent("error", { error, message: error.message, filename: "https://evil.example/x.js" }));
  assert.equal(reports.length, 1);
  assert.equal(reports[0].name, "TypeError");
  dom.window.close();
});
