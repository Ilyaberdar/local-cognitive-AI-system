import type { Schedule } from "../schedules/types";
import type { Task } from "../tasks/types";
import type { WorkflowDefinition, WorkflowRun } from "../workflows/types";
import { publicError } from "./publicError";

/** What a paired device sees of the host's tasks, schedules and workflow runs: no host
 * directories, no execution internals (session ids, frozen inputs and settings, attachment
 * contents) and error texts reduced by `publicError`. Workflow definitions are the user's own
 * and pass as saved; the run's snapshot of one loses its folder. */

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

const withoutFolder = (workflow: WorkflowDefinition): WorkflowDefinition => {
  if (!workflow.runDefaults?.rootPath) return workflow;
  const { rootPath: _rootPath, ...runDefaults } = workflow.runDefaults;
  return { ...workflow, runDefaults };
};

/** `withSnapshot: false` leaves out the workflow the run started from (lists of many runs). */
export const safeRun = (run: WorkflowRun, options: { withSnapshot?: boolean } = {}) => {
  const { state: _state, executionSnapshot: _snapshot, executionSessionId: _session, workspace, error, workflowSnapshot, ...rest } = run;
  return { ...rest,
    ...(workflowSnapshot && options.withSnapshot !== false ? { workflowSnapshot: withoutFolder(workflowSnapshot) } : {}),
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
      workflows: input.workflows.filter(workflow => keepWorkflows.has(workflow)),
      workflowRuns: newest(input.runs, step.runs).map((run, index) => safeRun(run, { withSnapshot: index < step.snapshots }))
    };
    if (bytes(lists) <= MAX_LIST_BYTES) break;
  }
  const truncated = lists.tasks.length < input.tasks.length || lists.workflowRuns.length < input.runs.length || lists.workflows.length < input.workflows.length;
  return { ...lists, ...(truncated ? { truncated: true } : {}) };
};
