import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { AgentLoopRunner } from "../src/agents/runtime/AgentLoopRunner";
import { OpenAICompatibleProvider } from "../src/llm/OpenAICompatibleProvider";
import { AnthropicProvider } from "../src/llm/AnthropicProvider";
import { GeminiProvider } from "../src/llm/GeminiProvider";
import { OllamaProvider } from "../src/llm/OllamaProvider";
import { LLMRegistry } from "../src/llm/LLMRegistry";
import { LLMService } from "../src/llm/LLMService";
import { OutputSanitizer } from "../src/llm/OutputSanitizer";
import { objectFormat } from "../src/llm/StructuredOutput";
import { agentActionFormat, agentFunctionTools } from "../src/tools/AgentTool";
import { OperationExecutor } from "../src/tools/OperationExecutor";
import { SessionSettingsStore } from "../src/session/SessionSettingsStore";
import { ExecutionContext, ProcessInput } from "../src/types";
import { Logger } from "../src/utils/Logger";
import { CognitiveEngine } from "../src/core/CognitiveEngine";
import { AgentNodeExecutor } from "../src/workflows/nodes/AgentNodeExecutor";
import { ReadFileNodeExecutor } from "../src/workflows/nodes/ReadFileNodeExecutor";
import { EntryNodeExecutor } from "../src/workflows/nodes/EntryNodeExecutor";
import { TerminalNodeExecutor } from "../src/workflows/nodes/TerminalNodeExecutor";
import { NodeExecutorRegistry } from "../src/workflows/nodes/NodeExecutor";
import { WorkflowRunner } from "../src/workflows/WorkflowRunner";
import { WorkflowRunStore } from "../src/workflows/WorkflowRunStore";
import { WorkflowStore } from "../src/workflows/WorkflowStore";
import { FsmEngine } from "../src/workflows/FsmEngine";
import { TaskStore } from "../src/tasks/TaskStore";
import { ProjectStore } from "../src/projects/ProjectStore";
import { SessionIndexStore } from "../src/session/SessionIndexStore";
import { WorkspaceResolver } from "../src/workspace/WorkspaceResolver";
import { WorkflowDefinition } from "../src/workflows/types";

const ids = ["openai", "anthropic", "gemini", "ollama", "lmstudio", "llamacpp"];
const code = 'const value = { path: "C:\\\\temp", quote: "\\\"", unicode: "тест" };\nconsole.log(value);\n';
const final = 'Created the file.\n\n```js\n' + code + '```\n\n| Case | Result |\n|---|---|\n| JSON | preserved |';
const write = { type: "tool_call" as const, tool: "file.write", arguments: { path: "result.js", content: code, expectedVersion: "missing" } };
const finish = { type: "final" as const, text: final };
function payload(id: string, action: typeof write | typeof finish): any {
  if (id === "openai") return { id: "response-1", status: "completed", output: action.type === "tool_call" ? [
    { type: "reasoning", id: "reasoning-1", summary: [], encrypted_content: "opaque-state" },
    { type: "message", role: "assistant", channel: "commentary", content: [{ type: "output_text", text: "I will write the file." }] },
    { type: "function_call", call_id: "call-1", name: "file_write", arguments: JSON.stringify(action.arguments), status: "completed" }
  ] : [
    { type: "message", role: "assistant", channel: "commentary", content: [{ type: "output_text", text: '{"not":"the final JSON"}' }] },
    { type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: action.text }] }
  ] };
  if (id === "anthropic") return { id: "response-1", stop_reason: action.type === "tool_call" ? "tool_use" : "end_turn", content: action.type === "tool_call" ? [
    { type: "text", text: "Writing." }, { type: "tool_use", id: "call-1", name: "file_write", input: action.arguments }
  ] : [{ type: "text", text: action.text }] };
  if (id === "gemini") return { candidates: [{ finishReason: "STOP", content: { role: "model", parts: action.type === "tool_call" ? [
    { functionCall: { id: "call-1", name: "file_write", args: action.arguments }, thoughtSignature: "preserve-this-signature" }
  ] : [{ thought: true, text: "Private reasoning" }, { text: action.text }] } }] };
  const text = JSON.stringify({ action });
  return id === "ollama" ? { response: text } : { choices: [{ message: { role: "assistant", content: text } }] };
}

async function fixture(t: test.TestContext, id: string) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lcai-structured-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const work = path.join(root, "project"); await fs.mkdir(work);
  const options = { baseUrl: "https://provider.test", model: "fixture", timeoutMs: 2000, apiKey: "fixture-key" };
  const logger = new Logger();
  const registry = new LLMRegistry();
  const provider = id === "anthropic" ? new AnthropicProvider({ ...options, version: "2023-06-01", maxTokens: 5000 }, logger)
    : id === "gemini" ? new GeminiProvider(options, logger) : id === "ollama" ? new OllamaProvider(options, logger)
      : new OpenAICompatibleProvider({ ...options, id, name: id }, logger);
  registry.register(provider);
  const llm = new LLMService(registry, id, logger, new OutputSanitizer());
  const settingsStore = new SessionSettingsStore({ baseDir: root }, { providerId: id, model: "fixture" }, {});
  const settings = await settingsStore.get("chat"); settings.defaultAccessMode = "full";
  const context: ExecutionContext = { actor: { sessionId: "chat", channel: "http" }, memory: [], conversation: [], providerId: id,
    activeTarget: settings.defaultTarget, sessionSettings: settings,
    workspace: { version: 1, kind: "project", projectId: "project", rootPath: work, outputDir: work, allowedDirectories: [work], memoryScope: "project:project" } };
  const operations = new OperationExecutor(root);
  const calls: any[] = []; const replies: any[] = [];
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    calls.push({ url: String(url), ...JSON.parse(init.body) });
    assert.ok(replies.length, "Unexpected provider call");
    const next = replies.shift(); return next instanceof Response ? next : Response.json(next);
  });
  const runner = () => new AgentLoopRunner(llm, operations, root);
  const run = (ctx = context) => runner().run({ id: "agent", input: "Create result.js and report the result.", instructions: "", target: ctx.activeTarget, context: ctx });
  return { root, work, llm, registry, operations, settingsStore, context, calls, replies, runner, run };
}

for (const id of ids) test(`${id}: shared agent protocol preserves code, executes once, and returns Markdown`, async t => {
  const f = await fixture(t, id); f.replies.push(payload(id, write), payload(id, finish));
  const result = await f.run();
  assert.equal(result.error, undefined); assert.equal(result.text, final);
  assert.equal(await fs.readFile(path.join(f.work, "result.js"), "utf8"), code);
  assert.equal(result.tools.length, 1); assert.equal(f.calls.length, 2);
  assert.equal((await f.run()).text, final); assert.equal(f.calls.length, 2);
  const first = f.calls[0]; const next = f.calls[1];
  if (id === "openai") {
    assert.equal(first.parallel_tool_calls, false); assert.equal(first.text, undefined);
    assert.ok(first.tools.every((tool: any) => tool.strict === true));
    assert.ok(next.input.some((item: any) => item.type === "function_call_output" && item.call_id === "call-1"));
    assert.ok(next.input.some((item: any) => item.encrypted_content === "opaque-state"));
  } else if (id === "anthropic") {
    assert.equal(first.tool_choice.disable_parallel_tool_use, true);
    assert.equal(first.tools[0].strict, undefined, "Anthropic tools must not receive OpenAI's strict field");
    assert.equal(next.messages.at(-1).content[0].tool_use_id, "call-1");
  } else if (id === "gemini") {
    assert.ok(first.tools[0].functionDeclarations[0].parametersJsonSchema);
    assert.equal(next.contents.at(-2).parts[0].thoughtSignature, "preserve-this-signature");
    assert.equal(next.contents.at(-1).parts[0].functionResponse.name, "file_write");
  } else if (id === "ollama") assert.equal(first.format.properties.action.anyOf.length, 10);
  else { assert.match(first.url, /chat\/completions$/); assert.equal(first.response_format.type, "json_schema"); }
});

test("schema definitions enforce required arguments and reject extra fields", () => {
  const format = agentActionFormat(); assert.equal(format.type, "json_schema");
  if (format.type !== "json_schema") throw new Error("Expected schema");
  const validate = new Ajv({ strict: false }).compile(format.schema);
  assert.equal(validate({ action: write }), true);
  assert.equal(validate({ action: { ...write, arguments: { path: "result.js", content: code } } }), false);
  assert.equal(validate({ action: { type: "final", text: "Done", tool: "file.write" } }), false);
  assert.ok(agentFunctionTools(true).every(tool => tool.action.startsWith("file.") && !tool.action.includes("write")));
});

test("native write approval survives a runner rebuild and preserves tool call identity", async t => {
  const f = await fixture(t, "openai");
  f.context.sessionSettings.defaultAccessMode = "ask";
  f.context.execution = { workspace: f.context.workspace!, accessMode: "ask", agentRunId: "agent", pauseForApproval: true };
  f.replies.push(payload("openai", write));
  const waiting = await f.run(); assert.ok(waiting.pendingApproval);
  await assert.rejects(fs.stat(path.join(f.work, "result.js")));
  f.context.execution.approval = { id: waiting.pendingApproval.id, approved: true };
  f.replies.push(payload("openai", finish));
  assert.equal((await f.run()).error, undefined);
  assert.equal(f.calls.length, 2); assert.equal(await fs.readFile(path.join(f.work, "result.js"), "utf8"), code);
  assert.ok(f.calls[1].input.some((item: any) => item.type === "function_call_output" && item.call_id === "call-1"));
});

test("unsupported local schema downgrades within the same run without replaying an operation", async t => {
  const f = await fixture(t, "lmstudio");
  f.replies.push(Response.json({ error: { message: "json_schema format is not supported by this model" } }, { status: 400 }),
    payload("lmstudio", write), payload("lmstudio", finish));
  assert.equal((await f.run()).error, undefined);
  assert.equal(f.calls[0].response_format.type, "json_schema");
  assert.equal(f.calls[1].response_format.type, "json_object");
  assert.equal(await fs.readFile(path.join(f.work, "result.js"), "utf8"), code);
});

test("native protocol falls back to schema only for explicit unsupported-tool errors", async t => {
  const f = await fixture(t, "openai");
  f.replies.push(Response.json({ error: { message: "Tools are not supported by this model" } }, { status: 400 }),
    { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ action: finish }) }] }] });
  assert.equal((await f.run()).text, final);
  assert.equal(f.calls[1].text.format.type, "json_schema"); assert.equal(f.calls[1].tools, undefined);
});

test("authentication failures never trigger protocol downgrade or automatic resubmission", async t => {
  const f = await fixture(t, "openai"); f.replies.push(Response.json({ error: { message: "Unauthorized" } }, { status: 401 }));
  assert.match((await f.run()).error!, /401/); assert.equal(f.calls.length, 1);
});

test("multiple native calls are rejected without executing any, and diagnostic evidence is saved", async t => {
  const f = await fixture(t, "openai");
  const malformed = payload("openai", write); malformed.output.push({ ...malformed.output.at(-1), call_id: "call-2" });
  f.replies.push(malformed, malformed, malformed);
  assert.match((await f.run()).error!, /multiple calls/);
  await assert.rejects(fs.stat(path.join(f.work, "result.js")));
  const run = (await f.runner().store.get("agent"))!;
  assert.equal(run.repairs, 3); assert.equal(run.turns[0].diagnostic?.responseId, "response-1");
  assert.ok(run.turns[0].diagnostic!.outputTypes.includes("function_call"));
});

test("structured data uses only the final message and preserves the requested schema", async t => {
  const f = await fixture(t, "openai");
  f.replies.push({ output: [
    { type: "message", role: "assistant", channel: "commentary", content: [{ type: "output_text", text: '{"commentary":1}' }] },
    { type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: '{"answer":' }, { type: "output_text", text: '42}' }] }
  ] });
  const format = objectFormat("answer", { answer: { type: "number" } });
  const result = await f.llm.generateObject({ prompt: "Answer", responseFormat: format });
  assert.deepEqual(result.data, { answer: 42 }); assert.deepEqual(f.calls[0].text.format, format);
});

for (const id of ids) test(`${id}: FSM agent node completes and passes its real file to the next node`, async t => {
  const f = await fixture(t, id); f.replies.push(payload(id, write), payload(id, finish));
  const engine = { process: async (input: ProcessInput) => {
    const context = { ...f.context, workspace: input.execution!.workspace, execution: input.execution,
      sessionSettings: { ...f.context.sessionSettings, defaultAccessMode: input.execution!.accessMode! } };
    const result = await f.runner().run({ id: input.execution!.agentRunId!, input: input.input, instructions: "", target: context.activeTarget, context });
    return { providerId: id, result: { response: result.text, error: result.error, model: "fixture" }, tools: result.tools, pendingApproval: result.pendingApproval };
  } } as unknown as CognitiveEngine;
  const tasks = new TaskStore(path.join(f.root, "tasks")); const workflows = new WorkflowStore(path.join(f.root, "workflows"));
  const runs = new WorkflowRunStore(path.join(f.root, "runs"));
  const resolver = new WorkspaceResolver({ appDataDir: f.root }, new ProjectStore(f.root), new SessionIndexStore(f.root));
  const executors = new NodeExecutorRegistry([new EntryNodeExecutor(), new AgentNodeExecutor(engine), new ReadFileNodeExecutor(f.operations), new TerminalNodeExecutor()]);
  const runner = new WorkflowRunner(tasks, workflows, runs, new FsmEngine(), executors, resolver, f.settingsStore);
  const nodes: WorkflowDefinition["nodes"] = [
    { id: "start", type: "entry", label: "Start", config: {}, position: { x: 0, y: 0 } },
    { id: "agent", type: "agent", label: "Agent", config: { providerId: id, model: "fixture", promptTemplate: "Create result.js", approval: "inherit" }, position: { x: 1, y: 0 } },
    { id: "read", type: "file_read", label: "Read", config: { path: "result.js" }, position: { x: 2, y: 0 } },
    { id: "done", type: "terminal", label: "Done", config: { runStatus: "done" }, position: { x: 3, y: 0 } }
  ];
  const graph: WorkflowDefinition = { id: "structured", name: "Structured test", version: 1, entryNodeId: "start", createdAt: "", updatedAt: "", nodes,
    transitions: nodes.slice(0, -1).map((node, index) => ({ id: node.id, from: node.id, to: nodes[index + 1].id, priority: 1, guard: { type: "status", equals: "ok" } })) };
  const run = await runner.startStandalone(graph, { rootPath: f.work, accessMode: "full" });
  assert.equal((await runner.runUntilStopped(run.id)).status, "done");
  const read = (await runs.listNodeRuns(run.id)).find(node => node.nodeId === "read")!;
  assert.equal(read.output?.data.content, code); assert.equal(f.calls.length, 2);
});

for (const id of ["openai", "anthropic", "gemini"]) test(`${id}: a third turn retains both completed native exchanges`, async t => {
  const f = await fixture(t, id);
  const secondWrite = { ...write, arguments: { ...write.arguments, path: "second.js" } };
  const first = payload(id, write); const second = payload(id, secondWrite);
  if (id === "openai") { second.id = "response-2"; second.output[0].id = "reasoning-2"; second.output.at(-1).call_id = "call-2"; }
  if (id === "anthropic") second.content.at(-1).id = "call-2";
  if (id === "gemini") second.candidates[0].content.parts[0].functionCall.id = "call-2";
  f.replies.push(first, second, payload(id, finish));
  assert.equal((await f.run()).error, undefined);
  const next = f.calls[2];
  const history = JSON.stringify(next.input ?? next.messages ?? next.contents);
  assert.ok(history.includes("call-1")); assert.ok(history.includes("call-2"));
  if (id === "openai") assert.equal(next.input.filter((x: any) => x.type === "function_call_output").length, 2);
  if (id === "anthropic") assert.equal(next.messages.filter((x: any) => x.role === "assistant").length, 2);
  if (id === "gemini") assert.equal(next.contents.filter((x: any) => x.role === "model").length, 2);
});

test("a local text-only model can downgrade schema and JSON mode without corrupting code", async t => {
  const f = await fixture(t, "lmstudio");
  f.replies.push(Response.json({error:{message:"json_schema is not supported"}},{status:400}),
    Response.json({error:{message:"json_object is not supported"}},{status:400}),
    payload("lmstudio", write), payload("lmstudio", finish));
  assert.equal((await f.run()).text, final);
  assert.equal(f.calls[2].response_format, undefined);
  assert.match(f.calls[2].url, /chat\/completions$/);
  assert.equal(await fs.readFile(path.join(f.work,"result.js"),"utf8"),code);
});

test("non-agent structured requests also negotiate explicit unsupported schema and JSON modes", async t => {
  const f = await fixture(t, "lmstudio");
  f.replies.push(Response.json({error:{message:"json_schema not supported"}},{status:400}),
    Response.json({error:{message:"json_object not supported"}},{status:400}), {output_text:'{"answer":42}'});
  const result = await f.llm.generateObject({prompt:"Answer",responseFormat:objectFormat("answer",{answer:{type:"number"}})});
  assert.deepEqual(result.data,{answer:42}); assert.equal(f.calls.length,3);
  assert.match(f.calls[2].url, /chat\/completions$/);
});

for (const id of ["openai","lmstudio","ollama"]) test(`${id}: a truncated response cannot execute an otherwise parseable action`, async t => {
  const f=await fixture(t,id);
  const response=payload(id,write);
  if(id==="openai"){response.status="incomplete";response.incomplete_details={reason:"max_output_tokens"};}
  if(id==="lmstudio")response.choices[0].finish_reason="length";
  if(id==="ollama")response.done_reason="length";
  f.replies.push(response);
  assert.ok((await f.run()).error); assert.equal(f.calls.length,1);
  await assert.rejects(fs.stat(path.join(f.work,"result.js")));
});

for(const text of ['{"answer":"wrong type"}', 'Example: {"answer":42}', '{"answer":42} {"answer":99}']) test(`structured data rejects an invalid document: ${text}`,async t=>{
  const f=await fixture(t,"openai");f.replies.push({output_text:text});
  const result=await f.llm.generateObject({prompt:"Answer",responseFormat:objectFormat("answer",{answer:{type:"number"}})});
  assert.equal(result.data,null);assert.match(result.response.error!,/Invalid structured response/);
});

for (const id of ids) test(`${id}: the final permitted turn returns evidence without another tool action`, async t => {
  const f = await fixture(t, id);
  f.replies.push(payload(id, write), payload(id, finish));
  const result = await new AgentLoopRunner(f.llm, f.operations, f.root, { maxSteps: 2 }).run({
    id: "reserved-final", input: "Create result.js and summarize.", instructions: "", target: f.context.activeTarget, context: f.context
  });
  assert.equal(result.error, undefined);
  assert.equal(result.text, final);
  assert.equal(result.tools.length, 1);
  assert.equal(f.calls.length, 2);
});

test("finalization respects an earlier schema downgrade", async t => {
  const f = await fixture(t, "lmstudio");
  f.replies.push(Response.json({ error: { message: "json_schema format is not supported by this model" } }, { status: 400 }),
    payload("lmstudio", write), payload("lmstudio", finish));
  const result = await new AgentLoopRunner(f.llm, f.operations, f.root, { maxSteps: 3 }).run({
    id: "downgraded-final", input: "Create result.js and summarize.", instructions: "", target: f.context.activeTarget, context: f.context
  });
  assert.equal(result.error, undefined);
  assert.equal(result.text, final);
  assert.equal(f.calls[0].response_format.type, "json_schema");
  assert.equal(f.calls[2].response_format.type, "json_object");
  assert.equal(result.tools.length, 1);
});
