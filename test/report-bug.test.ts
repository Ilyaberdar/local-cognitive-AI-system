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
    remote: { state: "online", serverVersion: "0.1.0", capabilities: ["a", "b"], hostName: "fedora-secret" } as never }), runtime: { runtimeKind: "desktop" } },
  log: [{ at: "2026-10-10T07:00:00.000Z", event: "provider.call_failed", fields: { httpStatus: 401 }, n: 1 }],
  screenshot: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  server: { snapshot: { runtimeKind: "server" } }
});

test("a report carries the user's words, and only the parts they chose", () => {
  const reportId = randomUUID();
  const form = bugReportFormSchema.parse({ reportId, message: "The model stops answering after I attach a file" });
  const plain = composeBugReport(form, prepared(reportId));
  assert.equal(plain.message, "The model stops answering after I attach a file");
  assert.deepEqual(plain.attachments, [], "nothing by default");
  assert.deepEqual(plain.contexts.lc, { report_id: reportId, mode: "remote", attached: "none" });
  assert.equal("diagnostics" in plain.file, false);
  const all = composeBugReport({ ...form, include: { diagnostics: true, screenshot: true } }, prepared(reportId));
  assert.deepEqual(all.attachments.map(item => [item.filename, item.contentType]), [["diagnostics.json", "application/json"], ["screenshot.jpg", "image/jpeg"]]);
  const diagnostics = JSON.parse(String(all.attachments[0]!.data));
  assert.deepEqual(Object.keys(diagnostics), ["client", "runtime", "log", "server"], "the technical log and the connected server's part are in the diagnostics");
  assert.equal((all.file.screenshot as { base64: string }).base64, "/9j/2Q==");
  assert.equal(JSON.stringify(all.file).includes("fedora-secret"), false, "the server's name is not in the diagnostics");
});

test("the form: a message is required and nothing else is accepted; the mode is believed only when connected", () => {
  const reportId = randomUUID();
  assert.equal(bugReportFormSchema.safeParse({ reportId, message: "  " }).success, false);
  assert.equal(bugReportFormSchema.safeParse({ reportId, message: "x", steps: "1." }).success, false);
  assert.equal(bugReportFormSchema.safeParse({ reportId, message: "x", include: { server: true } }).success, false);
  assert.equal(clientDiagnostics({ versions: {}, osVersion: "1", signedIn: false, modeHint: "remote" }).mode, "local");
});

async function until(check: () => boolean, label: string) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > 2000) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test("the page: a message and Send; diagnostics on when error reports are allowed, each part shown on request, a file only when sending fails", async t => {
  const dom = new JSDOM('<div id="page"></div>', { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  dom.window.eval(`${bundle}\nwindow.ReportBug = ReportBug;`);
  const reportId = randomUUID();
  const calls: unknown[][] = [];
  let failSend = true, expired = false;
  const bridge = {
    prepare: async (request: unknown) => { calls.push(["prepare", request]); return { ok: true, value: { reportId, diagnosticsByDefault: true, sendAvailable: true,
      diagnostics: { client: { mode: "local" }, runtime: {}, log: [{ event: "mcp.connection_failed", n: 2 }], server: { snapshot: { runtimeKind: "server" } } }, screenshot: "data:image/jpeg;base64,AAAA" } }; },
    submit: async (form: unknown) => {
      calls.push(["submit", form]);
      if (expired) { expired = false; return { ok: false, error: { code: "report_expired", message: "Expired." } }; }
      return failSend ? { ok: false, error: { message: "Offline." } } : { ok: true, value: { reportId, eventId: "e1" } };
    },
    export: async (form: unknown) => { calls.push(["export", form]); return { ok: true, value: { saved: true } }; }
  };
  const container = dom.window.document.getElementById("page");
  dom.window.ReportBug.mountReportBugPage(container, { bridge, mode: "local" });
  const $ = (selector: string) => container.querySelector(selector);
  await until(() => Boolean($("[data-report-message]")), "form");
  assert.equal(container.querySelectorAll("textarea, input:not([type=checkbox])").length, 1, "one field");
  assert.deepEqual([...container.querySelectorAll("[data-report-include]")].map((box: any) => [box.dataset.reportInclude, box.checked]), [["diagnostics", true], ["screenshot", false]]);
  assert.equal($("[data-report-export]"), null, "no file button until sending fails");
  assert.equal(($("[data-report-send]") as HTMLButtonElement).disabled, true, "a message first");
  assert.equal($("pre.report-preview"), null);
  ($('[data-report-show="diagnostics"]') as HTMLButtonElement).click();
  assert.match($("pre.report-preview")!.textContent!, /mcp\.connection_failed[\s\S]*runtimeKind/, "the technical log and the server's part, before sending");
  const area = $("[data-report-message]") as HTMLTextAreaElement;
  area.value = "MCP does not connect"; area.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const box = $('[data-report-include="screenshot"]') as HTMLInputElement;
  box.checked = true; box.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.ok($("img.report-screenshot"), "turning the screenshot on shows it");
  ($("[data-report-send]") as HTMLButtonElement).click();
  await until(() => /Not sent\. Offline\./.test(container.textContent), "failure");
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call => call[0] === "submit")![1])), { reportId, message: "MCP does not connect", include: { diagnostics: true, screenshot: true } });
  ($("[data-report-export]") as HTMLButtonElement).click();
  await until(() => /Saved to a file/.test(container.textContent), "saved");
  failSend = false;
  // Expired diagnostics: refreshed, the text kept, and Send asked again (what is sent is what is shown).
  expired = true;
  ($("[data-report-send]") as HTMLButtonElement).click();
  await until(() => /diagnostics were refreshed/.test(container.textContent), "refreshed");
  assert.equal(($("[data-report-message]") as HTMLTextAreaElement).value, "MCP does not connect");
  assert.equal(($('[data-report-include="screenshot"]') as HTMLInputElement).checked, true);
  ($("[data-report-send]") as HTMLButtonElement).click();
  await until(() => /the report was sent/.test(container.textContent), "sent");
  assert.match(container.textContent, new RegExp(reportId));
});
