import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import test from "node:test";
import { AgentLoopRunner } from "../src/agents/runtime/AgentLoopRunner";
import { answerStream, finalAnswerSoFar, visibleAnswer } from "../src/llm/AnswerStream";
import { LLMService } from "../src/llm/LLMService";
import { OpenAICompatibleProvider } from "../src/llm/OpenAICompatibleProvider";
import { SessionSettingsStore } from "../src/session/SessionSettingsStore";
import { OperationExecutor } from "../src/tools/OperationExecutor";
import { ExecutionContext, LLMRequest, ProcessProgressEvent } from "../src/types";
import { Logger } from "../src/utils/Logger";

/** Feeds a raw output one character at a time and records every visible text shown. */
const shownWhileWriting = (read: (raw: string) => string | undefined, raw: string) => {
  const shown: string[] = [];
  const stream = answerStream(read, text => shown.push(text));
  for (const char of raw) stream.push(char);
  return shown;
};

test("a final agent answer is shown as it is written, decoded, in every wrapping the agent loop accepts", () => {
  for (const raw of [
    '{"type":"final","text":"Line one\\nСтрока \\"два\\" 😀 \\ud83d\\ude00 done"}',
    '{ "action" : { "type" : "final" , "text" : "Line one\\nСтрока \\"два\\" 😀 \\ud83d\\ude00 done" } }',
    '<think>plan the answer</think>\n```json\n{"type":"final","text":"Line one\\nСтрока \\"два\\" 😀 \\ud83d\\ude00 done"}\n```'
  ]) {
    const shown = shownWhileWriting(finalAnswerSoFar, raw);
    assert.equal(shown.at(-1), "Line one\nСтрока \"два\" 😀 😀 done", raw);
    assert.ok(shown.length > 10, "it grows as the model writes");
    for (let i = 1; i < shown.length; i++) assert.ok(shown[i]!.startsWith(shown[i - 1]!), `only ever extended: ${JSON.stringify(shown[i])}`);
    assert.ok(shown.every(text => !/[\\{}]|"type"|think/.test(text.replace(/"два"/, ""))), "never JSON, escapes or reasoning");
    assert.ok(shown.every(text => !/[\ud800-\udbff]$/.test(text)), "never half of a surrogate pair");
  }
});

test("tool calls, arguments and actions in another key order are never shown", () => {
  for (const raw of [
    '{"type":"tool_call","tool":"file.write","arguments":{"path":"secret.txt","content":"text that is not an answer"}}',
    '{"action":{"type":"tool_call","tool":"command.run","arguments":{"command":"ls","text":"x"}}}',
    '{"text":"An answer before its type","type":"final"}',
    '<think>{"type":"final","text":"reasoning"}'
  ]) assert.deepEqual(shownWhileWriting(finalAnswerSoFar, raw), [], raw);
});

test("a plain answer hides reasoning, markers and file or command blocks while it is written", () => {
  assert.equal(visibleAnswer("<think>secret plan</think>\nHello"), "Hello");
  assert.equal(visibleAnswer("<thi"), "", "a tag that is still arriving");
  assert.equal(visibleAnswer("<think>still thinking"), "");
  assert.equal(visibleAnswer("Run this:\n<<<COMMAND>>>\nrm -rf /tmp/x\n<<<END COMMAND>>>"), "Run this:");
  assert.equal(visibleAnswer("<<<FINAL_OUTPUT>>>\nThe result is 4.\n<<<END_FINAL_OUTPUT>>>"), "The result is 4.");
  assert.equal(visibleAnswer("Use a < b and"), "Use a < b and");
  assert.equal(visibleAnswer("Almost <"), "Almost", "a trailing < may start a marker");
  assert.equal(visibleAnswer("<div>markup is an answer</div>"), "<div>markup is an answer</div>");
});

test("the bundled llama.cpp streams only a final action's text to onFinalAnswer, and nothing to onTextDelta", async () => {
  const run = async (chunks: string[]) => {
    const deltas: string[] = [], answers: string[] = [];
    const provider = new OpenAICompatibleProvider({ id: "llamacpp", name: "Local", baseUrl: "http://127.0.0.1/v1", model: "fixture", timeoutMs: 5000 }, new Logger(), async () =>
      new Response(chunks.map(content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join("") + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } }));
    await provider.generateText({ prompt: "Act", outputPurpose: "agent-action", onProgress: () => undefined, onTextDelta: delta => deltas.push(delta), onFinalAnswer: text => answers.push(text) });
    return { deltas, answers };
  };
  const final = await run(['{"action":{"type":"final",', '"text":"Do', 'ne"}}']);
  assert.deepEqual(final.deltas, []);
  assert.deepEqual(final.answers, ["Do", "Done"]);
  const tool = await run(['{"action":{"type":"tool_call",', '"tool":"file.read","arguments":{"path":"README.md"}}}']);
  assert.deepEqual(tool, { deltas: [], answers: [] });
});

test("a project chat's main agent shows its final answer while writing it, and takes back a step that becomes a tool call", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcai-answer-stream-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const work = await fs.realpath(await fs.mkdir(path.join(root, "project"), { recursive: true }).then(() => path.join(root, "project")));
  await fs.writeFile(path.join(work, "README.md"), "Notes");
  const settings = await new SessionSettingsStore({ baseDir: root }, { providerId: "llamacpp", model: "test" }, {}).get("chat");
  const events: ProcessProgressEvent[] = [];
  const context: ExecutionContext = { actor: { sessionId: "chat", channel: "http" }, memory: [], conversation: [], providerId: "llamacpp", activeTarget: settings.defaultTarget,
    sessionSettings: settings, onProgress: event => events.push(event),
    workspace: { version: 1, kind: "project", projectId: "project", rootPath: work, outputDir: work, allowedDirectories: [work], memoryScope: "project:project" } };
  const operations = new OperationExecutor(root);
  // Step 1 starts like an answer, then turns into a tool call; step 2 is the real answer.
  const steps = [
    { stream: ["Let me ", "check"], data: { type: "tool_call", tool: "file.read", arguments: { path: "README.md" } } },
    { stream: ["The notes ", "say: Notes."], data: { type: "final", text: "The notes say: Notes." } }
  ];
  const llm = { generateObject: async (request: LLMRequest) => {
    const step = steps.shift()!;
    let text = "";
    for (const piece of step.stream) { text += piece; request.onFinalAnswer?.(text); }
    return { data: step.data, response: { provider: "llamacpp", model: "test", text: JSON.stringify(step.data), usage: {} } };
  } } as unknown as LLMService;
  const runner = new AgentLoopRunner(llm, operations, root);
  const result = await runner.run({ id: "main", input: "What do the notes say?", instructions: "", context, target: context.activeTarget, streamAnswer: true });
  assert.equal(result.text, "The notes say: Notes.");
  const answers = events.filter(event => event.phase === "answer").map(event => event.answer);
  assert.deepEqual(answers, ["Let me ", "Let me check", "", "The notes ", "The notes say: Notes."], "the abandoned text is taken back before the tool runs");
  const toolAt = events.findIndex(event => event.phase === "tools"), clearedAt = events.findIndex(event => event.phase === "answer" && event.answer === "");
  assert.ok(clearedAt >= 0 && clearedAt < toolAt, "cleared before the tool call is shown");

  // A research agent (and any run that does not ask for it) shows nothing.
  events.length = 0;
  steps.push({ stream: ["Findings"], data: { type: "final", text: "Findings" } });
  await runner.run({ id: "research", input: "Research", instructions: "", context, target: context.activeTarget, readOnly: true });
  assert.deepEqual(events.filter(event => event.phase === "answer"), []);
});
