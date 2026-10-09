import { remoteModelOptions } from "./chat-target.js";
import { createRemoteRequest, SETTINGS_ROUTES } from "./runtime-routes.js";
import { createSettingsData } from "./settings-data.js";

const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const DEFERRED = new Set(["plugins", "connections", "mcp"]);

/** The Settings screen's host pages on the selected server (R5-3): the server's settings as a
 * device may see them, saved through the same settings store as on this computer but on that
 * server. One source per server selection; host-only fields are shown, never edited. */
export function createServerSettings({ target, bridge = window.desktopRemote, onChange = () => {}, onSaved = () => {} }) {
  const runtime = bridge?.runtime;
  let source = null, key = "";
  const current = () => {
    const next = runtime && target.isRemote() ? `${target.hostId()}:${target.generation()}` : "";
    if (next !== key) {
      source?.dispose();
      source = null;
      key = next;
      if (next) source = createSource({ target, runtime, onChange, onSaved });
    }
    return source;
  };
  return {
    /** The selected server's source, or undefined on this computer. */
    source: () => current() ?? undefined,
    /** The connection changed: true when the open page should be rendered again. */
    statusChanged: () => current()?.statusChanged() ?? false,
    dispose() { source?.dispose(); source = null; key = ""; }
  };
}

function createSource({ target, runtime, onChange, onSaved }) {
  const hostId = target.hostId(), generation = target.generation();
  const isCurrent = () => target.isRemote() && target.hostId() === hostId && target.generation() === generation;
  const name = () => target.hostName();
  const online = () => target.online();
  let view, runtimeStatus, loaded = false, loadError = "", inFlight = null, wasOnline = online(), disposed = false;
  const request = createRemoteRequest({ runtime, hostId, routes: SETTINGS_ROUTES, isCurrent, online,
    offlineMessage: () => `${name()} is not connected. Nothing was saved.` });
  const data = createSettingsData({ request, onSaved: response => {
    if (disposed || !isCurrent()) return;
    view = response.settings;
    onSaved();
    onChange();
  } });

  const load = () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      if (!online()) return;
      const [result] = await Promise.all([runtime.request("settings.get", {}, hostId), target.models().catch(() => undefined)]);
      if (disposed || !isCurrent()) return;
      if (!result?.ok) { loadError = result?.error?.message || `${name()} did not send its settings.`; return; }
      view = result.value.settings;
      runtimeStatus = result.value.runtimeStatus;
      loaded = true;
      loadError = "";
    })().catch(error => { loadError = error?.message || `${name()} did not send its settings.`; })
      .finally(() => { inFlight = null; if (!disposed && isCurrent()) onChange(); });
    return inFlight;
  };
  const unsupported = () => target.status().state === "online" && target.status().hostId === hostId && !target.supports("settings.get");
  const onServer = `set on ${name()}`;
  /** What a host-only field shows instead of a control: never a path or an address with credentials. */
  const hostOnly = (field, settings) => {
    if (field === "filesystem.accessMode") return `${settings?.filesystem?.accessMode === "full" ? "Full access" : "Restricted"} · ${onServer}`;
    if (field === "filesystem.allowedDirectories") {
      const count = settings?.filesystem?.allowedDirectoryCount ?? 0;
      return `${count} folder${count === 1 ? "" : "s"} · ${onServer}`;
    }
    const address = /^providers\.([^.]+)\.baseUrl$/.exec(field);
    if (address) return `${settings?.providers?.[address[1]]?.baseUrl || "Default address"} · ${onServer}`;
    if (["filesystem.outputDir", "localModels.modelsDir", "memory.baseDir", "memory.openMemory.dbPath"].includes(field)) return `Set on ${name()}`;
    return undefined;
  };

  return {
    key: hostId,
    hostName: name,
    /** The server's app version from the connection, when known. */
    version: () => target.status().hostId === hostId ? target.status().serverVersion : undefined,
    online,
    loaded: () => loaded,
    error: () => loadError,
    unsupported,
    settings: () => view,
    runtimeStatus: () => runtimeStatus,
    data,
    ensureLoaded() { if (!loaded && !loadError && !inFlight && online() && !unsupported()) void load(); },
    reload: () => { loadError = ""; return load(); },
    reconnect: () => target.reconnect(),
    /** The page's fields as the server allows them: host-only ones become read-only rows. */
    fields(_route, specs) {
      return specs.map(spec => {
        const display = hostOnly(spec.name, view);
        return display === undefined ? spec : { ...spec, type: "host-only", display };
      });
    },
    /** A page that cannot show the server yet (`blocked`), or the server-specific note. */
    page(route) {
      const [page] = route.split("/");
      const useLocal = { title: "", text: "", actions: ["use-local"] };
      if (DEFERRED.has(page)) return { blocked: { ...useLocal, title: `Plugins and MCP on ${name()} come in a later update`,
        text: `These settings are for each machine. Switch to This computer to manage this Mac's plugins and MCP servers.` } };
      if (unsupported()) return { blocked: { ...useLocal, title: `Update Local Cognitive on ${name()}`, text: `The version on ${name()} cannot show its settings here yet.` } };
      if (!loaded && !online()) return { blocked: { title: `${name()} is not connected`, text: "Its settings appear once it reconnects.", actions: ["retry", "use-local"] } };
      if (!loaded && loadError) return { blocked: { title: `${name()} did not send its settings`, text: loadError, actions: ["retry", "use-local"] } };
      if (!loaded) return { blocked: { title: `Loading settings from ${name()}…`, text: "", actions: [] } };
      const notes = {
        general: `Defaults for new chats on ${name()}, from every device.`,
        providers: `Keys are saved on ${name()} and are never shown again, here or on another device.`,
        runtime: `Saving changes other than the generation profile unloads ${name()}'s models for every device.`,
        agents: `Limits for agents on ${name()}, from every device.`,
        memory: `Memory on ${name()}. Its folders are set on ${name()}.`,
        data: `${name()} keeps its chats, configuration, memory and models on ${name()}. Its folders and filesystem access are set there.`
      };
      return { note: notes[page] };
    },
    /** The provider's model choice from the server's own list. */
    renderModelControl(providerId, value) {
      const choices = remoteModelOptions(target.cachedModels(), providerId);
      const label = choice => `${choice.label}${choice.loaded ? " · Loaded" : ""}`;
      if (providerId === "llamacpp") {
        return `<select name="provider.${escape(providerId)}.model"><option value="">${escape(`${name()} default`)}</option>${choices.map(choice =>
          `<option value="${escape(choice.id)}" ${choice.id === value ? "selected" : ""}>${escape(label(choice))}</option>`).join("")}</select>`;
      }
      const list = `server-models-${String(providerId).replace(/[^a-z0-9-]/gi, "")}`;
      return `<input name="provider.${escape(providerId)}.model" type="text" value="${escape(value)}" list="${list}" /><datalist id="${list}">${choices.map(choice =>
        `<option value="${escape(choice.id)}">${escape(label(choice))}</option>`).join("")}</datalist>`;
    },
    statusChanged() {
      const now = online(), changed = now !== wasOnline;
      wasOnline = now;
      if (changed && now && !loaded) { loadError = ""; void load(); }
      return changed;
    },
    dispose() { disposed = true; }
  };
}
