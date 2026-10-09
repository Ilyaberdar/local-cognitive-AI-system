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

const SERVER_FLOW = { ...WORKFLOW, id: "server-flow", name: "Server flow" };
/** fedora with its own tasks, schedule and workflow; `setStatus` changes the connection. */
function fedoraWithTasks({ name = "fedora", capabilities = ["chat.runs.start", "events.poll", "orchestration.snapshot", "tasks.create"] } = {}) {
  let status: Record<string, unknown> = { state: "online", hostId: HOST, hostName: name, serverVersion: "0.2.0", capabilities };
  const statusListeners: Array<(value: unknown) => void> = [];
  const db = { revision: 1, tasks: [{ id: "srv-task-1", title: "Server task", description: "On fedora", status: "todo", priority: "normal", workflowId: "server-flow",
    createdAt: T0, updatedAt: T0 }] as any[], schedules: [{ id: "srv-schedule-1", title: "Server schedule", description: "", workflowId: "server-flow", priority: "normal",
    frequency: "daily", time: "09:00", timezone: "UTC", enabled: true, nextRunAt: T0, createdAt: T0, updatedAt: T0 }] as any[], runs: [] as any[], next: 1 };
  const changed = () => { db.revision++; };
  const ok = (value: unknown) => ({ ok: true, value });
  const handlers: Record<string, (payload: any) => unknown> = {
    "sessions.list": () => [],
    "projects.list": () => [{ id: "srv-project", name: "Site", folder: { rootId: "projects", rootLabel: "Projects", path: ["site"] }, archived: false },
      { id: "host-project", name: "Host work", hostOnly: true, archived: false }],
    "models.available": () => ({ providers: [], availableModels: [], loadedModels: [], allManagedModels: [], appSettings: { llm: {}, providers: {} } }),
    "orchestration.snapshot": payload => payload?.revision === `r${db.revision}` ? { revision: payload.revision, unchanged: true }
      : copy({ revision: `r${db.revision}`, workflows: [WORKFLOW, SERVER_FLOW], tasks: db.tasks, schedules: db.schedules, workflowRuns: db.runs }),
    "tasks.update": payload => { const task = db.tasks.find(item => item.id === payload.taskId); Object.assign(task, payload.patch); changed(); return copy(task); },
    "tasks.delete": payload => { db.tasks = db.tasks.filter(item => item.id !== payload.taskId); changed(); return { deleted: true }; },
    "schedules.update": payload => { const schedule = db.schedules.find(item => item.id === payload.scheduleId); Object.assign(schedule, payload.patch); changed(); return copy(schedule); },
    "schedules.delete": payload => { db.schedules = db.schedules.filter(item => item.id !== payload.scheduleId); changed(); return { deleted: true }; }
  };
  const commands: Record<string, (payload: any) => unknown> = {
    "tasks.create": payload => { const task = { id: `srv-task-${++db.next}`, status: "todo", createdAt: T0, updatedAt: T0, ...payload }; db.tasks.push(task); changed(); return copy(task); },
    "tasks.run": payload => {
      const task = db.tasks.find(item => item.id === payload.taskId);
      const run = { id: `4f1c1b0e-8d5a-4b8e-9c55-0a6b2f1e9d${String(++db.next).padStart(2, "0")}`, workflowId: "server-flow", workflowVersion: 1, status: "running", taskId: task.id,
        createdAt: T0, updatedAt: T0 };
      db.runs.unshift(run); Object.assign(task, { status: "in_progress", lastRunId: run.id }); changed();
      return { task: copy(task), runId: run.id };
    },
    "schedules.create": payload => { const schedule = { id: `srv-schedule-${++db.next}`, enabled: true, nextRunAt: T0, createdAt: T0, updatedAt: T0, ...payload }; db.schedules.push(schedule); changed(); return copy(schedule); }
  };
  const bridge = {
    status: async () => ok(status),
    hosts: async () => ok([{ hostId: HOST, name, online: true, appVersion: "0.2.0", paired: true, devices: [] }]),
    connect: async () => ok(status), disconnect: async () => ok({ state: "idle" }), hostStatus: async () => ok({}),
    onChange: (listener: (value: unknown) => void) => { statusListeners.push(listener); return () => undefined; },
    runtime: {
      request: async (op: string, payload: unknown) => handlers[op] ? ok(handlers[op]!(payload)) : { ok: false, error: { code: "unknown_operation", message: `No ${op} here.` } },
      send: async (op: string, payload: unknown) => commands[op] ? ok(commands[op]!(payload)) : { ok: false, error: { code: "unknown_operation", message: `No ${op} here.` } },
      subscribe: async () => ok(undefined), unsubscribe: async () => ok(undefined), watch: async () => ok(undefined), unwatch: async () => ok(undefined), onEvent() {}
    }
  };
  return { bridge, db, setStatus(next: Record<string, unknown>) { status = { ...status, ...next }; statusListeners.forEach(listener => listener(status)); } };
}

const text = (app: Harness, selector: string) => String(app.document.querySelector(selector)?.textContent ?? "").replace(/\s+/g, " ").trim();
/** Bridge calls as [kind, operation, payload, server], plain values of the test's realm. */
const runtimeCalls = (app: Harness, from = 0) => copy(app.bridgeCalls.slice(from).filter(call => /^runtime\.(request|send)$/.test(call.op))
  .map(call => [call.op.slice("runtime.".length), ...call.payload])) as unknown[][];
const LOCAL_ORCHESTRATION_API = /^(EVENTSOURCE |\w+ )\/(tasks|schedules|workflows|workflow-runs|integrations\/available|projects|dashboard\/bootstrap)/;
async function onFedoraTasks(app: Harness) {
  await click(app, `[data-chat-target="${HOST}"]`);
  await settle();
  app.window.location.hash = "#/orchestration";
  await settle();
}

test("with fedora selected, the Tasks tab shows fedora's work and asks this computer nothing", async t => {
  const local = localOrchestration();
  local.db.tasks.push({ id: "local-task", title: "Local task", description: "Here", status: "todo", priority: "normal", workflowId: WORKFLOW.id, createdAt: T0, updatedAt: T0 });
  const fedora = fedoraWithTasks();
  const app = await bootApp({ ...local, remote: { bridge: fedora.bridge } });
  t.after(() => app.close());
  const localBefore = app.requests.length, callsBefore = app.bridgeCalls.length;
  await onFedoraTasks(app);
  assert.match(text(app, ".orchestration-main"), /Tasks on fedora[\s\S]*Server task/);
  assert.doesNotMatch(text(app, ".route--orchestration"), /Local task/);
  assert.equal(app.document.querySelector("#task-form [data-workspace-project]"), null, "no project of this computer is offered");
  assert.equal(app.document.querySelector("#task-form .task-attachments, #task-form [data-action='attach-task-files']"), null);
  assert.equal([...app.document.querySelectorAll("#task-access option")].some((item: { value: string }) => item.value === "full"), false, "no full access on a server");

  fill(app, { "#task-title": "Server report", "#task-description": "Summarise on fedora." });
  submit(app, "#task-form");
  await settle();
  assert.match(text(app, ".task-board"), /Server report/);
  await click(app, '[data-action="run-task"][data-task-id="srv-task-1"]');
  await settle();
  assert.match(text(app, ".task-board"), /in_progress/);
  await click(app, '[data-action="toggle-schedule"][data-schedule-id="srv-schedule-1"]');
  await settle();
  await click(app, '[data-action="delete-task"][data-task-id="srv-task-1"]');
  await settle();
  assert.equal(fedora.db.tasks.some(item => item.id === "srv-task-1"), false);
  await app.tick(1000);

  assert.deepEqual(app.requests.slice(localBefore).filter(entry => LOCAL_ORCHESTRATION_API.test(entry)), [], "this computer's tasks API was not asked");
  const calls = runtimeCalls(app, callsBefore);
  assert.ok(calls.every(call => call.at(-1) === HOST), "every call names fedora");
  const sent = calls.filter(call => call[0] === "send").map(call => call[1]);
  assert.deepEqual(sent, ["tasks.create", "tasks.run"], "what creates or starts work is sent as a command");
  const created = calls.find(call => call[1] === "tasks.create")![2] as Record<string, unknown>;
  assert.deepEqual(created, { title: "Server report", description: "Summarise on fedora.", workflowId: "default-task-workflow", priority: "normal", accessMode: "default" });
  assert.deepEqual(calls.find(call => call[1] === "schedules.update")!.slice(1, 3), ["schedules.update", { scheduleId: "srv-schedule-1", patch: { enabled: false } }]);
  assert.equal(local.db.tasks.length, 1, "this computer's tasks are untouched");
});

test("offline, fedora's board stays dimmed and nothing is sent; switching back shows this computer's tasks", async t => {
  const local = localOrchestration();
  local.db.tasks.push({ id: "local-task", title: "Local task", description: "Here", status: "todo", priority: "normal", workflowId: WORKFLOW.id, createdAt: T0, updatedAt: T0 });
  const fedora = fedoraWithTasks();
  const app = await bootApp({ ...local, remote: { bridge: fedora.bridge } });
  t.after(() => app.close());
  await onFedoraTasks(app);
  fedora.setStatus({ state: "reconnecting" });
  await settle();
  assert.match(text(app, ".server-banner"), /fedora is reconnecting\. Showing the last known state; nothing is sent\./);
  assert.match(text(app, ".task-board"), /Server task/);
  const run = app.document.querySelector('[data-action="run-task"]');
  assert.equal(run.disabled, true);
  const callsBefore = app.bridgeCalls.length;
  run.click();
  await app.tick(1000);
  await settle();
  assert.deepEqual(runtimeCalls(app, callsBefore), [], "nothing is sent or queued while offline");

  await click(app, '[data-chat-target="local"]');
  await settle();
  assert.equal(app.window.location.hash, "#/orchestration");
  assert.match(text(app, ".task-board"), /Local task/);
  assert.doesNotMatch(text(app, ".task-board"), /Server task/);
  assert.equal(app.document.querySelector(".server-banner"), null);
});

test("an older fedora is asked to update and nothing is sent; fedora's name is text", async t => {
  const older = fedoraWithTasks({ capabilities: ["chat.runs.start", "events.poll"] });
  const app = await bootApp({ ...localOrchestration(), remote: { bridge: older.bridge } });
  t.after(() => app.close());
  const callsBefore = app.bridgeCalls.length;
  await onFedoraTasks(app);
  assert.match(text(app, ".route--orchestration"), /Update Local Cognitive on fedora/);
  assert.equal(runtimeCalls(app, callsBefore).some(call => String(call[1]).startsWith("orchestration.") || String(call[1]).startsWith("tasks.")), false);

  const marked = fedoraWithTasks({ name: `<img src=x onerror="globalThis.hacked=1">` });
  const other = await bootApp({ ...localOrchestration(), remote: { bridge: marked.bridge } });
  t.after(() => other.close());
  await onFedoraTasks(other);
  marked.setStatus({ state: "reconnecting" });
  await settle();
  assert.equal(other.document.querySelector(".route--orchestration img"), null);
  assert.equal(other.window.hacked, undefined);
  assert.match(text(other, ".orchestration-main"), /Tasks on <img/);
});

const RUN_ID = "4f1c1b0e-8d5a-4b8e-9c55-0a6b2f1e9d77";
const liveEvent = (sequence: number) => ({ sequence, runId: RUN_ID, at: T0, type: "node.output", level: "info", message: `event ${sequence}` });

test("a run on fedora drives the editor's live view: history, live events, a lost cursor, a dropped connection and an unknown run", async () => {
  const fs = await import("node:fs");
  const vm = await import("node:vm");
  const routes = fs.readFileSync("public/assets/runtime-routes.js", "utf8").replace(/^export /gm, "");
  const live = fs.readFileSync("public/assets/workflow-live.js", "utf8").replace("export function", "function");
  let last = 2;
  const calls: unknown[][] = [], eventListeners: Array<(update: unknown) => void> = [], statusListeners: Array<(status: unknown) => void> = [];
  const detail = { run: { id: RUN_ID, status: "running", updatedAt: T0 }, nodeRuns: [] };
  const history = (after: number) => ({ events: Array.from({ length: Math.max(0, last - after) }, (_value, index) => liveEvent(after + index + 1)), firstSequence: 1,
    lastSequence: last, truncated: false, detail, cursor: { streamId: `workflow-run:${RUN_ID}`, epoch: "e1", after: last } });
  const runtime = {
    request: async (op: string, payload: any, hostId: string) => { calls.push([op, payload, hostId]); return { ok: true, value: op === "workflows.runs.events" ? history(payload.after) : detail }; },
    subscribe: async (cursor: unknown, hostId: string) => { calls.push(["subscribe", cursor, hostId]); return { ok: true }; },
    unsubscribe: async (streamId: string) => { calls.push(["unsubscribe", streamId]); return { ok: true }; },
    onEvent: (listener: (update: unknown) => void) => { eventListeners.push(listener); return () => eventListeners.splice(eventListeners.indexOf(listener), 1); }
  };
  const context: any = vm.createContext({ setTimeout, clearTimeout, URL, JSON, Promise });
  vm.runInContext(`${routes}\n${live}\nthis.createRunEventsSource = createRunEventsSource; this.watchWorkflowRun = watchWorkflowRun;`, context);
  const Source = context.createRunEventsSource({ runtime, hostId: HOST,
    onStatus: (listener: (status: unknown) => void) => { statusListeners.push(listener); return () => undefined; } });
  const observed: any[] = [];
  const watch = context.watchWorkflowRun({ runId: RUN_ID, detail, onChange: (value: unknown) => observed.push(copy(value)), EventSourceClass: Source,
    request: async () => detail });
  const sequences = () => observed.at(-1).events.map((item: { sequence: number }) => item.sequence);
  const emit = (update: unknown) => eventListeners.forEach(listener => listener(update));
  await flush(10);
  assert.deepEqual(copy(calls.slice(0, 2)), [["workflows.runs.events", { runId: RUN_ID, after: 0 }, HOST], ["subscribe", { streamId: `workflow-run:${RUN_ID}`, epoch: "e1", after: 2 }, HOST]]);
  assert.deepEqual(sequences(), [1, 2]);
  assert.equal(observed.at(-1).connection, "live");

  emit({ streamId: `workflow-run:${RUN_ID}`, events: [{ seq: 3, type: "node.output", runId: RUN_ID, occurredAt: T0, payload: liveEvent(3) }] });
  emit({ streamId: `workflow-run:${RUN_ID}`, events: [{ seq: 3, type: "node.output", runId: RUN_ID, occurredAt: T0, payload: liveEvent(3) }] });
  emit({ streamId: "workflow-run:another", events: [{ seq: 9, type: "x", runId: "another", occurredAt: T0, payload: liveEvent(9) }] });
  assert.deepEqual(sequences(), [1, 2, 3], "each event once, only this run's");

  // The cursor can no longer continue: the history after the last one seen.
  last = 5;
  emit({ streamId: `workflow-run:${RUN_ID}`, resync: "cursor_expired" });
  await flush(10);
  assert.deepEqual(copy(calls.at(-2)), ["workflows.runs.events", { runId: RUN_ID, after: 3 }, HOST]);
  assert.deepEqual(sequences(), [1, 2, 3, 4, 5]);

  // A dropped connection: reconnecting until fedora is back, then nothing is missed.
  emit({ streamId: `workflow-run:${RUN_ID}`, resync: "host_changed" });
  assert.equal(observed.at(-1).connection, "reconnecting");
  last = 6;
  statusListeners.forEach(listener => listener({ state: "online", hostId: HOST }));
  await flush(10);
  assert.deepEqual(sequences(), [1, 2, 3, 4, 5, 6]);
  assert.equal(observed.at(-1).connection, "live");

  // A run the server no longer knows: the view stops following it.
  emit({ streamId: `workflow-run:${RUN_ID}`, resync: "run_unknown" });
  await flush(5);
  assert.deepEqual(copy(calls.at(-1)), ["unsubscribe", `workflow-run:${RUN_ID}`]);
  const before = observed.length;
  emit({ streamId: `workflow-run:${RUN_ID}`, events: [{ seq: 7, type: "node.output", runId: RUN_ID, occurredAt: T0, payload: liveEvent(7) }] });
  assert.equal(observed.length, before);
  watch.close();
});

/** fedora with its models and the operations the workflow editor uses on it. */
function fedoraWithEditor() {
  const fedora = fedoraWithTasks({ capabilities: ["chat.runs.start", "events.poll", "orchestration.snapshot", "workflows.runs.start"] });
  const server = { workflow: copy(WORKFLOW), saves: 0, run: { id: RUN_ID, workflowId: WORKFLOW.id, workflowVersion: 1, workflowSnapshot: WORKFLOW, status: "running",
    source: "standalone", createdAt: T0, updatedAt: T0 } as Record<string, unknown> };
  const runtime = fedora.bridge.runtime as unknown as Record<string, (...args: any[]) => Promise<any>>;
  const request = runtime.request!, send = runtime.send!;
  const detail = () => copy({ run: server.run, nodeRuns: [] });
  runtime.request = async (op: string, payload: any, hostId: string) => {
    if (op === "models.available") return { ok: true, value: { providers: [{ id: "llamacpp", name: "Local models" }, { id: "local", name: "Local" }], availableModels: [],
      loadedModels: [], allManagedModels: [{ providerId: "llamacpp", id: "srv-llama", libraryId: "srv-llama", displayName: "Llama", filesAvailable: true }],
      appSettings: { llm: { defaultProvider: "llamacpp" }, providers: { llamacpp: { model: "srv-llama" } } } } };
    if (op === "workflows.validate") return { ok: true, value: { ok: true, errors: [] } };
    if (op === "workflows.runs.get") return { ok: true, value: detail() };
    if (op === "workflows.runs.events") return { ok: true, value: { events: [], firstSequence: 0, lastSequence: 0, truncated: false, detail: detail(),
      cursor: { streamId: `workflow-run:${payload.runId}`, epoch: "e1", after: 0 } } };
    if (op === "workflows.runs.cancel") { server.run.status = "cancelled"; return { ok: true, value: copy(server.run) }; }
    return request(op, payload, hostId);
  };
  runtime.send = async (op: string, payload: any, hostId: string) => {
    if (op === "workflows.save") {
      if (payload.expectedUpdatedAt !== server.workflow.updatedAt) return { ok: false, error: { code: "workflow_conflict",
        message: "This workflow was changed on the server since you opened it. Reload it, then make your changes again." } };
      server.workflow = { ...payload.workflow, updatedAt: `2026-10-0${2 + server.saves++}T10:00:00.000Z` };
      return { ok: true, value: copy(server.workflow) };
    }
    if (["workflows.runs.start", "workflows.runs.resume", "workflows.runs.review"].includes(op)) return { ok: true, value: copy(server.run) };
    return send(op, payload, hostId);
  };
  return { ...fedora, server };
}

test("on fedora the workflow editor offers its models without folders or full access, and runs, reviews and saves there", async t => {
  const fedora = fedoraWithEditor();
  const app = await bootApp({ ...localOrchestration(), remote: { bridge: fedora.bridge } });
  t.after(() => app.close());
  const localBefore = app.requests.length, callsBefore = app.bridgeCalls.length;
  await onFedoraTasks(app);
  await click(app, '[data-action="set-orchestration-tab"][data-orchestration-tab="workflow"]');
  await settle();
  const props = editor(app);
  assert.deepEqual(copy(props.limits), { folder: false, fullAccess: false });
  assert.equal(props.onChooseFolder, undefined);
  assert.deepEqual(copy(props.projects), []);
  assert.deepEqual(copy(props.plugins), []);
  assert.match(props.pluginsError, /later update/);
  assert.deepEqual(copy(props.providers).map((provider: { id: string; models: string[] }) => [provider.id, provider.models]), [["llamacpp", ["srv-llama"]]]);

  await props.onRun(copy(props.workflow));
  await settle();
  await props.onStop(RUN_ID);
  await props.onResume(RUN_ID);
  await props.onReview(RUN_ID, { approved: true, waitingNodeRunId: "step-1" });
  await settle();
  await click(app, '[data-action="save-workflow"]');
  await settle();
  // Someone else saves on fedora meanwhile: the next save is a conflict, not an overwrite.
  fedora.server.workflow.updatedAt = "2026-10-05T10:00:00.000Z";
  await click(app, '[data-action="save-workflow"]');
  await settle();
  const validations = app.editors.filter(entry => !entry.handle.unmounted).at(-1)!.handle.validations;
  assert.match(JSON.stringify(validations.at(-1)), /changed on the server since you opened it/);

  assert.deepEqual(app.requests.slice(localBefore).filter(entry => LOCAL_ORCHESTRATION_API.test(entry)), [], "this computer's workflow API was not asked");
  const calls = runtimeCalls(app, callsBefore);
  assert.ok(calls.every(call => call.at(-1) === HOST), "every call names fedora");
  const sent = calls.filter(call => call[0] === "send").map(call => [call[1], call[1] === "workflows.save" ? (call[2] as { expectedUpdatedAt: string }).expectedUpdatedAt : undefined]);
  assert.deepEqual(sent, [["workflows.runs.start", undefined], ["workflows.runs.resume", undefined], ["workflows.runs.review", undefined],
    ["workflows.save", T0], ["workflows.save", "2026-10-02T10:00:00.000Z"]], "runs, resumes, reviews and saves are commands; each save names its base");
  assert.deepEqual(calls.find(call => call[1] === "workflows.runs.review")![2], { runId: RUN_ID, approved: true, waitingNodeRunId: "step-1" });
  assert.ok(calls.some(call => call[1] === "workflows.runs.cancel"));
  assert.ok(app.bridgeCalls.slice(callsBefore).some(call => call.op === "runtime.subscribe" && call.payload[0].streamId === `workflow-run:${RUN_ID}`), "the run's log is followed");
});

test("on a server that offers projects, a task can work in one of its projects a device may use", async t => {
  const local = localOrchestration();
  const fedora = fedoraWithTasks({ capabilities: ["chat.runs.start", "events.poll", "orchestration.snapshot", "tasks.create", "projects.list"] });
  const app = await bootApp({ ...local, remote: { bridge: fedora.bridge } });
  t.after(() => app.close());
  const callsBefore = app.bridgeCalls.length;
  await onFedoraTasks(app);
  const select = app.document.querySelector("#task-server-project");
  assert.ok(select, "the server's projects are offered");
  assert.deepEqual([...select.options].map((item: { textContent: string }) => item.textContent), ["No project · separate task folder on fedora", "Site"], "not a project set up on the server");
  assert.equal(app.document.querySelector("#task-form [data-workspace-project]"), null, "not this computer's projects");
  fill(app, { "#task-title": "Build the page", "#task-description": "In the site", "#task-server-project": "srv-project" });
  submit(app, "#task-form");
  await settle();
  const created = runtimeCalls(app, callsBefore).find(call => call[1] === "tasks.create")![2] as Record<string, unknown>;
  assert.equal(created.projectId, "srv-project");
});
