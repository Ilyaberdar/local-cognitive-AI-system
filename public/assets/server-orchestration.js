import { createRemoteRequest, ORCHESTRATION_ROUTES } from "./runtime-routes.js";

const ACTIVE_RUNS = new Set(["queued", "running"]);
const LIST_FIELDS = ["workflows", "tasks", "schedules", "workflowRuns"];

/** The Tasks & workflows screen on the selected server (R5-2): the server's lists, and the API
 * calls the screen makes on this computer, run on that server. One source per server selection,
 * so nothing it holds or sends reaches another server. */
export function createServerOrchestration({ target, bridge = window.desktopRemote, onChange = () => {} }) {
  const runtime = bridge?.runtime;
  let source = null, key = "";
  const current = () => {
    const next = runtime && target.isRemote() ? `${target.hostId()}:${target.generation()}` : "";
    if (next !== key) {
      source?.dispose();
      source = null;
      key = next;
      if (next) source = createSource({ target, runtime, onChange });
    }
    return source;
  };
  return {
    /** The selected server's source, or null on this computer. */
    source: current,
    /** The connection changed: true when the screen should be rendered again. */
    statusChanged: () => current()?.statusChanged() ?? false,
    dispose() { source?.dispose(); source = null; key = ""; }
  };
}

function createSource({ target, runtime, onChange }) {
  const hostId = target.hostId(), generation = target.generation();
  const isCurrent = () => target.isRemote() && target.hostId() === hostId && target.generation() === generation;
  const name = () => target.hostName();
  const online = () => target.online();
  const request = createRemoteRequest({ runtime, hostId, routes: ORCHESTRATION_ROUTES, isCurrent, online,
    offlineMessage: () => `${name()} is not connected. Nothing was sent.` });
  const lists = { workflows: [], tasks: [], schedules: [], workflowRuns: [], projects: [], truncated: false };
  let revision, loaded = false, loadError = "", inFlight = null, lastRefresh = 0, wasOnline = online(), disposed = false;
  const body = value => JSON.stringify(value);
  const path = (prefix, id, suffix = "") => `${prefix}/${encodeURIComponent(id)}${suffix}`;

  // The same calls as the screen's local `api`, on the server.
  const api = {
    createTask: payload => request("/tasks", { method: "POST", body: body(payload) }),
    updateTask: (taskId, payload) => request(path("/tasks", taskId), { method: "PATCH", body: body(payload) }),
    deleteTask: taskId => request(path("/tasks", taskId), { method: "DELETE" }),
    runTask: taskId => request(path("/tasks", taskId, "/run"), { method: "POST" }),
    runNextTask: () => request("/tasks/run-next", { method: "POST" }),
    createSchedule: payload => request("/schedules", { method: "POST", body: body(payload) }),
    updateSchedule: (scheduleId, payload) => request(path("/schedules", scheduleId), { method: "PATCH", body: body(payload) }),
    deleteSchedule: scheduleId => request(path("/schedules", scheduleId), { method: "DELETE" }),
    getWorkflowRun: runId => request(path("/workflow-runs", runId)),
    cancelWorkflowRun: runId => request(path("/workflow-runs", runId, "/cancel"), { method: "POST" }),
    validateWorkflow: workflow => request(path("/workflows", workflow.id || "draft", "/validate"), { method: "POST", body: body(workflow) })
  };

  /** Fetches the lists; an unchanged answer keeps them. Arrays are replaced in place, so a list
   * a handler captured stays this server's. Resolves true when something changed. */
  const refresh = () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      if (!online()) throw Object.assign(new Error(`${name()} is not connected. Nothing was sent.`), { code: "not_connected" });
      const result = await runtime.request("orchestration.snapshot", revision ? { revision } : {}, hostId);
      if (disposed || !isCurrent()) return false;
      if (!result?.ok) {
        loadError = result?.error?.message || `${name()} did not answer.`;
        throw Object.assign(new Error(loadError), { code: result?.error?.code });
      }
      lastRefresh = Date.now();
      const changed = Boolean(loadError) || !loaded || !result.value.unchanged;
      loadError = "";
      if (!result.value.unchanged) {
        for (const field of LIST_FIELDS) lists[field].splice(0, lists[field].length, ...(result.value[field] ?? []));
        lists.truncated = Boolean(result.value.truncated);
        revision = result.value.revision;
      }
      loaded = true;
      return changed;
    })().finally(() => { inFlight = null; });
    return inFlight;
  };
  const load = () => { void refresh().then(changed => { if (changed) onChange(); }, () => { if (!disposed && isCurrent()) onChange(); }); };

  return {
    lists, api, request, refresh,
    hostName: name, online,
    loaded: () => loaded,
    error: () => loadError,
    /** An older server does not offer this screen's operations (known once it is online). */
    unsupported: () => target.status().state === "online" && target.status().hostId === hostId && !target.supports("orchestration.snapshot"),
    /** The first fetch, once the screen shows the server. */
    ensureLoaded() { if (!loaded && !inFlight && !loadError && online()) load(); },
    /** Called every second while the screen is visible: every 2 s while a run is active, else every 15 s. */
    async poll() {
      if (disposed || !online() || inFlight) return false;
      const active = lists.workflowRuns.some(run => ACTIVE_RUNS.has(run.status));
      if (Date.now() - lastRefresh < (active ? 2000 : 15000)) return false;
      return refresh().catch(() => false);
    },
    statusChanged() {
      const now = online(), changed = now !== wasOnline;
      wasOnline = now;
      // Back online: catch up on what the server did meanwhile.
      if (changed && now) { loadError = ""; load(); }
      return changed;
    },
    dispose() { disposed = true; }
  };
}
