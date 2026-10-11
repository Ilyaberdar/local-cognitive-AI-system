// B: a chat with the local model: the owner's demo prompt, typed for real, answered by Qwen3.8-27B
// on this Mac. Setup off camera (disclosed): the model is loaded before the take, Models → On device
// → Use in chat selects it, and Effort is Low.
//   node scripts/capture/b-chat.mjs
import { startShot } from "./recorder.mjs";
import { openProfile, preloadModel, setEffortLow, useModelInChat } from "./chat-setup.mjs";

const shotId = "B-chat";
const lines = [
  "Summarize these launch notes into three action items:",
  "Maya prepares screenshots by Friday.",
  "Alex verifies the workflow demo.",
  "Sam updates the documentation.",
];

const { app, page } = await openProfile(shotId);
try {
  await preloadModel(page);
  await useModelInChat(page);
  await setEffortLow(page);
  await page.waitForTimeout(1500);

  const shot = await startShot({ app, page, shotId });
  await shot.park(0.55, 0.4, 500);
  await shot.pause(1500);
  await shot.click(page.locator("#chat-form textarea[name='input']"), "composer");
  for (const [index, line] of lines.entries()) {
    await shot.type(line, `type line ${index + 1}`, 42);
    if (index < lines.length - 1) await page.keyboard.press("Shift+Enter");
  }
  await shot.pause(900);
  shot.log("Enter");
  await page.keyboard.press("Enter");
  await shot.park(0.62, 0.3, 900);
  await page.locator(".subagent-pending-line.is-streaming-answer").first().waitFor({ timeout: 180000 });
  shot.log("first text");
  await page.locator("article.message.assistant:not(.pending) .message-footer").first().waitFor({ timeout: 300000 });
  shot.log("answer finished");
  await shot.pause(4500);
  const record = await shot.stop();
  const answer = await page.locator("article.message.assistant:not(.pending)").last().innerText();
  console.log(JSON.stringify({ steps: record.steps.map(s => `${s.step}@${s.ms}`), videoMs: record.videoMs, answer: answer.slice(0, 600) }));
} finally {
  await app.close();
}
