// C: a subagent in a chat: Session Setup → Subagents → + → name it "Reviewer" (the model is the
// chat's own Qwen3.5-9B Q8_0 from LM Studio's folder, chosen by the owner: the 27B Q4 needed over
// 8 minutes for the main model's draft alone, and the 1-bit Bonsai-27B's subagent answered by
// repeating its own instructions), then call it with @Reviewer. The live trace shows the main model and the
// subagent taking turns (one model, one llama-server, calls one after another: nothing here claims
// parallel work), and the finished answer carries the subagent's card.
// Setup off camera (disclosed): model loaded before the take, Use in chat, Effort Low.
//   node scripts/capture/c-subagent.mjs
import { startShot } from "./recorder.mjs";
import { openProfile, preloadModel, setEffortLow, useModelInChat } from "./chat-setup.mjs";
import { models } from "./seed.mjs";

const shotId = "C-subagent";
const request = " review these launch notes and point out anything missing: Maya prepares screenshots by Friday. Alex verifies the workflow demo. Sam updates the documentation.";

const { app, page } = await openProfile(shotId, models.qwen35_9b);
let shot = null;
try {
  await preloadModel(page);
  await useModelInChat(page);
  await setEffortLow(page);
  await page.waitForTimeout(1500);

  shot = await startShot({ app, page, shotId });
  await shot.park(0.55, 0.4, 500);
  await shot.pause(1500);
  await shot.click(page.locator('[data-action="add-code-agent"]'), "add subagent");
  const name = page.locator('input[name="codeAgentName:0"]');
  await name.waitFor({ state: "visible" });
  await shot.pause(700);
  await shot.click(name, "name field");
  await page.keyboard.press("Meta+A");
  await shot.type("Reviewer", "type name", 70);
  await page.locator("[data-autosave-status]", { hasText: "Autosaved" }).first().waitFor({ timeout: 15000 });
  shot.log("autosaved");
  await shot.hover(page.locator('select[name="codeAgentModel:0"]'), "subagent model", { moveMs: 700 });
  await shot.pause(1600);

  await shot.click(page.locator("#chat-form textarea[name='input']"), "composer");
  await shot.type("@Rev", "type mention", 90);
  await page.locator(".mention-menu[data-mention-menu] button.mention-item").first().waitFor({ state: "visible", timeout: 10000 });
  shot.log("mention menu");
  await shot.pause(900);
  await page.keyboard.press("Enter");
  shot.log("mention picked");
  await shot.type(request, "type request", 38);
  await shot.pause(800);
  shot.log("Enter");
  await page.keyboard.press("Enter");
  const sentAt = Date.now();

  const trace = page.locator("article.message.pending details.activity-trace > summary").first();
  await trace.waitFor({ state: "visible", timeout: 60000 });
  await shot.pause(1200);
  await shot.click(trace, "open live trace");
  await shot.park(0.62, 0.25, 900);
  const done = page.locator("article.message.assistant:not(.pending) .subagent-card-stack details.subagent-card").first();
  await done.waitFor({ timeout: 10 * 60_000 });
  shot.log("answer seconds", { seconds: Math.round((Date.now() - sentAt) / 1000) });
  shot.log("answer with subagent card");
  await shot.pause(2500);
  await shot.click(done.locator("summary"), "open subagent card");
  await shot.pause(5000);
  const record = await shot.stop();
  const status = await done.locator(".subagent-card__status").innerText().catch(() => "");
  const output = await done.locator(".subagent-card__output").innerText().catch(() => "");
  console.log(JSON.stringify({ steps: record.steps.map(s => `${s.step}@${s.ms}`), videoMs: record.videoMs, status, output: output.slice(0, 500) }));
} catch (error) {
  shot?.abort();
  throw error;
} finally {
  await app.close();
}
