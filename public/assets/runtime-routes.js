// A screen's calls to this computer's API, run on the selected server instead (R5). The screen
// keeps its code; each route it uses maps to one operation of the server. Nothing falls back to
// this computer: an unknown route is refused, and nothing is sent while the server is offline.

const coded = (message, code) => Object.assign(new Error(message), { code });
const pick = (body, keys) => Object.fromEntries(keys.filter(key => body?.[key] !== undefined && body[key] !== "").map(key => [key, body[key]]));
/** A body as the host reads it: empty values (null, "", []) mean "not set" and are left out; the
 * rest is forwarded as is, so the host's strict check refuses what it does not take. */
const present = body => Object.fromEntries(Object.entries(body ?? {}).filter(([, value]) =>
  value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && !value.length)));
const segment = value => decodeURIComponent(value);

/** The Models tab's routes (public/assets/model-manager.js) → src/runtime/modelOperations.ts. */
export const MODEL_ROUTES = [
  { method: "GET", pattern: /^\/local\/catalog$/, op: "models.catalog.search",
    payload: (_match, query) => pick({ query: query.get("q") ?? undefined, cursor: query.get("cursor") ?? undefined, source: query.get("source") ?? undefined }, ["query", "cursor", "source"]) },
  { method: "GET", pattern: /^\/local\/catalog\/model$/, op: "models.catalog.get",
    payload: (_match, query) => pick({ repoId: query.get("repoId") ?? "", revision: query.get("revision") ?? undefined }, ["repoId", "revision"]) },
  { method: "GET", pattern: /^\/local\/runtime$/, op: "models.local.snapshot" },
  { method: "GET", pattern: /^\/local\/downloads$/, op: "models.downloads.list" },
  // Sent with a command id: a start lost in a reconnect is resent, never doubled.
  { method: "POST", pattern: /^\/local\/downloads$/, op: "models.downloads.start", send: true,
    payload: (_match, _query, body) => pick(body, ["repoId", "revision", "variantId", "projectorPath"]) },
  { method: "POST", pattern: /^\/local\/downloads\/([^/]+)\/(pause|resume|cancel)$/, op: match => `models.downloads.${match[2]}`,
    payload: match => ({ downloadId: decodeURIComponent(match[1]) }) },
  { method: "POST", pattern: /^\/local\/models\/load$/, op: "models.load", payload: (_match, _query, body) => ({ modelId: body?.modelId }) },
  { method: "POST", pattern: /^\/local\/models\/unload$/, op: "models.unload", payload: (_match, _query, body) => ({ modelId: body?.modelIdOrInstanceId }) },
  { method: "DELETE", pattern: /^\/local\/models\/([^/]+)$/, op: "models.local.delete", payload: match => ({ modelId: decodeURIComponent(match[1]) }) },
  { method: "GET", pattern: /^\/system\/metrics$/, op: "system.metrics" }
];

/** A `request(url, options)` with app.js semantics (resolves the value, throws Error with `.code`)
 * that runs `routes` on one server. `isCurrent` says whether that server is still the one on
 * screen: a call for another one is refused and a late answer is dropped. */
export function createRemoteRequest({ runtime, hostId, routes, isCurrent = () => true, online = () => true, offlineMessage = () => "The server is not connected. Nothing was sent." }) {
  return async (url, options = {}) => {
    const address = new URL(url, "http://local");
    const method = String(options.method || "GET").toUpperCase();
    let route, match;
    for (const entry of routes) {
      if (entry.method !== method) continue;
      match = entry.pattern.exec(address.pathname);
      if (match) { route = entry; break; }
    }
    if (!route) throw coded("This is not available on the server yet.", "unsupported");
    if (!isCurrent()) throw coded("The selected server changed. Nothing was sent.", "host_changed");
    if (!online()) throw coded(offlineMessage(), "not_connected");
    let body;
    try { body = typeof options.body === "string" && options.body ? JSON.parse(options.body) : options.body; }
    catch { throw coded("The request is not valid.", "invalid_request"); }
    const op = typeof route.op === "function" ? route.op(match) : route.op;
    const payload = route.payload?.(match, address.searchParams, body);
    const result = route.send ? await runtime.send(op, payload ?? {}, hostId) : await runtime.request(op, payload, hostId);
    // Sent, but another server is selected now: that server may have acted on it.
    if (!isCurrent()) throw coded(result?.ok ? "Done on the previous server; another server is selected now."
      : "Another server was selected before this one answered. The change may have been made there.", "unknown_outcome");
    if (!result?.ok) throw coded(result?.error?.message || "The server did not answer.", result?.error?.code);
    return result.value;
  };
}

/** An EventSource for screens written against this computer's event streams that follows a
 * state watch on the server instead (RemoteRuntime.watch). Every update is the whole state,
 * delivered as a "snapshot" event. When the watch ends (disconnect, another server) the source
 * reports an error, and it watches again once the server is back online. */
export function createWatchSource({ runtime, onStatus, hostId, streamId, isCurrent = () => true }) {
  return class WatchSource {
    constructor() {
      this.readyState = 0;
      this.onopen = null; this.onerror = null; this.onmessage = null;
      this.listeners = new Map();
      this.watching = false;
      this.stops = [
        runtime.onEvent?.(update => this.receive(update)),
        onStatus?.(status => { if (!this.watching && status?.state === "online" && status.hostId === hostId) this.open(); })
      ];
      this.open();
    }

    open() {
      if (this.readyState === 2 || !isCurrent()) return;
      this.watching = true;
      Promise.resolve(runtime.watch(streamId, hostId)).then(result => { if (!result?.ok) this.fail(); }, () => this.fail());
    }

    fail() {
      if (this.readyState === 2) return;
      this.watching = false;
      this.readyState = 0;
      this.dispatch("error", { type: "error" });
    }

    receive(update) {
      if (this.readyState === 2 || update?.streamId !== streamId || !isCurrent()) return;
      if ("resync" in update) { this.fail(); return; }
      if (!("snapshot" in update)) return;
      if (this.readyState !== 1) { this.readyState = 1; this.dispatch("open", { type: "open" }); }
      this.dispatch("snapshot", { type: "snapshot", lastEventId: String(update.sequence),
        data: JSON.stringify({ type: "snapshot", sequence: update.sequence, snapshot: update.snapshot }) });
    }

    dispatch(type, event) {
      const handler = this[`on${type}`];
      if (typeof handler === "function") handler.call(this, event);
      for (const listener of this.listeners.get(type) ?? []) listener.call(this, event);
    }

    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }

    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }

    close() {
      if (this.readyState === 2) return;
      this.readyState = 2;
      for (const stop of this.stops) if (typeof stop === "function") stop();
      Promise.resolve(runtime.unwatch?.(streamId)).catch(() => undefined);
    }
  };
}

/** The Tasks & workflows screen's routes (public/assets/app.js) → src/runtime/orchestrationOperations.ts. */
export const ORCHESTRATION_ROUTES = [
  // Commands carry a command id: a create or start lost in a reconnect is resent, never doubled.
  { method: "POST", pattern: /^\/tasks$/, op: "tasks.create", send: true, payload: (_match, _query, body) => present(body) },
  { method: "POST", pattern: /^\/tasks\/run-next$/, op: "tasks.runNext", send: true, payload: () => ({}) },
  { method: "POST", pattern: /^\/tasks\/([^/]+)\/run$/, op: "tasks.run", send: true, payload: match => ({ taskId: segment(match[1]) }) },
  { method: "PATCH", pattern: /^\/tasks\/([^/]+)$/, op: "tasks.update", payload: (match, _query, body) => ({ taskId: segment(match[1]), patch: present(body) }) },
  { method: "DELETE", pattern: /^\/tasks\/([^/]+)$/, op: "tasks.delete", payload: match => ({ taskId: segment(match[1]) }) },
  { method: "POST", pattern: /^\/schedules$/, op: "schedules.create", send: true, payload: (_match, _query, body) => present(body) },
  { method: "PATCH", pattern: /^\/schedules\/([^/]+)$/, op: "schedules.update", payload: (match, _query, body) => ({ scheduleId: segment(match[1]), patch: present(body) }) },
  { method: "DELETE", pattern: /^\/schedules\/([^/]+)$/, op: "schedules.delete", payload: match => ({ scheduleId: segment(match[1]) }) },
  { method: "POST", pattern: /^\/workflows\/[^/]+\/validate$/, op: "workflows.validate", payload: (_match, _query, body) => ({ workflow: body }) },
  { method: "GET", pattern: /^\/workflow-runs\/([^/]+)$/, op: "workflows.runs.get", payload: match => ({ runId: segment(match[1]) }) },
  { method: "POST", pattern: /^\/workflow-runs\/([^/]+)\/cancel$/, op: "workflows.runs.cancel", payload: match => ({ runId: segment(match[1]) }) },
  // The editor's run, resume and review: accepted on the server, followed through its events.
  { method: "POST", pattern: /^\/workflow-runs$/, op: "workflows.runs.start", send: true,
    payload: (_match, _query, body) => ({ workflow: body?.workflow, options: present(body?.options) }) },
  { method: "POST", pattern: /^\/workflow-runs\/([^/]+)\/resume$/, op: "workflows.runs.resume", send: true, payload: match => ({ runId: segment(match[1]) }) },
  { method: "POST", pattern: /^\/workflow-runs\/([^/]+)\/review$/, op: "workflows.runs.review", send: true,
    payload: (match, _query, body) => ({ runId: segment(match[1]), ...pick(body, ["approved", "comment", "approvalId", "waitingNodeRunId"]) }) },
  { method: "GET", pattern: /^\/workflow-runs\/([^/]+)\/agent-runs\/([^/]+)$/, op: "workflows.runs.agentTrace.get",
    payload: match => ({ runId: segment(match[1]), agentRunId: segment(match[2]) }) }
];

/** An EventSource for /workflow-runs/<id>/events?after=<n> (public/assets/workflow-live.js) that
 * follows the run on the server: its history first (`workflows.runs.events`), then its log as an
 * `events.poll` stream. A stream that cannot continue reads the history again from where the editor
 * is; a dropped connection is an error until the server is back; an unknown run stops it. */
export function createRunEventsSource({ runtime, hostId, isCurrent = () => true, onStatus }) {
  return class RunEventsSource {
    constructor(url) {
      const address = new URL(url, "http://local");
      const match = /^\/workflow-runs\/([^/]+)\/events$/.exec(address.pathname);
      this.runId = match ? decodeURIComponent(match[1]) : "";
      this.streamId = `workflow-run:${this.runId}`;
      this.after = Number(address.searchParams.get("after") || 0);
      this.readyState = 0;
      this.onopen = null; this.onerror = null; this.onmessage = null;
      this.listeners = new Map();
      this.following = false;
      this.stops = [
        runtime.onEvent?.(update => this.receive(update)),
        onStatus?.(status => { if (!this.following && status?.state === "online" && status.hostId === hostId) void this.open(); })
      ];
      void this.open();
    }

    async open() {
      if (this.readyState === 2 || !isCurrent() || !this.runId) return;
      this.following = true;
      try {
        const result = await runtime.request("workflows.runs.events", { runId: this.runId, after: this.after }, hostId);
        if (this.readyState === 2 || !isCurrent()) return;
        if (!result?.ok) { this.fail(result?.error?.code === "not_found"); return; }
        const history = result.value;
        this.after = history.lastSequence;
        if (this.readyState !== 1) { this.readyState = 1; this.dispatch("open", { type: "open" }); }
        this.dispatch("history", { type: "history", data: JSON.stringify(history), lastEventId: String(history.lastSequence) });
        const followed = await runtime.subscribe(history.cursor, hostId);
        if (!followed?.ok) this.fail();
      } catch { this.fail(); }
    }

    /** `final`: the run does not exist on the server; nothing more will come. */
    fail(final = false) {
      if (this.readyState === 2) return;
      this.following = false;
      this.readyState = 0;
      this.dispatch("error", { type: "error" });
      if (final) this.close();
    }

    receive(update) {
      if (this.readyState === 2 || update?.streamId !== this.streamId || !isCurrent()) return;
      if ("resync" in update) {
        if (update.resync === "run_unknown") this.fail(true);
        // Another server or a dropped connection: again once this server is back.
        else if (update.resync === "host_changed") this.fail();
        else void this.open();
        return;
      }
      for (const event of update.events ?? []) {
        if (event.seq <= this.after) continue;
        this.after = event.seq;
        this.dispatch("update", { type: "update", data: JSON.stringify(event.payload), lastEventId: String(event.seq) });
      }
    }

    dispatch(type, event) {
      const handler = this[`on${type}`];
      if (typeof handler === "function") handler.call(this, event);
      for (const listener of this.listeners.get(type) ?? []) listener.call(this, event);
    }

    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }

    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }

    close() {
      if (this.readyState === 2) return;
      this.readyState = 2;
      for (const stop of this.stops) if (typeof stop === "function") stop();
      Promise.resolve(runtime.unsubscribe?.(this.streamId)).catch(() => undefined);
    }
  };
}

/** A settings patch as the server takes it: a provider key is written ({set}) or, as an empty
 * string from "Remove key", cleared ({clear: true}); it is never read back. */
const hostSettingsPatch = body => {
  const patch = JSON.parse(JSON.stringify(body ?? {}));
  for (const provider of Object.values(patch.providers ?? {})) {
    if (provider && typeof provider.apiKey === "string") provider.apiKey = provider.apiKey === "" ? { clear: true } : { set: provider.apiKey };
  }
  return patch;
};

/** The Settings screen's host pages (public/assets/settings-data.js) → src/runtime/settingsOperations.ts.
 * MCP clients and integrations are not here: on a server they are refused before anything is sent. */
export const SETTINGS_ROUTES = [
  { method: "PUT", pattern: /^\/app\/settings$/, op: "settings.update", payload: (_match, _query, body) => hostSettingsPatch(body) },
  { method: "POST", pattern: /^\/providers\/([^/]+)\/test$/, op: "providers.test", payload: (match, _query, body) => ({ providerId: segment(match[1]), ...pick(body, ["model"]) }) }
];

/** The Synthesis screen's routes (frontend/synthesis, paths without its `/synthesis` prefix) →
 * src/runtime/synthesisOperations.ts. "Open in editor" and the preview are not here: they stay on
 * the server's own screen. */
export const SYNTHESIS_ROUTES = [
  { method: "GET", pattern: /^\/projects\/([^/]+)\/modules$/, op: "synthesis.modules.list", payload: match => ({ projectId: segment(match[1]) }) },
  { method: "GET", pattern: /^\/projects\/([^/]+)\/modules\/([^/]+)$/, op: "synthesis.modules.get", payload: match => ({ projectId: segment(match[1]), moduleId: segment(match[2]) }) },
  { method: "GET", pattern: /^\/projects\/([^/]+)\/folders$/, op: "synthesis.folders.list",
    payload: (match, query) => ({ projectId: segment(match[1]), ...(query.get("directory") ? { directory: query.get("directory") } : {}) }) },
  { method: "POST", pattern: /^\/projects\/([^/]+)\/modules$/, op: "synthesis.modules.create", send: true,
    payload: (match, _query, body) => ({ projectId: segment(match[1]), ...pick(body, ["name", "template", "directory"]) }) },
  { method: "GET", pattern: /^\/projects\/([^/]+)\/runs$/, op: "synthesis.runs.list", payload: match => ({ projectId: segment(match[1]) }) },
  { method: "POST", pattern: /^\/projects\/([^/]+)\/runs$/, op: "synthesis.runs.start", send: true,
    payload: (match, _query, body) => ({ projectId: segment(match[1]), moduleId: body?.moduleId }) },
  { method: "GET", pattern: /^\/runs\/([^/]+)$/, op: "synthesis.runs.get", payload: (match, query) => ({ runId: segment(match[1]), ...(query.get("after") ? { after: Number(query.get("after")) } : {}) }) },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/sources$/, op: "synthesis.runs.sources", payload: match => ({ runId: segment(match[1]) }) },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/diff$/, op: "synthesis.runs.diff", payload: match => ({ runId: segment(match[1]) }) },
  { method: "GET", pattern: /^\/runs\/([^/]+)\/file$/, op: "synthesis.runs.file",
    payload: (match, query) => ({ runId: segment(match[1]), path: query.get("path") ?? "", side: query.get("side") ?? "after" }) },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/cancel$/, op: "synthesis.runs.cancel", payload: match => ({ runId: segment(match[1]) }) },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/resume$/, op: "synthesis.runs.resume", send: true, payload: match => ({ runId: segment(match[1]) }) },
  { method: "POST", pattern: /^\/runs\/([^/]+)\/apply$/, op: "synthesis.runs.apply", send: true, payload: match => ({ runId: segment(match[1]) }) }
];
