import { createRemoteRequest, SYNTHESIS_ROUTES } from "./runtime-routes.js";

const MAX_EVENTS = 2000, MAX_RUNS = 20;

/** The Synthesis screen on the selected server (R5-5): its requests become the server's
 * operations, answers are put back in the shape the screen reads from this computer, a run's
 * events are followed with a cursor, and large changed files are fetched on their own. One
 * transport per server selection: a late answer for an earlier one is dropped. */
export function createServerSynthesis({ target, bridge = window.desktopRemote }) {
  const runtime = bridge?.runtime;
  let current = null, key = "";
  const select = () => {
    const next = runtime && target.isRemote() ? `${target.hostId()}:${target.generation()}` : "";
    if (next !== key) { key = next; current = next ? createTransport({ target, runtime }) : null; }
    return current;
  };
  return {
    /** The selected server's transport, or undefined on this computer. */
    transport: () => select() ?? undefined,
    /** An older server does not offer Synthesis (known once it is online). */
    unsupported: () => target.status().state === "online" && target.status().hostId === target.hostId() && !target.supports("synthesis.modules.list"),
    /** This server selection: the screen is mounted again for another. */
    key: () => (select(), key)
  };
}

function createTransport({ target, runtime }) {
  const hostId = target.hostId(), generation = target.generation();
  const isCurrent = () => target.isRemote() && target.hostId() === hostId && target.generation() === generation;
  const name = () => target.hostName();
  const call = createRemoteRequest({ runtime, hostId, routes: SYNTHESIS_ROUTES, isCurrent, online: () => target.online(),
    offlineMessage: () => `${name()} is not connected. Nothing was sent.` });
  // Each run's events so far: the next read asks only for what came after.
  const runs = new Map();

  const readRun = async (id, options) => {
    const known = runs.get(id);
    const detail = await call(`/runs/${encodeURIComponent(id)}${known ? `?after=${known.lastSequence}` : ""}`, options);
    const events = [...(known?.events ?? []), ...detail.events].slice(-MAX_EVENTS);
    // The runs read most recently are kept; an older one is read whole again when selected.
    runs.delete(id);
    runs.set(id, { events, lastSequence: detail.lastSequence });
    if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value);
    const { lastSequence: _lastSequence, truncated: _truncated, ...run } = detail;
    return { ...run, events };
  };
  const readDiff = async (id, options) => {
    const diff = await call(`/runs/${encodeURIComponent(id)}/diff`, options);
    const files = await Promise.all(diff.files.map(async file => {
      if (!file.omitted) return { path: file.path, before: file.before, after: file.after };
      const side = async which => {
        if (which === "before" && file.beforeBytes === null) return null;
        try { return (await call(`/runs/${encodeURIComponent(id)}/file?path=${encodeURIComponent(file.path)}&side=${which}`, options)).content; }
        catch { return `(${which === "before" ? file.beforeBytes : file.afterBytes} bytes: too large to show from ${name()}.)`; }
      };
      return { path: file.path, before: await side("before"), after: await side("after") };
    }));
    return { files, canApply: diff.canApply };
  };

  return {
    remote: { hostName: name() },
    async request(path, options = {}) {
      const method = String(options.method || "GET").toUpperCase();
      const run = /^\/runs\/([^/?]+)$/.exec(path);
      if (method === "GET" && run) return readRun(decodeURIComponent(run[1]), options);
      const diff = /^\/runs\/([^/?]+)\/diff$/.exec(path);
      if (method === "GET" && diff) return readDiff(decodeURIComponent(diff[1]), options);
      const value = await call(path, options);
      // A list of runs comes without events; the screen reads a run's own when it selects it.
      if (method === "GET" && /^\/projects\/[^/]+\/runs$/.test(path)) return value.runs.map(item => ({ ...item, events: [] }));
      if (method === "POST" && /^\/runs\/[^/]+\/(cancel|resume)$/.test(path)) return { ...value, events: runs.get(value.id)?.events ?? [] };
      if (method === "POST" && /^\/projects\/[^/]+\/runs$/.test(path)) return { ...value, events: [] };
      return value;
    }
  };
}
