// D4: a real Synthesis run of the Rate limiter module (the template the Synthesis guide starts
// with) on Qwen3.8-27B through the built-in llama.cpp: contract → Run synthesis → the real sandboxed
// tests → the result. If the run is not Accepted, the result is shown as it is and the run record
// is kept for diagnosis.
//
// Setup (disclosed in handoff/shot-list.md):
// - a fresh profile with only Qwen3.8-27B in it (APFS clone of the owner's file, seed.mjs);
// - context size 16384, because a fresh profile's 4096 tokens is too small for the prompt and the answer;
// - project folder /Users/Shared/Demo/synthesis-rate-limiter with the module created from the
//   template through the app API, as New module does;
// - one line of the flow changed from `max_size = 6GiB` to `16GiB`, so the flow may select the
//   27B model ("Edit selection in the flow to suit your installed models").
//
//   node scripts/capture/d4-synthesis.mjs --rehearse   no recording, prints timings
//   node scripts/capture/d4-synthesis.mjs              the take
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { launchApp, project } from "./app.mjs";
import { startShot } from "./recorder.mjs";
import { models, seedModels } from "./seed.mjs";

const { values } = parseArgs({ options: { rehearse: { type: "boolean", default: false } } });
const shotId = values.rehearse ? "D4-rehearsal" : "D4-synthesis";
const demoFolder = values.rehearse ? "/Users/Shared/Demo/synthesis-rehearsal" : "/Users/Shared/Demo/synthesis-rate-limiter";
const profileDir = path.join(project, ".profiles", shotId);
const evidenceDir = path.join(project, "public", "captures", `${shotId}-evidence`);

fs.rmSync(profileDir, { recursive: true, force: true });
fs.rmSync(demoFolder, { recursive: true, force: true });
fs.mkdirSync(demoFolder, { recursive: true });
seedModels(profileDir, [models.qwen27b]);

const { app, page } = await launchApp({ profile: shotId, theme: "light", fontScale: 115 });
const api = (url, method = "GET", body) => page.evaluate(async ({ url, method, body }) => {
  const response = await fetch(url, {
    method,
    headers: method === "GET" ? {} : { "Content-Type": "application/json", "X-Local-Cognitive": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${method} ${url}: HTTP ${response.status} ${json?.message ?? json?.error ?? ""}`);
  return json;
}, { url, method, body });

try {
  await api("/app/settings", "PUT", { localModels: { contextSize: 16384 } });
  const created = await api("/projects", "POST", { name: "Rate Limiter Demo", rootPath: demoFolder });
  await api(`/synthesis/projects/${created.id}/modules`, "POST", { name: "RateLimiter", template: "rate-limiter", directory: "Synthesis" });
  const flowFile = path.join(demoFolder, "Synthesis", "RateLimiter", "RateLimiter.lcflow");
  const flow = fs.readFileSync(flowFile, "utf8");
  if (!flow.includes("max_size = 6GiB")) throw new Error("the template's flow no longer has max_size = 6GiB");
  fs.writeFileSync(flowFile, flow.replace("max_size = 6GiB", "max_size = 16GiB"));
  const module = await api(`/synthesis/projects/${created.id}/modules/RateLimiter`);
  if (!module.valid) throw new Error(`module not valid: ${JSON.stringify(module.diagnostics ?? module).slice(0, 400)}`);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1500);

  const shot = values.rehearse ? null : await startShot({ app, page, shotId });
  const log = (step, extra) => (shot ? shot.log(step, extra) : console.log(step, extra ?? ""));
  const started = Date.now();
  const click = async (locator, step) => {
    if (shot) await shot.click(locator, step);
    else { await locator.click(); log(step); }
  };

  if (shot) { await shot.park(0.55, 0.45, 500); await shot.pause(1000); }
  await click(page.locator('button[data-action="route"][data-route="synthesis"]'), "open Synthesis");
  const run = page.locator("button.synthesis-run:not([disabled])");
  await run.waitFor({ timeout: 20000 });
  if (shot) { await shot.hover(page.locator('pre.synthesis-source[aria-label="LC Spec source"]'), "the contract", { moveMs: 900 }); await shot.pause(3500); }
  await click(run, "Run synthesis");

  // Follow the run through the API; the screen shows the same events.
  let runId = null;
  let record = null;
  const seen = new Set();
  for (;;) {
    await page.waitForTimeout(1500);
    if (!runId) runId = (await api(`/synthesis/projects/${created.id}/runs`))?.[0]?.id ?? (await api(`/synthesis/projects/${created.id}/runs`))?.runs?.[0]?.id ?? null;
    if (!runId) continue;
    record = await api(`/synthesis/runs/${runId}`);
    for (const event of record.events ?? []) {
      const key = event.sequence ?? `${event.at}-${event.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      log(`event ${event.status}: ${String(event.message ?? event.step ?? "").slice(0, 90)}`, { at: event.at, iteration: event.iteration });
    }
    if (!["queued", "running"].includes(record.status)) break;
    if (Date.now() - started > 30 * 60_000) throw new Error("run still going after 30 minutes");
  }
  log(`finished ${record.status}`, { seconds: Math.round((Date.now() - started) / 1000) });

  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "run.json"), JSON.stringify(record, null, 2));
  try { fs.writeFileSync(path.join(evidenceDir, "diff.json"), JSON.stringify(await api(`/synthesis/runs/${runId}/diff`), null, 2)); } catch (error) { log(`diff: ${error.message}`); }

  if (record.status === "accepted" && shot) {
    await shot.pause(2500);
    const toggle = page.locator("button.synthesis-diagnostics-toggle");
    if (await toggle.isVisible()) await shot.click(toggle, "open Diagnostics");
    await shot.pause(1500);
    const behavior = page.locator("details.synthesis-gate", { has: page.locator("summary strong", { hasText: "behavior" }) });
    if (await behavior.count()) { await shot.click(behavior.locator("summary"), "expand behavior gate"); await shot.pause(3000); }
    await shot.click(page.locator("#synthesis-tab-changes"), "Changes tab");
    await shot.pause(2500);
    await shot.click(page.getByRole("button", { name: "Apply verified patch" }), "Apply verified patch");
    await page.getByText("Applied to project").first().waitFor({ timeout: 20000 });
    log("applied");
    await shot.park(0.7, 0.3, 800);
    await shot.pause(3000);
  } else if (shot) {
    await shot.pause(5000);
  }
  const take = shot ? await shot.stop() : null;
  console.log(JSON.stringify({ status: record.status, runId, seconds: Math.round((Date.now() - started) / 1000), iteration: record.iteration, usage: record.usage, gates: (record.evidence?.gates ?? []).map(g => `${g.id}:${g.status ?? g.result}`), take: take ? { videoMs: take.videoMs } : null }));
} finally {
  await app.close();
}
