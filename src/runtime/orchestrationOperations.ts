import path from "path";
import { z } from "zod";
import type { RuntimeManager } from "../app/RuntimeManager";
import { RemoteOperationError, type OperationContext, type RemoteOperation } from "../remote/host/RemoteHost";
import { ScheduleValidationError } from "../schedules/ScheduleService";
import type { ScheduleWeekday } from "../schedules/types";
import { TaskValidationError } from "../tasks/types";
import { AgentTraceNotFoundError, readAgentTrace } from "../workflows/agentTrace";
import { DEFAULT_TASK_WORKFLOW_ID } from "../workflows/defaultWorkflows";
import { WorkflowConflictError, WorkflowRunConflictError, type WorkflowDefinition, type WorkflowRun } from "../workflows/types";
import { canonical, sha256 } from "./canonical";
import type { CommandLedger, CommandRecord, LedgerCommand } from "./CommandLedger";
import type { JournalEvent } from "./EventJournal";
import type { StreamSource } from "./eventStreams";
import { agentTraceDto, orchestrationLists, runDetail, safeRun, safeSchedule, safeTask, safeWorkflow, scrubberFor } from "./orchestrationDto";
import { FolderError, type HostFolders } from "./hostFolders";
import type { ProjectAccess } from "./projectOperations";
import { publicError } from "./publicError";

const MAX_WORKFLOW_BYTES = 200 * 1024;
const MAX_HISTORY_EVENTS = 500, MAX_HISTORY_BYTES = 256 * 1024;
const id = z.string().min(1).max(200);
const runId = z.uuid();
const commandId = z.string().min(8).max(100);
const priority = z.enum(["low", "normal", "high"]);
// Full access is set up on the host itself: from a device, steps ask for approval (R5-2).
const access = z.enum(["ask", "default"]);
const taskFields = {
  title: z.string().trim().min(1).max(500), description: z.string().max(100_000),
  workflowId: id, priority, accessMode: access, projectId: id.nullable()
};
const scheduleFields = {
  title: z.string().trim().min(1).max(500), description: z.string().max(100_000), workflowId: id, priority,
  frequency: z.enum(["daily", "weekly"]), weekday: z.number().int().min(0).max(6).transform(day => day as ScheduleWeekday), time: z.string().min(1).max(10), timezone: z.string().min(1).max(100),
  enabled: z.boolean(), accessMode: access, projectId: id.nullable()
};
const workflow = z.record(z.string(), z.unknown()).refine(value => Buffer.byteLength(JSON.stringify(value)) <= MAX_WORKFLOW_BYTES, "The workflow is too large.");
const schemas = {
  snapshot: z.object({ revision: z.string().max(100).optional() }).strict().optional(),
  taskCreate: z.object({ commandId, ...taskFields, description: taskFields.description.optional(), workflowId: id.optional(), priority: priority.optional(),
    accessMode: access.optional(), projectId: id.nullable().optional() }).strict(),
  taskUpdate: z.object({ taskId: id, patch: z.object({ ...taskFields,
    status: z.enum(["todo", "in_progress", "backlog", "queued", "running", "waiting", "interrupted", "blocked", "done", "failed", "cancelled"]) }).partial().strict() }).strict(),
  task: z.object({ taskId: id }).strict(),
  taskRun: z.object({ commandId, taskId: id }).strict(),
  runNext: z.object({ commandId }).strict(),
  scheduleCreate: z.object({ commandId, ...scheduleFields, description: scheduleFields.description.optional(), workflowId: id.optional(),
    priority: priority.optional(), frequency: scheduleFields.frequency.optional(), weekday: scheduleFields.weekday.optional(),
    enabled: z.boolean().optional(), accessMode: access.optional(), projectId: id.nullable().optional() }).strict(),
  scheduleUpdate: z.object({ scheduleId: id, patch: z.object(scheduleFields).partial().strict() }).strict(),
  schedule: z.object({ scheduleId: id }).strict(),
  validate: z.object({ workflow }).strict(),
  save: z.object({ commandId, workflow, expectedUpdatedAt: z.string().max(40).nullable() }).strict(),
  // A run works in a project a device may use, or a folder among the server's shared ones (never a path).
  runStart: z.object({ commandId, workflow, options: z.object({ description: z.string().max(100_000).optional(), accessMode: access.optional(),
    maxSteps: z.number().int().min(1).max(250).optional(), projectId: id.optional(),
    folder: z.object({ rootId: z.string().min(1).max(100), path: z.array(z.string().min(1).max(255)).max(32) }).strict().optional() }).strict().optional() }).strict(),
  run: z.object({ runId }).strict(),
  runEvents: z.object({ runId, after: z.number().int().nonnegative().optional() }).strict(),
  review: z.object({ commandId, runId, approved: z.boolean(), comment: z.string().max(4000).optional(), approvalId: z.string().max(200).optional(),
    waitingNodeRunId: z.string().max(200).optional() }).strict(),
  runCommand: z.object({ commandId, runId }).strict(),
  agentTrace: z.object({ runId, agentRunId: z.string().min(1).max(500) }).strict()
};

const LATER = {
  attachments: "Attachments for tasks on the server come in a later update.",
  project: "Projects and folders for work on the server come in a later update.",
  fullAccess: "Full access is not available from a device yet: on the server, steps ask for approval.",
  plugins: "Plugins in workflows on the server come in a later update."
};
// What the host set up with full access, or bound to a folder or project chosen there, stays the
// host's: a device can delete, cancel or pause it, never start, continue or change it.
const FULL_ON_HOST = "This runs with full access on the server, so it can only be started or changed there.";
const FOLDER_ON_HOST = "This runs in a folder or project chosen on the server, so it can only be started or changed there.";
const unsupported = (message: string) => new RemoteOperationError(message, "unsupported");
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Settings a device cannot make on the host (yet), checked before the schema so the answer says
 * why. A folder of the host is never sent; a project only to a server that offers projects. */
const refuseLater = (fields: Record<string, unknown>, projects = false): void => {
  if (Array.isArray(fields.attachments) && fields.attachments.length) throw unsupported(LATER.attachments);
  if ((fields.rootPath !== undefined && fields.rootPath !== null) || (!projects && fields.projectId !== undefined && fields.projectId !== null)) throw unsupported(LATER.project);
  if (fields.accessMode === "full") throw unsupported(LATER.fullAccess);
};

/** What a workflow sent from a device may not contain yet (see LATER). */
/** Tasks and schedules a device makes: their runs get no MCP tools of the host (`WorkflowRun.deviceOrigin`). */
const DEVICE_ORIGIN = { deviceOrigin: true };

export const workflowLimits = (definition: unknown): string[] => {
  const value = record(definition), runDefaults = record(value.runDefaults), problems = new Set<string>();
  if (runDefaults.accessMode === "full") problems.add(LATER.fullAccess);
  if (runDefaults.rootPath !== undefined || runDefaults.projectId !== undefined) problems.add(LATER.project);
  for (const node of Array.isArray(value.nodes) ? value.nodes : []) {
    const config = record(record(node).config);
    if (config.approval === "never" || config.access === "full") problems.add(LATER.fullAccess);
    if (record(node).type === "agent" && Array.isArray(config.pluginIds) && config.pluginIds.length) problems.add(LATER.plugins);
  }
  return [...problems];
};

/** Whether running this would skip approvals: nothing a device sends may lead there (R5-2). */
const skipsApproval = (workflow: WorkflowDefinition | null | undefined, accessMode?: string): boolean =>
  accessMode === "full" || workflowLimits(workflow).includes(LATER.fullAccess);
/** A run continues with what it started with: its own access and its snapshot of the workflow. */
const runSkipsApproval = (run: WorkflowRun): boolean => skipsApproval(run.workflowSnapshot, run.executionSnapshot?.accessMode);
const hasFolder = (workflow: WorkflowDefinition | null | undefined) => workflow?.runDefaults?.rootPath !== undefined || workflow?.runDefaults?.projectId !== undefined;
/** A run's folder chosen beyond its own managed one (<data>/workspaces/workflow-runs/<run id>). */
const chosenFolder = (run: WorkflowRun) => run.workspace?.kind === "workflow" && !(path.basename(run.workspace.rootPath) === run.id && path.basename(path.dirname(run.workspace.rootPath)) === "workflow-runs");

const parse = <T>(schema: z.ZodType<T>, payload: unknown): T => {
  const result = schema.safeParse(payload);
  if (!result.success) throw new RemoteOperationError(result.error.issues.some(issue => issue.message === "The workflow is too large.")
    ? "The workflow is too large." : "The request is not valid.", "invalid_request");
  return result.data;
};

/** Refusals of the task, schedule and workflow services are expected answers: devices get a code
 * and a short text. Anything else is reported generically by the dispatcher. */
const known = async <T>(task: () => Promise<T>): Promise<T> => {
  try { return await task(); }
  catch (error) {
    if (error instanceof RemoteOperationError) throw error;
    if (error instanceof FolderError) throw new RemoteOperationError(error.message, error.code);
    const status = (error as { statusCode?: unknown }).statusCode;
    const expected = error instanceof TaskValidationError || error instanceof ScheduleValidationError || error instanceof WorkflowConflictError
      || error instanceof WorkflowRunConflictError || (typeof status === "number" && status >= 400 && status < 500);
    if (!expected) throw error;
    const code = error instanceof WorkflowConflictError ? "workflow_conflict" : status === 409 ? "conflict" : "invalid_request";
    throw new RemoteOperationError(publicError((error as Error).message), code);
  }
};
const notFound = (what: string) => new RemoteOperationError(`The ${what} does not exist on the server.`, "not_found");

export interface OrchestrationOperationDependencies {
  runtimeManager: RuntimeManager;
  ledger: CommandLedger;
  /** Idempotency scope of a caller: commands from different devices never collide. */
  scopeOf(context: OperationContext): string;
  /** Projects a device may use and the server's shared folders (R5-4h); without them, work bound
   * to a project or folder stays on the host. */
  projects?: ProjectAccess;
  folders?: HostFolders;
  /** True while the host drains: new work is refused; reads, cancels and reviews still answer. */
  isDraining(): boolean;
  /** The event journal's epoch: workflow run streams use it, so their cursors survive restarts. */
  journalEpoch(): string;
  /** The host's data directories, replaced in run outputs and events a device receives. */
  hostDirectories?: string[];
}

/** Tasks & workflows on the host for a paired device (R5-2): lists, tasks, schedules and
 * workflows. Calls the services directly, never the HTTP API. Commands go through the ledger, so a
 * command resent after a lost answer acts once. */
export const createOrchestrationOperations = (deps: OrchestrationOperationDependencies): Record<string, RemoteOperation> => {
  const runtime = () => deps.runtimeManager.getRuntime();
  const draining = () => new RemoteOperationError("The server is shutting down. Try again when it is back.", "host_draining");
  const mutable = () => { if (deps.isDraining()) throw draining(); };
  const workflowOf = (workflowId: string, version?: number) => runtime().workflowStore.get(workflowId, version);
  /** A task or schedule a device creates or retargets must point at an existing workflow none of
   * whose versions skips approvals: a task keeps the version it last ran with, so checking only
   * the latest one would not cover what runs. */
  const allowedWorkflow = async (workflowId: string) => {
    const versions = (await runtime().workflowStore.list()).filter(workflow => workflow.id === workflowId);
    if (!versions.length) throw notFound("workflow");
    if (versions.some(workflow => skipsApproval(workflow))) throw unsupported(FULL_ON_HOST);
  };
  /** Whether a device may use this project now (checked at every use: archived or unshared ends it). */
  const projectUsable = async (projectId: string) => {
    if (!deps.projects) return false;
    try { return !(await deps.projects.usable(projectId)).reason; } catch { return false; }
  };
  const requireProject = async (projectId: string | null | undefined) => {
    if (!projectId) return;
    if (!deps.projects) throw unsupported(LATER.project);
    const { reason } = await deps.projects.usable(projectId);
    if (reason) throw unsupported(reason);
  };
  /** Why only the host may start or change this task or schedule, if so. */
  const hostOnly = async (item: { workflowId: string; workflowVersion?: number; accessMode?: string; projectId?: string }) =>
    skipsApproval(await workflowOf(item.workflowId, item.workflowVersion), item.accessMode) ? FULL_ON_HOST
      : item.projectId && !await projectUsable(item.projectId) ? FOLDER_ON_HOST : undefined;
  /** Why only the host may continue this run, if so: its access, or a project or folder that is not
   * (or no longer) one a device may use. */
  const runHostOnly = async (run: WorkflowRun): Promise<string | undefined> => {
    if (runSkipsApproval(run)) return FULL_ON_HOST;
    if (hasFolder(run.workflowSnapshot)) return FOLDER_ON_HOST;
    if (run.workspace?.kind === "project") return run.workspace.projectId && await projectUsable(run.workspace.projectId) ? undefined : FOLDER_ON_HOST;
    if (chosenFolder(run)) return deps.folders?.locate(run.workspace!.rootPath) ? undefined : FOLDER_ON_HOST;
    return undefined;
  };
  const requireRun = async (id: string) => {
    const run = await runtime().workflowRunStore.getRun(id);
    if (!run) throw notFound("run");
    return run;
  };
  const detailOf = async (id: string) => {
    const detail = await runtime().taskService.getRunDetail(id);
    if (!detail) throw notFound("run");
    return runDetail(detail, deps.hostDirectories);
  };
  /** `allowWhileDraining`: answering a waiting step finishes work, so it is not refused. */
  const command = <T>(context: OperationContext, operation: string, input: { commandId: string }, execute: (record: CommandRecord) => Promise<T>,
    { allowWhileDraining, ...options }: Pick<LedgerCommand<T>, "target" | "reconcile" | "reserveRunId"> & { allowWhileDraining?: boolean } = {}): Promise<T> => {
    const { commandId: key, ...payload } = input;
    return deps.ledger.run({ scope: deps.scopeOf(context), key, operation, payload, ...(allowWhileDraining ? {} : { accepting: () => !deps.isDraining() }), ...options }, execute);
  };

  return {
    /** The screen's lists with a revision: an unchanged answer is a few bytes. */
    "orchestration.snapshot": payload => known(async () => {
      const { revision } = parse(schemas.snapshot, payload) ?? {};
      const current = runtime();
      const [tasks, schedules, workflows, runs] = await Promise.all([current.taskService.list(), current.scheduleService.list(),
        current.workflowStore.list(), current.workflowRunStore.listRuns()]);
      const lists = orchestrationLists({ tasks, schedules, workflows, runs });
      const next = sha256(canonical(lists)).slice(0, 32);
      return revision === next ? { revision: next, unchanged: true } : { revision: next, ...lists };
    }),

    "tasks.create": (payload, context) => known(async () => {
      refuseLater(record(payload), Boolean(deps.projects));
      const input = parse(schemas.taskCreate, payload);
      const workflowId = input.workflowId || DEFAULT_TASK_WORKFLOW_ID;
      return command(context, "tasks.create", input, async () => {
        await allowedWorkflow(workflowId);
        await requireProject(input.projectId);
        return safeTask(await runtime().taskService.create({ title: input.title, description: (input.description ?? "").trim(), workflowId,
          priority: input.priority ?? "normal", accessMode: input.accessMode ?? "default", ...(input.projectId ? { projectId: input.projectId } : {}), metadata: DEVICE_ORIGIN }));
      });
    }),
    "tasks.update": payload => known(async () => {
      refuseLater(record(record(payload).patch), Boolean(deps.projects));
      const { taskId, patch } = parse(schemas.taskUpdate, payload);
      mutable();
      const current = await runtime().taskService.get(taskId);
      if (!current) throw notFound("task");
      // Not even its column: back in the queue, the host could start it.
      const reason = await hostOnly(current);
      if (reason) throw unsupported(reason);
      if (patch.workflowId) await allowedWorkflow(patch.workflowId);
      await requireProject(patch.projectId);
      const task = await runtime().taskService.update(taskId, { ...patch, ...(patch.description === undefined ? {} : { description: patch.description.trim() }) });
      if (!task) throw notFound("task");
      return safeTask(task);
    }),
    "tasks.delete": payload => known(async () => {
      const { taskId } = parse(schemas.task, payload);
      mutable();
      return { deleted: await runtime().taskService.delete(taskId) };
    }),
    /** Accepts and returns: the run goes on without the device; its progress is read separately. */
    "tasks.run": (payload, context) => known(async () => {
      const input = parse(schemas.taskRun, payload);
      const result = async (runId: string) => {
        const task = await runtime().taskService.get(input.taskId);
        return task ? { task: safeTask(task), runId } : undefined;
      };
      return command(context, "tasks.run", input, async () => {
        const task = await runtime().taskService.get(input.taskId);
        if (!task) throw notFound("task");
        const reason = await hostOnly(task);
        if (reason) throw unsupported(reason);
        const started = await runtime().taskService.startTask(input.taskId, { device: true });
        return { task: safeTask(started.task), runId: started.runId };
      }, { target: input.taskId,
        // A restart after the run was created: that run is the answer.
        reconcile: async accepted => {
          const run = (await runtime().workflowRunStore.listRuns()).find(item => item.taskId === input.taskId && item.createdAt >= accepted.acceptedAt);
          return run ? result(run.id) : undefined;
        } });
    }),
    "tasks.runNext": (payload, context) => known(async () => {
      const input = parse(schemas.runNext, payload);
      return command(context, "tasks.runNext", input, async () => {
        const started = await runtime().taskService.startNextQueued(async task => !await hostOnly(task), { device: true });
        return started ? { task: safeTask(started.task), runId: started.runId } : { task: null, runId: null };
      });
    }),

    "schedules.create": (payload, context) => known(async () => {
      refuseLater(record(payload), Boolean(deps.projects));
      const input = parse(schemas.scheduleCreate, payload);
      const { commandId: _commandId, ...fields } = input;
      const workflowId = fields.workflowId || DEFAULT_TASK_WORKFLOW_ID;
      return command(context, "schedules.create", input, async () => {
        await allowedWorkflow(workflowId);
        await requireProject(fields.projectId);
        const { projectId, ...rest } = fields;
        return safeSchedule(await runtime().scheduleService.create({ ...rest, description: fields.description ?? "", workflowId, ...(projectId ? { projectId } : {}), metadata: DEVICE_ORIGIN }));
      });
    }),
    "schedules.update": payload => known(async () => {
      refuseLater(record(record(payload).patch), Boolean(deps.projects));
      const { scheduleId, patch } = parse(schemas.scheduleUpdate, payload);
      mutable();
      const current = await runtime().scheduleService.get(scheduleId);
      if (!current) throw notFound("schedule");
      const pausing = Object.keys(patch).length === 1 && patch.enabled === false;
      const reason = pausing ? undefined : await hostOnly(current);
      if (reason) throw unsupported(reason);
      if (patch.workflowId) await allowedWorkflow(patch.workflowId);
      await requireProject(patch.projectId);
      // What a device changes runs later unattended: its tasks are the device's (no host MCP tools).
      const schedule = await runtime().scheduleService.update(scheduleId, pausing ? patch : { ...patch, metadata: { ...current.metadata, ...DEVICE_ORIGIN } });
      if (!schedule) throw notFound("schedule");
      return safeSchedule(schedule);
    }),
    "schedules.delete": payload => known(async () => {
      const { scheduleId } = parse(schemas.schedule, payload);
      mutable();
      return { deleted: await runtime().scheduleService.delete(scheduleId) };
    }),

    /** The editor's check, including what a device may not set yet. */
    "workflows.validate": payload => known(async () => {
      const { workflow: definition } = parse(schemas.validate, payload);
      const validation = runtime().workflowStore.validate(definition);
      const errors = [...validation.errors, ...workflowLimits(definition)];
      return { ok: errors.length === 0, errors };
    }),
    /** Starts a workflow from the editor; returns once it is queued, its progress is followed separately. */
    "workflows.runs.start": (payload, context) => known(async () => {
      refuseLater(record(record(payload).options), Boolean(deps.projects));
      const input = parse(schemas.runStart, payload);
      const limits = workflowLimits(input.workflow);
      if (limits.length) throw unsupported(limits[0]!);
      const definition = input.workflow as unknown as WorkflowDefinition;
      const validation = runtime().workflowStore.validate(definition);
      if (!validation.ok) throw new RemoteOperationError(publicError(validation.errors.join("; ")), "invalid_request");
      return command(context, "workflows.runs.start", input, async reserved => {
        const { folder, projectId, ...options } = input.options ?? {};
        if (folder && projectId) throw new RemoteOperationError("Choose a project or a folder, not both.", "invalid_request");
        await requireProject(projectId);
        if (folder && !deps.folders) throw unsupported(LATER.project);
        const rootPath = folder ? (await deps.folders!.resolve(folder.rootId, folder.path)).real : undefined;
        const run = await runtime().workflowRunner.startStandalone(definition, { ...options, ...(projectId ? { projectId } : {}), ...(rootPath ? { rootPath } : {}) },
          { runId: reserved.runId, device: true });
        runtime().workflowRunner.runInBackground(run.id);
        return safeRun(run);
      }, { reserveRunId: true,
        // A restart after the run was created: that run is the answer (recovery interrupted it if it never ran).
        reconcile: async accepted => {
          const run = accepted.runId ? await runtime().workflowRunStore.getRun(accepted.runId) : null;
          return run ? safeRun(run) : undefined;
        } });
    }),
    "workflows.runs.get": payload => known(async () => detailOf(parse(schemas.run, payload).runId)),
    /** What the run's live view starts from: its events after `after` (newest when there are many),
     * then its detail, and the cursor to follow it with `events.poll`. */
    "workflows.runs.events": payload => known(async () => {
      const input = parse(schemas.runEvents, payload);
      const run = await requireRun(input.runId);
      const events = runtime().workflowRunStore.events;
      let history = await events.list(input.runId, input.after ?? 0);
      // The device is ahead of the log (it was reset): start again from the beginning.
      if ((input.after ?? 0) > history.lastSequence) history = await events.list(input.runId, 0);
      const scrub = scrubberFor(run, deps.hostDirectories);
      const kept = scrub(history.events).slice(-MAX_HISTORY_EVENTS);
      while (kept.length > 1 && Buffer.byteLength(JSON.stringify(kept)) > MAX_HISTORY_BYTES) kept.shift();
      const dropped = kept.length < history.events.length;
      return { events: kept, firstSequence: dropped ? kept[0]!.sequence : history.firstSequence, lastSequence: history.lastSequence,
        truncated: history.truncated || dropped, detail: await detailOf(input.runId),
        cursor: { streamId: `workflow-run:${input.runId}`, epoch: deps.journalEpoch(), after: history.lastSequence } };
    }),
    /** Cancel needs no command id: cancelling twice is cancelling once. */
    "workflows.runs.cancel": payload => known(async () => {
      const { runId: id } = parse(schemas.run, payload);
      await requireRun(id);
      return safeRun(await runtime().workflowRunner.cancel(id));
    }),
    /** Answers a waiting step (approval or human review); the run continues on the host. */
    "workflows.runs.review": (payload, context) => known(async () => {
      const input = parse(schemas.review, payload);
      return command(context, "workflows.runs.review", input, async () => {
        const reason = await runHostOnly(await requireRun(input.runId));
        if (reason) throw unsupported(reason);
        return safeRun(await runtime().workflowRunner.review(input.runId, input.approved, input.comment ?? "", true,
          { ...(input.approvalId ? { approvalId: input.approvalId } : {}), ...(input.waitingNodeRunId ? { waitingNodeRunId: input.waitingNodeRunId } : {}) }));
      }, { target: input.runId, allowWhileDraining: true });
    }),
    "workflows.runs.resume": (payload, context) => known(async () => {
      const input = parse(schemas.runCommand, payload);
      return command(context, "workflows.runs.resume", input, async () => {
        const reason = await runHostOnly(await requireRun(input.runId));
        if (reason) throw unsupported(reason);
        return safeRun(await runtime().workflowRunner.resume(input.runId, true));
      }, { target: input.runId });
    }),
    "workflows.runs.agentTrace.get": payload => known(async () => {
      const input = parse(schemas.agentTrace, payload);
      const run = await requireRun(input.runId);
      const detail = await runtime().taskService.getRunDetail(input.runId);
      try { return agentTraceDto(await readAgentTrace(runtime().agentLoopRunner.store, detail?.nodeRuns, input.agentRunId), run, deps.hostDirectories); }
      catch (error) { if (error instanceof AgentTraceNotFoundError) throw new RemoteOperationError(error.message, "not_found"); throw error; }
    }),

    /** `expectedUpdatedAt`: the version the editor started from, null for a new workflow. */
    "workflows.save": (payload, context) => known(async () => {
      const input = parse(schemas.save, payload);
      const limits = workflowLimits(input.workflow);
      if (limits.length) throw unsupported(limits[0]!);
      const definition = input.workflow as unknown as WorkflowDefinition;
      return command(context, "workflows.save", input, async () => {
        // What a device saves would run with whatever the host's tasks and schedules that use it
        // were given there, and a task may run any version of it: all of them count.
        const [tasks, schedules, workflows] = await Promise.all([runtime().taskService.list(), runtime().scheduleService.list(), runtime().workflowStore.list()]);
        const users = [...tasks, ...schedules].filter(item => item.workflowId === definition.id);
        if (users.some(item => item.accessMode === "full")) throw unsupported(FULL_ON_HOST);
        if (users.some(item => item.projectId) || workflows.some(item => item.id === definition.id && hasFolder(item))) throw unsupported(FOLDER_ON_HOST);
        return safeWorkflow(await runtime().workflowStore.save(definition, { expectedUpdatedAt: input.expectedUpdatedAt }));
      });
    })
  };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_POLL_BYTES = 256 * 1024;

/** A workflow run's event log as an `events.poll` stream (`workflow-run:<runId>`). Its sequences
 * are the log's own and survive restarts, so the journal's epoch fits it; a cursor the log no
 * longer covers gets `resync`, as does a run that does not exist. */
export const createWorkflowRunStreams = (deps: Pick<OrchestrationOperationDependencies, "runtimeManager" | "journalEpoch" | "hostDirectories">): StreamSource => ({
  prefix: "workflow-run:",
  async read(id, cursor, maxEvents) {
    if (!UUID.test(id)) throw new RemoteOperationError("The request is not valid.", "invalid_request");
    const store = deps.runtimeManager.getRuntime().workflowRunStore;
    const run = await store.getRun(id);
    if (!run) return { resync: "run_unknown" };
    if (cursor.epoch !== deps.journalEpoch()) return { resync: "epoch_changed" };
    const history = await store.events.list(id, cursor.after);
    if (cursor.after > history.lastSequence) return { resync: "cursor_ahead" };
    if (history.truncated) return { resync: "cursor_expired" };
    const scrub = scrubberFor(run, deps.hostDirectories);
    const events: JournalEvent[] = [];
    let bytes = 0;
    for (const event of history.events.slice(0, maxEvents)) {
      const payload = scrub(event) as unknown as Record<string, unknown>;
      bytes += Buffer.byteLength(JSON.stringify(payload));
      // At least one event, so a large one cannot stall the cursor.
      if (events.length && bytes > MAX_POLL_BYTES) break;
      events.push({ seq: event.sequence, type: event.type, runId: id, occurredAt: event.at, payload });
    }
    return { events };
  },
  subscribe(id, wake) {
    return UUID.test(id) ? deps.runtimeManager.getRuntime().workflowRunStore.events.subscribe(id, () => wake()) : () => undefined;
  }
});
