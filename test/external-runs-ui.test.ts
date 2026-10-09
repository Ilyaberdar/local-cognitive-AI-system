import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, SESSION_ID } from "./fixtures/appHarness";

test("a turn this window did not start shows its question and progress while it runs, then its answer", async () => {
  let running = true;
  const at = "2026-10-09T13:40:00.000Z";
  const h = await bootApp({ route: (_method, url) => {
    if (url === "/process-runs?status=running") return { runs: running ? [{ id: "api-run", sessionId: SESSION_ID, status: "running",
      input: "Build a house in Blender", startedAt: at, progress: { phase: "tools", label: "mcp.call", detail: "blender · execute_blender_code", at } }] : [] };
    if (url === "/process-runs/api-run") return running ? { id: "api-run", sessionId: SESSION_ID, status: "running", progress: { phase: "tools", label: "mcp.call", at } }
      : { id: "api-run", sessionId: SESSION_ID, status: "completed" };
    if (url === `/sessions/${SESSION_ID}/messages`) return running ? [] : [
      { id: "u", role: "user", content: "Build a house in Blender", createdAt: at },
      { id: "a", role: "assistant", content: "The house is built.", createdAt: at }];
    return undefined;
  } });
  try {
    await h.tick(1500);
    const chat = () => h.document.querySelector(".chat-shell")?.textContent ?? h.document.body.textContent;
    assert.match(chat(), /Build a house in Blender/, "the question shows while the turn runs");
    assert.ok(h.document.querySelector(".message.pending"), "with the turn in progress");
    running = false;
    await h.poll();
    assert.match(chat(), /The house is built\./, "the answer once it ends");
    assert.equal(h.document.querySelector(".message.pending"), null);
    await h.tick(1500);
    assert.equal(h.requests.filter(request => request === "GET /process-runs/api-run").length, 1, "an ended turn is not followed again");
  } finally { h.close(); }
});
