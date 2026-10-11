// Shared setup for the Models, Chat and Subagents shots: a fresh profile holding only Qwen3.8-27B
// (an APFS clone, seed.mjs), the app's own API from inside the page, and off-camera preparation
// that the shot list discloses: the model loaded into memory before the take and the chat's
// Effort set to Low (thinking budget 128 tokens instead of 512, so the answer is not preceded by
// half a minute of hidden reasoning).
import fs from "node:fs";
import path from "node:path";
import { launchApp, project } from "./app.mjs";
import { models, seedModels } from "./seed.mjs";

// The model a shot uses; the owner asked for the light Bonsai where two roles share one model.
export let modelId = models.qwen27b;

export async function openProfile(shotId, model = models.qwen27b) {
  modelId = model;
  const profileDir = path.join(project, ".profiles", shotId);
  fs.rmSync(profileDir, { recursive: true, force: true });
  seedModels(profileDir, [modelId]);
  return launchApp({ profile: shotId, theme: "light", fontScale: 115 });
}

export function apiFor(page) {
  return (url, method = "GET", body) => page.evaluate(async ({ url, method, body }) => {
    const response = await fetch(url, {
      method,
      headers: method === "GET" ? {} : { "Content-Type": "application/json", "X-Local-Cognitive": "1" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${method} ${url}: HTTP ${response.status} ${json?.message ?? json?.error ?? ""}`);
    return json;
  }, { url, method, body });
}

export async function preloadModel(page) {
  const api = apiFor(page);
  await api("/local/models/load", "POST", { providerId: "llamacpp", modelId });
  for (let i = 0; i < 240; i++) {
    const runtime = await api("/local/runtime");
    const model = runtime.models.find(each => each.id === modelId);
    if (model?.state === "ready" || model?.loaded) return;
    await page.waitForTimeout(1000);
  }
  throw new Error("model did not load in 4 minutes");
}

// Effort Low on every chat of the profile (a fresh profile has only its "New chat"), then a reload
// so the composer shows it.
export async function setEffortLow(page) {
  const api = apiFor(page);
  const sessions = await api("/sessions");
  const list = Array.isArray(sessions) ? sessions : sessions.sessions ?? sessions.items ?? [];
  if (!list.length) throw new Error("no chat session");
  for (const session of list) await api(`/sessions/${session.id ?? session.sessionId}/settings`, "PUT", { reasoningEffort: "low" });
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.locator('#chat-effort-trigger[aria-label="Effort: Low"]').waitFor({ timeout: 15000 });
}

// Off camera: Models → On device → Use in chat, so the chat starts with the local model selected.
export async function useModelInChat(page) {
  await page.locator('button[data-action="route"][data-route="models"]').click();
  await page.locator("#mm-tab-device").click();
  await page.locator(`article.mm-library-card[data-mm-library-id="${modelId}"] [data-mm-action="use"]`).click();
  await page.locator("#chat-form textarea[name='input']").waitFor({ state: "visible" });
}
