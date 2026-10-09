import { createRemoteRequest, createWatchSource, MODEL_ROUTES } from "./runtime-routes.js";

const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const idOf = model => model?.libraryId || model?.id || "";

/** The Models tab on the selected server (R5): the same manager as on this computer, fed by the
 * server's operations. One manager per server selection, so nothing it holds or sends can reach
 * another server; import from this computer's files is not offered. */
export function createServerModels({ target, bridge = window.desktopRemote, createModelManager, onUse, notify, isVisible, currentTarget = () => undefined }) {
  const runtime = bridge?.runtime;
  let manager = null, key = "", context = {};

  /** Known only once connected: an older server does not offer the Models operations. */
  const unsupported = () => {
    const status = target.status();
    return status.state === "online" && status.hostId === target.hostId() && !target.supports("models.local.watch");
  };

  /** The manager of the server on screen, disposed when the selection changes. It is created
   * when the tab is first shown (`create`), then follows the server in the background. */
  function current(create = false) {
    const next = runtime && target.isRemote() ? `${target.hostId()}:${target.generation()}${unsupported() ? ":unsupported" : ""}` : "";
    if (next !== key) { manager?.dispose(); manager = null; key = next; context = {}; }
    if (manager || !create || !next || next.endsWith(":unsupported")) return manager;
    const hostId = target.hostId(), generation = target.generation(), name = () => target.hostName();
    const isCurrent = () => target.isRemote() && target.hostId() === hostId && target.generation() === generation;
    const request = createRemoteRequest({ runtime, hostId, routes: MODEL_ROUTES, isCurrent, online: () => target.online(),
      offlineMessage: () => `${name()} is not connected. Nothing was sent.` });
    const call = async (op, payload) => {
      if (!target.online()) throw new Error(`${name()} is not connected. Nothing was sent.`);
      const result = await runtime.request(op, payload, hostId);
      if (!result?.ok) throw Object.assign(new Error(result?.error?.message || "The server did not answer."), { code: result?.error?.code });
      return result.value;
    };
    // This selection's state: a late answer for an earlier selection never lands in it.
    const own = context;
    const keep = view => { if (isCurrent()) own.settings = view; };
    own.loadSettings = () => call("models.settings.get").then(view => { keep(view); if (isCurrent()) manager?.repaint(); }, () => undefined);
    own.metrics = () => call("system.metrics");
    manager = createModelManager({
      request,
      EventSourceClass: createWatchSource({ runtime, onStatus: bridge.onChange, hostId, streamId: "models.local", isCurrent }),
      desktopModels: null,
      getContext: () => ({ models: own.models ?? [], runtime: own.runtime, systemMetrics: own.systemMetrics, settings: own.settings,
        currentTarget: currentTarget(), host: name(), offline: target.online() ? "" : `${name()} is reconnecting. Showing the last known state; nothing is sent.` }),
      isVisible, notify,
      onLibraryChange: (models, snapshotRuntime) => {
        own.models = models;
        if (snapshotRuntime) own.runtime = snapshotRuntime;
        // The server chat's model choices follow the library (not every download tick).
        const signature = JSON.stringify(models.map(model => [idOf(model), model.state, model.filesAvailable]));
        if (signature !== own.library) { own.library = signature; target.invalidateModels?.(); }
      },
      // Host-wide: the copy in the manager says that other devices lose their loaded models too.
      onContextChange: contextSize => call("models.settings.update", { localModels: { contextSize } }).then(keep),
      onLocalSettingsChange: localModels => call("models.settings.update", { localModels }).then(keep),
      onDefault: model => call("models.setDefault", { modelId: idOf(model) }).then(keep),
      onUse
    });
    void own.loadSettings();
    return manager;
  }

  return {
    /** The Models tab shows the selected server. */
    active: () => Boolean(runtime) && target.isRemote(),
    render() {
      const active = current(isVisible());
      if (active) return active.render();
      if (!key.endsWith(":unsupported")) return "";
      return `<div class="model-manager" id="server-model-manager"><section class="mm-main-panel"><div class="mm-empty"><h3>${escape(`Models on ${target.hostName()}`)}</h3>
        <p>${escape(`Update Local Cognitive on ${target.hostName()} to manage its models from here.`)}</p></div></section></div>`;
    },
    bind(element) { current()?.bind(element); },
    /** The connection changed. Returns true when the tab must be rendered again (another
     * manager, or none); otherwise repaints in place and fetches the settings once back online. */
    statusChanged() {
      const before = key, active = current();
      if (key !== before) return true;
      if (!active) return false;
      if (target.online() && !context.settings) void context.loadSettings?.();
      active.repaint();
      return false;
    },
    async pollMetrics() {
      const active = current();
      if (!active || !target.online() || !isVisible()) return;
      const selection = key;
      try {
        const metrics = await context.metrics();
        if (selection !== key) return;
        context.systemMetrics = metrics;
        active.updateLiveView();
      } catch { /* Metrics never block the tab. */ }
    },
    /** The server's settings were saved from Settings: its runtime settings are read again. */
    settingsChanged() { if (manager && target.online()) void context.loadSettings?.(); },
    dispose() { manager?.dispose(); manager = null; key = ""; context = {}; }
  };
}
