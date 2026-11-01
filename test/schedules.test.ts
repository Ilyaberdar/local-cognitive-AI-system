import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import test from "node:test";
import { ScheduleService, ScheduleValidationError } from "../src/schedules/ScheduleService";
import { ScheduleStore } from "../src/schedules/ScheduleStore";
import { isWithinIntervalHours, nextDailyOccurrence, nextIntervalOccurrence, nextWeeklyOccurrence } from "../src/schedules/time";
import { TaskStore } from "../src/tasks/TaskStore";
import { CreateTaskInput, Task } from "../src/tasks/types";
import type { ScheduleWeekday } from "../src/schedules/types";

const makeTmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), "lcai-schedules-"));
const kyiv = "Europe/Kyiv";

class FakeTaskService {
  readonly created: CreateTaskInput[] = [];
  readonly runCalls: string[] = [];
  readonly tasks = new Map<string, Task>();
  runError: Error | undefined;
  runStatus: Task["status"] = "done";
  /** Tasks whose run is still going (an approval waiting, say). */
  readonly active = new Set<string>();
  /** Called as each run goes: a test moves its clock here. */
  onRun: (() => void) | undefined;

  async hasActiveRun(taskId: string): Promise<boolean> {
    return this.active.has(taskId);
  }

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

    this.onRun?.();
    task.status = this.runStatus;
    return { task, runId: `run-${taskId}` };
  }
}

const createService = async (clock?: () => Date) => {
  const root = await makeTmpDir();
  const taskService = new FakeTaskService();
  const store = new ScheduleStore(path.join(root, "schedules"));
  return {
    root,
    taskService,
    store,
    service: new ScheduleService(store, taskService, undefined, clock)
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

const weeklyInput = {
  ...dailyInput,
  title: "Weekly analysis",
  frequency: "weekly" as const,
  weekday: 3 as const
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

test("weekly schedules calculate the next matching local weekday", () => {
  assert.equal(
    nextWeeklyOccurrence(new Date("2026-08-10T05:30:00.000Z"), 1, "09:00", kyiv).toISOString(),
    "2026-08-10T06:00:00.000Z"
  );
  assert.equal(
    nextWeeklyOccurrence(new Date("2026-08-10T06:00:00.000Z"), 1, "09:00", kyiv).toISOString(),
    "2026-08-17T06:00:00.000Z"
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

test("a weekly schedule creates and runs a task, then advances to the following week", async () => {
  const { service, taskService } = await createService();
  const beforeRun = new Date("2026-08-10T05:30:00.000Z");
  const schedule = await service.create(weeklyInput, beforeRun);
  const dueAt = new Date("2026-08-12T06:00:01.000Z");

  assert.equal(schedule.frequency, "weekly");
  assert.equal(schedule.weekday, 3);
  assert.equal(schedule.nextRunAt, "2026-08-12T06:00:00.000Z");

  const results = await service.runDue(dueAt);
  const updated = await service.get(schedule.id);

  assert.deepEqual(results, [{
    scheduleId: schedule.id,
    taskId: "task-1",
    runId: "run-task-1"
  }]);
  assert.equal(taskService.created[0].scheduledFor, "2026-08-12T06:00:00.000Z");
  assert.equal(updated?.nextRunAt, "2026-08-19T06:00:00.000Z");
});

test("changing a daily schedule to weekly resets its next occurrence", async () => {
  const { service } = await createService();
  const now = new Date("2026-08-10T05:30:00.000Z");
  const schedule = await service.create(dailyInput, now);

  const updated = await service.update(schedule.id, { frequency: "weekly", weekday: 5 }, now);

  assert.equal(updated?.frequency, "weekly");
  assert.equal(updated?.weekday, 5);
  assert.equal(updated?.nextRunAt, "2026-08-14T06:00:00.000Z");
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

test("a run that waits for approval is not a failed run", async () => {
  const { service, taskService } = await createService();
  const schedule = await service.create(dailyInput, new Date("2026-08-10T05:30:00.000Z"));
  taskService.runStatus = "waiting";

  const results = await service.runDue(new Date("2026-08-10T06:00:01.000Z"));
  const updated = await service.get(schedule.id);

  assert.deepEqual(results, [{ scheduleId: schedule.id, taskId: "task-1", runId: "run-task-1" }]);
  assert.equal(updated?.lastError, undefined);
  assert.equal(updated?.lastTaskId, "task-1");
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

test("schedule input rejects invalid times, timezones, and weekly weekdays", async () => {
  const { service } = await createService();

  await assert.rejects(
    () => service.create({ ...dailyInput, time: "27:00" }),
    (error: unknown) => error instanceof ScheduleValidationError && /HH:mm/.test(error.message)
  );
  await assert.rejects(
    () => service.create({ ...dailyInput, timezone: "not/a-timezone" }),
    (error: unknown) => error instanceof ScheduleValidationError && /IANA timezone/.test(error.message)
  );
  await assert.rejects(
    () => service.create({ ...dailyInput, frequency: "weekly" }),
    (error: unknown) => error instanceof ScheduleValidationError && /weekday/.test(error.message)
  );
  await assert.rejects(
    () => service.create({ ...weeklyInput, weekday: 7 as unknown as 3 }),
    (error: unknown) => error instanceof ScheduleValidationError && /weekday/.test(error.message)
  );
});

const intervalInput = {
  ...dailyInput,
  title: "Check the news",
  frequency: "interval" as const,
  intervalMinutes: 30,
  time: "08:00",
  windowEnd: "22:00"
};

test("an interval schedule runs every interval within its hours, the last time included", () => {
  const rule = { time: "08:00", intervalMinutes: 30, windowEnd: "22:00" };
  // 08:40 in Kyiv (UTC+3 in August) → 09:00.
  assert.equal(nextIntervalOccurrence(new Date("2026-08-10T05:40:00.000Z"), rule, kyiv).toISOString(), "2026-08-10T06:00:00.000Z");
  // 21:59 → 22:00, the end of the hours.
  assert.equal(nextIntervalOccurrence(new Date("2026-08-10T18:59:00.000Z"), rule, kyiv).toISOString(), "2026-08-10T19:00:00.000Z");
  // 22:00 → tomorrow's first run at 08:00.
  assert.equal(nextIntervalOccurrence(new Date("2026-08-10T19:00:00.000Z"), rule, kyiv).toISOString(), "2026-08-11T05:00:00.000Z");
  // Before the hours start.
  assert.equal(nextIntervalOccurrence(new Date("2026-08-10T01:00:00.000Z"), rule, kyiv).toISOString(), "2026-08-10T05:00:00.000Z");
});

test("an interval that does not divide the day starts again at its time each day", () => {
  const rule = { time: "00:00", intervalMinutes: 7 * 60 };
  // 00:00, 07:00, 14:00, 21:00, then the next day's 00:00 (Kyiv, UTC+3).
  assert.equal(nextIntervalOccurrence(new Date("2026-08-10T18:00:00.000Z"), rule, kyiv).toISOString(), "2026-08-10T21:00:00.000Z");
});

test("hours that cross midnight belong to the day they start, for the days chosen", () => {
  // Fridays from 22:00 to 02:00; 2026-08-14 is a Friday.
  const rule = { time: "22:00", intervalMinutes: 30, windowEnd: "02:00", weekdays: [5] };
  // Saturday 01:10 local is still Friday's hours → 01:30.
  assert.equal(nextIntervalOccurrence(new Date("2026-08-14T22:10:00.000Z"), rule, kyiv).toISOString(), "2026-08-14T22:30:00.000Z");
  // Saturday 02:00 was the last; the next is the following Friday at 22:00.
  assert.equal(nextIntervalOccurrence(new Date("2026-08-14T23:00:00.000Z"), rule, kyiv).toISOString(), "2026-08-21T19:00:00.000Z");
  assert.equal(isWithinIntervalHours(new Date("2026-08-14T22:10:00.000Z"), rule, kyiv), true);
  assert.equal(isWithinIntervalHours(new Date("2026-08-15T10:00:00.000Z"), rule, kyiv), false);
});

test("an interval schedule's days and hours decide whether a time is within them", () => {
  const weekdays = { time: "08:00", intervalMinutes: 60, windowEnd: "22:00", weekdays: [1, 2, 3, 4, 5] };
  assert.equal(isWithinIntervalHours(new Date("2026-08-10T07:00:00.000Z"), weekdays, kyiv), true); // Monday 10:00
  assert.equal(isWithinIntervalHours(new Date("2026-08-10T20:00:00.000Z"), weekdays, kyiv), false); // Monday 23:00
  assert.equal(isWithinIntervalHours(new Date("2026-08-15T07:00:00.000Z"), weekdays, kyiv), false); // Saturday 10:00
  // Friday 22:00 → Monday 08:00.
  assert.equal(nextIntervalOccurrence(new Date("2026-08-14T19:00:00.000Z"), weekdays, kyiv).toISOString(), "2026-08-17T05:00:00.000Z");
});

test("interval runs keep going forward through both daylight-saving changes", async () => {
  const { service } = await createService();
  // 29 March 2026: Kyiv skips 03:00–03:59, so 02:30 is followed by 04:00 (01:00 UTC).
  assert.equal(nextIntervalOccurrence(new Date("2026-03-29T00:45:00.000Z"), { time: "00:00", intervalMinutes: 30 }, kyiv).toISOString(), "2026-03-29T01:00:00.000Z");
  // 25 October 2026: Kyiv repeats 03:00–03:59; each run is later than the one before.
  for (const start of ["2026-03-28T21:00:00.000Z", "2026-10-24T21:00:00.000Z"]) {
    const runs = service.preview({ frequency: "interval", intervalMinutes: 30, time: "00:00", timezone: kyiv }, new Date(start), 20).map(Date.parse);
    assert.equal(runs.length, 20);
    runs.slice(1).forEach((run, index) => assert.ok(run > runs[index], `run ${index + 1} goes forward`));
  }
});

test("interval schedule input is checked, and every day is kept as no days at all", async () => {
  const { service } = await createService();
  const now = new Date("2026-08-10T05:40:00.000Z");
  const bad: Array<Record<string, unknown>> = [
    { intervalMinutes: undefined }, { intervalMinutes: 4 }, { intervalMinutes: 1441 }, { intervalMinutes: 30.5 },
    { windowEnd: "08:00" }, { windowEnd: "25:00" }, { weekdays: [] }, { weekdays: [7] }
  ];
  for (const fields of bad) {
    await assert.rejects(service.create({ ...intervalInput, ...fields } as never, now), ScheduleValidationError, JSON.stringify(fields));
  }
  const everyDay = await service.create({ ...intervalInput, weekdays: [0, 1, 2, 3, 4, 5, 6, 3] as ScheduleWeekday[] }, now);
  assert.equal(everyDay.weekdays, undefined);
  const weekdays = await service.create({ ...intervalInput, weekdays: [5, 1, 3, 1] as ScheduleWeekday[] }, now);
  assert.deepEqual(weekdays.weekdays, [1, 3, 5]);
  assert.equal(weekdays.nextRunAt, "2026-08-10T06:00:00.000Z");
  // A daily schedule keeps none of an interval's fields.
  const daily = await service.create({ ...dailyInput, intervalMinutes: 30, windowEnd: "22:00", weekdays: [1] as ScheduleWeekday[] }, now);
  assert.equal(daily.intervalMinutes, undefined);
  assert.equal(daily.windowEnd, undefined);
  assert.equal(daily.weekdays, undefined);
});

test("changing an interval schedule to daily drops its interval and resets the next run", async () => {
  const { service } = await createService();
  const now = new Date("2026-08-10T05:40:00.000Z");
  const schedule = await service.create(intervalInput, now);
  const daily = await service.update(schedule.id, { frequency: "daily", time: "09:00" }, now);
  assert.equal(daily?.frequency, "daily");
  assert.equal(daily?.intervalMinutes, undefined);
  assert.equal(daily?.windowEnd, undefined);
  assert.equal(daily?.nextRunAt, "2026-08-10T06:00:00.000Z");
  const hourly = await service.update(schedule.id, { frequency: "interval", intervalMinutes: 60, windowEnd: null, time: "00:00" }, now);
  assert.equal(hourly?.windowEnd, undefined);
  assert.equal(hourly?.nextRunAt, "2026-08-10T06:00:00.000Z");
});

test("an interval run is left out while the previous one is still going, and counted", async () => {
  let clock = new Date("2026-08-10T06:00:01.000Z");
  const { service, taskService } = await createService(() => clock);
  const schedule = await service.create(intervalInput, new Date("2026-08-10T05:40:00.000Z"));

  await service.runDue(clock);
  assert.equal(taskService.created.length, 1);
  taskService.active.add("task-1"); // it stopped at an approval and goes on afterwards

  clock = new Date("2026-08-10T06:30:02.000Z");
  assert.deepEqual(await service.runDue(clock), [{ scheduleId: schedule.id, taskId: "task-1", skipped: "overlapping_run" }]);
  clock = new Date("2026-08-10T07:00:02.000Z");
  await service.runDue(clock);
  assert.equal(taskService.created.length, 1);
  let current = await service.get(schedule.id);
  assert.equal(current?.skippedRuns, 2);
  assert.equal(current?.lastSkippedAt, "2026-08-10T07:00:00.000Z");
  assert.equal(current?.nextRunAt, "2026-08-10T07:30:00.000Z");

  taskService.active.delete("task-1");
  clock = new Date("2026-08-10T07:30:02.000Z");
  await service.runDue(clock);
  assert.equal(taskService.created.length, 2);
  current = await service.get(schedule.id);
  assert.equal(current?.skippedRuns, undefined);
  assert.equal(current?.lastTaskId, "task-2");
});

test("an interval run longer than its interval is not followed by another at once", async () => {
  let clock = new Date("2026-08-10T06:00:01.000Z");
  const { service, taskService } = await createService(() => clock);
  const schedule = await service.create(intervalInput, new Date("2026-08-10T05:40:00.000Z"));
  taskService.onRun = () => { clock = new Date("2026-08-10T07:10:00.000Z"); }; // the run takes 70 minutes

  await service.runDue(new Date("2026-08-10T06:00:01.000Z"));
  assert.equal((await service.get(schedule.id))?.nextRunAt, "2026-08-10T07:30:00.000Z");
  assert.deepEqual(await service.runDue(clock), []);
  assert.equal(taskService.created.length, 1);
});

test("a late interval schedule catches up once within its hours, and not at all outside them", async () => {
  let clock = new Date("2026-08-10T10:10:00.000Z");
  const { service, taskService } = await createService(() => clock);
  const inside = await service.create(intervalInput, new Date("2026-08-10T05:40:00.000Z"));
  const outside = await service.create({ ...intervalInput, title: "Outside" }, new Date("2026-08-10T05:40:00.000Z"));

  // 13:10 in Kyiv, hours missed since 09:00: one run now, then 13:30.
  await service.update(outside.id, { enabled: false }, clock);
  await service.runDue(clock);
  assert.equal(taskService.created.length, 1);
  assert.equal((await service.get(inside.id))?.nextRunAt, "2026-08-10T10:30:00.000Z");

  // Back on at 02:00 at night (outside 08:00–22:00): no run, the next is 08:00.
  clock = new Date("2026-08-10T23:00:00.000Z");
  await service.update(outside.id, { enabled: true }, new Date("2026-08-10T05:40:00.000Z"));
  assert.deepEqual(await service.runDue(clock), []);
  assert.equal(taskService.created.length, 1);
  assert.equal((await service.get(outside.id))?.nextRunAt, "2026-08-11T05:00:00.000Z");
});

test("a schedule this version cannot read is reported once and never stops the others", async () => {
  const { service, store, taskService } = await createService();
  const daily = await service.create(dailyInput, new Date("2026-08-10T05:30:00.000Z"));
  const strange = await service.create({ ...dailyInput, title: "From a newer version" }, new Date("2026-08-10T05:30:00.000Z"));
  await store.update(strange.id, { frequency: "fortnightly" as never });
  const dueAt = new Date("2026-08-10T06:00:01.000Z");

  const results = await service.runDue(dueAt);
  assert.equal(results.find((result) => result.scheduleId === daily.id)?.taskId, "task-1");
  assert.match(results.find((result) => result.scheduleId === strange.id)?.error ?? "", /does not know/);
  assert.match((await service.get(strange.id))?.lastError ?? "", /does not know/);
  assert.deepEqual(await service.runDue(dueAt), []);
});

test("a schedule's preview lists its next runs without saving anything", async () => {
  const { service } = await createService();
  assert.deepEqual(
    service.preview({ frequency: "interval", intervalMinutes: 30, time: "08:00", windowEnd: "09:00", timezone: kyiv }, new Date("2026-08-10T05:40:00.000Z"), 4),
    // 08:00, 08:30 and 09:00 each day: from 08:40 today, 09:00, then tomorrow's three.
    ["2026-08-10T06:00:00.000Z", "2026-08-11T05:00:00.000Z", "2026-08-11T05:30:00.000Z", "2026-08-11T06:00:00.000Z"]
  );
  assert.deepEqual(await service.list(), []);
  assert.throws(() => service.preview({ frequency: "interval", intervalMinutes: 2, time: "08:00", timezone: kyiv }), ScheduleValidationError);
});
