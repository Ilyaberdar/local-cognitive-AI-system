// A: Models → Catalog → a model's card and its memory estimate (View model; nothing is downloaded)
// → On device → the installed Qwen3.8-27B → Use in chat. The catalog's Recommended list is a local
// file, so no network is needed; the On device card's memory label is computed live from this Mac's
// free memory at the time of the take.
//   node scripts/capture/a-models.mjs
import { startShot } from "./recorder.mjs";
import { modelId, openProfile } from "./chat-setup.mjs";

const shotId = "A-models";
const catalogModel = "Qwen/Qwen2.5-1.5B-Instruct-GGUF";

const { app, page } = await openProfile(shotId);
try {
  await page.waitForTimeout(1500);
  const shot = await startShot({ app, page, shotId });
  await shot.park(0.55, 0.42, 500);
  await shot.pause(1200);
  await shot.click(page.locator('button[data-action="route"][data-route="models"]'), "open Models");
  const details = page.locator(`[data-mm-action="details"][data-mm-id="${catalogModel}"]`);
  await details.waitFor({ state: "visible", timeout: 20000 });
  await shot.pause(1200);
  await shot.hover(details.locator("xpath=ancestor::article[1]").locator("h3"), "catalog card", { moveMs: 800 });
  await shot.pause(1800);
  await shot.click(details, "View model");
  const metrics = page.locator("#mm-detail-dialog .mm-variant-metrics");
  await metrics.waitFor({ state: "visible", timeout: 15000 });
  await shot.pause(800);
  await shot.hover(metrics, "memory estimate", { moveMs: 700 });
  await shot.pause(4200);
  shot.log("close dialog");
  await page.keyboard.press("Escape");
  await shot.pause(900);
  await shot.click(page.locator("#mm-tab-device"), "On device");
  const card = page.locator(`article.mm-library-card[data-mm-library-id="${modelId}"]`);
  await card.waitFor({ state: "visible" });
  await shot.pause(900);
  await shot.hover(card.locator(".mm-memory-estimate"), "installed model", { moveMs: 800 });
  await shot.pause(3500);
  await shot.click(card.locator('[data-mm-action="use"]'), "Use in chat");
  await page.locator("#chat-form textarea[name='input']").waitFor({ state: "visible" });
  shot.log("chat open");
  await shot.pause(800);
  await shot.hover(page.locator(".chat-activity-bar .activity-model"), "model in the composer", { moveMs: 800 });
  await shot.pause(3500);
  const record = await shot.stop();
  const label = await page.evaluate(() => document.querySelector(".chat-activity-bar .activity-model")?.textContent?.trim());
  console.log(JSON.stringify({ steps: record.steps.map(s => `${s.step}@${s.ms}`), videoMs: record.videoMs, composerModel: label }));
} finally {
  await app.close();
}
