import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { processRuntimeInput } from "../src/transports/shared/runtimeActions";
import { deferred, startChatHarness, untilAborted } from "./fixtures/chatHarness";

// Regression contract of the legacy local chat API (spec §7.3 step 1). These tests pin
// current behaviour, including quirks, so the move to durable runs is deliberate.

const usage = { inputTokens: 3, outputTokens: 2, totalTokens: 5 };

test("POST /process in general mode returns the legacy result shape with requestId, sessionId and usage", async (t) => {
  const h = await startChatHarness(t);
  await h.runtime.sessionSettingsStore.update("s-gen", { mode: "general" });
  h.setScript(() => ({ text: "Hello from fixture", usage }));
  const response = await h.call("POST", "/process", { requestId: "r-gen", input: "  Say hello  ", sessionId: "s-gen", providerId: "lmstudio" });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(),
    ["conversationSize", "input", "memory", "mode", "providerId", "requestId", "result", "sessionId", "sessionSettings", "tools"]);
  assert.equal(response.body.requestId, "r-gen");
  assert.equal(response.body.sessionId, "s-gen");
  assert.equal(response.body.input, "Say hello");
  assert.equal(response.body.mode, "general");
  assert.equal(response.body.providerId, "lmstudio");
  assert.equal(h.calls[0]?.providerId, "lmstudio");
  assert.match(response.body.result.response, /Hello from fixture/);
  assert.equal(response.body.result.error, undefined);
  assert.deepEqual(response.body.result.metrics.usage, usage);
  assert.ok(!Number.isNaN(Date.parse(response.body.result.metrics.startedAt)));
  assert.deepEqual(response.body.tools, []);
  assert.equal((await h.waitForRun("r-gen", (run) => run.status !== "running")).status, "completed");
});

test("POST /chat code mode sums usage across the draft and mentioned reviewers", async (t) => {
  const h = await startChatHarness(t);
  await h.runtime.sessionSettingsStore.update("review", { mode: "code", codeAgents: [
    { id: "atlas", name: "Atlas", providerId: "ollama", model: "atlas", accessMode: "default" },
    { id: "nova", name: "Nova", providerId: "ollama", model: "nova", accessMode: "default" }
  ] });
  const plannedDraft = "<<<DRAFT>>>Draft implementation<<<END_DRAFT>>>\n<<<TASK:atlas>>>Check API<<<END_TASK>>>\n<<<TASK:nova>>>Check errors<<<END_TASK>>>";
  h.setScript((request) => ({ usage, text: request.systemPrompt?.includes("only implementation writer") ? plannedDraft
    : request.model === "atlas" || request.model === "nova" ? "Reviewed the implementation." : "function add(a, b) { return a + b; }" }));
  const single = await h.call("POST", "/chat", { requestId: "r-code-1", input: "Show an add function", sessionId: "review" });
  assert.equal(single.status, 200);
  assert.equal(single.body.mode, "code");
  assert.deepEqual(single.body.result.metrics.usage, usage);
  const before = h.calls.length;
  const reviewed = await h.call("POST", "/chat", { requestId: "r-code-2", input: "@Atlas @Nova show an addition function", sessionId: "review" });
  assert.equal(reviewed.status, 200);
  assert.deepEqual(reviewed.body.result.subagents.map((agent: { id: string; status: string }) => [agent.id, agent.status]), [["atlas", "ok"], ["nova", "ok"]]);
  assert.equal(h.calls.length - before, 4);
  assert.deepEqual(reviewed.body.result.metrics.usage, { inputTokens: 12, outputTokens: 8, totalTokens: 20 });
});

test("hypothesis mode returns the debate verdict and summed participant usage", async (t) => {
  const h = await startChatHarness(t);
  await h.runtime.sessionSettingsStore.update("s-debate", { mode: "hypothesis" });
  h.setScript(() => ({ text: JSON.stringify({ summary: "Useful evidence", arguments: ["Strong argument"] }), usage }));
  const response = await h.call("POST", "/chat", { requestId: "r-debate", input: "Should we adopt local memory?", sessionId: "s-debate" });
  assert.equal(response.status, 200);
  assert.equal(response.body.mode, "hypothesis");
  assert.equal(response.body.result.participants.judge, "local");
  assert.ok(response.body.result.arguments.pro.includes("Strong argument"));
  assert.deepEqual(response.body.result.subagents, []);
  assert.deepEqual(response.body.result.metrics.usage, { inputTokens: 6, outputTokens: 4, totalTokens: 10 });
  assert.equal(h.calls.length, 2);
});

test("auto mode routes general, code and debate inputs by the current detector", async (t) => {
  const h = await startChatHarness(t);
  h.setScript((request) => ({ text: request.prompt.includes("Return valid JSON only")
    ? JSON.stringify({ summary: "Evidence", arguments: ["Point"] }) : "Plain answer" }));
  const modes: string[] = [];
  for (const [index, input] of ["Say hello", "Show a TypeScript function", "Should we adopt local memory?"].entries()) {
    const response = await h.call("POST", "/chat", { requestId: `r-auto-${index}`, input, sessionId: "s-auto" });
    assert.equal(response.status, 200);
    modes.push(response.body.mode);
  }
  assert.deepEqual(modes, ["general", "code", "hypothesis"]);
});

test("duplicate requestId is 409 while running and after completion", async (t) => {
  const h = await startChatHarness(t);
  await h.runtime.sessionSettingsStore.update("s-dup", { mode: "general" });
  const entered = deferred(), release = deferred();
  h.setScript(async () => { entered.resolve(); await release.promise; return { text: "done" }; });
  const first = h.call("POST", "/chat", { requestId: "r-dup", input: "Say hello", sessionId: "s-dup" });
  await entered.promise;
  assert.deepEqual(await h.call("POST", "/chat", { requestId: "r-dup", input: "Say hello", sessionId: "s-dup" }),
    { status: 409, body: { error: "Process request id already exists." } });
  release.resolve();
  assert.equal((await first).status, 200);
  assert.equal((await h.call("POST", "/chat", { requestId: "r-dup", input: "Say hello", sessionId: "s-dup" })).status, 409);
  assert.equal(h.calls.length, 1);
});

test("omitted ids are generated; blank input is 400 and leaves a failed run", async (t) => {
  const h = await startChatHarness(t);
  h.setScript(() => ({ text: "Generated ids" }));
  const generated = await h.call("POST", "/chat", { input: "Say hello" });
  assert.equal(generated.status, 200);
  assert.match(generated.body.requestId, /^[0-9a-f-]{36}$/);
  assert.match(generated.body.sessionId, /^[0-9a-f-]{36}$/);

  const calls = h.calls.length;
  const blank = await h.call("POST", "/chat", { requestId: "r-blank", input: "   ", sessionId: "s-blank" });
  assert.deepEqual(blank, { status: 400, body: { error: "Field 'input' must be a non-empty string." } });
  const run = await h.waitForRun("r-blank", () => true);
  assert.equal(run.status, "failed");
  assert.equal(run.error, "Input cannot be empty");
  assert.equal(h.calls.length, calls);
  assert.equal((await h.call("GET", "/sessions")).body.some((session: { id: string }) => session.id === "s-blank"), false);
});

test("a running request exposes progress without its controller", async (t) => {
  const h = await startChatHarness(t);
  await h.runtime.sessionSettingsStore.update("s-progress", { mode: "general" });
  const entered = deferred(), release = deferred();
  h.setScript(async () => { entered.resolve(); await release.promise; return { text: "Finished" }; });
  const pending = h.call("POST", "/chat", { requestId: "r-progress", input: "Say hello", sessionId: "s-progress" });
  await entered.promise;
  const running = await h.waitForRun("r-progress", (run) => Boolean(run.progress));
  assert.equal(running.status, "running");
  assert.equal(running.sessionId, "s-progress");
  assert.equal("controller" in running, false);
  assert.equal(running.approval, undefined);
  release.resolve();
  assert.equal((await pending).status, 200);
  const done = await h.waitForRun("r-progress", (run) => run.status !== "running");
  assert.equal(done.status, "completed");
  assert.equal((await h.call("GET", "/process-runs/unknown")).status, 404);
});

test("explicit cancel aborts the model, answers 499 and persists no turn", async (t) => {
  const h = await startChatHarness(t);
  await h.runtime.sessionSettingsStore.update("s-cancel", { mode: "general" });
  const entered = deferred();
  h.setScript((request) => { entered.resolve(); return untilAborted(request.signal); });
  const pending = h.call("POST", "/chat", { requestId: "r-cancel", input: "Say hello", sessionId: "s-cancel" });
  await entered.promise;
  assert.deepEqual(await h.call("POST", "/process-runs/r-cancel/cancel"), { status: 202, body: { requestId: "r-cancel", cancelled: true } });
  assert.deepEqual(await pending, { status: 499, body: { error: "Request cancelled", requestId: "r-cancel" } });
  assert.equal((await h.waitForRun("r-cancel", () => true)).status, "cancelled");
  assert.equal((await h.call("POST", "/process-runs/r-cancel/cancel")).status, 409);
  assert.equal((await h.call("POST", "/process-runs/missing/cancel")).status, 409);
  assert.deepEqual((await h.call("GET", "/sessions/s-cancel/messages")).body, []);
  // The session index is touched before the engine runs.
  assert.equal((await h.call("GET", "/sessions")).body.some((session: { id: string }) => session.id === "s-cancel"), true);
});

test("client disconnect cancels POST /process (legacy cancel-on-disconnect)", async (t) => {
  const h = await startChatHarness(t);
  await h.runtime.sessionSettingsStore.update("s-disconnect", { mode: "general" });
  const entered = deferred(), modelAborted = deferred();
  h.setScript((request) => {
    entered.resolve();
    request.signal?.addEventListener("abort", () => modelAborted.resolve(), { once: true });
    return untilAborted(request.signal);
  });
  const client = new AbortController();
  const pending = h.call("POST", "/process", { requestId: "r-disconnect", input: "Say hello", sessionId: "s-disconnect" }, client.signal);
  await entered.promise;
  client.abort();
  await assert.rejects(pending);
  await modelAborted.promise;
  assert.equal((await h.waitForRun("r-disconnect", (run) => run.status !== "running")).status, "cancelled");
  assert.deepEqual((await h.call("GET", "/sessions/s-disconnect/messages")).body, []);
});

test("provider errors, empty and legacy mock text are failed turns that run no tools but are saved", async (t) => {
  const h = await startChatHarness(t);
  await h.runtime.sessionSettingsStore.update("s-fail", { mode: "general" });
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ error: "offline" }, /offline/],
    [{ text: "" }, /no usable output/],
    [{ text: "Mock response from ollama." }, /no usable output/]
  ];
  for (const [index, [reply, expected]] of cases.entries()) {
    h.setScript(() => reply);
    const response = await h.call("POST", "/chat", { requestId: `r-fail-${index}`, input: "Create file `fail.txt`", sessionId: "s-fail" });
    assert.equal(response.status, 200);
    assert.match(String(response.body.result.error), expected);
    assert.deepEqual(response.body.tools, []);
    const run = await h.waitForRun(`r-fail-${index}`, (item) => item.status !== "running");
    assert.equal(run.status, "failed");
    assert.equal(run.error, response.body.result.error);
  }
  await assert.rejects(fs.access(path.join(h.outputDir, "fail.txt")));
  const history = (await h.call("GET", "/sessions/s-fail/messages")).body;
  assert.equal(history.length, cases.length * 2);
});

test("a thrown engine error is 500 and leaves a failed run with no saved turn", async (t) => {
  const h = await startChatHarness(t);
  await h.runtime.sessionSettingsStore.update("s-throw", { mode: "general" });
  h.setScript(() => { throw new Error("boom"); });
  const response = await h.call("POST", "/chat", { requestId: "r-throw", input: "Say hello", sessionId: "s-throw" });
  assert.equal(response.status, 500);
  const run = await h.waitForRun("r-throw", (item) => item.status !== "running");
  assert.equal(run.status, "failed");
  assert.equal(run.error, "boom");
  assert.deepEqual((await h.call("GET", "/sessions/s-throw/messages")).body, []);
});

test("session index is created from the input, retitled every turn, and sessionTitle wins", async (t) => {
  const h = await startChatHarness(t);
  await h.runtime.sessionSettingsStore.update("s-title", { mode: "general" });
  h.setScript(() => ({ text: "ok" }));
  const longInput = `Say hello ${"x".repeat(80)}`;
  await h.call("POST", "/chat", { requestId: "r-title-1", input: longInput, sessionId: "s-title" });
  const first = (await h.call("GET", "/sessions")).body.find((session: { id: string }) => session.id === "s-title");
  assert.equal(first.title, longInput.slice(0, 60));
  assert.equal(first.channel, "http");
  await h.call("POST", "/chat", { requestId: "r-title-2", input: "Say goodbye", sessionId: "s-title" });
  const second = (await h.call("GET", "/sessions")).body.find((session: { id: string }) => session.id === "s-title");
  assert.equal(second.title, "Say goodbye");
  assert.ok(second.updatedAt >= first.updatedAt);
  await h.call("POST", "/chat", { requestId: "r-title-3", input: "Say more", sessionId: "s-title", sessionTitle: "Custom" });
  assert.equal((await h.call("GET", "/sessions")).body.find((session: { id: string }) => session.id === "s-title").title, "Custom");
});

test("history returns ordered user/assistant pairs, scoped to the local profile and http channel", async (t) => {
  const h = await startChatHarness(t);
  await h.runtime.sessionSettingsStore.update("s-history", { mode: "general" });
  h.setScript((request) => ({ text: `Answer to ${request.prompt.includes("second") ? "second" : "first"}`, usage }));
  await h.call("POST", "/chat", { requestId: "r-history-1", input: "Say first", sessionId: "s-history" });
  const second = await h.call("POST", "/chat", { requestId: "r-history-2", input: "Say second", sessionId: "s-history", metadata: {
    attachments: [{ id: "a1", name: "notes.txt", mimeType: "text/plain", kind: "text", sizeBytes: 12, textContent: "Remember 42." }]
  } });
  assert.equal(second.status, 200);
  assert.equal(second.body.conversationSize, 1);
  const history = (await h.call("GET", "/sessions/s-history/messages")).body;
  assert.deepEqual(history.map((message: { role: string }) => message.role), ["user", "assistant", "user", "assistant"]);
  assert.match(history[0].id, /:user$/);
  assert.match(history[1].id, /:assistant$/);
  assert.equal(history[0].content, "Say first");
  assert.deepEqual(history[1].metrics.usage, usage);
  assert.equal(history[2].attachments?.[0]?.name, "notes.txt");

  h.setProfile("profile-b");
  assert.deepEqual((await h.call("GET", "/sessions/s-history/messages")).body, []);
  h.setProfile("profile-a");
  // Another transport writes to its own channel; the http history is unchanged.
  await processRuntimeInput(h.manager, h.runtime.sessionIndexStore, { input: "Say from MCP", sessionId: "s-history", userId: "profile-a" }, "mcp");
  assert.equal((await h.call("GET", "/sessions/s-history/messages")).body.length, 4);
  assert.equal((await h.call("GET", "/sessions")).body.find((session: { id: string }) => session.id === "s-history").channel, "mcp");
  assert.equal((await h.call("DELETE", "/sessions/s-history")).status, 200);
  assert.deepEqual((await h.call("GET", "/sessions/s-history/messages")).body, []);
});

test("Ask approval over HTTP: pending operation is visible, wrong reviews are rejected, approve writes once", async (t) => {
  const h = await startChatHarness(t);
  await h.runtime.sessionSettingsStore.update("s-ask", { mode: "general", defaultAccessMode: "ask" });
  h.setScript(() => ({ text: "<<<FILE:approved.txt>>>\nhello\n<<<END FILE>>>" }));
  const pending = h.call("POST", "/chat", { requestId: "r-ask", input: "Create file `approved.txt`", sessionId: "s-ask" });
  const waiting = await h.waitForRun("r-ask", (run) => Boolean(run.approval));
  assert.equal(waiting.progress.phase, "approval");
  assert.equal(waiting.approval.tool, "file");
  assert.match(waiting.approval.details, /hello/);
  await assert.rejects(fs.access(path.join(h.outputDir, "approved.txt")));
  const review = (body: unknown) => h.call("POST", "/process-runs/r-ask/review", body);
  assert.deepEqual(await review({ sessionId: "other", approvalId: waiting.approval.id, approved: true }), { status: 409, body: { accepted: false } });
  assert.equal((await review({ sessionId: "s-ask", approvalId: waiting.approval.id })).status, 400);
  assert.deepEqual(await review({ sessionId: "s-ask", approvalId: waiting.approval.id, approved: true }), { status: 200, body: { accepted: true } });
  assert.equal((await review({ sessionId: "s-ask", approvalId: waiting.approval.id, approved: true })).status, 409);
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.body.tools[0]?.ok, true);
  assert.match(await fs.readFile(path.join(h.outputDir, "approved.txt"), "utf8"), /hello/);
  const done = await h.waitForRun("r-ask", (run) => run.status !== "running");
  assert.equal(done.status, "completed");
  assert.equal(done.approval, undefined);
});

test("Ask denial returns the cancellation text and writes nothing", async (t) => {
  const h = await startChatHarness(t);
  await h.runtime.sessionSettingsStore.update("s-deny", { mode: "general", defaultAccessMode: "ask" });
  h.setScript(() => ({ text: "<<<FILE:denied.txt>>>\nhello\n<<<END FILE>>>" }));
  const pending = h.call("POST", "/chat", { requestId: "r-deny", input: "Create file `denied.txt`", sessionId: "s-deny" });
  const waiting = await h.waitForRun("r-deny", (run) => Boolean(run.approval));
  assert.equal((await h.call("POST", "/process-runs/r-deny/review", { sessionId: "s-deny", approvalId: waiting.approval.id, approved: false })).status, 200);
  const response = await pending;
  assert.equal(response.body.tools[0]?.metadata?.cancelled, true);
  assert.match(response.body.result.response, /File operation cancelled\. No changes were applied\./);
  await assert.rejects(fs.access(path.join(h.outputDir, "denied.txt")));
});

test("cancel while awaiting approval rejects it, answers 499 and never writes", async (t) => {
  const h = await startChatHarness(t);
  await h.runtime.sessionSettingsStore.update("s-ask-cancel", { mode: "general", defaultAccessMode: "ask" });
  h.setScript(() => ({ text: "<<<FILE:never.txt>>>\nhello\n<<<END FILE>>>" }));
  const pending = h.call("POST", "/chat", { requestId: "r-ask-cancel", input: "Create file `never.txt`", sessionId: "s-ask-cancel" });
  const waiting = await h.waitForRun("r-ask-cancel", (run) => Boolean(run.approval));
  assert.equal((await h.call("POST", "/process-runs/r-ask-cancel/cancel")).status, 202);
  assert.equal((await pending).status, 499);
  const run = await h.waitForRun("r-ask-cancel", () => true);
  assert.equal(run.approval, undefined);
  assert.equal((await h.call("POST", "/process-runs/r-ask-cancel/review", { sessionId: "s-ask-cancel", approvalId: waiting.approval.id, approved: true })).status, 409);
  await assert.rejects(fs.access(path.join(h.outputDir, "never.txt")));
});

test("a turn stopped after its agent acted stays in the chat with what was done", { timeout: 30_000 }, async (t) => {
  const h = await startChatHarness(t);
  // An editor's MCP server: the chat then works through the agent loop.
  await h.runtime.mcpClients.reconcile({ servers: { editor: { id: "editor", enabled: true, transport: "stdio", command: process.execPath,
    args: [path.join(__dirname, "fixtures", "mcpEditorLike.js")] } }, bindings: { editor: { id: "editor", serverId: "editor", enabled: true } } });
  t.after(() => h.runtime.mcpClients.reconcile({ servers: {}, bindings: {} }));
  await h.runtime.sessionSettingsStore.update("s-stopped", { mode: "general" });
  const second = deferred();
  let agentCalls = 0;
  h.setScript((request) => {
    if (request.outputPurpose !== "agent-action") return { text: "" };
    if (++agentCalls === 1) return { text: JSON.stringify({ type: "tool_call", tool: "mcp.call", arguments: { toolId: "mcp:editor:ok", argumentsJson: "{}" } }) };
    second.resolve();
    return untilAborted(request.signal);
  });
  const pending = h.call("POST", "/chat", { requestId: "r-stopped", input: "Build the scene", sessionId: "s-stopped" });
  const waiting = await h.waitForRun("r-stopped", run => Boolean(run.approval));
  assert.equal((await h.call("POST", "/process-runs/r-stopped/review", { sessionId: "s-stopped", approvalId: waiting.approval.id, approved: true })).status, 200);
  await second.promise;
  await h.call("POST", "/process-runs/r-stopped/cancel");
  assert.equal((await pending).status, 499);
  const messages = (await h.call("GET", "/sessions/s-stopped/messages")).body as Array<{ role: string; content: string }>;
  assert.equal(messages.find(message => message.role === "user")?.content, "Build the scene");
  assert.match(messages.find(message => message.role === "assistant")?.content ?? "", /Stopped before the answer\. Completed actions: editor · ok\./);
});
