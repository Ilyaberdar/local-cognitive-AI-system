import { icon } from "./ui-primitives.js";

const PROVIDER = "llamacpp";
const ACTIVE_DOWNLOADS = new Set(["queued", "downloading", "paused", "verifying"]);
const DOWNLOAD_LABELS = { queued: "Queued", downloading: "Downloading", paused: "Paused", verifying: "Verifying files", completed: "Installed", failed: "Download failed", cancelled: "Cancelled" };
const MODEL_LABELS = { unloaded: "On device", loading: "Loading into memory", ready: "Loaded", unloading: "Unloading", error: "Runtime error" };
// What stays possible while a server's tab is offline: nothing that would be sent to it.
const OFFLINE_ACTIONS = new Set(["tab", "close-detail", "delete-prompt", "delete-dismiss", "copy-error"]);
const MODEL_SETTINGS_TABS = [
  { id: "context", label: "Context" },
  { id: "gpuLayers", label: "GPU layers" },
  { id: "memoryLimitPercent", label: "Memory" },
  { id: "loadTimeoutMs", label: "Load timeout" },
  { id: "generationTimeoutMs", label: "Response timeout" },
  { id: "generation", label: "Generation" }
];
const MODEL_SETTINGS_FIELDS = {
  gpuLayers: { key: "gpuLayers", label: "GPU layers", min: 0, max: 999, allowAuto: true, description: "auto places each model on the GPU first and puts only what does not fit on the CPU. A number fixes the offloaded layers; 0 runs on the CPU." },
  memoryLimitPercent: { key: "memoryLimitPercent", label: "Memory warning threshold (%)", min: 10, max: 90, description: "Warn when a model estimate reaches this percentage of available memory." },
  loadTimeoutMs: { key: "loadTimeoutMs", label: "Load timeout (ms)", min: 10000, max: 1800000, description: "Maximum time allowed while loading a local model." },
  generationTimeoutMs: { key: "generationTimeoutMs", label: "Generation timeout (ms)", min: 10000, max: 3600000, description: "Maximum time allowed for one local model response." }
};
const GENERATION_PRESETS = {
  precise: { temperature: 0.2, topP: 0.9, topK: 40, minP: 0.05, repeatPenalty: 1.05, maxTokens: 1024 },
  balanced: { temperature: 0.7, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1.05, maxTokens: 2048 },
  creative: { temperature: 1, topP: 0.98, topK: 80, minP: 0.02, repeatPenalty: 1.02, maxTokens: 3072 }
};
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const bytes = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "—";
  const unit = Math.min(4, Math.floor(Math.log(number) / Math.log(1024)));
  return `${(number / 1024 ** unit).toFixed(unit > 1 ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
};
const asArray = (value) => Array.isArray(value) ? value : [];
const nameOf = (model) => model?.displayName || model?.name || model?.repoId?.split("/").at(-1) || model?.id || "Model";
const repoOf = (model) => model?.repoId || model?.id || "";
const idOf = (model) => model?.libraryId || model?.id || "";
const variantsOf = (model) => asArray(model?.variants);
const totalOf = (item) => Number(item?.totalBytes ?? item?.sizeBytes ?? item?.downloadSizeBytes ?? 0);
const downloadedOf = (item) => Number(item?.downloadedBytes ?? item?.receivedBytes ?? 0);
const modelState = (model) => model?.runtimeState || model?.runtimeStatus || model?.state || (model?.loaded || model?.loadedInstanceIds?.length ? "ready" : "unloaded");

// Catalog traffic and download progress stay isolated from the conversation DOM.
// A paired server's tab (server-models.js) passes `EventSourceClass` and `desktopModels: null`,
// and its context names the server (`host`) and says while it is `offline`.
export function createModelManager({ request, getContext, onLibraryChange, onUse, onDefault, onContextChange, onLocalSettingsChange, notify, isVisible, EventSourceClass, desktopModels }) {
  const state = {
    tab: "catalog", source: "recommended", query: "", cursor: null, catalog: [], catalogLoading: false,
    catalogLoaded: false, catalogError: "", catalogWarning: "", runtime: null, downloads: [], connected: false, connectionError: "",
    detail: null, detailRepoId: "", detailLoading: false, detailError: "", variantId: "", projectorPath: "",
    actions: new Set(), deleteId: "", started: false, eventSequence: 0,
    contextDraft: null, contextSaving: false, contextError: "", contextSaved: false,
    settingsTab: "context", advancedDrafts: {}, advancedSaving: false, advancedError: "", advancedSaved: false,
    gpuDraft: null, gpuSaving: false, gpuError: "", gpuSaved: false,
    generationDraft: null, generationSaving: false, generationError: "", generationSaved: false,
    storage: null, storageOpen: false, settingsOpen: false
  };
  let root = null;
  let events = null;
  let fallbackTimer = null;
  let repaintTimer = null;
  let catalogSequence = 0;
  let detailSequence = 0;
  let refreshInFlight = null;
  let settingsBindings = null;
  let settingsFocusId = "";

  const models = () => asArray(getContext().models).filter((model) => model.providerId === PROVIDER);
  const isDefault = (model) => getContext().settings?.llm?.defaultProvider === PROVIDER && getContext().settings?.providers?.[PROVIDER]?.model === idOf(model);
  const isCurrent = (model) => getContext().currentTarget?.providerId === PROVIDER && getContext().currentTarget?.model === idOf(model);
  const hostName = () => getContext().host || "";
  // Plain text: the server names itself, so every use is escaped.
  const place = (local) => hostName() ? `on ${hostName()}` : local;
  const desktop = () => desktopModels === undefined ? window.desktopModels : desktopModels;
  const actionButton = (action, id, label, { primary = false, disabled = false, title = "", symbol = "", spinning = false } = {}) => `<button type="button" class="${primary ? "primary-button" : "ghost-button"}" data-mm-action="${action}" data-mm-id="${escape(id)}" ${disabled || state.actions.has(`${action}:${id}`) || (getContext().offline && !OFFLINE_ACTIONS.has(action)) ? "disabled" : ""} ${title ? `title="${escape(title)}"${!label ? ` aria-label="${escape(title)}"` : ""}` : ""}>${spinning || state.actions.has(`${action}:${id}`) ? '<span class="button-spinner mm-loading-spinner" aria-hidden="true"></span>' : symbol ? icon(symbol) : ""}${escape(label)}</button>`;

  function compatibility(item) {
    const result = item?.compatibility;
    if (!result) return { tone: "muted", label: "Compatibility checked before download", messages: [] };
    const status = result.status || result.level;
    const messagesOf = (items) => asArray(items).map((reason) => typeof reason === "string" ? reason : reason.message || reason.detail || "").filter(Boolean);
    const reasons = messagesOf(result.reasons);
    const warnings = messagesOf(result.warnings);
    const issueCodes = new Set(asArray(result.blockingIssues).map((issue) => issue.code));
    const blocked = result.compatible === false || result.canLoad === false || result.canDownload === false || ["incompatible", "blocked", "unsupported"].includes(status);
    const warning = ["warning", "limited", "too_large"].includes(status) || warnings.length > 0;
    // Warnings must never relabel an architecture/disk failure as a memory failure.
    const memoryBlocked = issueCodes.has("model_memory") || reasons.some((message) => /too large|exceeds? .*(?:memory|RAM)|memory budget/i.test(message));
    const diskBlocked = issueCodes.has("disk_space") || reasons.some((message) => /disk space/i.test(message));
    const typeBlocked = issueCodes.has("model_type") || reasons.some((message) => /architecture|standalone text/i.test(message));
    const memoryWarning = warnings.some((message) => /memory (?:is tight|pressure|use.*exceeds)|swapping/i.test(message));
    const estimateOnly = warnings.length > 0 && warnings.every((message) => /^Memory is an estimate\b/i.test(message));
    return {
      tone: blocked ? "danger" : estimateOnly || status === "unknown" ? "muted" : warning ? "warning" : "success",
      label: blocked ? memoryBlocked ? "Weights exceed device memory" : diskBlocked ? "Not enough disk space" : typeBlocked ? "Unsupported model type" : "Runtime compatibility issue" : warning ? memoryWarning ? "High memory usage" : estimateOnly ? "Compatibility checked on load" : "Compatibility needs attention" : status === "unknown" ? "Compatibility not verified" : "Fits this device",
      messages: [...reasons, ...warnings], blocked,
      downloadBlocked: result.canDownload === false || (result.canDownload === undefined && blocked),
      loadBlocked: result.canLoad === false || (result.canLoad === undefined && blocked),
      memory: result.estimatedMemoryBytes ?? result.requiredMemoryBytes ?? result.estimatedRamBytes,
      totalMemory: result.totalMemoryBytes,
      disk: result.requiredDiskBytes ?? result.requiredFreeDiskBytes
    };
  }

  function renderCompatibility(item, expanded = false, projector = null) {
    const result = compatibility(item);
    return `<div class="mm-compatibility mm-compatibility--${result.tone}" title="${escape(result.messages.join(" "))}"><span class="mm-status-dot" aria-hidden="true"></span><span>${projector ? "Main model: " : ""}${escape(hostName() && result.label === "Fits this device" ? `Fits ${hostName()}` : result.label)}</span></div>${expanded && (result.messages.length || result.memory || projector) ? `<div class="mm-compatibility-detail ${result.tone}">${result.memory ? `<div>${projector ? "Main-model memory estimate" : "Estimated memory"}: <strong>${bytes(result.memory)}</strong>${result.totalMemory ? ` · Device memory: ${bytes(result.totalMemory)}` : ""}${result.disk ? ` · ${projector ? "Main-model disk estimate" : "Required disk space"}: ${bytes(result.disk)}` : ""}</div>` : ""}${projector ? `<div>Vision adapter: ${bytes(projector.sizeBytes)} additional disk space. Additional memory for image processing is checked when loading.</div>` : ""}${result.messages.length ? `<ul>${result.messages.map((message) => `<li>${escape(message)}</li>`).join("")}</ul>` : ""}</div>` : ""}`;
  }

  function renderRuntime() {
    const runtime = state.runtime || getContext().runtime;
    const metrics = getContext().systemMetrics;
    const resources = runtime?.resources || runtime?.limits || {};
    const compatibility = models().find((model) => model.compatibility)?.compatibility || state.catalog.flatMap(variantsOf).find((variant) => variant.compatibility)?.compatibility;
    const totalMemory = resources.totalMemoryBytes ?? resources.totalRamBytes ?? metrics?.memoryTotalBytes ?? compatibility?.totalMemoryBytes;
    const freeMemory = resources.freeMemoryBytes ?? (metrics?.memoryTotalBytes ? metrics.memoryTotalBytes - metrics.memoryUsedBytes : undefined);
    const freeDisk = resources.freeDiskBytes ?? resources.availableDiskBytes ?? compatibility?.freeDiskBytes;
    const status = runtime?.status || "idle";
    const missing = ["unavailable", "missing", "error", "unsupported"].includes(status);
    const label = status === "ready" && runtime?.busy ? "Running inference" : { ready: "Runtime ready", running: "Runtime ready", idle: "Ready when needed", stopped: "Ready when needed", loading: "Loading model", stopping: "Stopping runtime", starting: "Starting runtime", unavailable: "Runtime unavailable", missing: "Runtime not installed", error: "Runtime needs attention", unsupported: "Unsupported platform" }[status] || status;
    const contextSize = runtime?.effectiveContextSize;
    // A server's GPUs (system.metrics): how much of each one's memory its models use.
    const gpus = getContext().host ? metrics?.gpus || [] : [];
    const gpuBars = gpus.map((gpu) => { const used = Number(gpu.totalBytes) > 0 ? Math.min(100, Math.max(0, Number(gpu.usedBytes) / Number(gpu.totalBytes) * 100)) : 0;
      return `<span class="mm-gpu" title="${escape(gpu.name)}"><span>GPU ${escape(gpu.index)}</span><span class="mm-gpu-bar" role="img" aria-label="${escape(`${gpu.name}: ${bytes(gpu.usedBytes)} of ${bytes(gpu.totalBytes)} used`)}"><span style="width: ${used.toFixed(1)}%"></span></span><span>${bytes(gpu.freeBytes)} free / ${bytes(gpu.totalBytes)}</span></span>`; }).join("");
    return `<div class="mm-runtime-strip" data-mm-runtime>
      <div class="mm-runtime-status"><span class="mm-status-dot ${missing ? "is-warning" : "is-success"}"></span><span>${escape(label)}</span>${runtime?.backend ? `<span class="mm-runtime-backend">${escape(runtime.backend)}</span>` : ""}${runtime?.fallbackReason ? `<span class="mm-runtime-backend is-warning" title="${escape(runtime.fallbackReason)}">CPU fallback</span>` : ""}${runtime?.queueLength ? `<span>${runtime.queueLength} waiting</span>` : ""}</div>
      <div class="mm-resource-list">${contextSize ? `<span>Active context: <strong>${Number(contextSize).toLocaleString()} tokens</strong></span>` : ""}${totalMemory ? `<span>${freeMemory ? `${bytes(freeMemory)} available / ` : ""}${bytes(totalMemory)} memory</span>` : ""}${freeDisk ? `<span>${bytes(freeDisk)} free on disk</span>` : ""}${gpuBars}${runtime?.version ? `<span title="Bundled runtime version">${escape(runtime.version)}</span>` : ""}</div>
      ${missing && (runtime?.message || runtime?.error) ? renderModelError(runtime.message || runtime.error) : ""}
      ${runtime?.fallbackReason ? `<p class="mm-runtime-message">${escape(runtime.fallbackReason)}</p>` : ""}
    </div>`;
  }

  // Settings change the runtime of the machine on screen; a server's for every device using it.
  function reconfigureNote() {
    const host = getContext().host;
    return host ? `Saving reconfigures the runtime on ${host} and unloads its models for every device using it.` : "Saving reconfigures the local runtime. Load the model again to use the new value.";
  }

  function errorSummary(error) {
    const text = String(typeof error === "string" ? error : error?.message || "Model operation failed.");
    if (/has offset .*expected|failed to read tensor data/i.test(text)) return "Model format is incompatible with this runtime, or the file is damaged.";
    if (/out of memory|failed to allocate|not enough memory/i.test(text)) return "Not enough memory to load this model.";
    if (/Local runtime exited|failed to load model/i.test(text)) return "The local runtime could not load this model.";
    return text.split(/\r?\n/)[0].slice(0, 160) + (text.split(/\r?\n/)[0].length > 160 ? "…" : "");
  }

  function renderModelError(error) {
    const detail = typeof error === "string" ? error : error?.message || "Model operation failed.";
    return `<div class="mm-inline-error mm-model-error" role="status"><span>${escape(errorSummary(detail))}</span><button type="button" class="ghost-button" data-mm-action="copy-error" data-mm-id="${escape(detail)}" aria-label="Copy full error">Copy</button></div>`;
  }

  function renderContextControl() {
    const configured = getContext().settings?.localModels?.contextSize ?? 4096;
    return `<form class="mm-settings-form" id="mm-context-form">
      <div class="mm-settings-copy"><h3>Context size</h3><p class="subtle">Tokens shared by the conversation, tools and answer. Larger context uses more memory.</p><p class="subtle">${escape(reconfigureNote())}</p></div>
      <label class="mm-settings-field" for="mm-context-size"><span>Context size (tokens)</span><span class="mm-settings-input-row"><input id="mm-context-size" name="contextSize" type="number" min="512" max="131072" step="1" required value="${escape(state.contextDraft ?? configured)}" aria-label="Local model context size in tokens" ${state.contextSaving ? "disabled" : ""} /><button id="mm-context-save" class="ghost-button mm-settings-save" type="submit" ${state.contextSaving ? "disabled" : ""}>${state.contextSaving ? '<span class="button-spinner" aria-hidden="true"></span>Saving…' : "Save"}</button></span></label>
      ${state.contextError ? renderModelError(state.contextError) : state.contextSaved ? `<div class="subtle mm-context-feedback" role="status">${getContext().host ? escape(`Context saved on ${getContext().host}. Its models were unloaded; load them again to use it.`) : "Context saved. The local runtime was reconfigured; load the models again to use it."}</div>` : ""}
    </form>`;
  }

  function settingValue(key) {
    return state.advancedDrafts[key] ?? getContext().settings?.localModels?.[key] ?? "";
  }

  function renderAdvancedField(field) {
    return `<label class="mm-settings-field" for="mm-${field.key}"><span>${escape(field.label)}</span><span class="mm-settings-input-row"><input id="mm-${field.key}" name="${field.key}" data-mm-local-setting="${field.key}" ${field.allowAuto ? 'type="text" inputmode="numeric" placeholder="auto"' : `type="number" min="${field.min}" max="${field.max}" step="1" required`} value="${escape(settingValue(field.key))}" aria-label="${escape(field.label)}" ${state.advancedSaving ? "disabled" : ""} /><button id="mm-${field.key}-save" class="ghost-button mm-settings-save" type="submit" ${state.advancedSaving ? "disabled" : ""}>${state.advancedSaving ? '<span class="button-spinner" aria-hidden="true"></span>Saving…' : "Save"}</button></span></label>`;
  }

  function renderAdvancedSettings(tab) {
    const field = MODEL_SETTINGS_FIELDS[tab];
    if (!field) return "";
    const formId = `mm-${tab}-form`;
    return `<form class="mm-settings-form" id="${formId}" data-mm-settings-form="${tab}">
      <div class="mm-settings-copy"><h3>${escape(field.label)}</h3><p class="subtle">${escape(field.description)}</p><p class="subtle">${escape(reconfigureNote())}</p></div>
      ${renderAdvancedField(field)}
      ${state.advancedError ? renderModelError(state.advancedError) : state.advancedSaved ? `<div class="subtle mm-context-feedback" role="status">${getContext().host ? escape(`Settings saved on ${getContext().host}. Its models were unloaded.`) : "Settings saved. The local runtime was reconfigured."}</div>` : ""}
    </form>`;
  }

  function generationSettings() {
    const configured = getContext().settings?.localModels?.generation || { preset: "server" };
    return state.generationDraft || configured;
  }

  function generationValues(settings) {
    return settings.preset === "custom" ? settings : GENERATION_PRESETS[settings.preset] || {};
  }

  function renderGenerationSettings() {
    const generation = generationSettings();
    const values = generationValues(generation);
    return `<form class="mm-settings-form" id="mm-generation-form">
      <div class="mm-settings-copy"><h3>Generation profile</h3><p class="subtle">Controls the next local response. Changing these values keeps a loaded model in memory.</p></div>
      <label class="mm-settings-field" for="mm-generation-preset"><span>Profile</span><select id="mm-generation-preset" data-mm-generation-preset aria-label="Generation profile">${[["server", "Default"], ["precise", "Precise"], ["balanced", "Balanced"], ["creative", "Creative"], ["custom", "Custom"]].map(([id, label]) => `<option value="${id}" ${generation.preset === id ? "selected" : ""}>${label}</option>`).join("")}</select><small>${generation.preset === "server" ? "Uses built-in values until you choose a profile or edit a value." : getContext().host ? "Top P, Top K, Min P, repeat penalty and seed keep their values." : "Open Local Runtime for Top P, Top K, Min P, repeat penalty and seed."}</small></label>
      <label class="mm-settings-field" for="mm-generation-temperature"><span>Temperature</span><span class="mm-settings-input-row"><input id="mm-generation-temperature" data-mm-generation-value="temperature" type="number" min="0" max="2" step="0.01" value="${escape(values.temperature ?? "")}" placeholder="Use default" aria-label="Temperature" ${state.generationSaving ? "disabled" : ""} /><button class="ghost-button mm-settings-save" type="submit" ${state.generationSaving ? "disabled" : ""}>${state.generationSaving ? '<span class="button-spinner" aria-hidden="true"></span>Saving…' : "Save"}</button></span></label>
      <label class="mm-settings-field" for="mm-generation-max-tokens"><span>Max response tokens</span><input id="mm-generation-max-tokens" data-mm-generation-value="maxTokens" type="number" min="1" max="32768" step="1" value="${escape(values.maxTokens ?? "")}" placeholder="Runtime default" aria-label="Max response tokens" ${state.generationSaving ? "disabled" : ""} /></label>
      ${getContext().host ? "" : `<a class="mm-generation-link" href="#/settings/runtime">Open full local generation settings ${icon("chevronRight")}</a>`}
      ${state.generationError ? renderModelError(state.generationError) : state.generationSaved ? '<div class="subtle mm-context-feedback" role="status">Generation settings saved. The loaded models stay ready.</div>' : ""}
    </form>`;
  }

  function renderStorage() {
    const storage = state.storage || getContext().storage;
    if (!storage) return `<details class="mm-storage" id="mm-storage" ${state.storageOpen ? "open" : ""}><summary>${icon("info")}<span>Info</span>${icon("chevronDown")}</summary><div class="mm-storage-body"><strong>Model storage</strong><p class="subtle">Storage information is not available yet.</p></div></details>`;
    const external = asArray(storage.externalLibraries);
    return `<details class="mm-storage" id="mm-storage" ${state.storageOpen ? "open" : ""}><summary>${icon("info")}<span>Info</span>${icon("chevronDown")}</summary>
      <div class="mm-storage-body"><strong>Model storage</strong><p class="subtle">${bytes(storage.managedBytes)} in this app${external.length ? ` · ${bytes(external.reduce((sum, library) => sum + Number(library.sizeBytes || 0), 0))} in other libraries` : ""}</p><div class="mm-storage-row"><strong>This app</strong><span>${bytes(storage.managedBytes)}</span></div>
      ${storage.partialBytes ? `<div class="mm-storage-row"><span>Partial downloads</span><span>${bytes(storage.partialBytes)}</span></div>` : ""}${storage.untrackedBytes ? `<div class="mm-storage-row"><span>Other files in the model folder</span><span>${bytes(storage.untrackedBytes)}</span></div>` : ""}
      ${external.map(library => `<section class="mm-storage-library"><div class="mm-storage-row"><strong>${escape(library.name)}</strong><span>${bytes(library.sizeBytes)}</span></div><p class="subtle mm-storage-path">${escape(library.path)}</p><p class="subtle">Stored separately. GGUF models can be imported; MLX models use their own runtime.</p>${asArray(library.models).map(model => `<div class="mm-storage-row"><span>${escape(model.name)} <span class="badge">${escape(model.format)}</span></span><span>${bytes(model.sizeBytes)}</span></div>`).join("")}</section>`).join("")}
      ${asArray(storage.warnings).map(warning => `<p class="subtle">${escape(warning)}</p>`).join("")}</div></details>`;
  }

  /** The GPUs a CUDA build sees; the GPU tab is shown only with more than one. */
  function runtimeGpus() { return (state.runtime || getContext().runtime)?.gpus ?? []; }
  function settingsTabs() { return runtimeGpus().length > 1 ? [...MODEL_SETTINGS_TABS, { id: "gpus", label: "GPUs" }] : MODEL_SETTINGS_TABS; }
  function gpuSettings() { return state.gpuDraft ?? getContext().settings?.localModels?.multiGpu ?? {}; }

  /** How models use several GPUs: split or not, by layers or rows, and which GPUs. */
  function renderGpuSettings() {
    const settings = gpuSettings(), gpus = runtimeGpus(), chosen = settings.devices ?? [];
    const split = settings.split ?? "auto", mode = settings.mode ?? "layer";
    return `<form class="mm-settings-form" id="mm-gpus-form" data-mm-gpu-form>
      <div class="mm-settings-copy"><h3>Several GPUs</h3><p class="subtle">How a model uses more than one GPU. It applies to the next model you load; loaded models keep their place.</p><p class="subtle">Not yet checked on real multi-GPU hardware.</p></div>
      <label class="mm-settings-field"><span>Split a model across GPUs</span><select data-mm-gpu="split" ${state.gpuSaving ? "disabled" : ""}>
        <option value="auto" ${split === "auto" ? "selected" : ""}>Only when it does not fit one GPU</option>
        <option value="always" ${split === "always" ? "selected" : ""}>Always, over every chosen GPU with room</option>
        <option value="never" ${split === "never" ? "selected" : ""}>Never (one GPU; the rest on the CPU)</option></select></label>
      <label class="mm-settings-field"><span>Split by</span><select data-mm-gpu="mode" ${state.gpuSaving ? "disabled" : ""}>
        <option value="layer" ${mode === "layer" ? "selected" : ""}>Layers (any GPU)</option>
        <option value="row" ${mode === "row" ? "selected" : ""}>Rows (NVIDIA; the main GPU also holds the context)</option></select></label>
      <fieldset class="mm-settings-field"><legend>GPUs models may use</legend>${gpus.map((gpu) => `<label class="mm-gpu-choice"><input type="checkbox" data-mm-gpu-device="${escape(gpu.id)}" ${!chosen.length || chosen.includes(gpu.id) ? "checked" : ""} ${state.gpuSaving ? "disabled" : ""} /> GPU ${escape(gpu.index)} · ${escape(gpu.name)} · ${bytes(gpu.totalBytes)}</label>`).join("")}</fieldset>
      <button class="ghost-button mm-settings-save" type="submit" ${state.gpuSaving ? "disabled" : ""}>${state.gpuSaving ? '<span class="button-spinner" aria-hidden="true"></span>Saving…' : "Save"}</button>
      ${state.gpuError ? renderModelError(state.gpuError) : state.gpuSaved ? '<div class="subtle mm-context-feedback" role="status">Saved. The next model you load follows it.</div>' : ""}
    </form>
    <div class="mm-settings-copy"><h3>Rebalance</h3><p class="subtle">Load the loaded models again by these settings, the largest first, once their running requests finish. They are briefly unavailable.</p>
      <button type="button" class="ghost-button" data-mm-rebalance ${state.rebalancing ? "disabled" : ""}>${state.rebalancing ? '<span class="button-spinner" aria-hidden="true"></span>Rebalancing…' : "Rebalance loaded models"}</button>
      ${state.rebalanceMessage ? `<div class="subtle mm-context-feedback" role="status">${escape(state.rebalanceMessage)}</div>` : ""}</div>`;
  }

  async function rebalanceModels() {
    if (state.rebalancing) return;
    state.rebalancing = true; state.rebalanceMessage = ""; repaint();
    try {
      const result = await request("/local/models/rebalance", { method: "POST", timeoutMs: 0 });
      state.rebalanceMessage = result.status === "rebalancing" ? "Rebalancing continues; the models show their new places when loaded."
        : result.failed?.length ? `Reloaded ${result.reloaded.length}; not loaded again: ${result.failed.map((item) => item.modelId).join(", ")}.`
        : result.reloaded?.length ? `Reloaded ${result.reloaded.length} model${result.reloaded.length === 1 ? "" : "s"}.` : "No model was loaded.";
      await refresh();
    } catch (error) { state.rebalanceMessage = error.message || "Unable to rebalance the models."; }
    finally { state.rebalancing = false; repaint(); }
  }

  async function saveGpuSettings() {
    if (state.gpuSaving) return;
    const form = root.querySelector("[data-mm-gpu-form]");
    const devices = [...form.querySelectorAll("[data-mm-gpu-device]")];
    const checked = devices.filter((box) => box.checked).map((box) => box.dataset.mmGpuDevice);
    if (!checked.length) { state.gpuError = "Choose at least one GPU."; repaint(); return; }
    const multiGpu = { split: form.querySelector('[data-mm-gpu="split"]').value, mode: form.querySelector('[data-mm-gpu="mode"]').value,
      // All GPUs checked: no list, so a GPU added later is used too. A model's own GPUs stay.
      ...(checked.length < devices.length ? { devices: checked } : {}), ...(gpuSettings().pins ? { pins: gpuSettings().pins } : {}) };
    state.gpuSaving = true; state.gpuError = ""; state.gpuSaved = false; repaint();
    try {
      if (typeof onLocalSettingsChange !== "function") throw new Error("GPU settings cannot be saved in this build.");
      await onLocalSettingsChange({ multiGpu });
      state.gpuDraft = null; state.gpuSaved = true;
      await refresh();
    } catch (error) { state.gpuError = error.message || "Unable to save the GPU settings."; }
    finally { state.gpuSaving = false; repaint(); }
  }

  function renderSettings() {
    const tabs = settingsTabs();
    const activeTab = tabs.some((tab) => tab.id === state.settingsTab) ? state.settingsTab : "context";
    const activePanel = activeTab === "context" ? renderContextControl() : activeTab === "generation" ? renderGenerationSettings() : activeTab === "gpus" ? renderGpuSettings() : renderAdvancedSettings(activeTab);
    return `<section id="mm-settings" class="mm-settings" popover="auto" role="dialog" tabindex="-1" aria-labelledby="mm-settings-title">
      <header class="mm-settings-header"><div><h2 id="mm-settings-title">Model settings</h2><p class="subtle">${getContext().host ? escape(`Configure inference on ${getContext().host}`) : "Configure local inference"}</p></div><button type="button" class="mm-settings-close" popovertarget="mm-settings" popovertargetaction="hide" aria-label="Close model settings">${icon("close")}</button></header>
      <div class="mm-settings-body"><div class="mm-settings-tabs" role="tablist" aria-label="Model settings">${tabs.map((tab) => `<button type="button" role="tab" id="mm-${tab.id}-tab" data-mm-settings-tab="${tab.id}" aria-selected="${tab.id === activeTab}" aria-controls="mm-${tab.id}-panel" tabindex="${tab.id === activeTab ? "0" : "-1"}">${tab.label}</button>`).join("")}</div>
      <div id="mm-${activeTab}-panel" class="mm-settings-panel" role="tabpanel" aria-labelledby="mm-${activeTab}-tab">${activePanel}</div>${renderStorage()}</div>
    </section>`;
  }

  async function saveContext() {
    if (state.contextSaving) return;
    const contextSize = Number(state.contextDraft ?? getContext().settings?.localModels?.contextSize ?? 4096);
    if (!Number.isInteger(contextSize) || contextSize < 512 || contextSize > 131072) {
      state.contextError = "Enter a whole number between 512 and 131072 tokens.";
      repaint(); return;
    }
    state.contextSaving = true; state.contextError = ""; state.contextSaved = false; repaint();
    try {
      await onContextChange(contextSize);
      state.contextDraft = null; state.contextSaved = true;
      await refresh();
    } catch (error) { state.contextError = error.message || "Unable to save the context size."; }
    finally { state.contextSaving = false; repaint(); }
  }

  async function saveAdvancedSettings(tab) {
    if (state.advancedSaving) return;
    const field = MODEL_SETTINGS_FIELDS[tab];
    if (!field) return;
    const raw = String(settingValue(field.key)).trim();
    const value = field.allowAuto && (raw === "" || raw.toLowerCase() === "auto") ? "auto" : Number(raw);
    if (value !== "auto" && (!Number.isInteger(value) || value < field.min || value > field.max)) {
      state.advancedError = `Enter ${field.allowAuto ? "auto or " : ""}a whole number between ${field.min.toLocaleString()} and ${field.max.toLocaleString()} for ${field.label}.`;
      state.advancedSaved = false; repaint(); return;
    }
    state.advancedSaving = true; state.advancedError = ""; state.advancedSaved = false; repaint();
    try {
      if (typeof onLocalSettingsChange !== "function") throw new Error("Local model settings cannot be saved in this build.");
      await onLocalSettingsChange({ [field.key]: value });
      delete state.advancedDrafts[field.key];
      state.advancedSaved = true;
      await refresh();
    } catch (error) { state.advancedError = error.message || "Unable to save the local model settings."; }
    finally { state.advancedSaving = false; repaint(); }
  }

  async function saveGenerationSettings() {
    if (state.generationSaving) return;
    const generation = generationSettings();
    const values = generationValues(generation);
    if (generation.preset === "custom" && (!Number.isFinite(Number(values.temperature)) || Number(values.temperature) < 0 || Number(values.temperature) > 2 || !Number.isInteger(Number(values.maxTokens)) || Number(values.maxTokens) < 1 || Number(values.maxTokens) > 32768)) {
      state.generationError = "Enter a temperature between 0 and 2 and a whole response limit between 1 and 32768.";
      state.generationSaved = false; repaint(); return;
    }
    state.generationSaving = true; state.generationError = ""; state.generationSaved = false; repaint();
    try {
      if (typeof onLocalSettingsChange !== "function") throw new Error("Local generation settings cannot be saved in this build.");
      await onLocalSettingsChange({ generation });
      state.generationDraft = null; state.generationSaved = true;
      await refresh();
    } catch (error) { state.generationError = error.message || "Unable to save generation settings."; }
    finally { state.generationSaving = false; repaint(); }
  }

  function renderDownload(job) {
    const total = totalOf(job);
    const received = downloadedOf(job);
    const percent = total > 0 ? Math.min(100, Math.max(0, received / total * 100)) : 0;
    const status = job.status || job.state || "queued";
    const speed = Number(job.speedBytesPerSecond ?? job.bytesPerSecond ?? 0);
    const id = job.downloadId || job.id;
    return `<article class="mm-download" data-mm-download="${escape(id)}">
      <div class="mm-download-head"><div><strong>${escape(job.displayName || job.name || job.modelName || job.repoId?.split("/").at(-1) || "Model download")}</strong><span class="subtle">${escape(job.quantization || job.variantId || "")}</span></div><span class="mm-download-state ${status === "failed" ? "danger" : ""}">${escape(DOWNLOAD_LABELS[status] || status)}</span></div>
      <progress class="mm-download-progress" max="100" ${total > 0 ? `value="${percent}"` : ""} aria-label="Download progress"></progress>
      <div class="mm-download-footer"><div class="mm-download-numbers"><span>${bytes(received)} / ${bytes(total)}${total ? ` · ${percent.toFixed(1)}%` : ""}</span><span>${status === "downloading" && speed ? `${bytes(speed)}/s` : status === "verifying" ? "Checking file integrity" : ""}</span></div><div class="mm-inline-actions">
        ${["queued", "downloading"].includes(status) ? actionButton("pause", id, "Pause") : ""}
        ${["paused", "failed"].includes(status) ? actionButton("resume", id, status === "failed" ? "Retry" : "Resume") : ""}
        ${ACTIVE_DOWNLOADS.has(status) || status === "failed" ? actionButton("cancel", id, "Cancel", { disabled: status === "verifying" }) : ""}
      </div></div>${job.error ? renderModelError(job.error) : ""}
    </article>`;
  }

  function renderDownloads() {
    const active = state.downloads.filter((job) => ACTIVE_DOWNLOADS.has(job.status || job.state) || (job.status || job.state) === "failed");
    return `<div data-mm-downloads>${active.length ? `<section class="mm-downloads"><div class="mm-section-heading"><h3>Downloads</h3><span class="mm-count">${active.length}</span><span class="subtle">Saved automatically · Resume after restart</span></div>${active.map(renderDownload).join("")}</section>` : ""}</div>`;
  }

  function renderCatalogCard(item) {
    const repoId = repoOf(item);
    const author = item.author || repoId.split("/")[0];
    const installed = models().some((model) => model.repoId === repoId);
    const preview = variantsOf(item)[0] || item;
    return `<article class="mm-model-card">
      <div class="mm-card-heading"><div class="mm-model-mark">${icon("models")}</div><div><h3>${escape(nameOf(item))}</h3><div class="subtle">${escape(author)}</div></div>${installed ? `<span class="badge success">${escape(hostName() ? `On ${hostName()}` : "On device")}</span>` : ""}</div>
      ${item.description ? `<p class="mm-description">${escape(item.description)}</p>` : ""}
      <div class="mm-tags"><span>GGUF</span><span>${asArray(item.projectors).length ? "Images with adapter" : item.projectors ? "Text only" : "Check image support"}</span>${item.parameterCount || item.parameters ? `<span>${escape(item.parameterCount || item.parameters)}</span>` : ""}${item.license ? `<span title="Model license">${escape(item.license)}</span>` : ""}${totalOf(preview) ? `<span>${bytes(totalOf(preview))}${variantsOf(item).length > 1 ? "+" : ""}</span>` : ""}${item.gated ? '<span class="warning">Access required</span>' : ""}</div>
      ${preview.compatibility ? renderCompatibility(preview) : '<div class="subtle mm-card-note">Choose a quantization to check memory and disk requirements.</div>'}
      <div class="mm-card-footer"><a href="https://huggingface.co/${encodeRepo(repoId)}" target="_blank" rel="noopener noreferrer" class="mm-source-link">Model card ↗</a>${actionButton("details", repoId, "View model", { symbol: "chevronRight" })}</div>
    </article>`;
  }

  function renderCatalog() {
    return `<div id="mm-catalog" role="tabpanel" aria-labelledby="mm-tab-catalog">
      <form class="mm-search" id="mm-search-form"><label class="mm-search-input" for="mm-search-input">${icon("search")}<input id="mm-search-input" name="query" type="search" value="${escape(state.query)}" placeholder="Search Hugging Face GGUF models" autocomplete="off" aria-label="Search Hugging Face models" /></label><button class="ghost-button" type="submit" ${state.catalogLoading ? "disabled" : ""}>Search</button></form>
      <div class="mm-catalog-toolbar"><div class="mm-source-tabs" aria-label="Catalog source"><button type="button" data-mm-action="recommended" aria-pressed="${state.source === "recommended"}">Recommended</button><button type="button" data-mm-action="browse" aria-pressed="${state.source === "search"}">Hugging Face</button></div><span class="subtle">GGUF models · Text and images</span></div>
      ${state.catalogWarning ? `<div class="mm-catalog-warning" role="status">${escape(state.catalogWarning)}</div>` : ""}
      ${state.catalogError ? `<div class="mm-empty mm-empty--error" role="status">${icon("models")}<h3>Catalog is unavailable</h3><p>${escape(state.catalogError)}</p><p>Models on this device remain available offline.</p>${actionButton("retry-catalog", "", "Try again")}</div>` : ""}
      ${state.catalogLoading && !state.catalog.length ? '<div class="mm-empty" role="status"><span class="activity-scan" aria-hidden="true"></span><p>Loading model catalog…</p></div>' : ""}
      <div class="mm-catalog-grid">${state.catalog.map(renderCatalogCard).join("")}</div>
      ${!state.catalogLoading && !state.catalogError && state.catalogLoaded && !state.catalog.length ? '<div class="mm-empty"><h3>No models found</h3><p>Try a model name or author. Only supported GGUF variants can be downloaded.</p></div>' : ""}
      ${state.cursor ? `<div class="mm-load-more">${actionButton("more", "", state.catalogLoading ? "Loading…" : "Show more", { disabled: state.catalogLoading })}</div>` : ""}
    </div>`;
  }

  // Where a loaded model runs (GPU, several GPUs, partly CPU) and why it may be slow.
  function renderPlacement(id) {
    const runtime = state.runtime || getContext().runtime;
    const placement = (runtime?.instances || []).find(instance => instance.modelId === id)?.placement;
    if (!placement) return "";
    const warnings = (placement.warnings || []).map(warning => `<div class="subtle mm-placement-warning">${escape(warning)}</div>`).join("");
    return `<div class="subtle mm-placement">Runs on: <strong>${escape(placement.label)}</strong>${placement.retried ? " · placed again after running out of memory" : ""}</div>${warnings}`;
  }

  function renderLibraryCard(model) {
    const id = idOf(model);
    const status = modelState(model);
    const busy = ["loading", "unloading"].includes(status) || state.actions.has(`load:${id}`) || state.actions.has(`unload:${id}`) || state.actions.has(`projector:${id}`);
    const loaded = status === "ready";
    const used = Boolean(model.busy) || Number(model.activeRequests || model.inUse || 0) > 0;
    const fit = compatibility(model);
    return `<article class="mm-model-card mm-library-card" data-mm-library-id="${escape(id)}">
      <div class="mm-card-heading"><div class="mm-model-mark ${loaded ? "is-loaded" : ""}">${icon("models")}</div><div><h3>${escape(nameOf(model))}</h3><div class="subtle">${escape(model.repoId || model.providerName || "Local models")}</div></div><span class="badge ${loaded ? "success" : status === "error" ? "danger" : ""}">${busy ? '<span class="button-spinner mm-loading-spinner" aria-hidden="true"></span>' : ""}${escape(status === "unloaded" && hostName() ? `On ${hostName()}` : MODEL_LABELS[status] || status)}</span></div>
      <div class="mm-tags"><span>${bytes(totalOf(model))}</span><span>${model.vision === true ? "Images" : "Text only"}</span>${model.quantization ? `<span>${escape(model.quantization)}</span>` : ""}${model.license ? `<span>${escape(model.license)}</span>` : ""}${isDefault(model) ? '<span class="mm-tag-selected">App default</span>' : ""}${isCurrent(model) ? '<span class="mm-tag-selected">Current chat</span>' : ""}${used ? '<span>In use</span>' : ""}</div>
      <div class="mm-library-status">${renderCompatibility(model)}
      ${fit.memory ? `<div class="subtle mm-memory-estimate">Estimated memory: ${bytes(fit.memory)}${fit.totalMemory ? ` · ${bytes(fit.totalMemory)} ${escape(place("on device"))}` : ""}</div>` : ""}
      ${fit.messages.length ? `<details class="mm-memory-details"><summary>Compatibility details</summary>${renderCompatibility(model, true)}</details>` : ""}
      ${model.projector ? `<div class="subtle mm-projector-note">Vision adapter: ${escape(model.projector.path)} · ${bytes(model.projector.sizeBytes)}</div>` : ""}
      ${loaded && desktop()?.importProjector ? '<div class="subtle mm-projector-note">Changing the vision adapter unloads this model. It loads again with the next request.</div>' : ""}
      ${loaded ? renderPlacement(id) : ""}
      ${model.error ? renderModelError(model.error) : ""}</div>
      <div class="mm-library-actions">${actionButton(loaded ? "unload" : "load", id, status === "loading" || state.actions.has(`load:${id}`) ? "Loading…" : status === "unloading" ? "Unloading…" : loaded ? "Unload" : "Load model", { spinning: busy, primary: !loaded, disabled: busy || used || (!loaded && fit.loadBlocked), symbol: loaded ? "stop" : "play", title: loaded ? "Free memory and keep the downloaded files" : fit.loadBlocked ? fit.messages.join(" ") : "Load this model into memory" })}${actionButton("use", id, isCurrent(model) ? "Open chat" : "Use in chat", { disabled: busy || (!loaded && fit.loadBlocked), symbol: "chat" })}</div>
      <div class="mm-library-footer"><div class="mm-card-footer"><span class="subtle">${loaded ? hostName() ? "Ready for chats" : "Ready for chat, agents and workflows" : fit.loadBlocked ? escape(`Downloaded · Cannot run ${place("on this device")}`) : "Downloaded · Loads automatically when used"}</span><div class="mm-inline-actions">${desktop()?.importProjector ? actionButton("projector", id, model.projector ? "Change vision adapter" : "Add vision adapter", { disabled: busy || used, title: "Choose the matching mmproj GGUF file for this model" }) : ""}${actionButton("default", id, isDefault(model) ? "Default" : "Set default", { disabled: isDefault(model) || (!loaded && fit.loadBlocked) })}${actionButton("delete-prompt", id, "", { disabled: busy || used, symbol: "trash", title: `Delete from ${hostName() || "device"}` })}</div></div>
      ${state.deleteId === id ? `<div class="mm-delete-confirm" role="alert"><p>Delete <strong>${escape(nameOf(model))}</strong> and free ${bytes(totalOf(model))}? You can download it again. Saved chats and workflows keep their model reference.</p><div class="mm-inline-actions">${actionButton("delete", id, `Delete from ${hostName() || "device"}`)}${actionButton("delete-dismiss", id, "Keep model")}</div></div>` : ""}</div>
    </article>`;
  }

  function renderLibrary() {
    const installed = [...models()].sort((left, right) => Number(modelState(right) === "ready") - Number(modelState(left) === "ready") || nameOf(left).localeCompare(nameOf(right)));
    return `<div id="mm-device" role="tabpanel" aria-labelledby="mm-tab-device"><div class="mm-library-intro"><span class="subtle">${hostName() ? escape(`Downloaded files stay on ${hostName()}. Load model uses its memory; Unload frees it.`) : "Downloaded files stay on this device. Load model uses memory; Unload frees it."}</span><div class="mm-inline-actions">${desktop()?.importModel ? actionButton("import", "", "Import GGUF", { symbol: "plus", title: "Choose model weights and, optionally, a matching mmproj vision adapter" }) : ""}${actionButton("refresh", "", "Refresh", { symbol: "refresh" })}</div></div>${installed.length ? `<div class="mm-library-grid">${installed.map(renderLibraryCard).join("")}</div>` : `<div class="mm-empty">${icon("models")}${hostName() ? `<h3>${escape(`No models on ${hostName()} yet`)}</h3><p>Download a model from the catalog to the server, then use it in its chats.</p>` : "<h3>Your local library starts here</h3><p>Download a model from the catalog, then use it in chats, agents and workflows — including workflows with cloud models.</p>"}${actionButton("tab", "catalog", "Browse catalog", { primary: true })}</div>`}</div>`;
  }

  function renderDetail() {
    if (!state.detailRepoId) return "";
    const detail = state.detail;
    const variants = variantsOf(detail);
    const variant = variants.find((item) => String(item.id || item.variantId) === state.variantId) || variants[0];
    const projectors = asArray(detail?.projectors);
    const projector = projectors.find((item) => item.path === state.projectorPath);
    const downloadSize = totalOf(variant) + Number(projector?.sizeBytes || 0);
    const result = compatibility(variant);
    const repoId = state.detailRepoId;
    const gated = detail?.gated || detail?.private;
    const installed = variant && models().some((model) => model.repoId === repoId && model.variantId === (variant.id || variant.variantId) && (!detail?.revision || model.revision === detail.revision));
    const active = variant && state.downloads.some((job) => job.repoId === repoId && job.variantId === (variant.id || variant.variantId) && ACTIVE_DOWNLOADS.has(job.status || job.state));
    return `<dialog class="mm-detail-dialog" id="mm-detail-dialog" aria-labelledby="mm-detail-title"><div class="mm-detail-head"><div><div class="mm-eyebrow">${escape(hostName() ? `Download to ${hostName()}` : "Local model")}</div><h2 id="mm-detail-title">${escape(detail ? nameOf(detail) : repoId.split("/").at(-1))}</h2><a class="mm-source-link" href="https://huggingface.co/${encodeRepo(repoId)}" target="_blank" rel="noopener noreferrer">${escape(repoId)} ↗</a></div><button type="button" class="icon-button" data-mm-action="close-detail" aria-label="Close model details">${icon("close")}</button></div>
      <div class="mm-detail-body">${state.detailLoading ? '<div class="mm-empty" role="status"><span class="activity-scan" aria-hidden="true"></span><p>Checking available files and device compatibility…</p></div>' : state.detailError ? `<div class="mm-inline-error" role="alert">${escape(state.detailError)}</div>` : `
        <div class="mm-tags"><span>GGUF · ${projector ? "Images" : "Text only"}</span>${detail?.license ? `<span>License: ${escape(detail.license)}</span>` : '<span>License not specified</span>'}${detail?.revision ? `<span title="${escape(detail.revision)}">Revision ${escape(detail.revision.slice(0, 8))}</span>` : ""}</div>
        ${detail?.description ? `<p class="mm-description">${escape(detail.description)}</p>` : ""}
        <div class="mm-detail-section"><h3>Download variant</h3><p class="subtle">Smaller quantizations use less disk space and memory. Only the selected variant and its required parts are downloaded.</p>
          ${variants.length ? `<label class="field" for="mm-variant"><span class="subtle">Quantization</span><select id="mm-variant" name="variant">${variants.map((item) => { const id = item.id || item.variantId; return `<option value="${escape(id)}" ${String(id) === String(variant?.id || variant?.variantId) ? "selected" : ""}>${escape(item.quantization || item.name || id)} · ${bytes(totalOf(item))}${compatibility(item).blocked ? " · incompatible" : ""}</option>`; }).join("")}</select></label>` : '<div class="mm-inline-error">This repository has no downloadable text-model variants supported by this runtime.</div>'}
          ${projectors.length ? `<label class="field" for="mm-projector"><span class="subtle">Vision adapter (optional)</span><select id="mm-projector" name="projectorPath"><option value="" ${!projector ? "selected" : ""}>Text only — no vision adapter</option>${projectors.map((item) => `<option value="${escape(item.path)}" ${item.path === state.projectorPath ? "selected" : ""}>${escape(item.path)} · ${bytes(item.sizeBytes)}</option>`).join("")}</select></label><p class="subtle mm-projector-note">${projectors.length > 1 ? "Several adapters are available. Choose the one that matches this model to enable images." : "Choose the matching adapter above to enable images, or choose Text only if you do not need images."} The adapter adds to disk and memory use; compatibility is checked before downloading and loading.</p>` : '<p class="subtle mm-projector-note">No vision adapter is listed in this repository. This download supports text; a matching adapter can be added from your library later.</p>'}
          ${variant ? `<div class="mm-variant-metrics"><div><span>Download size</span><strong>${bytes(downloadSize)}</strong></div><div><span>${projector ? "Main-model memory estimate" : "Estimated memory"}</span><strong>${bytes(result.memory)}</strong></div><div><span>Files</span><strong>${(asArray(variant.files).length || 1) + Number(Boolean(projector))}</strong></div></div>${renderCompatibility(variant, true, projector)}` : ""}
          ${gated ? '<div class="mm-compatibility-detail warning">This model requires access on Hugging Face. Choose a public model from the catalog for direct download.</div>' : ""}
          ${variant?.files?.length ? `<details class="mm-file-details"><summary>Included files (${variant.files.length + Number(Boolean(projector))})</summary><ul>${[...variant.files, ...(projector ? [projector] : [])].map((file) => `<li><span>${escape(typeof file === "string" ? file : file.path || file.filename || file.name)}</span><span>${typeof file === "object" ? bytes(file.sizeBytes ?? file.size) : ""}</span></li>`).join("")}</ul></details>` : ""}
        </div>`}
      </div><div class="mm-detail-footer"><div class="subtle">${installed ? hostName() ? escape(`This variant is already on ${hostName()}.`) : "This variant is already on your device. Add or change its vision adapter in On device." : active ? "Download is already in progress. You can manage it in Downloads." : "Files are checked before the model is added to your library."}</div>${actionButton("download", repoId, installed ? "Installed" : active ? "Downloading" : `Download${variant ? ` · ${bytes(downloadSize)}` : ""}`, { primary: true, disabled: state.detailLoading || Boolean(state.detailError) || !variant || result.downloadBlocked || Boolean(gated) || installed || active, symbol: "arrowDown" })}</div>
    </dialog>`;
  }

  function render() {
    const installed = models();
    const host = hostName(), offline = getContext().offline;
    return `<div class="model-manager${offline ? " is-offline" : ""}" id="${host ? "server-model-manager" : "local-model-manager"}"><section class="mm-main-panel" aria-labelledby="mm-title"><div class="mm-heading"><div><div class="mm-eyebrow">${host ? escape(`Private inference, on ${host}`) : "Private inference, on your computer"}</div><h2 id="mm-title">${host ? escape(`Models on ${host}`) : "Local models"}</h2><p class="subtle">${host ? "Download a model to the server once. Use it in its chats from any paired device." : "Download a model once. Use it in chats, agents and workflows."}</p></div><div class="mm-heading-actions"><div class="mm-library-summary"><strong>${installed.length}</strong><span>${escape(place("on device"))}</span><span class="mm-summary-divider"></span><strong>${installed.filter((model) => modelState(model) === "ready").length}</strong><span>loaded</span></div><button type="button" id="mm-settings-toggle" class="mm-settings-toggle" popovertarget="mm-settings" aria-haspopup="dialog" aria-controls="mm-settings" aria-expanded="${state.settingsOpen}" aria-label="Model settings" title="Model settings">${icon("settings")}</button></div></div>
      ${renderSettings()}${renderRuntime()}<div class="mm-tabs" role="tablist" aria-label="Local model library"><button type="button" id="mm-tab-catalog" role="tab" aria-selected="${state.tab === "catalog"}" aria-controls="mm-catalog" data-mm-action="tab" data-mm-id="catalog">${icon("search")}Catalog</button><button type="button" id="mm-tab-device" role="tab" aria-selected="${state.tab === "device"}" aria-controls="mm-device" data-mm-action="tab" data-mm-id="device">${icon("models")}${escape(host ? `On ${host}` : "On device")}<span class="mm-count">${installed.length}</span></button><span class="mm-live-status" title="${state.connected ? "Live model and download updates" : "Reconnecting; snapshots are refreshed automatically"}"><span class="mm-status-dot ${state.connected ? "is-success" : ""}"></span>${state.connected ? "Live" : "Connecting"}</span></div>
      ${offline ? `<div class="mm-offline-banner" role="status">${icon("info")}<span>${escape(offline)}</span></div>` : state.connectionError ? renderModelError(state.connectionError) : ""}
      ${renderDownloads()}${state.tab === "catalog" ? renderCatalog() : renderLibrary()}
    </section>${renderDetail()}</div>`;
  }

  function repaint() {
    if (!root?.isConnected || !isVisible()) return;
    const active = document.activeElement;
    if (active?.closest?.("#mm-settings") && active.id && active.id !== "mm-settings") settingsFocusId = active.id;
    const focusedId = active?.id === "mm-settings" ? settingsFocusId : root.contains(active) ? active.id : "";
    const selection = active?.tagName === "INPUT" ? [active.selectionStart, active.selectionEnd] : null;
    const dialogScroll = root.querySelector(".mm-detail-body")?.scrollTop || 0;
    const settingsScroll = root.querySelector("#mm-settings")?.scrollTop || 0;
    const holder = document.createElement("div");
    holder.innerHTML = render();
    const replacement = holder.firstElementChild;
    root.replaceWith(replacement);
    bind(replacement);
    const focus = focusedId ? document.getElementById(focusedId) : null;
    if (focus && root.contains(focus)) {
      if (focus.disabled && state.settingsOpen) root.querySelector("#mm-settings")?.focus({ preventScroll: true });
      else focus.focus({ preventScroll: true });
      if (selection && selection[0] !== null) focus.setSelectionRange?.(...selection);
    }
    const body = root.querySelector(".mm-detail-body");
    if (body) body.scrollTop = dialogScroll;
    const settings = root.querySelector("#mm-settings");
    if (settings) settings.scrollTop = settingsScroll;
  }

  function scheduleRepaint() {
    if (repaintTimer) return;
    repaintTimer = window.setTimeout(() => { repaintTimer = null; repaint(); }, 150);
  }

  function updateLiveView() {
    if (!root?.isConnected || !isVisible()) return;
    const runtime = root.querySelector("[data-mm-runtime]");
    if (runtime) { const holder = document.createElement("div"); holder.innerHTML = renderRuntime(); runtime.replaceWith(holder.firstElementChild); }
    const jobs = state.downloads.filter((job) => ACTIVE_DOWNLOADS.has(job.status || job.state) || (job.status || job.state) === "failed");
    const cards = [...root.querySelectorAll("[data-mm-download]")];
    const sameJobs = cards.length === jobs.length && jobs.every((job) => {
      const card = cards.find((item) => item.dataset.mmDownload === (job.id || job.downloadId));
      return card && card.querySelector(".mm-download-state")?.textContent === (DOWNLOAD_LABELS[job.status || job.state] || job.status || job.state);
    });
    if (sameJobs) {
      for (const job of jobs) {
        const card = cards.find((item) => item.dataset.mmDownload === (job.id || job.downloadId));
        const holder = document.createElement("div"); holder.innerHTML = renderDownload(job);
        const progress = card.querySelector("progress");
        const nextProgress = holder.querySelector("progress");
        if (nextProgress.hasAttribute("value")) progress.value = nextProgress.value;
        else progress.removeAttribute("value");
        card.querySelector(".mm-download-numbers").innerHTML = holder.querySelector(".mm-download-numbers").innerHTML;
      }
    } else {
      const downloads = root.querySelector("[data-mm-downloads]");
      if (downloads) { const holder = document.createElement("div"); holder.innerHTML = renderDownloads(); downloads.replaceWith(holder.firstElementChild); }
    }
  }

  async function loadCatalog(more = false) {
    const sequence = ++catalogSequence;
    state.catalogLoading = true;
    state.catalogError = "";
    state.catalogWarning = "";
    if (!more) { state.catalog = []; state.cursor = null; }
    repaint();
    const params = new URLSearchParams();
    if (state.source === "search") params.set("q", state.query.trim());
    if (more && state.cursor) params.set("cursor", state.cursor);
    params.set("source", state.source);
    try {
      const result = await request(`/local/catalog?${params}`, { timeoutMs: 60000 });
      if (sequence !== catalogSequence) return;
      const items = asArray(result?.items || result?.models || result?.repositories || result);
      const combined = more ? [...state.catalog, ...items] : items;
      state.catalog = [...new Map(combined.map((item) => [repoOf(item), item])).values()];
      state.cursor = result?.nextCursor || result?.cursor || null;
      state.catalogWarning = result?.warning || (result?.cached && state.source === "search" ? "Showing a cached catalog. Availability is checked before download." : "");
      state.catalogLoaded = true;
    } catch (error) {
      if (sequence === catalogSequence) state.catalogError = error.message || "Unable to reach Hugging Face.";
    } finally {
      if (sequence === catalogSequence) { state.catalogLoading = false; repaint(); }
    }
  }

  async function openDetail(repoId) {
    const sequence = ++detailSequence;
    state.detailRepoId = repoId;
    state.detail = null; state.detailLoading = true; state.detailError = ""; state.variantId = ""; state.projectorPath = "";
    repaint();
    try {
      const catalogModel = state.catalog.find((item) => repoOf(item) === repoId);
      const params = new URLSearchParams({ repoId });
      if (catalogModel?.revision) params.set("revision", catalogModel.revision);
      const detail = await request(`/local/catalog/model?${params}`, { timeoutMs: 60000 });
      if (sequence !== detailSequence || state.detailRepoId !== repoId) return;
      state.detail = detail;
      if (asArray(detail.projectors).length === 1) state.projectorPath = detail.projectors[0].path;
      const variants = variantsOf(detail);
      const preferred = variants.find((item) => !compatibility(item).blocked && compatibility(item).tone === "success") || variants.find((item) => !compatibility(item).blocked) || variants[0];
      state.variantId = String(preferred?.id || preferred?.variantId || "");
    } catch (error) {
      if (sequence === detailSequence) state.detailError = error.message;
    } finally {
      if (sequence === detailSequence) { state.detailLoading = false; repaint(); }
    }
  }

  async function refresh() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const startedAtSequence = state.eventSequence;
      // The runtime snapshot already includes the complete built-in library.
      // Do not make local actions wait for discovery in unrelated model providers.
      const results = await Promise.allSettled([request("/local/runtime"), request("/local/downloads")]);
      if (results[0].status === "fulfilled") {
        const snapshot = results[0].value;
        state.connectionError = "";
        if (state.eventSequence === startedAtSequence) {
          state.runtime = snapshot?.runtime || snapshot;
          if (snapshot?.storage) state.storage = snapshot.storage;
          if (Array.isArray(snapshot?.models)) onLibraryChange(snapshot.models, state.runtime);
          if (Array.isArray(snapshot?.downloads)) state.downloads = snapshot.downloads;
        }
      }
      else state.connectionError = results[0].reason?.message || "Local model status is unavailable. Retrying automatically.";
      if (state.eventSequence === startedAtSequence && results[1].status === "fulfilled") state.downloads = asArray(results[1].value?.downloads || results[1].value?.jobs || results[1].value);
      scheduleRepaint();
    })().finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  }

  function receiveEvent(event) {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    const sequence = Number(payload.sequence || event.lastEventId || 0);
    // A reconnect snapshot is authoritative, including after a backend restart.
    const type = payload.type || event.type;
    if (type !== "snapshot" && sequence && sequence <= state.eventSequence) return;
    if (sequence) state.eventSequence = sequence;
    const data = payload.snapshot || payload.data || payload;
    const modelSignature = () => JSON.stringify(models().map((model) => [model.id, modelState(model), model.busy, model.error, model.vision, model.projector?.path]));
    const previousModels = modelSignature();
    state.connectionError = "";
    if (data.runtime) state.runtime = data.runtime;
    if (data.storage) state.storage = data.storage;
    if (Array.isArray(data.downloads)) state.downloads = data.downloads;
    if (Array.isArray(data.models)) onLibraryChange(data.models, state.runtime);
    else if (Array.isArray(data.library)) onLibraryChange(data.library, state.runtime, true);
    if (!data.runtime && !Array.isArray(data.downloads) && !Array.isArray(data.models) && !Array.isArray(data.library)) {
      // Events are hints; the snapshot endpoint provides a complete consistent state.
      void refresh();
    } else if (state.detailRepoId || previousModels === modelSignature()) updateLiveView();
    else scheduleRepaint();
  }

  function start() {
    if (state.started) return;
    state.started = true;
    void refresh();
    const Source = EventSourceClass ?? (typeof EventSource !== "undefined" ? EventSource : undefined);
    if (Source) {
      events = new Source("/local/events");
      events.onopen = () => { state.connected = true; scheduleRepaint(); };
      events.onerror = () => { state.connected = false; scheduleRepaint(); };
      events.onmessage = receiveEvent;
      ["snapshot", "download", "model", "runtime", "download.updated", "model.updated", "runtime.updated"].forEach((type) => events.addEventListener(type, receiveEvent));
    }
    fallbackTimer = window.setInterval(() => { if ((isVisible() || getContext().testing) && !state.connected) void refresh(); }, 5000);
  }

  async function perform(action, id) {
    if (action === "copy-error") {
      try { await navigator.clipboard.writeText(id); notify("Full error copied.", "info"); }
      catch { notify("Could not copy the error. Check clipboard permissions.", "danger"); }
      return;
    }
    if (action === "tab") { state.tab = id; state.deleteId = ""; repaint(); if (id === "catalog" && !state.catalogLoaded && !state.catalogLoading) void loadCatalog(); return; }
    if (action === "recommended" || action === "browse") { state.source = action === "recommended" ? "recommended" : "search"; state.query = ""; await loadCatalog(); return; }
    if (action === "retry-catalog" || action === "more") { await loadCatalog(action === "more"); return; }
    if (action === "details") { await openDetail(id); return; }
    if (action === "close-detail") { detailSequence++; state.detailRepoId = ""; repaint(); return; }
    if (action === "delete-prompt" || action === "delete-dismiss") { state.deleteId = action === "delete-prompt" ? id : ""; repaint(); return; }
    const key = `${action}:${id}`;
    if (state.actions.has(key)) return;
    state.actions.add(key); repaint();
    try {
      if (action === "refresh") await refresh();
      else if (action === "import") { const model = await desktop().importModel(); if (model) { await refresh(); notify(`${nameOf(model)} was added to the library.`, "info"); } }
      else if (action === "projector") { const model = await desktop().importProjector(id); if (model) { await refresh(); notify(`${nameOf(model)} now has a vision adapter. It will load with the next request.`, "info"); } }
      else if (action === "download") {
        const variant = variantsOf(state.detail).find((item) => String(item.id || item.variantId) === state.variantId);
        if (!variant || compatibility(variant).downloadBlocked || state.detail.gated || state.detail.private) return;
        await request("/local/downloads", { method: "POST", body: JSON.stringify({ repoId: state.detailRepoId, revision: state.detail.revision, variantId: variant.id || variant.variantId, ...(state.projectorPath ? { projectorPath: state.projectorPath } : {}) }), timeoutMs: 60000 });
        state.detailRepoId = "";
        await refresh();
      } else if (["pause", "resume", "cancel"].includes(action)) {
        await request(`/local/downloads/${encodeURIComponent(id)}/${action}`, { method: "POST", timeoutMs: 60000 });
        await refresh();
      } else if (action === "load" || action === "unload") {
        await request(`/local/models/${action}`, { method: "POST", timeoutMs: 0, body: JSON.stringify(action === "load" ? { providerId: PROVIDER, modelId: id } : { providerId: PROVIDER, modelIdOrInstanceId: id }) });
        await refresh();
      } else if (action === "delete") {
        await request(`/local/models/${encodeURIComponent(id)}`, { method: "DELETE", timeoutMs: 60000 });
        state.deleteId = ""; await refresh();
      } else if (action === "use" || action === "default") {
        const model = models().find((item) => idOf(item) === id);
        if (!model) throw new Error("This model is no longer installed. Refresh the library.");
        if (action === "use") await onUse(model);
        else { await onDefault(model); notify(`${nameOf(model)} is the app default for new chats.`, "info"); }
      }
    } catch (error) {
      notify(errorSummary(error.message || "Unable to complete this model action."), "danger");
      if (action === "download") state.detailError = error.message;
      if (action === "load" || action === "unload") await refresh();
    } finally {
      state.actions.delete(key); repaint();
    }
  }

  function bind(element) {
    settingsBindings?.abort();
    root = element;
    if (!root) return;
    settingsBindings = new AbortController();
    const panel = root.querySelector("#mm-settings");
    const trigger = root.querySelector("#mm-settings-toggle");
    const positionSettings = () => {
      if (!panel?.isConnected || !trigger) return;
      const rect = trigger.getBoundingClientRect();
      const top = Math.max(12, Math.min(rect.bottom + 10, innerHeight - 100));
      const width = panel.getBoundingClientRect().width || Math.min(540, innerWidth - 24);
      panel.style.top = `${top}px`;
      panel.style.right = `${Math.min(Math.max(12, innerWidth - rect.right), Math.max(12, innerWidth - width - 12))}px`;
      panel.style.maxHeight = `${innerHeight - top - 12}px`;
    };
    panel?.addEventListener("beforetoggle", event => {
      if (!panel.isConnected) return;
      state.settingsOpen = event.newState === "open";
      trigger?.setAttribute("aria-expanded", String(state.settingsOpen));
      if (state.settingsOpen) positionSettings();
    });
    panel?.querySelector(".mm-settings-close")?.addEventListener("click", () => trigger?.focus({ preventScroll: true }));
    window.addEventListener("resize", positionSettings, { signal: settingsBindings.signal });
    window.addEventListener("scroll", positionSettings, { capture: true, passive: true, signal: settingsBindings.signal });
    if (panel && state.settingsOpen && isVisible()) panel.showPopover();
    root.addEventListener("click", (event) => {
      const button = event.target.closest("[data-mm-action]");
      if (!button || button.disabled || !root.contains(button)) return;
      event.preventDefault();
      void perform(button.dataset.mmAction, button.dataset.mmId || "");
    });
    root.querySelector("#mm-search-input")?.addEventListener("input", (event) => { state.query = event.target.value; });
    root.querySelector("#mm-context-size")?.addEventListener("input", (event) => { state.contextDraft = event.target.value; state.contextError = ""; state.contextSaved = false; });
    root.querySelector("#mm-context-form")?.addEventListener("submit", (event) => { event.preventDefault(); void saveContext(); });
    const settingsTabs = [...root.querySelectorAll("[data-mm-settings-tab]")];
    settingsTabs.forEach((tab, index) => {
      tab.addEventListener("click", () => {
        state.settingsTab = tab.dataset.mmSettingsTab || "context";
        state.advancedError = ""; state.advancedSaved = false; repaint();
      });
      tab.addEventListener("keydown", (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? settingsTabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + settingsTabs.length) % settingsTabs.length;
        state.settingsTab = settingsTabs[next].dataset.mmSettingsTab || "context";
        state.advancedError = ""; state.advancedSaved = false; repaint();
      });
    });
    root.querySelectorAll("[data-mm-local-setting]").forEach((input) => input.addEventListener("input", (event) => {
      state.advancedDrafts[event.target.dataset.mmLocalSetting] = event.target.value;
      state.advancedError = ""; state.advancedSaved = false;
    }));
    root.querySelectorAll("[data-mm-generation-value]").forEach((input) => input.addEventListener("input", (event) => {
      const key = event.target.dataset.mmGenerationValue;
      const current = generationSettings();
      const base = current.preset === "custom" ? { ...current } : { ...(GENERATION_PRESETS[current.preset] || GENERATION_PRESETS.balanced), preset: "custom" };
      if (event.target.value === "") delete base[key]; else base[key] = Number(event.target.value);
      state.generationDraft = base; state.generationError = ""; state.generationSaved = false;
    }));
    root.querySelector("[data-mm-generation-preset]")?.addEventListener("change", (event) => {
      const preset = event.target.value;
      if (!["server", "precise", "balanced", "creative", "custom"].includes(preset)) return;
      const current = generationSettings();
      state.generationDraft = preset === "custom"
        ? { ...(current.preset === "custom" ? current : GENERATION_PRESETS[current.preset] || GENERATION_PRESETS.balanced), preset: "custom" }
        : { preset };
      state.generationError = ""; state.generationSaved = false; repaint();
    });
    root.querySelector("#mm-generation-form")?.addEventListener("submit", (event) => { event.preventDefault(); void saveGenerationSettings(); });
    root.querySelector("[data-mm-gpu-form]")?.addEventListener("submit", (event) => { event.preventDefault(); void saveGpuSettings(); });
    root.querySelector("[data-mm-rebalance]")?.addEventListener("click", () => { void rebalanceModels(); });
    root.querySelectorAll("[data-mm-gpu]").forEach((select) => select.addEventListener("change", (event) => {
      state.gpuDraft = { ...gpuSettings(), [event.target.dataset.mmGpu]: event.target.value }; state.gpuError = ""; state.gpuSaved = false;
    }));
    MODEL_SETTINGS_TABS.filter((tab) => tab.id !== "context" && tab.id !== "generation").forEach((tab) => {
      root.querySelector(`#mm-${tab.id}-form`)?.addEventListener("submit", (event) => { event.preventDefault(); void saveAdvancedSettings(tab.id); });
    });
    root.querySelector("#mm-storage")?.addEventListener("toggle", (event) => { state.storageOpen = event.target.open; });
    root.querySelector("#mm-search-form")?.addEventListener("submit", (event) => { event.preventDefault(); state.source = "search"; void loadCatalog(); });
    root.querySelector("#mm-variant")?.addEventListener("change", (event) => { state.variantId = event.target.value; repaint(); });
    root.querySelector("#mm-projector")?.addEventListener("change", (event) => { state.projectorPath = event.target.value; repaint(); });
    const dialog = root.querySelector("#mm-detail-dialog");
    if (dialog && isVisible()) {
      dialog.showModal();
      dialog.addEventListener("cancel", (event) => { event.preventDefault(); void perform("close-detail", ""); });
      dialog.addEventListener("click", (event) => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) void perform("close-detail", ""); } });
    }
    if (isVisible()) {
      start();
      if (state.tab === "catalog" && !state.catalogLoaded && !state.catalogLoading && !state.catalogError) void loadCatalog();
    }
  }

  return { render, bind, start, refresh, repaint, updateLiveView, dispose() { settingsBindings?.abort(); events?.close(); window.clearInterval(fallbackTimer); window.clearTimeout(repaintTimer); } };
}

function encodeRepo(repoId) { return String(repoId).split("/").map(encodeURIComponent).join("/"); }
