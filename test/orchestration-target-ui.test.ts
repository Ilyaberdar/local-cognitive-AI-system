import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { bootApp, flush, SESSION_ID, type Harness } from "./fixtures/appHarness";

const HOST = "6f1c2c3e-58a4-4c55-9a0e-3c7f5b1d2e90";
const T0 = "2026-10-01T10:00:00.000Z";
const settle = async () => { await flush(30); await new Promise(resolve => setTimeout(resolve, 150)); await flush(10); };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const WORKFLOW = { id: "default-task-workflow", name: "Default Task Workflow", version: 1, description: "", entryNodeId: "entry",
  nodes: [
    { id: "entry", type: "entry", label: "Entry", position: { x: 0, y: 0 }, config: {} },
    { id: "work", type: "agent", label: "Work", position: { x: 320, y: 0 }, config: {} },
    { id: "done", type: "terminal", label: "Done", position: { x: 640, y: 0 }, config: { runStatus: "done" } }],
  transitions: [
    { id: "entry-work", from: "entry", to: "work", priority: 100, guard: { type: "always" } },
    { id: "work-done", from: "work", to: "done", priority: 100, guard: { type: "always" } }],
  createdAt: T0, updatedAt: T0 };

/** This computer's tasks, schedules, workflows and runs behind a fake local API. */
export function localOrchestration() {
  const db = { tasks: [] as any[], schedules: [] as any[], runs: [] as any[], next: 1 };
  const newRun = (extra: Record<string, unknown>) => {
    const run = { id: `run-${db.next++}`, workflowId: WORKFLOW.id, workflowVersion: 1, workflowSnapshot: WORKFLOW, status: "running", currentNodeId: "work",
      state: {}, createdAt: T0, updatedAt: T0, ...extra };
    db.runs.unshift(run);
    return run;
  };
  const detail = (id: string) => ({ run: db.runs.find(run => run.id === id),
    nodeRuns: [{ id: `node-${id}`, runId: id, nodeId: "work", status: "running", agentRunId: `agent-${id}`, startedAt: T0 }] });
  const bootstrap = () => copy({
    providers: [{ id: "ollama", name: "Ollama", capabilities: { local: true } }], tools: [], plugins: [], pluginStatuses: [],
    tasks: db.tasks, schedules: db.schedules, workflows: [WORKFLOW], workflowRuns: db.runs, projects: [],
    appSettings: { ui: { theme: "dark", animations: false }, llm: { defaultProvider: "ollama" }, providers: { ollama: { model: "llama3.2", enabled: true } } },
    sessions: [{ id: SESSION_ID, title: "First chat", updatedAt: T0 }],
    availableModels: [], loadedModels: [{ providerId: "ollama", id: "llama3.2" }], allManagedModels: [], localModels: { runtime: { status: "stopped" } }, systemMetrics: {}
  });
  const answer = (method: string, path: string, body: any): unknown => {
    if (path === "/dashboard/bootstrap") return bootstrap();
    if (path === "/tasks" && method === "GET") return db.tasks;
    if (path === "/tasks" && method === "POST") {
      const task = { id: `task-${db.next++}`, status: "todo", createdAt: T0, updatedAt: T0, ...body };
      db.tasks.push(task);
      return task;
    }
    let match = /^\/tasks\/([^/]+)\/run$/.exec(path);
    if (match && method === "POST") {
      const task = db.tasks.find(item => item.id === match![1]);
      const run = newRun({ taskId: task.id, source: "task" });
      Object.assign(task, { lastRunId: run.id, status: "in_progress" });
      return { task, runId: run.id };
    }
    match = /^\/tasks\/([^/]+)$/.exec(path);
    if (match && method === "DELETE") { db.tasks = db.tasks.filter(item => item.id !== match![1]); return { ok: true }; }
    if (path === "/schedules" && method === "POST") {
      const schedule = { id: `schedule-${db.next++}`, enabled: true, nextRunAt: T0, createdAt: T0, updatedAt: T0, ...body };
      db.schedules.push(schedule);
      return schedule;
    }
    match = /^\/schedules\/([^/]+)$/.exec(path);
    if (match && method === "PATCH") return Object.assign(db.schedules.find(item => item.id === match![1]), body);
    if (match && method === "DELETE") { db.schedules = db.schedules.filter(item => item.id !== match![1]); return { ok: true }; }
    if (path === "/workflow-runs" && method === "GET") return db.runs;
    if (path === "/workflow-runs" && method === "POST") return newRun({ source: "standalone" });
    match = /^\/workflow-runs\/([^/]+)$/.exec(path);
    if (match && method === "GET") return detail(match[1]!);
    match = /^\/workflow-runs\/([^/]+)\/(cancel|resume|review)$/.exec(path);
    if (match && method === "POST") return Object.assign(db.runs.find(run => run.id === match![1]), { status: match[2] === "cancel" ? "cancelled" : "running" });
    match = /^\/workflow-runs\/([^/]+)\/agent-runs\/([^/]+)$/.exec(path);
    if (match) return { id: match[2], status: "running", turns: [{ type: "assistant", content: "Working on it." }] };
    if (/^\/workflows\/[^/]+\/validate$/.test(path)) return { ok: true, errors: [] };
    if (/^\/workflows(\/[^/]+)?$/.test(path) && ["POST", "PUT"].includes(method)) return body;
    return undefined;
  };
  const route = (method: string, url: string, body?: string): unknown => {
    const value = answer(method, url.split("?")[0]!, body ? JSON.parse(body) : undefined);
    return value === undefined ? undefined : copy(value);
  };
  return { route, bootstrap, db };
}

const click = async (app: Harness, selector: string) => {
  const element = app.document.querySelector(selector);
  assert.ok(element, `missing ${selector}`);
  element.click();
};
const fill = (app: Harness, values: Record<string, string>) => {
  for (const [selector, value] of Object.entries(values)) {
    const field = app.document.querySelector(selector);
    assert.ok(field, `missing ${selector}`);
    field.value = value;
  }
};
const submit = (app: Harness, selector: string) => app.document.querySelector(selector).dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
const editor = (app: Harness) => { const mounted = app.editors.filter(entry => !entry.handle.unmounted).at(-1); assert.ok(mounted, "the workflow editor is mounted"); return mounted.props; };

/** Requests in order, one marker per user action. Times are masked; long bodies are pinned by hash. */
async function walkOrchestration(app: Harness) {
  const trace = [...app.requests];
  const step = async (label: string, action: () => unknown) => {
    const before = app.requests.length;
    await action();
    await settle();
    trace.push(`--- ${label}`, ...app.requests.slice(before));
  };
  await step("open #/orchestration", () => { app.window.location.hash = "#/orchestration"; });
  await step("create task", () => {
    fill(app, { "#task-title": "Write the report", "#task-description": "Summarise the week." });
    submit(app, "#task-form");
  });
  await step("run task", () => click(app, '[data-action="run-task"]'));
  const runId = app.document.querySelector("[data-agent-trace]")?.dataset.runId;
  assert.ok(runId, "the run trace shows the task's run");
  await step("editor stop", () => editor(app).onStop(runId));
  await step("editor resume", () => editor(app).onResume(runId));
  await step("editor review", () => editor(app).onReview(runId, { approved: true, comment: "Looks right" }));
  await step("editor run", () => editor(app).onRun(copy(editor(app).workflow)));
  await step("save workflow", () => click(app, '[data-action="save-workflow"]'));
  await step("agent steps", () => { app.document.querySelector("[data-agent-trace]").open = true; });
  await step("1 s tick", () => app.tick(1000));
  await step("refresh", () => click(app, '[data-action="refresh-orchestration"]'));
  await step("tasks tab", () => click(app, '[data-action="set-orchestration-tab"][data-orchestration-tab="tasks"]'));
  await step("create schedule", () => {
    fill(app, { "#schedule-title": "Weekly report", "#schedule-description": "Summarise the week.", "#schedule-timezone": "Europe/Kyiv" });
    submit(app, "#schedule-form");
  });
  await step("pause schedule", () => click(app, '[data-action="toggle-schedule"]'));
  await step("delete schedule", () => click(app, '[data-action="delete-schedule"]'));
  await step("delete task", () => click(app, '[data-action="delete-task"]'));
  return trace.map(entry => {
    const masked = entry.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<time>");
    const space = masked.indexOf(" {");
    if (space < 0 || masked.length - space < 160) return masked;
    return `${masked.slice(0, space)} <body ${createHash("sha256").update(masked.slice(space + 1)).digest("hex").slice(0, 12)}>`;
  });
}

/** The Tasks & workflows screen of this computer, recorded before it could show a server. */
const LOCAL_ORCHESTRATION_TRACE = [
  "GET /dashboard/bootstrap", "GET /integrations/available", `GET /sessions/${SESSION_ID}/messages`, `GET /sessions/${SESSION_ID}/settings`,
  "GET /local/runtime", "GET /local/downloads", "EVENTSOURCE /local/events",
  "--- open #/orchestration",
  "--- create task", "POST /tasks <body bd28257806cb>", "GET /dashboard/bootstrap", "GET /integrations/available",
  "--- run task", 'POST /tasks/task-1/run {"background":true}', "GET /dashboard/bootstrap", "GET /integrations/available", "GET /workflow-runs/run-2",
  "GET /workflow-runs/run-2", "GET /integrations/available", "EVENTSOURCE /workflow-runs/run-2/events?after=0",
  "--- editor stop", "POST /workflow-runs/run-2/cancel", "GET /workflow-runs/run-2",
  "--- editor resume", 'POST /workflow-runs/run-2/resume {"background":true}', "GET /workflow-runs/run-2",
  "--- editor review", 'POST /workflow-runs/run-2/review {"approved":true,"comment":"Looks right","background":true}', "GET /workflow-runs/run-2",
  "--- editor run", "POST /workflow-runs <body af9447084fc7>", "EVENTSOURCE /workflow-runs/run-3/events?after=0", "GET /workflow-runs/run-3",
  "--- save workflow", "POST /workflows/default-task-workflow/validate <body ea3d602fa568>", "PUT /workflows/default-task-workflow <body ea3d602fa568>",
  "GET /dashboard/bootstrap", "GET /integrations/available",
  "--- agent steps", "GET /workflow-runs/run-3/agent-runs/agent-run-3",
  "--- 1 s tick", "GET /tasks", "GET /workflow-runs", "GET /workflow-runs/run-3",
  "--- refresh", "GET /workflow-runs/run-3", "GET /integrations/available", "GET /dashboard/bootstrap", "EVENTSOURCE /workflow-runs/run-3/events?after=0",
  "GET /workflow-runs/run-3", "GET /workflow-runs/run-3", "GET /integrations/available", "EVENTSOURCE /workflow-runs/run-3/events?after=0",
  "--- tasks tab",
  "--- create schedule", "POST /schedules <body b8e4a559bab1>", "GET /dashboard/bootstrap", "GET /integrations/available",
  "--- pause schedule", 'PATCH /schedules/schedule-4 {"enabled":false}', "GET /dashboard/bootstrap", "GET /integrations/available",
  "--- delete schedule", "DELETE /schedules/schedule-4", "GET /dashboard/bootstrap", "GET /integrations/available",
  "--- delete task", "DELETE /tasks/task-1", "GET /dashboard/bootstrap", "GET /integrations/available"
];

/** A paired server that is never selected here. */
const pairedBridge = () => {
  const ok = (value: unknown) => ({ ok: true, value });
  const status = { state: "online", hostId: HOST, hostName: "fedora", serverVersion: "0.2.0", capabilities: ["chat.runs.start", "events.poll", "models.local.watch"] };
  return { status: async () => ok(status), hosts: async () => ok([{ hostId: HOST, name: "fedora", online: true, appVersion: "0.2.0", paired: true, devices: [] }]),
    connect: async () => ok(status), disconnect: async () => ok({ state: "idle" }), hostStatus: async () => ok({}), onChange() {},
    runtime: { request: async () => ok({}), send: async () => ok({}), subscribe: async () => ok(undefined), unsubscribe: async () => ok(undefined),
      watch: async () => ok(undefined), unwatch: async () => ok(undefined), onEvent() {} } };
};

test("this computer's Tasks & workflows screen makes exactly the same requests with or without a paired server", async t => {
  const plain = await bootApp(localOrchestration());
  t.after(() => plain.close());
  assert.deepEqual(await walkOrchestration(plain), LOCAL_ORCHESTRATION_TRACE);

  const paired = await bootApp({ ...localOrchestration(), remote: { bridge: pairedBridge() } });
  t.after(() => paired.close());
  assert.deepEqual(await walkOrchestration(paired), LOCAL_ORCHESTRATION_TRACE);
  assert.deepEqual(paired.bridgeCalls.filter(call => call.op.startsWith("runtime.")), [], "nothing went to the server");
});
