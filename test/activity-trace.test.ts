import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { ActivityTrace } from "../src/core/ActivityTrace";
import { ProcessRunRegistry } from "../src/api/ProcessRunRegistry";
import { OpenAICompatibleProvider } from "../src/llm/OpenAICompatibleProvider";
import { Logger } from "../src/utils/Logger";

test("activity coalesces streaming notes, retains tool targets, bounds storage and completes active agents", () => {
  const trace = new ActivityTrace();
  const record = (phase: string, extra = {}) => trace.record({ phase, label: phase, at: new Date().toISOString(), ...extra });
  record("thinking", { note: "a", agentRunId: "one" });
  const original = record("thinking", { note: "ab", agentRunId: "one" });
  assert.equal(original.length, 1); assert.equal(original[0].note, "ab");
  record("tools", { label: "web.fetch", detail: "https://example.com", operationId: "op", agentRunId: "one" });
  const done = record("tool_result", { label: "web.fetch completed", detail: "very long tool output", operationId: "op", agentRunId: "one" });
  assert.equal(done.length, 2); assert.equal(done[1].detail, "https://example.com"); assert.equal(done[1].status, "complete");
  assert.equal(original[0].status, "active", "Published snapshots must be immutable");
  for (let i = 0; i < 80; i++) record("thinking", { label: String(i), note: "x".repeat(8000) });
  const final = record("complete"); assert.equal(final.length, 48);
  assert.ok(final.every(item => item.status !== "active")); assert.ok(final.every(item => !item.note || item.note.length <= 6000));
});

test("status-only updates preserve streamed answer and recorded activity", () => {
  const registry = new ProcessRunRegistry(); registry.start("trace");
  const progress = { phase: "answer", label: "Writing response", at: new Date().toISOString(), answer: "hello", activity: [] };
  registry.update("trace", progress);
  registry.update("trace", { phase: "complete", label: "Complete", at: progress.at });
  assert.equal(registry.get("trace")?.progress?.answer, "hello");
  assert.deepEqual(registry.get("trace")?.progress?.activity, []);
});

test("chat activity escapes model notes and stays collapsed with no invented thinking", () => {
  const context: any = {};
  vm.runInNewContext(fs.readFileSync("public/assets/activity-ui.js", "utf8").replace(/export function/g, "function"), context);
  assert.equal(context.activityLabel({ phase: "generating", label: "Working in project" }), "Waiting for model");
  assert.equal(context.activityLabel({ label: "web.fetch" }), "Reading webpage");
  const html = context.renderChatActivity({ pending: true, activity: [{ id: "1", phase: "thinking", label: "Thinking", note: "<script>alert(1)</script>", status: "active", at: new Date().toISOString(), updatedAt: new Date().toISOString() }] });
  assert.match(html, /Model notes/); assert.doesNotMatch(html, /<script>|<details[^>]* open/);
  assert.match(html, /&lt;script&gt;/);
});

test("live activity time advances without tokens; subsecond events show no misleading zero", () => {
  let now = 300;
  const context: any = { Date: class extends Date { static now() { return now; } } };
  vm.runInNewContext(fs.readFileSync("public/assets/activity-ui.js", "utf8").replace(/export function/g, "function"), context);
  const state = { pending: true, activity: [{ id: "1", phase: "waiting", label: "Waiting for model", status: "active", at: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }] };
  assert.doesNotMatch(context.renderChatActivity(state), />0s</);
  now = 4300;
  assert.equal((context.renderChatActivity(state).match(/>4s<\/time>/g) || []).length, 2);
  assert.doesNotMatch(fs.readFileSync("public/assets/app.js", "utf8"), /esc to stop/);
});

test("local action streaming reports model notes separately and never leaks partial JSON into the answer", async () => {
  const events: any[] = []; const text: string[] = [];
  const provider = new OpenAICompatibleProvider({ id: "llamacpp", name: "Local", baseUrl: "http://127.0.0.1/v1", model: "fixture", timeoutMs: 5000 }, new Logger(), async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).stream, true);
    const chunks = [{ reasoning_content: "Inspecting the provided file." }, { content: '{"type":"final",' }, { content: '"text":"Done"}' }];
    return new Response(chunks.map(delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`).join("") + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  });
  const result = await provider.generateText({ prompt: "Act", outputPurpose: "agent-action", onProgress: event => events.push(event), onTextDelta: delta => text.push(delta) });
  assert.deepEqual(text, []); assert.equal(result.error, undefined);
  assert.match(result.text, /"type":"final"/);
  assert.equal(events.find(event => event.phase === "thinking")?.note, "Inspecting the provided file.");
  assert.equal(events.at(-1).phase, "responding");
});

test("a long turn keeps its first step, so its total time never shrinks", () => {
  const trace = new ActivityTrace();
  const started = new Date(Date.now() - 55 * 60_000).toISOString();
  trace.record({ phase: "preparing", label: "Preparing request", at: started });
  for (let i = 0; i < 80; i++) trace.record({ phase: "tools", label: `step ${i}`, operationId: `op-${i}`, at: new Date().toISOString() });
  const kept = trace.snapshot();
  assert.equal(kept.length, 48);
  assert.equal(kept[0]!.at, started, "the turn's beginning stays");
  assert.equal(kept.at(-1)!.label, "step 79");
  const ui: any = {};
  vm.runInNewContext(fs.readFileSync("public/assets/activity-ui.js", "utf8").replace(/export function/g, "function"), ui);
  const renderChatActivity = ui.renderChatActivity as (options: object) => string;
  const total = (html: string) => /<summary>[\s\S]*?<time>([^<]*)<\/time>/.exec(html)?.[1];
  assert.match(total(renderChatActivity({ activity: kept, pending: true, createdAt: started }))!, /55m|55 min|0?55:/);
  // Sent before its first recorded step: counted from the send.
  const later = [{ ...kept[0]!, at: new Date(Date.now() - 60_000).toISOString() }];
  assert.match(total(renderChatActivity({ activity: later, pending: true, createdAt: started }))!, /55m|55 min|0?55:/);
});
