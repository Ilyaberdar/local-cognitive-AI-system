import { z } from "zod";
import type { RuntimeManager } from "../app/RuntimeManager";
import { RemoteOperationError, type OperationContext, type RemoteOperation } from "../remote/host/RemoteHost";
import { ScheduleValidationError } from "../schedules/ScheduleService";
import type { ScheduleWeekday } from "../schedules/types";
import { TaskValidationError } from "../tasks/types";
import { DEFAULT_TASK_WORKFLOW_ID } from "../workflows/defaultWorkflows";
import { WorkflowConflictError, WorkflowRunConflictError, type WorkflowDefinition } from "../workflows/types";
import { canonical, sha256 } from "./canonical";
import type { CommandLedger, LedgerCommand } from "./CommandLedger";
import { orchestrationLists, safeSchedule, safeTask } from "./orchestrationDto";
import { publicError } from "./publicError";

const MAX_WORKFLOW_BYTES = 200 * 1024;
const id = z.string().min(1).max(200);
const commandId = z.string().min(8).max(100);
const priority = z.enum(["low", "normal", "high"]);
// Full access is set up on the host itself: from a device, steps ask for approval (R5-2).
const access = z.enum(["ask", "default"]);
const taskFields = {
  title: z.string().trim().min(1).max(500), description: z.string().max(100_000),
  workflowId: id, priority, accessMode: access
};
const scheduleFields = {
  title: z.string().trim().min(1).max(500), description: z.string().max(100_000), workflowId: id, priority,
  frequency: z.enum(["daily", "weekly"]), weekday: z.number().int().min(0).max(6).transform(day => day as ScheduleWeekday), time: z.string().min(1).max(10), timezone: z.string().min(1).max(100),
  enabled: z.boolean(), accessMode: access
};
const workflow = z.record(z.string(), z.unknown()).refine(value => Buffer.byteLength(JSON.stringify(value)) <= MAX_WORKFLOW_BYTES, "The workflow is too large.");
const schemas = {
  snapshot: z.object({ revision: z.string().max(100).optional() }).strict().optional(),
  taskCreate: z.object({ commandId, ...taskFields, description: taskFields.description.optional(), workflowId: id.optional(), priority: priority.optional(),
    accessMode: access.optional() }).strict(),
  taskUpdate: z.object({ taskId: id, patch: z.object({ ...taskFields,
    status: z.enum(["todo", "in_progress", "backlog", "queued", "running", "waiting", "interrupted", "blocked", "done", "failed", "cancelled"]) }).partial().strict() }).strict(),
  task: z.object({ taskId: id }).strict(),
  taskRun: z.object({ commandId, taskId: id }).strict(),
  runNext: z.object({ commandId }).strict(),
  scheduleCreate: z.object({ commandId, ...scheduleFields, description: scheduleFields.description.optional(), workflowId: id.optional(),
    priority: priority.optional(), frequency: scheduleFields.frequency.optional(), weekday: scheduleFields.weekday.optional(),
    enabled: z.boolean().optional(), accessMode: access.optional() }).strict(),
  scheduleUpdate: z.object({ scheduleId: id, patch: z.object(scheduleFields).partial().strict() }).strict(),
  schedule: z.object({ scheduleId: id }).strict(),
  validate: z.object({ workflow }).strict(),
  save: z.object({ commandId, workflow, expectedUpdatedAt: z.string().max(40).nullable() }).strict()
};

const LATER = {
  attachments: "Attachments for tasks on the server come in a later update.",
  project: "Projects and folders for work on the server come in a later update.",
  fullAccess: "Full access is not available from a device yet: on the server, steps ask for approval.",
  plugins: "Plugins in workflows on the server come in a later update."
};
const unsupported = (message: string) => new RemoteOperationError(message, "unsupported");
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Settings a device cannot make on the host yet, checked before the schema so the answer says why. */
const refuseLater = (fields: Record<string, unknown>): void => {
  if (Array.isArray(fields.attachments) && fields.attachments.length) throw unsupported(LATER.attachments);
  if (fields.projectId !== undefined && fields.projectId !== null) throw unsupported(LATER.project);
  if (fields.accessMode === "full") throw unsupported(LATER.fullAccess);
};

/** What a workflow sent from a device may not contain yet (see LATER). */
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
  /** True while the host drains: new work is refused; reads, cancels and reviews still answer. */
  isDraining(): boolean;
}

/** Tasks & workflows on the host for a paired device (R5-2): lists, tasks, schedules and
 * workflows. Calls the services directly, never the HTTP API. Commands go through the ledger, so a
 * command resent after a lost answer acts once. */
export const createOrchestrationOperations = (deps: OrchestrationOperationDependencies): Record<string, RemoteOperation> => {
  const runtime = () => deps.runtimeManager.getRuntime();
  const draining = () => new RemoteOperationError("The server is shutting down. Try again when it is back.", "host_draining");
  const mutable = () => { if (deps.isDraining()) throw draining(); };
  const command = <T>(context: OperationContext, operation: string, input: { commandId: string }, execute: () => Promise<T>,
    options: Pick<LedgerCommand<T>, "target" | "reconcile"> = {}): Promise<T> => {
    const { commandId: key, ...payload } = input;
    return deps.ledger.run({ scope: deps.scopeOf(context), key, operation, payload, accepting: () => !deps.isDraining(), ...options }, execute);
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
      refuseLater(record(payload));
      const input = parse(schemas.taskCreate, payload);
      return command(context, "tasks.create", input, async () => safeTask(await runtime().taskService.create({
        title: input.title, description: (input.description ?? "").trim(), workflowId: input.workflowId || DEFAULT_TASK_WORKFLOW_ID,
        priority: input.priority ?? "normal", accessMode: input.accessMode ?? "default" })));
    }),
    "tasks.update": payload => known(async () => {
      refuseLater(record(record(payload).patch));
      const { taskId, patch } = parse(schemas.taskUpdate, payload);
      mutable();
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
        if (!await runtime().taskService.get(input.taskId)) throw notFound("task");
        const started = await runtime().taskService.startTask(input.taskId);
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
        const started = await runtime().taskService.startNextQueued();
        return started ? { task: safeTask(started.task), runId: started.runId } : { task: null, runId: null };
      });
    }),

    "schedules.create": (payload, context) => known(async () => {
      refuseLater(record(payload));
      const input = parse(schemas.scheduleCreate, payload);
      const { commandId: _commandId, ...fields } = input;
      return command(context, "schedules.create", input, async () => safeSchedule(await runtime().scheduleService.create({
        ...fields, description: fields.description ?? "", workflowId: fields.workflowId || DEFAULT_TASK_WORKFLOW_ID })));
    }),
    "schedules.update": payload => known(async () => {
      refuseLater(record(record(payload).patch));
      const { scheduleId, patch } = parse(schemas.scheduleUpdate, payload);
      mutable();
      const schedule = await runtime().scheduleService.update(scheduleId, patch);
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
    /** `expectedUpdatedAt`: the version the editor started from, null for a new workflow. */
    "workflows.save": (payload, context) => known(async () => {
      const input = parse(schemas.save, payload);
      const limits = workflowLimits(input.workflow);
      if (limits.length) throw unsupported(limits[0]!);
      return command(context, "workflows.save", input, () =>
        runtime().workflowStore.save(input.workflow as unknown as WorkflowDefinition, { expectedUpdatedAt: input.expectedUpdatedAt }));
    })
  };
};
