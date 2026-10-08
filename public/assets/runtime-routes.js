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
    if (!isCurrent()) throw coded("The selected server changed.", "host_changed");
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
  { method: "POST", pattern: /^\/workflow-runs\/([^/]+)\/cancel$/, op: "workflows.runs.cancel", payload: match => ({ runId: segment(match[1]) }) }
];
