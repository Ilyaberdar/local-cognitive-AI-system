import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

// Exercise the real app integration, including its captured async callbacks. The
// React renderer and HTTP transport are replaced, not the workspace functions.
const source = fs.readFileSync("public/assets/app.js", "utf8");
const start = source.indexOf("function workflowDraftKey(");
const end = source.indexOf("function renderWorkflowNodeEditor(", start);
assert.ok(start >= 0 && end > start);
const integration = source.slice(start, end);
const graph = (id: string, description = "saved") => ({ id, version: 1, name: id, description,
  entryNodeId: "entry", nodes: [{ id: "entry", label: "Entry", type: "entry", position: { x: 0, y: 0 }, config: {} }], transitions: [],
  createdAt: "2026-09-24T00:00:00Z", updatedAt: "2026-09-24T00:00:00Z" });
const detail = (workflow: ReturnType<typeof graph>, id: string, status = "done") => ({
  run: { id, workflowId: workflow.id, workflowVersion: workflow.version, workflowSnapshot: structuredClone(workflow), status,
    createdAt: "2026-09-24T00:00:00Z", updatedAt: "2026-09-24T00:00:01Z" }, nodeRuns: []
});
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const deferred = <T = any>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

function harness(workflows = [graph("A"), graph("B")]) {
  const mounts: any[] = [], subscriptions: any[] = [], requests: Array<{ url: string; body: any }> = [];
  const runs = new Map<string, any>();
  const container = { innerHTML: "", isConnected: true };
  const module = { mountWorkflowEditor: (_container: unknown, props: any) => {
    const mount = { props, executions: [] as any[], starting: [] as boolean[], captured: { selected: { kind: "node", id: "entry" },
      inspectorOpen: true, viewport: { x: 120, y: 30, zoom: 0.75 }, console: { height: 180, follow: false, scrollTop: 60 } }, unmounted: false };
    mounts.push(mount);
    return { captureState: () => mount.captured, unmount: () => { mount.unmounted = true; }, setValidation() {},
      setStarting: (value: boolean) => mount.starting.push(value), setExecution: (value: any) => mount.executions.push(value) };
  } };
  const context: any = vm.createContext({ structuredClone, JSON, Map, Option: class {},
    state: { route: "orchestration", orchestrationTab: "workflow", ui: { theme: "dark" },
      bootstrap: { workflows, workflowRuns: [] }, workflowBuilder: { draft: structuredClone(workflows[0]), validation: null },
      activeWorkflowRunId: null, workflowRunDetail: null },
    workflowWorkspaces: new Map(), workflowEventCache: new Map(), workflowWorkspaceKey: null, workflowMountedKey: null,
    workflowSelectionSequence: 0, workflowEditorMountGeneration: 0, workflowEditorHandle: null, workflowLiveConnection: null,
    workflowEditorModulePromise: Promise.resolve(module), window: {},
    document: { querySelector: (selector: string) => selector === "#workflow-graph-editor" ? container : null },
    cloneWorkflow: structuredClone, getProviderOptions: () => [], resolveTheme: () => "dark", escapeHtml: String,
    api: { getWorkflowRun: async (id: string) => { assert.ok(runs.has(id), `Missing run fixture ${id}`); return runs.get(id); } },
    request: async (url: string, options: any) => { requests.push({ url, body: JSON.parse(options.body) }); return {}; },
    watchWorkflowRun: (options: any) => {
      let closed = false;
      const publish = (value: any) => { if (!closed) options.onChange({ ...value, events: options.cached?.events ?? [], connection: "live" }); };
      const subscription = { options, publish, close: () => { closed = true; }, setDetail: publish };
      subscriptions.push(subscription); publish(options.detail); return subscription;
    }
  });
  vm.runInContext(integration, context);
  const remount = async () => { context.unmountWorkflowEditor(); await context.mountActiveWorkflowEditor(); };
  const select = async (workflow: ReturnType<typeof graph>) => { context.selectWorkflowWorkspace(workflow); await remount(); };
  return { context, mounts, subscriptions, requests, runs, remount, select };
}

test("workflow switches preserve each unsaved draft, selected run, viewport and console state", async () => {
  const h = harness(); const [a, b] = h.context.state.bootstrap.workflows;
  await h.context.mountActiveWorkflowEditor();
  const original = h.mounts[0];
  original.props.onChange({ ...a, description: "unfinished A prompt" });
  const aRun = detail(a, "run-a"); h.runs.set(aRun.run.id, aRun);
  h.context.connectWorkflowRun(aRun, h.context.workflowEditorMountGeneration, h.context.workflowWorkspaces.get("draft:A@1"));
  const event = { sequence: 1, message: "A output" };
  h.subscriptions.at(-1)!.options.onChange({ ...aRun, events: [event], connection: "live" });
  await h.select(b);
  h.mounts.at(-1)!.props.onChange({ ...b, description: "unfinished B prompt" });
  await h.select(a);
  const restored = h.mounts.at(-1)!;
  assert.equal(restored.props.workflow.description, "unfinished A prompt");
  assert.deepEqual(plain(restored.props.initialViewState), original.captured);
  assert.equal(restored.props.execution.run.id, "run-a");
  assert.deepEqual(plain(restored.props.execution.events), [event]);
  assert.equal(h.context.workflowWorkspaces.get("draft:B@1").draft.description, "unfinished B prompt");
});

test("Task trace preserves an edited draft while inspecting the frozen execution snapshot", async () => {
  const h = harness(); const a = h.context.state.bootstrap.workflows[0];
  await h.context.mountActiveWorkflowEditor();
  h.mounts[0].props.onChange({ ...a, description: "unsaved changes" });
  const historical = { ...detail(a, "task-run"), run: { ...detail(a, "task-run").run, taskId: "task-1" } };
  h.context.selectWorkflowRun(historical);
  assert.equal(h.context.workflowWorkspaceKey, "run:task-run");
  assert.equal(h.context.state.workflowBuilder.draft.description, "saved");
  assert.equal(h.context.state.workflowRunDetail.run.taskId, "task-1");
  h.context.selectWorkflowWorkspace(a);
  assert.equal(h.context.state.workflowBuilder.draft.description, "unsaved changes");
});

test("history for an unopened workflow cannot replace its newer saved definition", async () => {
  const b = graph("B"), latestA = graph("A", "latest saved definition");
  const h = harness([b, latestA]);
  const historical = detail(graph("A", "old execution"), "old-a");
  h.context.selectWorkflowRun(historical);
  assert.equal(h.context.workflowWorkspaceKey, "run:old-a");
  assert.equal(h.context.state.workflowBuilder.draft.description, "old execution");
  h.context.selectWorkflowWorkspace(latestA);
  assert.equal(h.context.state.workflowBuilder.draft.description, "latest saved definition");
});

test("Run stays pending across shell remount and connects the accepted run without creating a second run", async () => {
  const h = harness(); await h.context.mountActiveWorkflowEditor();
  const accepted = detail(graph("A"), "new-run", "running"); h.runs.set("new-run", accepted);
  const response = deferred(); let starts = 0;
  h.context.request = async () => { starts++; return response.promise; };
  const running = h.mounts[0].props.onRun(graph("A"));
  await h.remount();
  assert.equal(h.mounts[1].props.starting, true);
  await h.mounts[1].props.onRun(graph("A"));
  assert.equal(starts, 1);
  response.resolve(accepted.run); await running;
  assert.equal(h.context.state.activeWorkflowRunId, "new-run");
  assert.equal(h.mounts[1].executions.at(-1)?.run.id, "new-run");
  assert.equal(h.mounts[1].starting.at(-1), false);
});

test("a late Run response is saved for its workflow without stealing another workflow's editor", async () => {
  const h = harness(); await h.context.mountActiveWorkflowEditor();
  const response = deferred(); h.context.request = () => response.promise;
  const accepted = detail(graph("A"), "late-a", "running"); h.runs.set("late-a", accepted);
  const running = h.mounts[0].props.onRun(graph("A"));
  await h.select(graph("B"));
  response.resolve(accepted.run); await running;
  assert.equal(h.context.state.workflowBuilder.draft.id, "B");
  assert.equal(h.context.state.activeWorkflowRunId, null);
  assert.equal(h.mounts[1].executions.length, 0);
  assert.equal(h.context.workflowWorkspaces.get("draft:A@1").runId, "late-a");
  await h.select(graph("A"));
  assert.equal(h.mounts.at(-1)!.props.execution.run.id, "late-a");
});

test("graph review forwards its captured approval identity and fences late detail updates after switching", async () => {
  const h = harness(); await h.context.mountActiveWorkflowEditor();
  const callback = h.mounts[0].props.onReview;
  const waiting = detail(graph("A"), "waiting/a", "waiting");
  h.context.connectWorkflowRun(waiting, h.context.workflowEditorMountGeneration, h.context.workflowWorkspaces.get("draft:A@1"));
  const response = deferred(); h.context.api.getWorkflowRun = () => response.promise;
  const pending = callback("waiting/a", { approved: true, approvalId: "captured-approval" });
  await h.select(graph("B"));
  response.resolve(detail(graph("A"), "waiting/a", "done")); await pending;
  assert.equal(h.requests[0].url, "/workflow-runs/waiting%2Fa/review");
  assert.deepEqual(plain(h.requests[0].body), { approved: true, approvalId: "captured-approval", background: true });
  assert.equal(h.context.state.workflowBuilder.draft.id, "B");
  assert.equal(h.context.state.activeWorkflowRunId, null);
  assert.equal(h.context.state.workflowRunDetail, null);
  h.context.api.getWorkflowRun = async () => detail(graph("A"), "human", "done");
  await callback("human", { approved: false, waitingNodeRunId: "captured-node-run" });
  assert.deepEqual(plain(h.requests[1].body), { approved: false, waitingNodeRunId: "captured-node-run", background: true });
});

test("rapid Task Trace selections keep the newer selection when requests finish out of order", async () => {
  const h = harness();
  const responses = { first: deferred(), second: deferred() };
  const callbacks: Record<string, () => Promise<void>> = {};
  const buttons = Object.keys(responses).map(runId => ({ dataset: { runId },
    addEventListener: (_event: string, callback: () => Promise<void>) => { callbacks[runId] = callback; } }));
  h.context.document.querySelectorAll = () => buttons;
  h.context.api.getWorkflowRun = (id: keyof typeof responses) => responses[id].promise;
  h.context.render = () => {};
  h.context.pushToast = (message: string) => assert.fail(message);
  const begin = source.indexOf('  document.querySelectorAll("[data-action=\'select-workflow-run\']")');
  const finish = source.indexOf("  bindWorkflowReviewActions();", begin);
  assert.ok(begin >= 0 && finish > begin);
  vm.runInContext(source.slice(begin, finish), h.context);
  const first = callbacks.first(), second = callbacks.second();
  responses.second.resolve(detail(graph("B"), "second")); await second;
  responses.first.resolve(detail(graph("A"), "first")); await first;
  assert.equal(h.context.state.activeWorkflowRunId, "second");
  assert.equal(h.context.state.workflowBuilder.draft.id, "B");
});

test("Refresh cannot write the previous run detail into another selected workflow", async () => {
  const h = harness();
  const aRun = detail(graph("A"), "run-a"), bRun = detail(graph("B"), "run-b");
  h.context.selectWorkflowRun(aRun);
  let callback!: () => Promise<void>;
  h.context.document.querySelector = () => ({ addEventListener: (_event: string, handler: typeof callback) => { callback = handler; } });
  const requested = deferred(), response = deferred();
  h.context.runAction = (action: () => Promise<void>) => action();
  h.context.refreshBootstrap = async () => {};
  h.context.api.getWorkflowRun = () => { requested.resolve(true); return response.promise; };
  const begin = source.indexOf('  document.querySelector("[data-action=\'refresh-orchestration\']")?.addEventListener');
  const finish = source.indexOf('  document.querySelectorAll("[data-action=\'set-orchestration-tab\']")', begin);
  assert.ok(begin >= 0 && finish > begin);
  vm.runInContext(source.slice(begin, finish), h.context);
  const refreshing = callback(); await requested.promise;
  h.context.selectWorkflowRun(bRun);
  response.resolve(aRun); await refreshing;
  assert.equal(h.context.state.activeWorkflowRunId, "run-b");
  assert.equal(h.context.state.workflowRunDetail.run.id, "run-b");
  h.context.rememberWorkflowWorkspace();
  assert.equal(h.context.workflowWorkspaces.get("draft:B@1").detail.run.id, "run-b");
});
