import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require("jsdom");
const bundle = buildSync({ entryPoints: ["public/assets/usage-ui.js"], bundle: true, write: false, format: "iife", globalName: "UsageUi" }).outputFiles[0].text;

const totals = (totalTokens: number, extra: Record<string, number> = {}) => ({ requests: 1, inputTokens: Math.round(totalTokens * 0.8), outputTokens: totalTokens - Math.round(totalTokens * 0.8),
  totalTokens, cachedInputTokens: 0, reasoningTokens: 0, requestsWithoutUsage: 0, ...extra });
const overview = (patch: Record<string, unknown> = {}) => ({
  state: "cloud", timeZone: "Europe/Moscow", from: "2025-10-04", to: "2026-10-09", asOf: "2026-10-09T18:00:00.000Z", ledgerStartedAt: "2026-10-09T10:00:00.000Z",
  firstEventAt: "2026-09-01T10:00:00.000Z", lifetime: totals(1500, { requests: 4, requestsWithoutUsage: 1 }), before: totals(0, { requests: 0 }),
  days: [{ date: "2026-09-01", ...totals(1000) }, { date: "2026-10-05", ...totals(300) }, { date: "2026-10-09", ...totals(200) }],
  sources: [{ id: "here", kind: "local", name: null, here: true, totalTokens: 1500 }], unsentHere: 0, runtimeId: "here", ...patch
});

async function until(check: () => boolean, label: string) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > 2000) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function mount(usage: unknown, remote?: unknown) {
  const dom = new JSDOM('<div id="page"></div>', { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.eval(`${bundle}\nwindow.UsageUi = UsageUi;`);
  const container = dom.window.document.getElementById("page");
  const dispose = dom.window.UsageUi.mountUsagePage(container, { usage, remote });
  return { dom, container, ui: dom.window.UsageUi, dispose, text: () => container.textContent.replace(/\s+/g, " ") };
}

test("periods, Monday weeks and a cumulative line from one year of days", () => {
  const { ui } = mount({ overview: async () => ({ ok: true, value: overview() }) });
  const days = overview().days;
  assert.equal(ui.periodTotals(days, "7d", "2026-10-09").totalTokens, 500);
  assert.equal(ui.periodTotals(days, "month", "2026-10-09").totalTokens, 500);
  assert.equal(ui.periodTotals(days, "30d", "2026-10-09").totalTokens, 500, "1 September is more than 30 days back");
  assert.equal(ui.mondayOf("2026-10-09"), "2026-10-05");
  const weeks = ui.weeklyTotals(days, "2026-10-09", 6);
  assert.deepEqual(JSON.parse(JSON.stringify(weeks.map((week: any) => [week.start, week.totalTokens]))),
    [["2026-08-31", 1000], ["2026-09-07", 0], ["2026-09-14", 0], ["2026-09-21", 0], ["2026-09-28", 0], ["2026-10-05", 500]]);
  const line = ui.cumulativeTotals(days, { totalTokens: 50 }, "2026-10-04", "2026-10-09");
  assert.deepEqual(JSON.parse(JSON.stringify(line.map((point: any) => point.total))), [50, 350, 350, 350, 350, 550], "starts with what came before");
});

test("the page: lifetime, the period, Token Activity, where it ran; a connected server adds its unsent part", async () => {
  const requests: unknown[][] = [];
  const remote = {
    status: async () => ({ ok: true, value: { state: "online", hostId: "host-1", hostName: "fedora", capabilities: ["usage.pending"] } }),
    runtime: { request: async (op: string, payload: unknown, hostId: string) => { requests.push([op, payload, hostId]);
      return { ok: true, value: { available: true, name: "fedora", unsent: 2, lifetime: totals(46, { requests: 2 }), before: totals(0, { requests: 0 }), days: [{ date: "2026-10-09", ...totals(46) }], firstEventAt: "2026-10-09T17:00:00.000Z" } }; } }
  };
  const page = mount({ overview: async () => ({ ok: true, value: overview() }) }, remote);
  await until(() => /Lifetime tokens/.test(page.text()), "page");
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [["usage.pending", { timeZone: "Europe/Moscow", from: "2025-10-04", asOf: "2026-10-09T18:00:00.000Z" }, "host-1"]]);
  const text = page.text();
  assert.match(text, /1,546/, "the lifetime with the server's unsent tokens");
  assert.match(text, /1 request without a token report/);
  assert.match(text, /fedora: 2 not yet sent requests are included/);
  assert.match(text, /This computer\s*1,500/);
  assert.match(text, /fedora\s*46/);
  assert.equal(page.container.querySelectorAll(".usage-heatmap-grid .usage-cell").length, 53 * 7);
  assert.ok(page.container.querySelector('.usage-cell[data-level="4"]'), "the largest day is the darkest");
  (page.container.querySelector('[data-usage-period="month"]') as HTMLElement).click();
  assert.match(page.text(), /546 tokens/);
  (page.container.querySelector('[data-usage-activity="weekly"]') as HTMLElement).click();
  assert.equal(page.container.querySelectorAll("svg.usage-chart rect").length, 26);
  (page.container.querySelector('[data-usage-activity="cumulative"]') as HTMLElement).click();
  assert.ok(page.container.querySelector("svg.usage-chart .usage-line"));
  page.dispose();
});

test("signed out, offline and failing pages say what they show", async () => {
  const local = mount({ overview: async () => ({ ok: true, value: overview({ state: "local", asOf: null, sources: [] }) }) });
  await until(() => /Lifetime/.test(local.text()), "local");
  assert.match(local.text(), /Signed out: this shows only what ran on this computer/);
  const offline = mount({ overview: async () => ({ ok: true, value: overview({ state: "offline", asOf: null, unsentHere: 3, error: "The Cloud answered HTTP 503." }) }) });
  await until(() => /Lifetime/.test(offline.text()), "offline");
  assert.match(offline.text(), /could not be loaded from the Cloud \(The Cloud answered HTTP 503\): this shows only what ran on this computer/);
  assert.match(offline.text(), /3 requests from this computer are not sent yet/);
  const failing = mount({ overview: async () => ({ ok: false, error: { message: "Usage is not recorded on this computer." } }) });
  await until(() => /could not be loaded/.test(failing.text()), "error");
  assert.match(failing.text(), /not recorded on this computer/);
  const hostile = mount({ overview: async () => ({ ok: true, value: overview({ sources: [{ id: "h", kind: "host", name: "<img src=x onerror=alert(1)>", here: false, totalTokens: 1 }] }) }) });
  await until(() => /Lifetime/.test(hostile.text()), "hostile");
  assert.equal(hostile.container.querySelector("img"), null, "names are text");
});
