import { icon } from "./ui-primitives.js";

const PROVIDER = "llamacpp";
const ACTIVE_DOWNLOADS = new Set(["queued", "downloading", "paused", "verifying"]);
const DOWNLOAD_LABELS = { queued: "Queued", downloading: "Downloading", paused: "Paused", verifying: "Verifying files", completed: "Installed", failed: "Download failed", cancelled: "Cancelled" };
const MODEL_LABELS = { unloaded: "On device", loading: "Loading into memory", ready: "Loaded", unloading: "Unloading", error: "Runtime error" };
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
export function createModelManager({ request, getContext, onLibraryChange, onUse, onDefault, notify, isVisible }) {
  const state = {
    tab: "catalog", source: "recommended", query: "", cursor: null, catalog: [], catalogLoading: false,
    catalogLoaded: false, catalogError: "", catalogWarning: "", runtime: null, downloads: [], connected: false, connectionError: "",
    detail: null, detailRepoId: "", detailLoading: false, detailError: "", variantId: "",
    actions: new Set(), deleteId: "", started: false, eventSequence: 0
  };
  let root = null;
  let events = null;
  let fallbackTimer = null;
  let repaintTimer = null;
  let catalogSequence = 0;
  let detailSequence = 0;
  let refreshInFlight = null;

  const models = () => asArray(getContext().models).filter((model) => model.providerId === PROVIDER);
  const isDefault = (model) => getContext().settings?.llm?.defaultProvider === PROVIDER && getContext().settings?.providers?.[PROVIDER]?.model === idOf(model);
  const isCurrent = (model) => getContext().currentTarget?.providerId === PROVIDER && getContext().currentTarget?.model === idOf(model);
  const actionButton = (action, id, label, { primary = false, disabled = false, title = "", symbol = "" } = {}) => `<button type="button" class="${primary ? "primary-button" : "ghost-button"}" data-mm-action="${action}" data-mm-id="${escape(id)}" ${disabled || state.actions.has(`${action}:${id}`) ? "disabled" : ""} ${title ? `title="${escape(title)}"${!label ? ` aria-label="${escape(title)}"` : ""}` : ""}>${state.actions.has(`${action}:${id}`) ? '<span class="button-spinner" aria-hidden="true"></span>' : symbol ? icon(symbol) : ""}${escape(label)}</button>`;

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

  function renderCompatibility(item, expanded = false) {
    const result = compatibility(item);
    return `<div class="mm-compatibility mm-compatibility--${result.tone}" title="${escape(result.messages.join(" "))}"><span class="mm-status-dot" aria-hidden="true"></span><span>${escape(result.label)}</span></div>${expanded && (result.messages.length || result.memory) ? `<div class="mm-compatibility-detail ${result.tone}">${result.memory ? `<div>Estimated memory: <strong>${bytes(result.memory)}</strong>${result.totalMemory ? ` · Device memory: ${bytes(result.totalMemory)}` : ""}${result.disk ? ` · Required disk space: ${bytes(result.disk)}` : ""}</div>` : ""}${result.messages.length ? `<ul>${result.messages.map((message) => `<li>${escape(message)}</li>`).join("")}</ul>` : ""}</div>` : ""}`;
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
    return `<div class="mm-runtime-strip" data-mm-runtime>
      <div class="mm-runtime-status"><span class="mm-status-dot ${missing ? "is-warning" : "is-success"}"></span><span>${escape(label)}</span>${runtime?.backend ? `<span class="mm-runtime-backend">${escape(runtime.backend)}</span>` : ""}${runtime?.queueLength ? `<span>${runtime.queueLength} waiting</span>` : ""}</div>
      <div class="mm-resource-list">${totalMemory ? `<span>${freeMemory ? `${bytes(freeMemory)} available / ` : ""}${bytes(totalMemory)} memory</span>` : ""}${freeDisk ? `<span>${bytes(freeDisk)} free on disk</span>` : ""}${runtime?.version ? `<span title="Bundled runtime version">${escape(runtime.version)}</span>` : ""}</div>
      ${missing && (runtime?.message || runtime?.error) ? `<div class="mm-runtime-message">${escape(runtime.message || runtime.error)}</div>` : ""}
    </div>`;
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
      </div></div>${job.error ? `<div class="mm-inline-error" role="status">${escape(typeof job.error === "string" ? job.error : job.error.message)}</div>` : ""}
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
      <div class="mm-card-heading"><div class="mm-model-mark">${icon("models")}</div><div><h3>${escape(nameOf(item))}</h3><div class="subtle">${escape(author)}</div></div>${installed ? '<span class="badge success">On device</span>' : ""}</div>
      ${item.description ? `<p class="mm-description">${escape(item.description)}</p>` : ""}
      <div class="mm-tags"><span>GGUF</span>${item.parameterCount || item.parameters ? `<span>${escape(item.parameterCount || item.parameters)}</span>` : ""}${item.license ? `<span title="Model license">${escape(item.license)}</span>` : ""}${totalOf(preview) ? `<span>${bytes(totalOf(preview))}${variantsOf(item).length > 1 ? "+" : ""}</span>` : ""}${item.gated ? '<span class="warning">Access required</span>' : ""}</div>
      ${preview.compatibility ? renderCompatibility(preview) : '<div class="subtle mm-card-note">Choose a quantization to check memory and disk requirements.</div>'}
      <div class="mm-card-footer"><a href="https://huggingface.co/${encodeRepo(repoId)}" target="_blank" rel="noopener noreferrer" class="mm-source-link">Model card ↗</a>${actionButton("details", repoId, "View model", { symbol: "chevronRight" })}</div>
    </article>`;
  }

  function renderCatalog() {
    return `<div id="mm-catalog" role="tabpanel" aria-labelledby="mm-tab-catalog">
      <form class="mm-search" id="mm-search-form"><label class="mm-search-input" for="mm-search-input">${icon("search")}<input id="mm-search-input" name="query" type="search" value="${escape(state.query)}" placeholder="Search Hugging Face GGUF models" autocomplete="off" aria-label="Search Hugging Face models" /></label><button class="ghost-button" type="submit" ${state.catalogLoading ? "disabled" : ""}>Search</button></form>
      <div class="mm-catalog-toolbar"><div class="mm-source-tabs" aria-label="Catalog source"><button type="button" data-mm-action="recommended" aria-pressed="${state.source === "recommended"}">Recommended</button><button type="button" data-mm-action="browse" aria-pressed="${state.source === "search"}">Hugging Face</button></div><span class="subtle">Text models · Download one variant</span></div>
      ${state.catalogWarning ? `<div class="mm-catalog-warning" role="status">${escape(state.catalogWarning)}</div>` : ""}
      ${state.catalogError ? `<div class="mm-empty mm-empty--error" role="status">${icon("models")}<h3>Catalog is unavailable</h3><p>${escape(state.catalogError)}</p><p>Models on this device remain available offline.</p>${actionButton("retry-catalog", "", "Try again")}</div>` : ""}
      ${state.catalogLoading && !state.catalog.length ? '<div class="mm-empty" role="status"><span class="activity-scan" aria-hidden="true"></span><p>Loading model catalog…</p></div>' : ""}
      <div class="mm-catalog-grid">${state.catalog.map(renderCatalogCard).join("")}</div>
      ${!state.catalogLoading && !state.catalogError && state.catalogLoaded && !state.catalog.length ? '<div class="mm-empty"><h3>No models found</h3><p>Try a model name or author. Only supported GGUF variants can be downloaded.</p></div>' : ""}
      ${state.cursor ? `<div class="mm-load-more">${actionButton("more", "", state.catalogLoading ? "Loading…" : "Show more", { disabled: state.catalogLoading })}</div>` : ""}
    </div>`;
  }

  function renderLibraryCard(model) {
    const id = idOf(model);
    const status = modelState(model);
    const busy = ["loading", "unloading"].includes(status) || state.actions.has(`load:${id}`) || state.actions.has(`unload:${id}`);
    const loaded = status === "ready";
    const used = Boolean(model.busy) || Number(model.activeRequests || model.inUse || 0) > 0;
    const fit = compatibility(model);
    return `<article class="mm-model-card mm-library-card" data-mm-library-id="${escape(id)}">
      <div class="mm-card-heading"><div class="mm-model-mark ${loaded ? "is-loaded" : ""}">${icon("models")}</div><div><h3>${escape(nameOf(model))}</h3><div class="subtle">${escape(model.repoId || model.providerName || "Local models")}</div></div><span class="badge ${loaded ? "success" : status === "error" ? "danger" : ""}">${busy ? '<span class="activity-scan" aria-hidden="true"></span>' : ""}${escape(MODEL_LABELS[status] || status)}</span></div>
      <div class="mm-tags"><span>${bytes(totalOf(model))}</span>${model.quantization ? `<span>${escape(model.quantization)}</span>` : ""}${model.license ? `<span>${escape(model.license)}</span>` : ""}${isDefault(model) ? '<span class="mm-tag-selected">App default</span>' : ""}${isCurrent(model) ? '<span class="mm-tag-selected">Current chat</span>' : ""}${used ? '<span>In use</span>' : ""}</div>
      <div class="mm-library-status">${renderCompatibility(model)}
      ${fit.memory ? `<div class="subtle mm-memory-estimate">Estimated memory: ${bytes(fit.memory)}${fit.totalMemory ? ` · ${bytes(fit.totalMemory)} on device` : ""}</div>` : ""}
      ${fit.messages.length ? `<details class="mm-memory-details"><summary>Compatibility details</summary>${renderCompatibility(model, true)}</details>` : ""}
      ${model.error ? `<div class="mm-inline-error">${escape(typeof model.error === "string" ? model.error : model.error.message)}</div>` : ""}</div>
      <div class="mm-library-actions">${actionButton(loaded ? "unload" : "load", id, loaded ? "Unload" : "Load model", { primary: !loaded, disabled: busy || used || (!loaded && fit.loadBlocked), symbol: loaded ? "stop" : "play", title: loaded ? "Free memory and keep the downloaded files" : fit.loadBlocked ? fit.messages.join(" ") : "Load this model into memory" })}${actionButton("use", id, isCurrent(model) ? "Open chat" : "Use in chat", { disabled: busy || (!loaded && fit.loadBlocked), symbol: "chat" })}</div>
      <div class="mm-library-footer"><div class="mm-card-footer"><span class="subtle">${loaded ? "Ready for chat, agents and workflows" : fit.loadBlocked ? "Downloaded · Cannot run on this device" : "Downloaded · Loads automatically when used"}</span><div class="mm-inline-actions">${actionButton("default", id, isDefault(model) ? "Default" : "Set default", { disabled: isDefault(model) || (!loaded && fit.loadBlocked) })}${actionButton("delete-prompt", id, "", { disabled: busy || used, symbol: "trash", title: "Delete from device" })}</div></div>
      ${state.deleteId === id ? `<div class="mm-delete-confirm" role="alert"><p>Delete <strong>${escape(nameOf(model))}</strong> and free ${bytes(totalOf(model))}? You can download it again. Saved chats and workflows keep their model reference.</p><div class="mm-inline-actions">${actionButton("delete", id, "Delete from device")}${actionButton("delete-dismiss", id, "Keep model")}</div></div>` : ""}</div>
    </article>`;
  }

  function renderLibrary() {
    const installed = [...models()].sort((left, right) => Number(modelState(right) === "ready") - Number(modelState(left) === "ready") || nameOf(left).localeCompare(nameOf(right)));
    return `<div id="mm-device" role="tabpanel" aria-labelledby="mm-tab-device"><div class="mm-library-intro"><span class="subtle">Downloaded files stay on this device. Load model uses memory; Unload frees it.</span><div class="mm-inline-actions">${window.desktopModels?.importModel ? actionButton("import", "", "Import GGUF", { symbol: "plus" }) : ""}${actionButton("refresh", "", "Refresh", { symbol: "refresh" })}</div></div>${installed.length ? `<div class="mm-library-grid">${installed.map(renderLibraryCard).join("")}</div>` : `<div class="mm-empty">${icon("models")}<h3>Your local library starts here</h3><p>Download a model from the catalog, then use it in chats, agents and workflows — including workflows with cloud models.</p>${actionButton("tab", "catalog", "Browse catalog", { primary: true })}</div>`}</div>`;
  }

  function renderDetail() {
    if (!state.detailRepoId) return "";
    const detail = state.detail;
    const variants = variantsOf(detail);
    const variant = variants.find((item) => String(item.id || item.variantId) === state.variantId) || variants[0];
    const result = compatibility(variant);
    const repoId = state.detailRepoId;
    const gated = detail?.gated || detail?.private;
    const installed = variant && models().some((model) => model.repoId === repoId && model.variantId === (variant.id || variant.variantId) && (!detail?.revision || model.revision === detail.revision));
    const active = variant && state.downloads.some((job) => job.repoId === repoId && job.variantId === (variant.id || variant.variantId) && ACTIVE_DOWNLOADS.has(job.status || job.state));
    return `<dialog class="mm-detail-dialog" id="mm-detail-dialog" aria-labelledby="mm-detail-title"><div class="mm-detail-head"><div><div class="mm-eyebrow">Local model</div><h2 id="mm-detail-title">${escape(detail ? nameOf(detail) : repoId.split("/").at(-1))}</h2><a class="mm-source-link" href="https://huggingface.co/${encodeRepo(repoId)}" target="_blank" rel="noopener noreferrer">${escape(repoId)} ↗</a></div><button type="button" class="icon-button" data-mm-action="close-detail" aria-label="Close model details">${icon("close")}</button></div>
      <div class="mm-detail-body">${state.detailLoading ? '<div class="mm-empty" role="status"><span class="activity-scan" aria-hidden="true"></span><p>Checking available files and device compatibility…</p></div>' : state.detailError ? `<div class="mm-inline-error" role="alert">${escape(state.detailError)}</div>` : `
        <div class="mm-tags"><span>GGUF · Text generation</span>${detail?.license ? `<span>License: ${escape(detail.license)}</span>` : '<span>License not specified</span>'}${detail?.revision ? `<span title="${escape(detail.revision)}">Revision ${escape(detail.revision.slice(0, 8))}</span>` : ""}</div>
        ${detail?.description ? `<p class="mm-description">${escape(detail.description)}</p>` : ""}
        <div class="mm-detail-section"><h3>Download variant</h3><p class="subtle">Smaller quantizations use less disk space and memory. Only the selected variant and its required parts are downloaded.</p>
          ${variants.length ? `<label class="field" for="mm-variant"><span class="subtle">Quantization</span><select id="mm-variant" name="variant">${variants.map((item) => { const id = item.id || item.variantId; return `<option value="${escape(id)}" ${String(id) === String(variant?.id || variant?.variantId) ? "selected" : ""}>${escape(item.quantization || item.name || id)} · ${bytes(totalOf(item))}${compatibility(item).blocked ? " · incompatible" : ""}</option>`; }).join("")}</select></label>` : '<div class="mm-inline-error">This repository has no downloadable text-model variants supported by this runtime.</div>'}
          ${variant ? `<div class="mm-variant-metrics"><div><span>Download size</span><strong>${bytes(totalOf(variant))}</strong></div><div><span>Estimated memory</span><strong>${bytes(result.memory)}</strong></div><div><span>Files</span><strong>${asArray(variant.files).length || 1}</strong></div></div>${renderCompatibility(variant, true)}` : ""}
          ${gated ? '<div class="mm-compatibility-detail warning">This model requires access on Hugging Face. Choose a public model from the catalog for direct download.</div>' : ""}
          ${variant?.files?.length ? `<details class="mm-file-details"><summary>Included files (${variant.files.length})</summary><ul>${variant.files.map((file) => `<li><span>${escape(typeof file === "string" ? file : file.path || file.filename || file.name)}</span><span>${typeof file === "object" ? bytes(file.sizeBytes ?? file.size) : ""}</span></li>`).join("")}</ul></details>` : ""}
        </div>`}
      </div><div class="mm-detail-footer"><div class="subtle">${installed ? "This variant is already on your device." : active ? "Download is already in progress. You can manage it in Downloads." : "Files are checked before the model is added to your library."}</div>${actionButton("download", repoId, installed ? "Installed" : active ? "Downloading" : `Download${variant ? ` · ${bytes(totalOf(variant))}` : ""}`, { primary: true, disabled: state.detailLoading || Boolean(state.detailError) || !variant || result.downloadBlocked || Boolean(gated) || installed || active, symbol: "arrowDown" })}</div>
    </dialog>`;
  }

  function render() {
    const installed = models();
    return `<div class="model-manager" id="local-model-manager"><section class="panel mm-main-panel"><div class="mm-heading"><div><div class="mm-eyebrow">Private inference, on your computer</div><h2>Local models</h2><p class="subtle">Download a model once. Use it in chats, agents and workflows.</p></div><div class="mm-library-summary"><strong>${installed.length}</strong><span>on device</span><span class="mm-summary-divider"></span><strong>${installed.filter((model) => modelState(model) === "ready").length}</strong><span>loaded</span></div></div>
      ${renderRuntime()}<div class="mm-tabs" role="tablist" aria-label="Local model library"><button type="button" id="mm-tab-catalog" role="tab" aria-selected="${state.tab === "catalog"}" aria-controls="mm-catalog" data-mm-action="tab" data-mm-id="catalog">${icon("search")}Catalog</button><button type="button" id="mm-tab-device" role="tab" aria-selected="${state.tab === "device"}" aria-controls="mm-device" data-mm-action="tab" data-mm-id="device">${icon("models")}On device<span class="mm-count">${installed.length}</span></button><span class="mm-live-status" title="${state.connected ? "Live model and download updates" : "Reconnecting; snapshots are refreshed automatically"}"><span class="mm-status-dot ${state.connected ? "is-success" : ""}"></span>${state.connected ? "Live" : "Connecting"}</span></div>
      ${state.connectionError ? `<div class="mm-inline-error" role="status">${escape(state.connectionError)}</div>` : ""}
      ${renderDownloads()}${state.tab === "catalog" ? renderCatalog() : renderLibrary()}
    </section>${renderDetail()}</div>`;
  }

  function repaint() {
    if (!root?.isConnected || !isVisible()) return;
    const active = document.activeElement;
    const focusedId = root.contains(active) ? active.id : "";
    const selection = active?.tagName === "INPUT" ? [active.selectionStart, active.selectionEnd] : null;
    const dialogScroll = root.querySelector(".mm-detail-body")?.scrollTop || 0;
    const holder = document.createElement("div");
    holder.innerHTML = render();
    const replacement = holder.firstElementChild;
    root.replaceWith(replacement);
    bind(replacement);
    const focus = focusedId ? document.getElementById(focusedId) : null;
    if (focus && root.contains(focus)) {
      focus.focus({ preventScroll: true });
      if (selection && selection[0] !== null) focus.setSelectionRange?.(...selection);
    }
    const body = root.querySelector(".mm-detail-body");
    if (body) body.scrollTop = dialogScroll;
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
    state.detail = null; state.detailLoading = true; state.detailError = ""; state.variantId = "";
    repaint();
    try {
      const catalogModel = state.catalog.find((item) => repoOf(item) === repoId);
      const params = new URLSearchParams({ repoId });
      if (catalogModel?.revision) params.set("revision", catalogModel.revision);
      const detail = await request(`/local/catalog/model?${params}`, { timeoutMs: 60000 });
      if (sequence !== detailSequence || state.detailRepoId !== repoId) return;
      state.detail = detail;
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
      const results = await Promise.allSettled([request("/local/runtime"), request("/local/downloads"), request("/local/models/all")]);
      if (results[0].status === "fulfilled") {
        const snapshot = results[0].value;
        state.connectionError = "";
        if (state.eventSequence === startedAtSequence) {
          state.runtime = snapshot?.runtime || snapshot;
          if (Array.isArray(snapshot?.models)) onLibraryChange(snapshot.models, state.runtime);
          if (Array.isArray(snapshot?.downloads)) state.downloads = snapshot.downloads;
        }
      }
      else state.connectionError = results[0].reason?.message || "Local model status is unavailable. Retrying automatically.";
      if (state.eventSequence === startedAtSequence && results[1].status === "fulfilled") state.downloads = asArray(results[1].value?.downloads || results[1].value?.jobs || results[1].value);
      if (state.eventSequence === startedAtSequence && results[2].status === "fulfilled") onLibraryChange(asArray(results[2].value), state.runtime);
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
    const previousModels = JSON.stringify(models().map((model) => [model.id, modelState(model), model.busy, model.error]));
    state.connectionError = "";
    if (data.runtime) state.runtime = data.runtime;
    if (Array.isArray(data.downloads)) state.downloads = data.downloads;
    if (Array.isArray(data.models)) onLibraryChange(data.models, state.runtime);
    else if (Array.isArray(data.library)) onLibraryChange(data.library, state.runtime, true);
    if (!data.runtime && !Array.isArray(data.downloads) && !Array.isArray(data.models) && !Array.isArray(data.library)) {
      // Events are hints; the snapshot endpoint provides a complete consistent state.
      void refresh();
    } else if (state.detailRepoId || previousModels === JSON.stringify(models().map((model) => [model.id, modelState(model), model.busy, model.error]))) updateLiveView();
    else scheduleRepaint();
  }

  function start() {
    if (state.started) return;
    state.started = true;
    void refresh();
    if (typeof EventSource !== "undefined") {
      events = new EventSource("/local/events");
      events.onopen = () => { state.connected = true; scheduleRepaint(); };
      events.onerror = () => { state.connected = false; scheduleRepaint(); };
      events.onmessage = receiveEvent;
      ["snapshot", "download", "model", "runtime", "download.updated", "model.updated", "runtime.updated"].forEach((type) => events.addEventListener(type, receiveEvent));
    }
    fallbackTimer = window.setInterval(() => { if ((isVisible() || getContext().testing) && !state.connected) void refresh(); }, 5000);
  }

  async function perform(action, id) {
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
      else if (action === "import") { const model = await window.desktopModels.importModel(); if (model) { await refresh(); notify(`${nameOf(model)} was added to the library.`, "info"); } }
      else if (action === "download") {
        const variant = variantsOf(state.detail).find((item) => String(item.id || item.variantId) === state.variantId);
        if (!variant || compatibility(variant).downloadBlocked || state.detail.gated || state.detail.private) return;
        await request("/local/downloads", { method: "POST", body: JSON.stringify({ repoId: state.detailRepoId, revision: state.detail.revision, variantId: variant.id || variant.variantId }), timeoutMs: 60000 });
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
      notify(error.message || "Unable to complete this model action.", "danger");
      if (action === "download") state.detailError = error.message;
      if (action === "load" || action === "unload") await refresh();
    } finally {
      state.actions.delete(key); repaint();
    }
  }

  function bind(element) {
    root = element;
    if (!root) return;
    root.addEventListener("click", (event) => {
      const button = event.target.closest("[data-mm-action]");
      if (!button || button.disabled || !root.contains(button)) return;
      event.preventDefault();
      void perform(button.dataset.mmAction, button.dataset.mmId || "");
    });
    root.querySelector("#mm-search-input")?.addEventListener("input", (event) => { state.query = event.target.value; });
    root.querySelector("#mm-search-form")?.addEventListener("submit", (event) => { event.preventDefault(); state.source = "search"; void loadCatalog(); });
    root.querySelector("#mm-variant")?.addEventListener("change", (event) => { state.variantId = event.target.value; repaint(); });
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

  return { render, bind, start, refresh, repaint, updateLiveView, dispose() { events?.close(); window.clearInterval(fallbackTimer); window.clearTimeout(repaintTimer); } };
}

function encodeRepo(repoId) { return String(repoId).split("/").map(encodeURIComponent).join("/"); }
