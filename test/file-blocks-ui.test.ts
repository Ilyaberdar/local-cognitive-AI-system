import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, SESSION_ID } from "./fixtures/appHarness";

test("a chat's answer that wrote a file shows the file's code under its name, and Copy copies it as Markdown", async () => {
  const at = "2026-10-31T13:40:00.000Z";
  const content = "<<<FILE:notes.txt>>>\nhello from the Mac\n<<<END FILE>>>";
  const h = await bootApp({ route: (_method, url) => url === `/sessions/${SESSION_ID}/messages` ? [
    { id: "u", role: "user", content: "Create a file named notes.txt containing exactly: hello from the Mac", createdAt: at },
    { id: "a", role: "assistant", content, createdAt: at }] : undefined });
  try {
    const answer = h.document.querySelector(".message.assistant, .message:last-of-type");
    assert.doesNotMatch(String(h.document.querySelector(".chat-shell")?.textContent), /<<<|END FILE/);
    assert.equal(h.document.querySelector(".chat-shell .markdown-code__header span")?.textContent, "notes.txt");
    assert.equal(h.document.querySelector(".chat-shell .markdown-code pre code")?.textContent, "hello from the Mac");
    let copied = "";
    Object.defineProperty(h.window.navigator, "clipboard", { value: { writeText: async (value: string) => { copied = value; } }, configurable: true });
    (h.document.querySelector("[data-action='copy-message'][data-message-id='a']") as any).click();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(copied, "notes.txt\n```txt\nhello from the Mac\n```\n");
    assert.ok(answer);
  } finally { h.close(); }
});
