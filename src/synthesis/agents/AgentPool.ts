import { AgentLoopRunner } from "../../agents/runtime/AgentLoopRunner";
import type { LLMService } from "../../llm/LLMService";
import { ExecutionContext, ManagedModel, SessionSettings } from "../../types";
import type { WorkspaceSnapshot } from "../../workspace/types";
import { agentTools, agentToolText, CandidateStore, FilePermissions, SynthesisFileTools } from "./SynthesisFileTools";
import { Checkouts } from "./Checkouts";

/** An agent as a flow describes it: a model, its file rights and what it is told. A description,
 * not a process: every task parallel_map gives it runs a fresh agent from it. */
export interface AgentSpec { kind: "agent"; model: ManagedModel; rights: FilePermissions; instructions: string; steps: number }
/** What a task's agent returned to the flow. */
export interface TaskResult { index: number; task: string; ok: boolean; output: string; error: string; files: string[] }
export type AgentStatus = "queued" | "running" | "done" | "failed" | "cancelled";
/** One task's agent, as the run shows it. */
export interface AgentSummary {
  index: number; call: number; task: string; providerId: string; model: string; status: AgentStatus;
  steps: number; inputTokens: number; outputTokens: number; durationMs: number; files: string[]; error?: string;
  /** Changes it left checked out when it failed or was stopped: dropped, as in Perforce. */
  reverted?: string[];
  /** The agent loop's own record, for its steps. */
  loopId: string;
}
export const MAX_AGENT_OUTPUT = 8000;

export interface PoolOptions {
  llm: LLMService;
  /** Where the agents' own records are kept. */
  baseDir: string;
  runId: string;
  /** Which parallel_map of the run this is (1, 2…), so its agents have their own records. */
  call: number;
  module: { name: string; description: string };
  store: CandidateStore;
  agents: AgentSpec[];
  tasks: string[];
  concurrency: number;
  failFast: boolean;
  /** Every change needs a checkout first. */
  checkoutRequired?: boolean;
  /** Where agents with a terminal run their commands. */
  terminal?: import("./Terminal").TerminalHost;
  signal: AbortSignal;
  /** Checked before each agent starts: its provider may still be used. */
  admit(spec: AgentSpec): Promise<void>;
  /** The summaries changed (an agent started, finished or spent tokens). */
  update(summaries: AgentSummary[]): void;
}

const settings = (target: { providerId: string; model: string }): SessionSettings => ({
  mode: "auto", language: "auto", outputStyle: "balanced", reasoningEffort: "low", defaultTarget: target, defaultAccessMode: "default",
  codeAgents: [], hypothesisAgents: [], debate: { enabled: false, profile: "general", support: target, attack: target, judge: target }
} as SessionSettings);

/** Runs every task with its agent (task i with agent i, round the list), at most `concurrency` at
 * once, and returns their results in task order whatever order they finish in. */
export async function runAgents(options: PoolOptions): Promise<{ results: TaskResult[]; summaries: AgentSummary[] }> {
  const { tasks, agents } = options;
  const controller = new AbortController();
  const stop = () => controller.abort(options.signal.reason);
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) stop();
  const summaries: AgentSummary[] = tasks.map((task, index) => {
    const spec = agents[index % agents.length];
    return { index, call: options.call, task: task.slice(0, 400), providerId: spec.model.providerId, model: spec.model.id, status: "queued", steps: 0,
      inputTokens: 0, outputTokens: 0, durationMs: 0, files: [], loopId: `synthesis:${options.runId}:map-${options.call}:task-${index}` };
  });
  const results: TaskResult[] = new Array(tasks.length);
  // One parallel_map's checkouts and owned files, shared by its agents.
  const checkouts = new Checkouts(options.checkoutRequired);
  let next = 0;
  let failure: Error | undefined;
  options.update(summaries);
  const runOne = async (index: number) => {
    const spec = agents[index % agents.length], summary = summaries[index], task = tasks[index];
    const started = Date.now();
    summary.status = "running"; options.update(summaries);
    const tools = new SynthesisFileTools(options.baseDir, options.store, spec.rights, { checkouts, me: { agent: index, task }, ...(options.terminal ? { terminal: options.terminal } : {}) });
    let finished = false;
    try {
      await options.admit(spec);
      const target = { providerId: spec.model.providerId, model: spec.model.id };
      const workspace: WorkspaceSnapshot = { version: 1, kind: "project", rootPath: ".", outputDir: options.store.outputPath ?? ".", allowedDirectories: ["."], memoryScope: `synthesis:${options.runId}` };
      const context: ExecutionContext = { actor: { sessionId: `synthesis:${options.runId}`, channel: "system" }, memory: [], conversation: [], providerId: target.providerId,
        activeTarget: target, sessionSettings: settings(target), pluginIds: [], signal: controller.signal, workspace,
        execution: { pluginIds: [], mcpServerIds: [], workspace, accessMode: "default", agentRunId: summary.loopId },
        // Each request is a turn: counted as it starts, so the row moves while the agent works (the end sets the exact count).
        onProgress: event => {
          if (event.phase === "preparing") { summary.steps++; summary.durationMs = Date.now() - started; options.update(summaries); }
          else if (event.phase === "tool_result" || event.phase === "tool_error") options.update(summaries);
        } };
      // An agent that only reads may still run its terminal (a reviewer running the tests): not read-only then.
      const changes = spec.rights.write.length > 0 || spec.rights.delete.length > 0;
      const readOnly = !changes && !spec.rights.terminal?.length;
      const runner = new AgentLoopRunner(options.llm, tools, options.baseDir,
        { maxSteps: spec.steps, advisorMaxSteps: spec.steps, maxTotalSteps: 0, maxActiveMs: 0, maxRepairs: 3 });
      const rights = [`read ${spec.rights.read.join(", ") || "nothing"}`, spec.rights.write.length ? `write ${spec.rights.write.join(", ")}` : "",
        spec.rights.delete.length ? `delete ${spec.rights.delete.join(", ")}` : ""].filter(Boolean).join("; ");
      const result = await runner.run({ id: summary.loopId, budgetId: summary.loopId, input: task, target, context, readOnly, maxSteps: spec.steps,
        tools: agentTools(spec.rights),
        toolInstructions: agentToolText(spec.rights),
        accessNote: `You are agent ${index + 1} of ${tasks.length}, working at the same time as the others on parts of one goal for the module ${options.module.name}. Your task is your part only. ` +
          `Files: you may ${rights}. Paths are relative to the project folder. ${changes ? "What you write goes into the run's copy; the project changes only when the engineer applies the run. " : ""}` +
          (spec.rights.read.length ? "Read the files of your task with your tools before you answer: a finding about code you have not read is wrong, and every path:line you cite is checked. " : "") +
          "Your final answer is returned to the flow as your result: give your findings with path:line references where they apply, and name the files you wrote.",
        instructions: [`Module ${options.module.name}: ${options.module.description}`.slice(0, 4000), spec.instructions].filter(Boolean).join("\n\n") });
      // Bookkeeping only: a record that cannot be read leaves the step count at 0, not the agent failed.
      const saved = await runner.store.get(summary.loopId).catch(() => undefined);
      summary.steps = saved?.steps ?? summary.steps;
      summary.inputTokens = result.usage.inputTokens ?? 0; summary.outputTokens = result.usage.outputTokens ?? 0;
      summary.files = [...tools.touched].sort();
      finished = !result.error;
      // What it left checked out: submitted when it finished, dropped when it did not.
      const reverted = await tools.finish(finished);
      if (reverted.length) summary.reverted = reverted;
      summary.files = [...tools.touched].sort();
      if (result.error) { summary.status = "failed"; summary.error = result.error.slice(0, 1000); }
      else summary.status = "done";
      results[index] = { index, task, ok: !result.error, output: result.text.slice(0, MAX_AGENT_OUTPUT), error: result.error?.slice(0, 1000) ?? "", files: summary.files };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!finished) { const reverted = await tools.finish(false).catch(() => []); if (reverted.length) summary.reverted = reverted; }
      summary.files = [...tools.touched].sort();
      summary.status = controller.signal.aborted ? "cancelled" : "failed"; summary.error = message.slice(0, 1000);
      results[index] = { index, task, ok: false, output: "", error: summary.error, files: summary.files };
      if (!controller.signal.aborted && !options.signal.aborted && options.failFast) { failure ??= new Error(`Agent ${index + 1} failed: ${message}`); controller.abort(failure); }
    } finally {
      summary.durationMs = Date.now() - started;
      options.update(summaries);
    }
    if (options.failFast && summary.status === "failed" && !failure) { failure = new Error(`Agent ${index + 1} failed: ${summary.error}`); controller.abort(failure); }
  };
  const worker = async () => {
    while (next < tasks.length && !controller.signal.aborted) await runOne(next++);
  };
  try {
    await Promise.all(Array.from({ length: Math.min(options.concurrency, tasks.length) }, worker));
  } finally { options.signal.removeEventListener("abort", stop); }
  for (const summary of summaries) if (summary.status === "queued") summary.status = "cancelled";
  for (let index = 0; index < tasks.length; index++) results[index] ??= { index, task: tasks[index], ok: false, output: "", error: "Not run: the agents were stopped.", files: [] };
  options.update(summaries);
  options.signal.throwIfAborted();
  if (failure) throw failure;
  return { results, summaries };
}
