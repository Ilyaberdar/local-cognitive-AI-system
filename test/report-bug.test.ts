import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { buildSync } from "esbuild";
import { bugReportFormSchema, clientDiagnostics, composeBugReport, type PreparedReport } from "../src/diagnostics/BugReport";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require("jsdom");
const bundle = buildSync({ entryPoints: ["public/assets/report-bug.js"], bundle: true, write: false, format: "iife", globalName: "ReportBug" }).outputFiles[0].text;

const prepared = (reportId: string): PreparedReport => ({
  reportId, createdAt: "2026-10-10T08:00:00.000Z", appVersion: "0.1.0",
  diagnostics: { client: clientDiagnostics({ versions: { electron: "35.1.0", chrome: "134.0" }, osVersion: "15.4", signedIn: true, modeHint: "remote",
    remote: { state: "connected", serverVersion: "0.1.0", capabilities: ["a", "b"], hostName: "fedora-secret" } as never }), runtime: { runtimeKind: "desktop" } },
  log: [{ at: "2026-10-10T07:00:00.000Z", event: "provider.call_failed", fields: { httpStatus: 401 }, n: 1 }],
  screenshot: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  server: { snapshot: { runtimeKind: "server" } }
});

test("a report carries the user's words, and only the parts they ticked", () => {
  const reportId = randomUUID();
  const form = bugReportFormSchema.parse({ reportId, summary: "The model hangs", description: "It stops at 50%", steps: "1. Load\n2. Ask", expected: "", actual: "", contact: "me@example.com" });
  const plain = composeBugReport(form, prepared(reportId));
  assert.equal(plain.message, "The model hangs\n\nWhat happened:\nIt stops at 50%\n\nSteps to reproduce:\n1. Load\n2. Ask");
  assert.equal(plain.email, "me@example.com");
  assert.deepEqual(plain.attachments, [], "nothing by default");
  assert.deepEqual(plain.contexts.lc, { report_id: reportId, mode: "remote", attached: "none" });
  assert.equal("diagnostics" in plain.file, false);
  const all = composeBugReport({ ...form, include: { diagnostics: true, screenshot: true, server: true } }, prepared(reportId));
  assert.deepEqual(all.attachments.map(item => [item.filename, item.contentType]), [["diagnostics.json", "application/json"], ["server-diagnostics.json", "application/json"], ["screenshot.jpg", "image/jpeg"]]);
  assert.match(String(all.attachments[0]!.data), /provider\.call_failed/);
  assert.equal((all.file.screenshot as { base64: string }).base64, "/9j/2Q==");
  assert.equal(JSON.stringify(all.file).includes("fedora-secret"), false, "the server's name is not in the diagnostics");
});

test("the form: a summary is required, the email must be one, nothing else is accepted; the mode is believed only when connected", () => {
  const reportId = randomUUID();
  assert.equal(bugReportFormSchema.safeParse({ reportId, summary: "  " }).success, false);
  assert.equal(bugReportFormSchema.safeParse({ reportId, summary: "x", contact: "not an email" }).success, false);
  assert.equal(bugReportFormSchema.safeParse({ reportId, summary: "x", path: "/etc" }).success, false);
  assert.equal(clientDiagnostics({ versions: {}, osVersion: "1", signedIn: false, modeHint: "remote" }).mode, "local");
});

async function until(check: () => boolean, label: string) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > 2000) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test("the page: nothing ticked, each part shown before it is sent, the ID after sending, a file when sending fails", async t => {
  const dom = new JSDOM('<div id="page"></div>', { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  dom.window.eval(`${bundle}\nwindow.ReportBug = ReportBug;`);
  const reportId = randomUUID();
  const calls: unknown[][] = [];
  let failSend = true;
  const bridge = {
    prepare: async (request: unknown) => { calls.push(["prepare", request]); return { ok: true, value: { reportId, diagnostics: { client: { mode: "local" }, runtime: { app: { version: "0.1.0" } } },
      log: [{ event: "mcp.connection_failed", n: 2 }], screenshot: "data:image/jpeg;base64,AAAA", server: { name: "fedora" }, sendAvailable: true } }; },
    serverDiagnostics: async () => { calls.push(["server"]); return { ok: true, value: { snapshot: { runtimeKind: "server" } } }; },
    submit: async (form: unknown) => { calls.push(["submit", form]); return failSend ? { ok: false, error: { message: "Offline." } } : { ok: true, value: { reportId, eventId: "e1" } }; },
    export: async (form: unknown) => { calls.push(["export", form]); return { ok: true, value: { saved: true } }; }
  };
  const container = dom.window.document.getElementById("page");
  dom.window.ReportBug.mountReportBugPage(container, { bridge, mode: "local" });
  const $ = (selector: string) => container.querySelector(selector);
  await until(() => Boolean($('[data-report-field="summary"]')), "form");
  assert.deepEqual([...container.querySelectorAll("[data-report-include]")].map((box: any) => [box.dataset.reportInclude, box.checked]), [["diagnostics", false], ["screenshot", false], ["server", false]]);
  assert.equal($("pre.report-preview"), null, "no preview of unticked parts");
  assert.equal(($("[data-report-send]") as HTMLButtonElement).disabled, true, "a summary first");
  const type = (name: string, value: string) => { const input = $(`[data-report-field="${name}"]`) as HTMLInputElement; input.value = value; input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); };
  type("summary", "MCP does not connect");
  type("steps", "Open Blender");
  const tick = (name: string) => { const box = $(`[data-report-include="${name}"]`) as HTMLInputElement; box.checked = true; box.dispatchEvent(new dom.window.Event("change", { bubbles: true })); };
  tick("diagnostics");
  assert.match($("pre.report-preview")!.textContent!, /mcp\.connection_failed/);
  tick("screenshot");
  assert.ok($("img.report-screenshot"));
  tick("server");
  await until(() => /runtimeKind/.test(container.querySelectorAll("pre.report-preview")[1]?.textContent ?? ""), "server preview");
  ($("[data-report-send]") as HTMLButtonElement).click();
  await until(() => /Offline\. You can save it to a file instead\./.test(container.textContent), "failure");
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call => call[0] === "submit")![1])), { reportId, summary: "MCP does not connect", description: "", steps: "Open Blender", expected: "", actual: "", contact: "",
    include: { diagnostics: true, screenshot: true, server: true } });
  ($("[data-report-export]") as HTMLButtonElement).click();
  await until(() => /saved to a file/.test(container.textContent), "saved");
  failSend = false;
  ($("[data-report-send]") as HTMLButtonElement).click();
  await until(() => /the report was sent/.test(container.textContent), "sent");
  assert.match(container.textContent, new RegExp(reportId));
});
