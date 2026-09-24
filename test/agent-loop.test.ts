import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import test from "node:test";
import { AgentLoopRunner } from "../src/agents/runtime/AgentLoopRunner";
import { OperationExecutor } from "../src/tools/OperationExecutor";
import { ExecutionContext, LLMRequest, ProcessProgressEvent } from "../src/types";
import { SessionSettingsStore } from "../src/session/SessionSettingsStore";
import { LLMService } from "../src/llm/LLMService";
import { LLMRegistry } from "../src/llm/LLMRegistry";
import { OutputSanitizer } from "../src/llm/OutputSanitizer";
import { Logger } from "../src/utils/Logger";
import { CodeAgentCoordinator } from "../src/agents/code/CodeAgentCoordinator";
import { defaultAgentLimits, readAgentLimits } from "../src/agents/runtime/AgentLimits";

const digest=(text:string)=>createHash("sha256").update(text).digest("hex");
async function fixture(t:test.TestContext){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"lcai-agent-loop-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let work=path.join(root,"project");await fs.mkdir(work);work=await fs.realpath(work);
  const settings=await new SessionSettingsStore({baseDir:root},{providerId:"fixture",model:"test"},{}).get("chat");
  const context:ExecutionContext={actor:{sessionId:"chat",channel:"http"},memory:[],conversation:[],providerId:"fixture",activeTarget:settings.defaultTarget,sessionSettings:settings,
    workspace:{version:1,kind:"project",projectId:"project",rootPath:work,outputDir:work,allowedDirectories:[work],memoryScope:"project:project"}};
  const operations=new OperationExecutor(root);
  const calls:string[]=[];
  let turns:Array<Record<string,unknown>|((prompt:string)=>Record<string,unknown>)>=[];
  const llm={generateObject:async(request:{prompt:string})=>{
    calls.push(request.prompt);
    const next=turns.shift();assert.ok(next,"Unexpected model call");
    const data=typeof next==="function"?next(request.prompt):next;
    return {data,response:{provider:"fixture",model:"test",text:JSON.stringify(data),usage:{totalTokens:10}}};
  }} as unknown as LLMService;
  const run=(id="agent",ctx=context)=>new AgentLoopRunner(llm,operations,root).run({id,input:"Inspect this project, fix the number and verify it.",instructions:"",context:ctx,target:ctx.activeTarget});
  const set=(values:typeof turns)=>{turns=values;};
  return {root,work,context,operations,calls,set,run,llm};
}
const action=(tool:string,args:Record<string,unknown>)=>({type:"tool_call",tool,arguments:args});

test("workspace agent forwards model loading phases and live tool output with operation identity", async t => {
  const f = await fixture(t);
  const events: ProcessProgressEvent[] = [];
  f.context.onProgress = event => events.push(event);
  f.context.sessionSettings.defaultAccessMode = "full";
  let calls = 0;
  const llm = { generateObject: async (request: LLMRequest) => {
    for (const phase of ["queued", "loading", "generating"] as const) request.onProgress?.({ phase, model: "test-model", queuePosition: phase === "queued" ? 2 : undefined });
    const data = calls++ === 0 ? action("command.run", { executable: process.execPath, args: ["-e", "console.log('live agent output')"], cwd: ".", timeoutMs: 2000 }) : { type: "final", text: "Verified." };
    return { data, response: { provider: "fixture", model: "test", text: JSON.stringify(data), usage: {} } };
  } } as unknown as LLMService;
  const result = await new AgentLoopRunner(llm, f.operations, f.root).run({ id: "live-agent", input: "Run a command", instructions: "", context: f.context, target: f.context.activeTarget });
  assert.equal(result.error, undefined);
  assert.deepEqual(events.filter(event => event.agentRunId === "live-agent" && ["Waiting for model", "Loading model", "Generating"].includes(event.label)).map(event => event.phase), ["queued", "loading", "generating", "queued", "loading", "generating"]);
  assert.match(events.find(event => event.phase === "queued")!.detail!, /queue position 2/);
  const output = events.find(event => event.output?.text.includes("live agent output"));
  assert.equal(output?.output?.stream, "stdout"); assert.equal(output?.agentRunId, "live-agent"); assert.ok(output?.operationId);
  const completed = events.find(event => event.phase === "tool_result");
  assert.equal(completed?.label, "command.run completed");
  assert.equal(completed?.operationId, output?.operationId);
  assert.match(completed?.detail ?? "", /live agent output/);
});

test("activity reports tool errors and format corrections without changing execution", async t => {
  const f = await fixture(t);
  const events: ProcessProgressEvent[] = [];
  f.context.onProgress = event => events.push(event);
  f.context.sessionSettings.defaultAccessMode = "full";
  f.set([action("file.read", { path: "missing.txt" }), { type: "invalid" }, { type: "final", text: "The file is missing." }]);
  const result = await f.run();
  assert.equal(result.error, undefined);
  assert.equal(events.find(event => event.phase === "tool_error")?.label, "file.read failed");
  assert.match(events.find(event => event.phase === "correction")?.detail ?? "", /Correction 1\/3/);
});

test("agent consumes list/read results, changes the observed version and verifies actual files before final",async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.work,"value.txt"),"number=1\n");
  f.set([action("file.list",{path:"."}),action("file.read",{path:"value.txt"}),prompt=>{
    assert.match(prompt,/number=1/);assert.match(prompt,new RegExp(digest("number=1\n")));
    return action("file.replace",{path:"value.txt",oldText:"number=1",newText:"number=2",expectedVersion:digest("number=1\n")});
  },action("file.read",{path:"value.txt"}),prompt=>{assert.match(prompt,/number=2/);return {type:"final",text:"Updated and verified number=2."};}]);
  const result=await f.run();assert.equal(result.error,undefined);assert.equal(result.tools.length,4);assert.equal(result.usage.totalTokens,50);
  assert.equal(await fs.readFile(path.join(f.work,"value.txt"),"utf8"),"number=2\n");
  const again=await f.run();assert.equal(again.text,result.text);assert.equal(f.calls.length,5);
});

test("saved agent pauses after reads and resumes the exact write after restart without repeating earlier calls",async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.work,"value.txt"),"old");
  f.context.sessionSettings.defaultAccessMode="ask";
  f.context.execution={workspace:f.context.workspace!,accessMode:"ask",agentRunId:"agent",pauseForApproval:true};
  f.set([action("file.read",{path:"value.txt"}),action("file.write",{path:"value.txt",content:"new",expectedVersion:digest("old")})]);
  const waiting=await f.run();assert.ok(waiting.pendingApproval);assert.equal(await fs.readFile(path.join(f.work,"value.txt"),"utf8"),"old");
  f.context.execution.approval={id:waiting.pendingApproval.id,approved:true};
  f.set([action("file.read",{path:"value.txt"}),{type:"final",text:"Written and checked."}]);
  const resumed=await f.run();assert.equal(resumed.error,undefined);assert.equal(resumed.tools.length,3);assert.equal(f.calls.length,4);
  assert.equal(await fs.readFile(path.join(f.work,"value.txt"),"utf8"),"new");
});

test("denial is returned to the model, malformed actions never execute and version conflicts preserve external edits",async t=>{
  const f=await fixture(t);f.context.sessionSettings.defaultAccessMode="ask";f.context.requestApproval=async()=>false;
  f.set([action("file.write",{path:"file.txt",content:"no",expectedVersion:"missing"}),prompt=>{
    assert.match(prompt,/Cancelled/);return {type:"final",text:"The requested action was declined."};}]);
  await f.run();await assert.rejects(fs.stat(path.join(f.work,"file.txt")));
  f.context.sessionSettings.defaultAccessMode="default";
  await fs.writeFile(path.join(f.work,"file.txt"),"other change");
  f.set([action("file.write",{path:"file.txt",content:"bad",expectedVersion:digest("old")}),prompt=>{
    assert.match(prompt,/version conflict/);return {type:"final",text:"File changed; preserved it."};}]);
  await f.run("conflict");assert.equal(await fs.readFile(path.join(f.work,"file.txt"),"utf8"),"other change");
  f.set([action("file.write",{path:"bad.txt",content:"bad"}),action("file.write",{path:"bad.txt",content:"bad"}),action("file.write",{path:"bad.txt",content:"bad"})]);
  assert.match((await f.run("invalid")).error!,/valid next action/);await assert.rejects(fs.stat(path.join(f.work,"bad.txt")));
});

test("external and symlink reads wait for approval and unknown effects are never replayed",async t=>{
  const f=await fixture(t);const outside=path.join(f.root,"external.txt");await fs.writeFile(outside,"private");
  await fs.symlink(outside,path.join(f.work,"link.txt"));
  const args={id:"read-external",agentRunId:"run",workspace:f.context.workspace!,accessMode:"default" as const,tool:"file.read",arguments:{path:"link.txt"},pauseForApproval:true};
  const waiting=await f.operations.execute(args);assert.ok(waiting.pendingApproval);assert.equal(waiting.result,undefined);
  const approved=await f.operations.execute({...args,approval:{id:waiting.pendingApproval.id,approved:true}});assert.match(approved.result!.output,/private/);
  const pending=await f.operations.execute({...args,id:"unknown-write",tool:"file.write",accessMode:"ask",arguments:{path:"new.txt",content:"no replay",expectedVersion:"missing"}});
  assert.ok(pending.pendingApproval);
  const saved=await f.operations.store.get("unknown-write");saved!.status="executing";await f.operations.store.save(saved!);
  const unknown=await f.operations.execute({...args,id:"unknown-write",tool:"file.write",accessMode:"ask",arguments:{path:"new.txt",content:"no replay",expectedVersion:"missing"},approval:{id:"unknown-write",approved:true}});
  assert.equal(unknown.result?.metadata?.unknown,true);await assert.rejects(fs.stat(path.join(f.work,"new.txt")));
});

test("file errors enter the next model turn and readonly advisers cannot write",async t=>{
  const f=await fixture(t);
  f.set([action("file.read",{path:"missing.txt"}),prompt=>{assert.match(prompt,/ENOENT/);return {type:"final",text:"File is missing."};}]);
  assert.equal((await f.run()).error,undefined);
  const outcome=await f.operations.execute({id:"adviser",agentRunId:"adviser",workspace:f.context.workspace!,accessMode:"full",tool:"file.write",arguments:{path:"new.txt",content:"not allowed",expectedVersion:"missing"},readOnly:true});
  assert.equal(outcome.result?.ok,false);await assert.rejects(fs.stat(path.join(f.work,"new.txt")));
});

test("agent actions embedded in prose are rejected even when generic JSON extraction finds a valid tool call", async t => {
  const f = await fixture(t);
  const write = action("file.write", { path: "must-not-execute.txt", content: "unapproved example", expectedVersion: "missing" });
  const json = JSON.stringify(write);
  const malformed = [`Answer: ${json}`, `Example only, do not execute:\n${json}`, `${json}\nAdditional explanation outside JSON.`];
  const requests: string[] = [];
  const registry = new LLMRegistry();
  registry.register({ id: "fixture", name: "Fixture", defaultModel: "test", isConfigured: () => true,
    getDescriptor: () => ({ id: "fixture", name: "Fixture", defaultModel: "test", configured: true }),
    generateText: async request => {
      assert.equal(request.outputPurpose, "agent-action");
      requests.push(request.prompt);
      const text = malformed.shift(); assert.ok(text, "Malformed actions must exhaust their bounded repair budget.");
      return { provider: "fixture", model: "test", text };
    }
  });
  const llm = new LLMService(registry, "fixture", new Logger(), new OutputSanitizer());
  const generateObject = llm.generateObject.bind(llm);
  t.mock.method(llm, "generateObject", async (...args: Parameters<typeof llm.generateObject>) => {
    const result = await generateObject(...args);
    assert.deepEqual(result.data, write, "This specifically exercises the permissive generic JSON extractor boundary.");
    return result;
  });
  const result = await new AgentLoopRunner(llm, f.operations, f.root).run({ id: "mixed-prose", input: "Inspect the project.",
    instructions: "", context: f.context, target: f.context.activeTarget });
  assert.match(result.error!, /valid next action after three corrections/);
  assert.equal(result.tools.length, 0);
  assert.equal(requests.length, 3);
  assert.match(requests[1], /FORMAT_ERROR/);
  await assert.rejects(fs.stat(path.join(f.work, "must-not-execute.txt")), { code: "ENOENT" });
});

test("a huge latest tool result stays visible with truncation and error evidence in the next model turn", async t => {
  const f = await fixture(t);
  f.context.sessionSettings.defaultAccessMode = "full";
  f.set([
    action("command.run", { executable: process.execPath, args: ["-e",
      "process.stdout.write('HEAD-EVIDENCE\\n' + 'x'.repeat(60_000) + '\\nTAIL-EVIDENCE'); process.stderr.write('VERIFICATION-FAILED-73'); process.exitCode = 73;"], cwd: "." }),
    prompt => {
      assert.match(prompt, /USER TASK:\nInspect this project/);
      assert.match(prompt, /RESULT: /, "The newest oversized result must never be discarded as a whole.");
      assert.match(prompt, /HEAD-EVIDENCE/);
      assert.match(prompt, /TAIL-EVIDENCE/);
      assert.match(prompt, /OUTPUT TRUNCATED: middle omitted/);
      assert.match(prompt, /VERIFICATION-FAILED-73/);
      assert.match(prompt, /"ok":false/);
      assert.ok(prompt.length < 50_000, "Transcript must remain bounded after retaining the latest tool's evidence.");
      return { type: "final", text: "The verification failed with exit code 73; inspect the reported error." };
    }
  ]);
  const result = await f.run("large-result");
  assert.equal(result.error, undefined);
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].ok, false);
  assert.equal(result.tools[0].metadata?.exitCode, 73);
  assert.match(result.tools[0].output, /VERIFICATION-FAILED-73/);
  assert.ok(result.tools[0].output.length > 48_000, "The stored trace retains the actual tool output independently of prompt truncation.");
  assert.equal(f.calls.length, 2);
});

test("the combined advisor/main budget survives approval and restart without regaining consumed steps", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.work, "value.txt"), "old");
  f.context.sessionSettings.defaultAccessMode = "ask";
  f.context.sessionSettings.codeAgents = [{ id: "reviewer", name: "Reviewer", providerId: "fixture", model: "test", accessMode: "full" }];
  f.context.execution = { workspace: f.context.workspace!, accessMode: "ask", agentRunId: "combined", pauseForApproval: true };
  f.set([{ type: "final", text: "Inspect value.txt." }, action("file.read", { path: "value.txt" }),
    action("file.write", { path: "value.txt", content: "new", expectedVersion: digest("old") })]);
  const first = new CodeAgentCoordinator(new AgentLoopRunner(f.llm, f.operations, f.root, { maxTotalSteps: 3 }));
  const fallback = async () => { throw new Error("The code coordinator must use its loop."); };
  const waiting = await first.run("@Reviewer fix value.txt", "code", f.context, fallback);
  assert.ok(waiting.pendingApproval);
  assert.equal(f.calls.length, 3);
  f.context.execution.approval = { id: waiting.pendingApproval.id, approved: true };
  f.set([]);
  // Raising a server ceiling does not silently increase an already-created run's budget.
  const resumed = await new CodeAgentCoordinator(new AgentLoopRunner(f.llm, f.operations, f.root, { maxTotalSteps: 20 }))
    .run("@Reviewer fix value.txt", "code", f.context, fallback);
  assert.match(resumed.result.error!, /total step limit \(3\)/);
  assert.equal(f.calls.length, 3);
  assert.equal(resumed.tools.length, 2);
  assert.equal(resumed.result.metrics?.usage?.totalTokens, 30);
  assert.equal(await fs.readFile(path.join(f.work, "value.txt"), "utf8"), "new");
});

test("the durable shared active-time budget excludes time spent waiting for permission", async t => {
  const f = await fixture(t);
  let now = 10_000;
  let generationMs = 125;
  const timeouts: number[] = [];
  t.mock.method(Date, "now", () => now);
  const original = f.llm.generateObject.bind(f.llm);
  t.mock.method(f.llm, "generateObject", async (request: LLMRequest, providerId?: string) => {
    timeouts.push(request.timeoutMs!);
    const generated = await original(request, providerId);
    now += generationMs;
    return generated;
  });
  f.context.sessionSettings.defaultAccessMode = "ask";
  f.context.requestApproval = async () => { now += 600_000; return true; };
  f.set([action("file.write", { path: "approved.txt", content: "yes", expectedVersion: "missing" }), { type: "final", text: "Saved." }]);
  const runner = new AgentLoopRunner(f.llm, f.operations, f.root, { maxActiveMs: 1_000 });
  const request = { input: "Use the workspace.", instructions: "", context: f.context, target: f.context.activeTarget, budgetId: "timed" };
  assert.equal((await runner.run({ ...request, id: "timed:agent:first" })).error, undefined);
  assert.equal((await runner.store.get("timed:agent:first"))?.activeMs, 250);
  generationMs = 750;
  f.set([{ type: "final", text: "Finished analysis." }]);
  const restarted = new AgentLoopRunner(f.llm, f.operations, f.root, { maxActiveMs: 1_000 });
  assert.equal((await restarted.run({ ...request, id: "timed:agent:second" })).error, undefined);
  assert.deepEqual(timeouts, [1_000, 875, 750]);
  f.set([]);
  assert.match((await restarted.run({ ...request, id: "timed:agent:main" })).error!, /active generation time limit/);
  assert.equal(f.calls.length, 3);
});

test("agent thinking budget reaches inference and timeout reports its actual cause", async t => {
  const f = await fixture(t);
  f.context.execution = { workspace: f.context.workspace!, accessMode: "default", agentRunId: "timeout", localReasoningBudget: 0 };
  t.mock.method(f.llm, "generateObject", async (request: LLMRequest) => {
    assert.equal(request.localReasoningBudget, 0);
    return new Promise((_resolve, reject) => request.signal!.addEventListener("abort", () => reject(new Error("Request cancelled")), { once: true }));
  });
  const result = await new AgentLoopRunner(f.llm, f.operations, f.root, { maxActiveMs: 1000 }).run({
    id: "timeout", input: "Read files", instructions: "", context: f.context, target: f.context.activeTarget
  });
  assert.match(result.error!, /active generation time limit \(1000 ms\)/);
});

test("configured context and correction limits bound generation while preserving the explicit maxSteps override", async t => {
  const f = await fixture(t);
  const runner = new AgentLoopRunner(f.llm, f.operations, f.root, { contextChars: 8_192, maxRepairs: 1, maxSteps: 5 });
  const request = { input: "Read the project file.", instructions: "reference data ".repeat(4_000), context: f.context, target: f.context.activeTarget };
  f.set([{ type: "tool_call", tool: "file.write", arguments: { path: "invalid.txt", content: "missing version" } }]);
  assert.match((await runner.run({ ...request, id: "one-repair" })).error!, /after 1 corrections/);
  assert.equal(f.calls.length, 1);
  const original = f.llm.generateObject.bind(f.llm);
  t.mock.method(f.llm, "generateObject", async (input: LLMRequest, providerId?: string) => {
    assert.ok(input.prompt.length + (input.systemPrompt?.length ?? 0) <= 8_192);
    assert.match(input.systemPrompt!, /SUPPORTING CONTEXT TRUNCATED/);
    return original(input, providerId);
  });
  f.set([action("file.list", { path: "." })]);
  const limited = await runner.run({ ...request, id: "one-step", maxSteps: 1 });
  assert.match(limited.error!, /step limit \(1\)/);
  assert.equal(limited.tools.length, 1);
  assert.equal(f.calls.length, 2);
  f.set([]);
  const tooLong = await runner.run({ ...request, id: "oversized-task", input: "x".repeat(9_000) });
  assert.match(tooLong.error!, /configured context limit/);
  assert.equal(f.calls.length, 2, "An oversized original task is rejected rather than silently truncated.");
});

test("hypothesis output includes research usage and keeps workspace context for the existing debate handler", async t => {
  const f = await fixture(t);
  f.context.execution = { workspace: f.context.workspace!, accessMode: "default", agentRunId: "hypothesis" };
  f.context.sessionSettings.hypothesisAgents = [{ id: "support", name: "Support", role: "support", providerId: "fixture", model: "test" }];
  f.set([{ type: "final", text: "The project's evidence supports the proposal." }]);
  const coordinator = new CodeAgentCoordinator(new AgentLoopRunner(f.llm, f.operations, f.root));
  const result = await coordinator.run("Evaluate this proposal", "hypothesis", f.context, async (_input, context) => {
    assert.equal(context.workspace?.rootPath, f.work);
    assert.match(JSON.stringify(context.requestMetadata?.attachments), /project's evidence/);
    return { response: "Debate complete.", provider: "fixture", model: "test", metrics: {
      startedAt: "2026-09-23T00:00:00.000Z", completedAt: "2026-09-23T00:00:01.000Z", durationMs: 1_000,
      usage: { inputTokens: 15, outputTokens: 10, totalTokens: 25 }
    } };
  });
  assert.deepEqual(result.result.metrics?.usage, { inputTokens: 15, outputTokens: 10, totalTokens: 35 });
  assert.equal(result.result.metrics?.durationMs, 1_000);
});

test("server agent-limit configuration uses environment overrides and bounded defaults", () => {
  assert.deepEqual(readAgentLimits(undefined, {}), defaultAgentLimits);
  assert.deepEqual(readAgentLimits({ maxSteps: 12, advisorMaxSteps: 4, contextChars: 12_000 }, {
    AGENT_MAX_STEPS: "999999", AGENT_MAX_TOTAL_STEPS: "-5", AGENT_MAX_ACTIVE_MS: "Infinity", AGENT_MAX_REPAIRS: "n/a"
  }), { maxSteps: 200, advisorMaxSteps: 4, maxTotalSteps: 1, maxActiveMs: 600_000, maxRepairs: 3, contextChars: 12_000 });
});
