import type { Schedule } from "../schedules/types";
import type { Task } from "../tasks/types";
import type { AgentTrace } from "../workflows/agentTrace";
import type { NodeRun, WorkflowDefinition, WorkflowRun } from "../workflows/types";
import { publicError } from "./publicError";

/** What a paired device sees of the host's tasks, schedules and workflow runs: no host
 * directories, no execution internals (session ids, frozen inputs and settings, attachment
 * contents) and error texts reduced by `publicError`. Workflow definitions are the user's own and
 * pass as saved, except the folder chosen on the host for their runs. */

export const safeTask = (task: Task) => {
  const { sessionId: _sessionId, sourceSessionId: _sourceSessionId, metadata, attachments, ...rest } = task;
  const schedule = metadata ? Object.fromEntries(Object.entries(metadata).filter(([key]) => key === "scheduleId" || key === "scheduleOccurrenceAt")) : {};
  return { ...rest,
    ...(attachments?.length ? { attachments: attachments.map(({ dataUrl: _dataUrl, textContent: _textContent, ...attachment }) => attachment) } : {}),
    ...(Object.keys(schedule).length ? { metadata: schedule } : {}) };
};

export const safeSchedule = (schedule: Schedule) => {
  const { activeTaskInput: _input, sessionId: _sessionId, metadata: _metadata, lastError, ...rest } = schedule;
  return { ...rest, ...(lastError ? { lastError: publicError(lastError) } : {}) };
};

/** A workflow without the folder chosen on the host for its runs (saving from a device keeps it). */
export const safeWorkflow = (workflow: WorkflowDefinition): WorkflowDefinition => {
  if (workflow.runDefaults?.rootPath === undefined) return workflow;
  const { rootPath: _rootPath, ...runDefaults } = workflow.runDefaults;
  return { ...workflow, runDefaults };
};

/** `withSnapshot: false` leaves out the workflow the run started from (lists of many runs). */
export const safeRun = (run: WorkflowRun, options: { withSnapshot?: boolean } = {}) => {
  const { state: _state, executionSnapshot: _snapshot, executionSessionId: _session, workspace, error, workflowSnapshot, ...rest } = run;
  return { ...rest,
    ...(workflowSnapshot && options.withSnapshot !== false ? { workflowSnapshot: safeWorkflow(workflowSnapshot) } : {}),
    ...(workspace ? { workspace: { kind: workspace.kind, ...(workspace.projectName ? { projectName: workspace.projectName } : {}) } } : {}),
    ...(error ? { error: publicError(error) } : {}) };
};

const MAX_LIST_BYTES = 900 * 1024;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const newest = <T extends { updatedAt: string }>(items: T[], count: number) => [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, count);

/** The Tasks & workflows screen's lists in one answer that fits a frame: the newest items when
 * there are too many (`truncated`), with the workflow snapshot only on the most recent runs. */
export const orchestrationLists = (input: { tasks: Task[]; schedules: Schedule[]; workflows: WorkflowDefinition[]; runs: WorkflowRun[] }) => {
  const steps = [{ tasks: 500, runs: 200, snapshots: 50, workflows: 100 }, { tasks: 200, runs: 100, snapshots: 10, workflows: 50 }, { tasks: 100, runs: 50, snapshots: 0, workflows: 20 }];
  let lists!: { tasks: ReturnType<typeof safeTask>[]; schedules: ReturnType<typeof safeSchedule>[]; workflows: WorkflowDefinition[]; workflowRuns: ReturnType<typeof safeRun>[] };
  for (const step of steps) {
    // Lists keep the stores' order; only which items are included depends on age.
    const keepTasks = new Set(newest(input.tasks, step.tasks).map(task => task.id));
    const keepWorkflows = new Set(newest(input.workflows, step.workflows));
    lists = {
      tasks: input.tasks.filter(task => keepTasks.has(task.id)).map(safeTask),
      schedules: input.schedules.map(safeSchedule),
      workflows: input.workflows.filter(workflow => keepWorkflows.has(workflow)).map(safeWorkflow),
      workflowRuns: newest(input.runs, step.runs).map((run, index) => safeRun(run, { withSnapshot: index < step.snapshots }))
    };
    if (bytes(lists) <= MAX_LIST_BYTES) break;
  }
  const truncated = lists.tasks.length < input.tasks.length || lists.workflowRuns.length < input.runs.length || lists.workflows.length < input.workflows.length;
  return { ...lists, ...(truncated ? { truncated: true } : {}) };
};

/** Replaces each folder by its label in a whole value (longest folder first, so a folder inside
 * another is replaced by its own label). */
export const pathScrubber = (pairs: Array<[string, string]>) => {
  const sorted = pairs.filter(([dir]) => dir.length > 1).sort((a, b) => b[0].length - a[0].length);
  return <T>(value: T): T => {
    if (!sorted.length || value === undefined) return value;
    let json = JSON.stringify(value);
    for (const [dir, label] of sorted) json = json.split(JSON.stringify(dir).slice(1, -1)).join(label);
    return JSON.parse(json) as T;
  };
};

/** Replaces folders of the host in what a device receives about a run: the run's workspace and
 * output folders, then the host's data directories. Applied to whole values (outputs, events). */
export const scrubberFor = (run: WorkflowRun | undefined, hostDirectories: string[] = []) => {
  const pairs: Array<[string, string]> = [
    ...[run?.workspace?.outputDir, run?.workspace?.rootPath].filter((dir): dir is string => Boolean(dir && dir.length > 1)).map(dir => [dir, dir === run?.workspace?.outputDir ? "<output>" : "<workspace>"] as [string, string]),
    ...(run?.workspace?.allowedDirectories ?? []).filter(dir => dir.length > 1).map(dir => [dir, "<folder>"] as [string, string]),
    ...hostDirectories.filter(dir => dir.length > 1).map(dir => [dir, "<server>"] as [string, string])
  ];
  return pathScrubber(pairs);
};

const MAX_DATA_BYTES = 32 * 1024;
const MAX_RESPONSE_CHARS = 24_000;
/** Small fields of a step's output a device needs to act on it (approvals, its agent, target). */
const KEPT_WHEN_LARGE = ["permissionRequired", "approvalId", "agentRunId", "target", "event", "tool", "operation", "summary", "approved", "path"];

/** A step of a run: without the input it was given; large outputs are cut, their response kept. */
export const safeNodeRun = (nodeRun: NodeRun) => {
  const { input: _input, output, error, ...rest } = nodeRun;
  let safeOutput = output;
  if (output) {
    const { artifacts, data, ...result } = output;
    const small = Buffer.byteLength(JSON.stringify(data ?? {})) <= MAX_DATA_BYTES;
    const kept = small ? data : {
      ...Object.fromEntries(Object.entries(data ?? {}).filter(([key, value]) => KEPT_WHEN_LARGE.includes(key) && Buffer.byteLength(JSON.stringify(value ?? null)) <= 2048)),
      ...(typeof data?.response === "string" ? { response: data.response.slice(0, MAX_RESPONSE_CHARS) } : {}), truncated: true };
    safeOutput = { ...result, ...(result.error ? { error: publicError(result.error) } : {}), data: kept,
      ...(artifacts?.length ? { artifacts: artifacts.map(artifact => ({ name: artifact.name, ...(artifact.contentType ? { contentType: artifact.contentType } : {}) })) } : {}) };
  }
  return { ...rest, ...(safeOutput ? { output: safeOutput } : {}), ...(error ? { error: publicError(error) } : {}) };
};

const MAX_DETAIL_BYTES = 700 * 1024;
/** A run with its steps, as the editor shows it; the oldest outputs give way when it is too large. */
export const runDetail = (detail: { run: WorkflowRun; nodeRuns: NodeRun[] }, hostDirectories: string[] = []) => {
  const scrub = scrubberFor(detail.run, hostDirectories);
  const value = scrub({ run: safeRun(detail.run), nodeRuns: detail.nodeRuns.map(safeNodeRun) });
  for (let index = 0; index < value.nodeRuns.length && bytes(value) > MAX_DETAIL_BYTES; index++) {
    const step = value.nodeRuns[index]!;
    if (step.output) step.output = { ...step.output, data: { truncated: true } };
  }
  return value;
};

const MAX_TURN_CHARS = 16_000;
const MAX_TRACE_BYTES = 512 * 1024;
/** An agent step's turns, as text: never its instructions, tools, pending action or continuation. */
export const agentTraceDto = (trace: AgentTrace, run: WorkflowRun, hostDirectories: string[] = []) => {
  const scrub = scrubberFor(run, hostDirectories);
  const turns: Array<{ type: string; content: string }> = [];
  let size = 0;
  for (const turn of trace.turns) {
    const item = scrub({ type: turn.type, content: turn.content.length > MAX_TURN_CHARS ? `${turn.content.slice(0, MAX_TURN_CHARS)}…` : turn.content });
    size += Buffer.byteLength(JSON.stringify(item));
    if (turns.length && size > MAX_TRACE_BYTES) break;
    turns.push(item);
  }
  return { id: trace.id, ...("status" in trace ? { status: trace.status } : {}), turns, ...(turns.length < trace.turns.length ? { truncated: true } : {}) };
};
