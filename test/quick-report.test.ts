import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildSync } from "esbuild";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require("jsdom");
const bundle = buildSync({ entryPoints: ["public/assets/quick-report.js"], bundle: true, write: false, format: "iife", globalName: "QuickReport" }).outputFiles[0].text;

async function until(check: () => boolean, label: string) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > 2000) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test("the bug button's form: a field and Send; diagnostics as error reports allow; More options opens the full page", async t => {
  const dom = new JSDOM('<button id="anchor"></button>', { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  // jsdom has no popovers: opening and closing are enough here.
  dom.window.HTMLElement.prototype.showPopover = function () { this.dataset.open = "1"; };
  dom.window.HTMLElement.prototype.hidePopover = function () { delete this.dataset.open; };
  dom.window.eval(`${bundle}\nwindow.QuickReport = QuickReport;`);
  const reportId = randomUUID();
  const calls: unknown[][] = [];
  let more = 0, consent = false, fail = false;
  const bridge = {
    prepare: async (request: unknown) => { calls.push(["prepare", request]); return { ok: true, value: { reportId, diagnosticsByDefault: consent, sendAvailable: true, diagnostics: {} } }; },
    submit: async (form: unknown) => { calls.push(["submit", form]); return fail ? { ok: false, error: { message: "Offline." } } : { ok: true, value: { reportId } }; },
    export: async (form: unknown) => { calls.push(["export", form]); return { ok: true, value: { saved: true } }; }
  };
  const quick = dom.window.QuickReport.createQuickReport({ bridge, mode: () => "remote", onMore: () => { more++; } });
  quick.open(dom.window.document.getElementById("anchor"));
  const panel = dom.window.document.querySelector(".quick-report");
  const $ = (selector: string) => panel.querySelector(selector);
  assert.equal(quick.isOpen(), true);
  assert.equal(panel.querySelectorAll("textarea, input").length, 1, "one field");
  await until(() => /Only your text is sent/.test($("[data-quick-status]").textContent), "the note");
  assert.equal(($("[data-quick-send]") as HTMLButtonElement).disabled, true);
  const area = $("[data-quick-message]") as HTMLTextAreaElement;
  area.value = "The chat froze"; area.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  fail = true;
  ($("[data-quick-send]") as HTMLButtonElement).click();
  await until(() => /Not sent\. Offline\./.test($("[data-quick-status]").textContent), "failure");
  assert.equal(($("[data-quick-export]") as HTMLButtonElement).hidden, false, "a file when sending fails");
  fail = false;
  ($("[data-quick-send]") as HTMLButtonElement).click();
  await until(() => /Sent\. Thank you/.test($("[data-quick-status]").textContent), "sent");
  const sent = calls.filter(call => call[0] === "submit").map(call => JSON.parse(JSON.stringify(call[1])));
  assert.deepEqual(sent.at(-1), { reportId, message: "The chat froze", include: { diagnostics: false, screenshot: false } });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ["prepare", { mode: "remote" }]);
  // With error reports allowed, diagnostics go along.
  consent = true;
  quick.open(dom.window.document.getElementById("anchor"));
  await until(() => /Diagnostics go along/.test($("[data-quick-status]").textContent), "consent note");
  ($("[data-quick-more]") as HTMLButtonElement).click();
  assert.equal(more, 1);
  assert.equal(quick.isOpen(), false);
});
