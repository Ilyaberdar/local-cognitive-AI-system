import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import test from "node:test";
import { ScheduleService, ScheduleValidationError } from "../src/schedules/ScheduleService";
import { ScheduleStore } from "../src/schedules/ScheduleStore";
import { nextDailyOccurrence } from "../src/schedules/time";
import { TaskStore } from "../src/tasks/TaskStore";
import { CreateTaskInput, Task } from "../src/tasks/types";

const makeTmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), "lcai-schedules-"));
const kyiv = "Europe/Kyiv";

class FakeTaskService {
  readonly created: CreateTaskInput[] = [];
  readonly runCalls: string[] = [];
  readonly tasks = new Map<string, Task>();
  runError: Error | undefined;
  runStatus: Task["status"] = "done";

  async create(input: CreateTaskInput): Promise<Task> {
    const id = `task-${this.created.length + 1}`;
    const timestamp = new Date(0).toISOString();
    const task: Task = {
      id,
      title: input.title,
      description: input.description,
      workflowId: input.workflowId,
      priority: input.priority ?? "normal",
      sessionId: input.sessionId,
      scheduledFor: input.scheduledFor,
      metadata: input.metadata,
      status: "todo",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.created.push(input);
    this.tasks.set(id, task);
    return task;
  }

  async get(taskId: string): Promise<Task | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async findByScheduleOccurrence(scheduleId: string, occurrenceAt: string): Promise<Task | null> {
    return [...this.tasks.values()].find((task) =>
      task.metadata?.scheduleId === scheduleId &&
      task.metadata?.scheduleOccurrenceAt === occurrenceAt
    ) ?? null;
  }

  async runTask(taskId: string): Promise<{ task: Task; runId: string }> {
    this.runCalls.push(taskId);
    const task = this.tasks.get(taskId);

    if (!task) {
      throw new Error("Task was not found.");
    }

    if (this.runError) {
      throw this.runError;
    }

    task.status = this.runStatus;
    return { task, runId: `run-${taskId}` };
  }
}

const createService = async () => {
  const root = await makeTmpDir();
  const taskService = new FakeTaskService();
  const store = new ScheduleStore(path.join(root, "schedules"));
  return {
    taskService,
    store,
    service: new ScheduleService(store, taskService)
  };
};

const dailyInput = {
  title: "Daily analysis",
  description: "Analyze the latest data.",
  workflowId: "default-task-workflow",
  priority: "high" as const,
  time: "09:00",
  timezone: kyiv,
  sessionId: "analysis-session"
};

test("daily schedules calculate the next occurrence in their IANA timezone", () => {
  assert.equal(
    nextDailyOccurrence(new Date("2026-08-10T05:30:00.000Z"), "09:00", kyiv).toISOString(),
    "2026-08-10T06:00:00.000Z"
  );
  assert.equal(
    nextDailyOccurrence(new Date("2026-01-10T06:30:00.000Z"), "09:00", kyiv).toISOString(),
    "2026-01-10T07:00:00.000Z"
  );
});

test("a due schedule creates and runs a new task, then advances to tomorrow", async () => {
  const { service, taskService } = await createService();
  const beforeRun = new Date("2026-08-10T05:30:00.000Z");
  const schedule = await service.create(dailyInput, beforeRun);
  const dueAt = new Date("2026-08-10T06:00:01.000Z");

  assert.equal(schedule.nextRunAt, "2026-08-10T06:00:00.000Z");

  const results = await service.runDue(dueAt);
  const updated = await service.get(schedule.id);

  assert.deepEqual(results, [{
    scheduleId: schedule.id,
    taskId: "task-1",
    runId: "run-task-1"
  }]);
  assert.equal(taskService.created.length, 1);
  assert.equal(taskService.runCalls.length, 1);
  assert.equal(taskService.created[0].scheduledFor, schedule.nextRunAt);
  assert.deepEqual(taskService.created[0].metadata, {
    scheduleId: schedule.id,
    scheduleOccurrenceAt: schedule.nextRunAt
  });
  assert.equal(updated?.lastTaskId, "task-1");
  assert.equal(updated?.lastRunAt, dueAt.toISOString());
  assert.equal(updated?.nextRunAt, "2026-08-11T06:00:00.000Z");
  assert.equal(updated?.lastError, undefined);

  assert.deepEqual(await service.runDue(dueAt), []);
  assert.equal(taskService.created.length, 1);
});

test("paused schedules are skipped and a waiting previous task does not block tomorrow's task", async () => {
  const { service, taskService } = await createService();
  const beforeRun = new Date("2026-08-10T05:30:00.000Z");
  const paused = await service.create(dailyInput, beforeRun);
  await service.update(paused.id, { enabled: false }, beforeRun);

  assert.deepEqual(await service.runDue(new Date("2026-08-10T06:00:01.000Z")), []);
  assert.equal(taskService.created.length, 0);

  const active = await service.create({ ...dailyInput, title: "Active prior run" }, beforeRun);
  const first = await service.runDue(new Date("2026-08-10T06:00:01.000Z"));
  assert.equal(first.length, 1);
  const previousTask = taskService.tasks.get("task-1");
  assert.ok(previousTask);
  previousTask.status = "waiting";

  const secondDue = new Date("2026-08-11T06:00:01.000Z");
  const results = await service.runDue(secondDue);
  const updated = await service.get(active.id);

  assert.deepEqual(results, [{
    scheduleId: active.id,
    taskId: "task-2",
    runId: "run-task-2"
  }]);
  assert.equal(taskService.created.length, 2);
  assert.equal(updated?.nextRunAt, "2026-08-12T06:00:00.000Z");
});

test("a dispatch failure is persisted and retried at the next daily occurrence", async () => {
  const { service, taskService } = await createService();
  const schedule = await service.create(dailyInput, new Date("2026-08-10T05:30:00.000Z"));
  taskService.runError = new Error("provider unavailable");

  const results = await service.runDue(new Date("2026-08-10T06:00:01.000Z"));
  const updated = await service.get(schedule.id);

  assert.deepEqual(results, [{
    scheduleId: schedule.id,
    taskId: "task-1",
    error: "provider unavailable"
  }]);
  assert.equal(updated?.lastError, "provider unavailable");
  assert.equal(updated?.lastTaskId, "task-1");
  assert.equal(updated?.nextRunAt, "2026-08-11T06:00:00.000Z");
});

test("a claimed occurrence is recovered after a restart without creating a duplicate task", async () => {
  const { service, store, taskService } = await createService();
  const beforeRun = new Date("2026-08-10T05:30:00.000Z");
  const schedule = await service.create(dailyInput, beforeRun);
  const claimed = await store.claimDispatch(
    schedule.id,
    schedule.nextRunAt,
    "2026-08-11T06:00:00.000Z"
  );

  assert.equal(claimed?.activeOccurrenceAt, "2026-08-10T06:00:00.000Z");
  assert.equal(claimed?.nextRunAt, "2026-08-11T06:00:00.000Z");

  const results = await service.runDue(new Date("2026-08-10T06:00:01.000Z"));
  const recovered = await service.get(schedule.id);

  assert.deepEqual(results, [{
    scheduleId: schedule.id,
    taskId: "task-1",
    runId: "run-task-1"
  }]);
  assert.equal(taskService.created.length, 1);
  assert.equal(recovered?.activeOccurrenceAt, undefined);
  assert.equal(recovered?.nextRunAt, "2026-08-11T06:00:00.000Z");
});

test("an in-progress claimed task is resumed after a restart without duplication", async () => {
  const { service, store, taskService } = await createService();
  const beforeRun = new Date("2026-08-10T05:30:00.000Z");
  const schedule = await service.create(dailyInput, beforeRun);
  const claimed = await store.claimDispatch(
    schedule.id,
    schedule.nextRunAt,
    "2026-08-11T06:00:00.000Z"
  );
  const occurrenceAt = claimed?.activeOccurrenceAt;

  assert.ok(occurrenceAt);
  taskService.tasks.set("task-recovered", {
    id: "task-recovered",
    title: schedule.title,
    description: schedule.description,
    workflowId: schedule.workflowId,
    priority: schedule.priority,
    scheduledFor: occurrenceAt,
    metadata: {
      scheduleId: schedule.id,
      scheduleOccurrenceAt: occurrenceAt
    },
    status: "in_progress",
    createdAt: beforeRun.toISOString(),
    updatedAt: beforeRun.toISOString()
  });

  const results = await service.runDue(new Date("2026-08-10T06:00:01.000Z"));
  const recovered = await service.get(schedule.id);

  assert.deepEqual(results, [{
    scheduleId: schedule.id,
    taskId: "task-recovered",
    runId: "run-task-recovered"
  }]);
  assert.deepEqual(taskService.runCalls, ["task-recovered"]);
  assert.equal(taskService.created.length, 0);
  assert.equal(recovered?.activeOccurrenceAt, undefined);
  assert.equal(recovered?.nextRunAt, "2026-08-11T06:00:00.000Z");
});

test("a failed workflow status is recorded as a failed scheduled run", async () => {
  const { service, taskService } = await createService();
  const schedule = await service.create(dailyInput, new Date("2026-08-10T05:30:00.000Z"));
  taskService.runStatus = "failed";

  const results = await service.runDue(new Date("2026-08-10T06:00:01.000Z"));
  const updated = await service.get(schedule.id);
  const error = "Workflow run run-task-1 ended with task status \"failed\".";

  assert.deepEqual(results, [{
    scheduleId: schedule.id,
    taskId: "task-1",
    runId: "run-task-1",
    error
  }]);
  assert.equal(updated?.lastError, error);
});

test("a malformed schedule store is preserved instead of being overwritten", async () => {
  const root = await makeTmpDir();
  const schedulesDir = path.join(root, "schedules");
  const store = new ScheduleStore(schedulesDir);
  await store.list();
  const filePath = path.join(schedulesDir, "schedules.json");
  await fs.writeFile(filePath, "{}", "utf8");

  await assert.rejects(() => store.list(), /Could not parse schedule store/);
  assert.equal(await fs.readFile(filePath, "utf8"), "{}");
});

test("scheduled task lookup is durable and malformed task storage is preserved", async () => {
  const root = await makeTmpDir();
  const tasksDir = path.join(root, "tasks");
  const store = new TaskStore(tasksDir);
  const occurrenceAt = "2026-08-10T06:00:00.000Z";
  const task = await store.create({
    title: "Scheduled analysis",
    description: "Analyze the latest data.",
    workflowId: "default-task-workflow",
    scheduledFor: occurrenceAt,
    metadata: {
      scheduleId: "schedule-1",
      scheduleOccurrenceAt: occurrenceAt
    }
  });

  assert.equal(
    (await store.findByScheduleOccurrence("schedule-1", occurrenceAt))?.id,
    task.id
  );

  const filePath = path.join(tasksDir, "tasks.json");
  await fs.writeFile(filePath, "{}", "utf8");

  await assert.rejects(() => store.list(), /Could not parse task store/);
  assert.equal(await fs.readFile(filePath, "utf8"), "{}");
});

test("schedule input rejects invalid daily times and timezones", async () => {
  const { service } = await createService();

  await assert.rejects(
    () => service.create({ ...dailyInput, time: "27:00" }),
    (error: unknown) => error instanceof ScheduleValidationError && /HH:mm/.test(error.message)
  );
  await assert.rejects(
    () => service.create({ ...dailyInput, timezone: "not/a-timezone" }),
    (error: unknown) => error instanceof ScheduleValidationError && /IANA timezone/.test(error.message)
  );
});
