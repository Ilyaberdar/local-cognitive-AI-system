const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
const activePhases = ["preparing", "recording", "transcribing", "error"];
export const appendDictation = (draft, text) => `${draft}${draft && !/\s$/.test(draft) ? " " : ""}${text}`;

export async function encodeRecording(chunks, rate) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  if (!length || length > rate * 300 || rate < 8000 || rate > 96000) throw new Error("The recording is empty or too long.");
  const samples = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length; }
  let mono = samples;
  if (rate !== 16000) {
    const offline = new OfflineAudioContext(1, Math.ceil(length * 16000 / rate), 16000);
    const buffer = offline.createBuffer(1, length, rate); buffer.copyToChannel(samples, 0);
    const source = offline.createBufferSource(); source.buffer = buffer; source.connect(offline.destination); source.start();
    mono = (await offline.startRendering()).getChannelData(0);
  }
  const bytes = new Uint8Array(mono.length * 2), view = new DataView(bytes.buffer);
  for (let index = 0; index < mono.length; index++) {
    const sample = Math.max(-1, Math.min(1, mono[index]));
    view.setInt16(index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

export function createVoiceInput(options) {
  const bridge = options.bridge;
  let status = null, job = null, panel = null, poll = null, devices = [], error = "", savingSettings = false, closing = Promise.resolve();
  const isCurrent = current => job === current && !current.cancelled;
  const busy = sessionId => Boolean(job && activePhases.includes(job.phase) && (!sessionId || job.sessionId === sessionId));
  const notify = message => options.notify?.(message);
  const settings = () => status?.settings ?? { language: "auto", deviceId: "default" };
  const message = value => String(value?.message || value || "Voice input failed.").replace(/^Error invoking remote method '[^']+': Error: /, "");

  function renderButton() {
    if (!bridge) return "";
    return `<button type="button" class="icon-button voice-trigger" data-voice-action="record" aria-label="Dictate message" title="Dictate message">${options.icon("microphone")}</button><button type="button" class="icon-button voice-options" data-voice-action="options" popovertarget="voice-input-settings" aria-label="Voice input settings" aria-expanded="${Boolean(panel?.matches(":popover-open"))}" title="Voice input settings">${options.icon("chevronDown")}</button>`;
  }
  function renderStrip() { return bridge ? '<div class="voice-strip" data-voice-strip hidden></div>' : ""; }

  function paint() {
    const visible = job && options.isChat() && job.sessionId === options.sessionId();
    const composer = document.querySelector("#chat-form");
    if (composer) composer.dataset.voiceActive = visible ? "true" : "false";
    const strip = document.querySelector("[data-voice-strip]");
    if (strip) {
      strip.hidden = !visible;
      if (visible) {
        const phase = job.phase;
        const key = `${job.id}:${phase}:${job.error || ""}`;
        if (strip.dataset.state !== key) {
          strip.dataset.state = key;
          strip.innerHTML = `<div class="voice-strip__content"><span class="voice-indicator ${phase === "recording" ? "is-recording" : ""}">${options.icon("microphone")}</span><div class="voice-strip__text"><strong role="status">${phase === "recording" ? "Listening…" : phase === "preparing" ? "Preparing microphone…" : phase === "transcribing" ? "Transcribing locally…" : "Could not transcribe"}</strong><span data-voice-detail>${escape(job.error || (phase === "recording" ? "00:00 · max 5 min" : "Your draft is kept"))}</span></div></div><div class="voice-strip__actions"><button class="icon-button" type="button" data-voice-action="cancel" title="Cancel dictation (Esc)" aria-label="Cancel dictation">${options.icon("close")}</button>${phase === "recording" ? `<button class="icon-button" type="button" data-voice-action="stop" title="Finish dictation" aria-label="Finish dictation">${options.icon("check")}</button>` : phase === "error" ? `<button class="icon-button" type="button" data-voice-action="retry" aria-label="Retry dictation" title="Retry dictation">${options.icon("refresh")}</button>` : ""}</div>`;
        }
      } else { strip.innerHTML = ""; delete strip.dataset.state; }
    }
    const trigger = document.querySelector(".voice-trigger");
    if (trigger) { trigger.disabled = Boolean(job || savingSettings); trigger.classList.toggle("is-recording", job?.phase === "recording"); }
    document.querySelector(".voice-options")?.setAttribute("aria-expanded", String(Boolean(panel?.matches(":popover-open"))));
    const send = document.querySelector("#chat-form button[type='submit']");
    if (send) send.disabled = Boolean(options.sendBusy() || busy(options.sessionId()));
    const field = document.querySelector("#chat-form textarea");
    if (field) { field.inert = Boolean(visible); field.setAttribute("aria-hidden", String(Boolean(visible))); }
  }

  async function refresh() { if (bridge) { status = await bridge.status(); updatePanel(); } return status; }
  function panelMarkup() {
    const s = settings();
    const selected = devices.find(device => device.deviceId === s.deviceId || (s.deviceLabel && device.label === s.deviceLabel));
    return `<div class="voice-panel__header"><strong>Voice input</strong><button type="button" class="icon-button" data-voice-action="close-panel" aria-label="Close voice settings">${options.icon("close")}</button></div><p class="voice-panel__hint">Dictate locally, edit the text, then send.</p><label>Language<select data-voice-language>${[["auto", "Auto detect"], ["ru", "Русский"], ["uk", "Українська"], ["en", "English"]].map(([value, label]) => `<option value="${value}" ${s.language === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><label>Microphone<select data-voice-device><option value="default">System default</option>${!selected && s.deviceId !== "default" ? `<option value="${escape(s.deviceId)}" selected>${escape(s.deviceLabel || "Previously selected microphone")}</option>` : ""}${devices.filter(device => device.deviceId && device.deviceId !== "default").map((device, index) => `<option value="${escape(device.deviceId)}" ${selected?.deviceId === device.deviceId ? "selected" : ""}>${escape(device.label || `Microphone ${index + 1}`)}</option>`).join("")}</select></label><button type="button" class="voice-device-refresh" data-voice-action="devices">Choose microphone…</button><label>Recognition<select data-voice-model>${(status?.models || []).map(model => `<option value="${escape(model.id)}" ${s.modelId === model.id ? "selected" : ""}>${escape(model.label)}</option>`).join("")}</select></label><div class="voice-panel__model"><strong data-voice-model-name></strong><span data-voice-model-size></span><span data-voice-model-state role="status"></span><progress data-voice-progress max="1" hidden></progress></div><p class="voice-panel__error" data-voice-error role="alert" hidden></p><div class="voice-panel__actions"><button type="button" class="action-button" data-voice-action="install">Download model</button><button type="button" class="action-button" data-voice-action="cancel-download" hidden>Cancel download</button><button type="button" class="action-button" data-voice-action="remove" hidden>Remove model</button><button type="button" class="action-button" data-voice-action="permissions">Microphone permissions</button></div><p class="voice-panel__hint">Audio is discarded after transcription or cancellation. Sent text goes to your selected chat provider.</p>`;
  }
  function updatePanel() {
    if (!panel?.querySelector("[data-voice-model-state]")) return;
    const download = status?.download?.modelId === settings().modelId ? status.download : null;
    const downloading = ["downloading", "verifying"].includes(download?.state);
    const model = status?.model;
    panel.querySelector("[data-voice-model-name]").textContent = model?.name || "Speech model";
    panel.querySelector("[data-voice-model-size]").textContent = model ? `Multilingual · ${model.sizeBytes >= 1073741824 ? `${(model.sizeBytes / 1073741824).toFixed(1)} GiB` : `${Math.round(model.sizeBytes / 1048576)} MiB`} · on your device` : "";
    if (!savingSettings) panel.querySelector("[data-voice-model]").value = settings().modelId || "";
    panel.querySelector("[data-voice-model-state]").textContent = !status ? "Checking…" : !status.available ? "Speech runtime is missing in this build" : status.installed ? "Ready for offline dictation" : downloading ? status.download.state === "verifying" ? "Verifying model…" : `Downloading ${Math.round(status.download.received / status.download.total * 100)}%` : "Download once to enable voice input";
    const progress = panel.querySelector("progress"); progress.hidden = !downloading; progress.value = (status?.download?.received || 0) / (status?.download?.total || 1);
    const install = panel.querySelector('[data-voice-action="install"]'); install.hidden = Boolean(status?.installed || downloading); install.disabled = Boolean(!status?.available || savingSettings || job);
    panel.querySelector('[data-voice-action="cancel-download"]').hidden = !downloading;
    const remove = panel.querySelector('[data-voice-action="remove"]'); remove.hidden = !status?.installed; remove.disabled = Boolean(job || savingSettings || status?.busy);
    for (const field of panel.querySelectorAll("select")) field.disabled = Boolean(job || savingSettings || downloading);
    panel.querySelector('[data-voice-action="devices"]').disabled = Boolean(job || savingSettings || !status?.installed);
    const detail = panel.querySelector("[data-voice-error]"); detail.textContent = error || download?.error || ""; detail.hidden = !detail.textContent;
  }
  function positionPanel() {
    if (!panel?.matches(":popover-open")) return;
    const trigger = document.querySelector(".voice-trigger")?.getBoundingClientRect();
    const width = Math.min(300, innerWidth - 24);
    panel.style.width = `${width}px`; panel.style.maxHeight = `${innerHeight - 24}px`;
    panel.style.left = `${Math.max(12, Math.min(innerWidth - width - 12, (trigger?.right || innerWidth - 12) - width))}px`;
    panel.style.top = `${Math.max(12, (trigger?.top || innerHeight - 12) - panel.offsetHeight - 10)}px`;
  }
  async function openPanel() {
    if (!panel) {
      panel = document.createElement("div"); panel.id = "voice-input-settings"; panel.className = "voice-panel"; panel.setAttribute("popover", "auto"); panel.setAttribute("aria-label", "Voice input settings");
      panel.addEventListener("click", onClick);
      panel.addEventListener("change", async () => {
        try {
          const deviceId = panel.querySelector("[data-voice-device]").value;
          const next = { language: panel.querySelector("[data-voice-language]").value, deviceId,
            modelId: panel.querySelector("[data-voice-model]").value,
            deviceLabel: devices.find(device => device.deviceId === deviceId)?.label || (deviceId === settings().deviceId ? settings().deviceLabel : "") || "" };
          savingSettings = true; error = ""; updatePanel(); paint();
          status.settings = await bridge.updateSettings(next);
          await refresh();
        } catch (failure) { error = message(failure); }
        finally { savingSettings = false; updatePanel(); paint(); }
      });
      panel.addEventListener("toggle", () => {
        clearInterval(poll); poll = null;
        if (panel.matches(":popover-open")) poll = setInterval(() => void refresh().catch(() => {}), 700);
        paint();
      });
      document.body.append(panel);
    }
    try {
      await refresh();
    } catch (failure) { error = message(failure); }
    panel.innerHTML = panelMarkup(); updatePanel(); panel.showPopover(); positionPanel();
  }

  function release(current) {
    clearInterval(current.timer);
    current.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    current.source?.disconnect(); current.node?.disconnect(); current.node?.port.close();
    if (current.context?.state !== "closed") void current.context?.close().catch(() => {});
    current.stream = null; current.source = null; current.node = null; current.chunks = [];
    return bridge.releaseMicrophone(current.id).catch(() => {});
  }
  function fail(current, failure) {
    if (!isCurrent(current)) return;
    void release(current);
    if (options.sessionId() !== current.sessionId || !options.isChat()) {
      current.pcm = null; job = null; paint();
      notify(`Dictation could not be added to the original chat: ${message(failure)}`);
      return;
    }
    current.phase = "error"; current.error = message(failure); paint();
  }
  async function start() {
    if (!bridge || job || savingSettings || !options.sessionId()) return;
    const current = { id: crypto.randomUUID(), sessionId: options.sessionId(), phase: "preparing", chunks: [], cancelled: false };
    job = current; error = ""; paint();
    try {
      await closing;
      await refresh();
      if (!isCurrent(current)) return;
      if (!status.installed || !status.available) { job = null; paint(); await openPanel(); return; }
      current.language = settings().language;
      await bridge.requestMicrophone(current.id);
      if (!isCurrent(current)) { await bridge.releaseMicrophone(current.id); return; }
      let device = settings().deviceId;
      if (device !== "default") {
        const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "audioinput");
        device = inputs.find(input => input.deviceId === device)?.deviceId || inputs.find(input => input.label && input.label === settings().deviceLabel)?.deviceId;
        if (!device) throw new Error("The selected microphone is unavailable. Choose System default or another microphone in Voice input settings.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, ...(device !== "default" ? { deviceId: { exact: device } } : {}) }, video: false });
      if (!isCurrent(current)) { stream.getTracks().forEach(track => track.stop()); await bridge.releaseMicrophone(current.id); return; }
      current.stream = stream;
      for (const track of stream.getTracks()) track.onended = () => { if (current.phase === "recording") void stop(); };
      try { current.context = new AudioContext({ sampleRate: 16000 }); } catch { current.context = new AudioContext(); }
      await current.context.audioWorklet.addModule("/assets/voice-worklet.js");
      if (!isCurrent(current)) { await release(current); return; }
      current.rate = current.context.sampleRate;
      current.node = new AudioWorkletNode(current.context, "dictation-capture");
      current.node.port.onmessage = ({ data }) => {
        if (!isCurrent(current)) return;
        if (data.samples) {
          current.chunks.push(data.samples);
          let energy = 0; for (const sample of data.samples) energy += sample * sample;
          document.querySelector(".voice-indicator")?.style.setProperty("--voice-level", String(Math.min(1, Math.sqrt(energy / data.samples.length) * 8)));
        }
        if (data.flushed) current.flushed?.();
        if (data.limit) void stop();
      };
      current.source = current.context.createMediaStreamSource(stream);
      current.source.connect(current.node); current.node.connect(current.context.destination);
      await current.context.resume();
      if (!isCurrent(current)) { await release(current); return; }
      current.started = Date.now(); current.phase = "recording";
      current.timer = setInterval(() => {
        const seconds = Math.floor((Date.now() - current.started) / 1000);
        const detail = document.querySelector("[data-voice-detail]");
        if (detail && current.phase === "recording") detail.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")} · max 5 min`;
        if (seconds >= 300) void stop();
      }, 250);
      panel?.hidePopover(); paint();
    } catch (failure) { fail(current, failure); }
  }
  async function recognize(current) {
    try {
      const result = await bridge.transcribe({ id: current.id, sessionId: current.sessionId, language: current.language, pcm: current.pcm });
      if (!isCurrent(current)) return;
      if (result.id !== current.id || result.sessionId !== current.sessionId) throw new Error("The dictation result belongs to another recording.");
      if (result.text && options.hasSession(current.sessionId)) {
        options.appendText(current.sessionId, result.text);
        if (options.sessionId() !== current.sessionId || !options.isChat()) notify("Dictation added to the original chat draft.");
      } else if (!result.text) notify("No speech detected. Your draft is unchanged.");
      current.pcm = null; job = null; paint();
      if (options.sessionId() === current.sessionId && options.isChat()) document.querySelector("#chat-form textarea")?.focus({ preventScroll: true });
    } catch (failure) { fail(current, failure); }
  }
  async function stop() {
    const current = job;
    if (!current) return;
    if (current.phase === "preparing") { cancel(); return; }
    if (current.phase !== "recording") return;
    current.phase = "transcribing"; clearInterval(current.timer);
    current.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    paint();
    try {
      await new Promise(resolve => { current.flushed = resolve; current.node.port.postMessage("flush"); setTimeout(resolve, 150); });
      const chunks = current.chunks;
      await release(current);
      if (!isCurrent(current)) return;
      current.pcm = await encodeRecording(chunks, current.rate);
      if (isCurrent(current)) await recognize(current);
    } catch (failure) { fail(current, failure); }
  }
  function cancel() {
    const current = job;
    if (!current) return;
    current.cancelled = true; current.pcm = null; job = null;
    closing = Promise.all([release(current), bridge.cancel(current.id).catch(() => {})]);
    paint(); updatePanel();
  }
  async function retry() {
    const current = job;
    if (current?.pcm) { current.phase = "transcribing"; current.error = ""; paint(); await recognize(current); }
    else { cancel(); await start(); }
  }
  async function onClick(event) {
    const action = event.target.closest("[data-voice-action]")?.dataset.voiceAction;
    if (!action) return;
    event.preventDefault();
    try {
      if (action === "record") await start();
      if (action === "options") { if (panel?.matches(":popover-open")) panel.hidePopover(); else await openPanel(); }
      if (action === "stop") await stop();
      if (action === "cancel") cancel();
      if (action === "retry") await retry();
      if (action === "close-panel") panel.hidePopover();
      if (action === "install") { error = ""; await bridge.install(); await refresh(); }
      if (action === "cancel-download") { await bridge.cancelDownload(); await refresh(); }
      if (action === "remove" && !job) { await bridge.removeModel(); await refresh(); }
      if (action === "permissions") await bridge.openMicrophoneSettings();
      if (action === "devices" && !job) {
        const id = `devices-${crypto.randomUUID()}`;
        try {
          await bridge.requestMicrophone(id);
          devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "audioinput" && device.deviceId);
          panel.innerHTML = panelMarkup(); updatePanel(); positionPanel();
        } finally { await bridge.releaseMicrophone(id); }
      }
    } catch (failure) { error = message(failure); updatePanel(); }
  }
  function bind() {
    if (!bridge) return;
    if (job && (!options.isChat() || options.sessionId() !== job.sessionId)) {
      if (job.phase === "recording") void stop();
      else if (job.phase === "preparing" || job.phase === "error") cancel();
    }
    document.querySelector("#chat-form")?.addEventListener("click", onClick);
    paint(); positionPanel();
  }
  if (bridge) {
    bridge.onStopCapture(() => void stop());
    document.addEventListener("visibilitychange", () => { if (document.hidden) void stop(); });
    window.addEventListener("beforeunload", cancel);
    window.addEventListener("resize", positionPanel);
  }
  return { renderButton, renderStrip, bind, busy, cancelSession: id => { if (job?.sessionId === id) cancel(); },
    escape: () => { if (panel?.matches(":popover-open")) { panel.hidePopover(); return true; } if (job) { cancel(); return true; } return false; } };
}
