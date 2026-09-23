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
  let status = null, job = null, panel = null, settingsHost = null, poll = null, devices = [], error = "", savingSettings = false, closing = Promise.resolve();
  let probe = null, refreshVersion = 0, panelEpoch = 0, saveQueue = Promise.resolve(), saveCount = 0, saveMessage = "Changes save automatically.";
  let inputMessage = "Test your microphone to check its input level. No audio is saved or transcribed.", inputLevel = 0;
  const views = () => [panel, settingsHost].filter(Boolean);
  const audioConstraints = deviceId => ({ channelCount: { ideal: 1 }, echoCancellation: false, noiseSuppression: false, autoGainControl: true,
    ...(deviceId && deviceId !== "default" ? { deviceId: { exact: deviceId } } : {}) });
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
          strip.innerHTML = `<div class="voice-strip__content"><span class="voice-indicator ${phase === "recording" ? "is-recording" : ""}">${options.icon("microphone")}</span><div class="voice-strip__text"><strong role="status">${phase === "recording" ? "Listening…" : phase === "preparing" ? "Preparing microphone…" : phase === "transcribing" ? "Transcribing locally…" : "Could not transcribe"}</strong><span data-voice-detail>${escape(job.error || (phase === "recording" ? "00:00 · max 5 min" : "Your draft is kept"))}</span></div></div><div class="voice-strip__actions"><button class="icon-button" type="button" data-voice-action="cancel" title="Cancel dictation (Esc)" aria-label="Cancel dictation">${options.icon("close")}</button>${phase === "recording" ? `<button class="icon-button" type="button" data-voice-action="stop" title="Finish dictation" aria-label="Finish dictation">${options.icon("check")}</button>` : phase === "error" ? `<button class="icon-button" type="button" data-voice-action="retry" aria-label="Retry dictation" title="Retry dictation">${options.icon("refresh")}</button><button class="icon-button" type="button" data-voice-action="full-settings" aria-label="Open Voice settings" title="Open Voice settings">${options.icon("settings")}</button>` : ""}</div>`;
        }
      } else { strip.innerHTML = ""; delete strip.dataset.state; }
    }
    const trigger = document.querySelector(".voice-trigger");
    if (trigger) { trigger.disabled = Boolean(job || probe || savingSettings); trigger.classList.toggle("is-recording", job?.phase === "recording"); }
    document.querySelector(".voice-options")?.setAttribute("aria-expanded", String(Boolean(panel?.matches(":popover-open"))));
    const send = document.querySelector("#chat-form button[type='submit']");
    if (send) send.disabled = Boolean(options.sendBusy() || busy(options.sessionId()));
    const field = document.querySelector("#chat-form textarea");
    if (field) { field.inert = Boolean(visible); field.setAttribute("aria-hidden", String(Boolean(visible))); }
  }

  async function refresh() {
    if (!bridge) return null;
    const version = ++refreshVersion;
    const next = await bridge.status();
    if (version === refreshVersion && !savingSettings) { status = next; updatePanel(); }
    return status;
  }
  function deviceOptions() {
    const s = settings();
    // IDs are origin-bound. The desktop server can have a different port after restart.
    const selected = s.deviceId !== "default" && (devices.find(device => device.deviceId === s.deviceId)
      || devices.find(device => s.deviceLabel && device.label === s.deviceLabel));
    const defaultLabel = devices.find(device => device.deviceId === "default")?.label;
    return `<option value="default" ${s.deviceId === "default" ? "selected" : ""}>System default${defaultLabel ? ` · ${escape(defaultLabel.replace(/^Default - /, ""))}` : ""}</option>${!selected && s.deviceId !== "default" ? `<option value="${escape(s.deviceId)}" selected>${escape(s.deviceLabel || "Selected microphone")} · unavailable</option>` : ""}${devices.filter(device => !["default", "communications"].includes(device.deviceId)).map((device, index) => `<option value="${escape(device.deviceId)}" ${selected?.deviceId === device.deviceId ? "selected" : ""}>${escape(device.label || `Microphone ${index + 1}`)}</option>`).join("")}`;
  }
  function panelMarkup(full = false) {
    const s = settings();
    const microphone = `<label data-setting="voice.microphone">Microphone<select data-voice-device>${deviceOptions()}</select></label><div class="voice-panel__actions"><button type="button" class="action-button" data-voice-action="devices">Refresh microphones</button><button type="button" class="action-button" data-voice-action="test-input">Test microphone</button></div><div class="voice-input-test"><meter data-voice-level min="0" max="1" value="0" aria-label="Microphone input level"></meter><p data-voice-input-status role="status">${escape(inputMessage)}</p></div>`;
    const recognition = `<label data-setting="voice.language">Language<select data-voice-language>${[["auto", "Auto detect"], ["ru", "Русский"], ["uk", "Українська"], ["en", "English"]].map(([value, label]) => `<option value="${value}" ${s.language === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><label data-setting="voice.recognition">Recognition<select data-voice-model>${(status?.models || []).map(model => `<option value="${escape(model.id)}" ${s.modelId === model.id ? "selected" : ""}>${escape(model.label)}</option>`).join("")}</select></label><div class="voice-panel__model"><strong data-voice-model-name></strong><span data-voice-model-size></span><span data-voice-model-state role="status"></span><progress data-voice-progress max="1" hidden></progress></div><div class="voice-panel__actions"><button type="button" class="action-button" data-voice-action="install">Download model</button><button type="button" class="action-button" data-voice-action="cancel-download" hidden>Cancel download</button><button type="button" class="action-button" data-voice-action="remove" hidden>Remove model</button></div>`;
    return `${full ? '<p class="settings-description">Choose the microphone used for chat dictation. Test its signal before recording.</p><div class="voice-settings-card"><h2>Microphone</h2>' : `<div class="voice-panel__header"><strong>Voice input</strong><button type="button" class="icon-button" data-voice-action="close-panel" aria-label="Close voice settings">${options.icon("close")}</button></div>`}${microphone}${full ? '</div><div class="voice-settings-card"><h2>Local recognition</h2>' : ''}${recognition}${full ? '</div>' : ''}<p class="voice-panel__error" data-voice-error role="alert" hidden></p><p class="${full ? 'settings-footnote' : 'voice-panel__hint'}" data-voice-save-status role="status"></p><div class="voice-panel__actions"><button type="button" class="action-button" data-voice-action="permissions">Microphone permissions</button>${full ? '' : '<button type="button" class="action-button" data-voice-action="full-settings">Open Voice settings</button>'}</div><p class="${full ? 'settings-footnote' : 'voice-panel__hint'}">Audio is processed on this device and discarded after transcription or cancellation. Sent text goes to your selected chat provider.</p>`;
  }
  function updateInputLevel() {
    for (const view of views()) {
      const meter = view.querySelector("[data-voice-level]"); if (meter) meter.value = inputLevel;
      const detail = view.querySelector("[data-voice-input-status]"); if (detail) detail.textContent = inputMessage;
    }
  }
  function updatePanel() {
    const download = status?.download && status.download.modelId === settings().modelId ? status.download : null;
    const downloading = ["downloading", "verifying"].includes(download?.state);
    for (const view of views()) {
      if (!view.querySelector("[data-voice-model-state]")) continue;
      const model = status?.model;
      view.querySelector("[data-voice-model-name]").textContent = model?.name || "Speech model";
      view.querySelector("[data-voice-model-size]").textContent = model ? `Multilingual · ${model.sizeBytes >= 1073741824 ? `${(model.sizeBytes / 1073741824).toFixed(1)} GiB` : `${Math.round(model.sizeBytes / 1048576)} MiB`} · on your device` : "";
      if (!savingSettings) {
        const select = view.querySelector("[data-voice-device]"), markup = deviceOptions();
        // Keep the native dropdown intact while status polling runs.
        if (select.dataset.optionsMarkup !== markup) { select.innerHTML = markup; select.dataset.optionsMarkup = markup; }
        const models = view.querySelector("[data-voice-model]");
        const choices = (status?.models || []).map(model => `<option value="${escape(model.id)}">${escape(model.label)}</option>`).join("");
        if (models.dataset.optionsMarkup !== choices) { models.innerHTML = choices; models.dataset.optionsMarkup = choices; }
        models.value = settings().modelId || "";
        view.querySelector("[data-voice-language]").value = settings().language;
      }
      view.querySelector("[data-voice-model-state]").textContent = !status ? "Checking…" : !status.available ? "Speech runtime is missing in this build" : status.installed ? "Ready for offline dictation" : downloading ? download.state === "verifying" ? "Verifying model…" : `Downloading ${Math.round(download.received / download.total * 100)}%` : "Download once to enable voice input";
      const progress = view.querySelector("progress"); progress.hidden = !downloading; progress.value = (download?.received || 0) / (download?.total || 1);
      const install = view.querySelector('[data-voice-action="install"]'); install.hidden = Boolean(status?.installed || downloading); install.disabled = Boolean(!status?.available || savingSettings || job);
      view.querySelector('[data-voice-action="cancel-download"]').hidden = !downloading;
      const remove = view.querySelector('[data-voice-action="remove"]'); remove.hidden = !status?.installed; remove.disabled = Boolean(job || savingSettings || status?.busy);
      for (const field of view.querySelectorAll("select")) field.disabled = Boolean(!status || job || probe || savingSettings || (field.hasAttribute("data-voice-model") && downloading));
      view.querySelector('[data-voice-action="devices"]').disabled = Boolean(job || probe || savingSettings);
      const test = view.querySelector('[data-voice-action="test-input"]'); test.disabled = Boolean(job || savingSettings || (probe && probe.mode !== "test")); test.textContent = probe?.mode === "test" ? "Stop test" : "Test microphone";
      const detail = view.querySelector("[data-voice-error]"); detail.textContent = error || download?.error || ""; detail.hidden = !detail.textContent;
      view.querySelector("[data-voice-save-status]").textContent = savingSettings ? "Saving…" : saveMessage;
    }
    updateInputLevel();
  }
  async function onSettingsChange(event) {
    const field = event.target, key = field.matches('[data-voice-device]') ? 'deviceId' : field.matches('[data-voice-language]') ? 'language' : field.matches('[data-voice-model]') ? 'modelId' : null;
    if (!key) return;
    const patch = { [key]: field.value };
    if (key === 'deviceId') patch.deviceLabel = field.value === 'default' ? '' : devices.find(device => device.deviceId === field.value)?.label || settings().deviceLabel || '';
    ++refreshVersion; ++saveCount; savingSettings = true; error = ""; updatePanel(); paint();
    const saving = saveQueue.then(async () => {
      const next = await bridge.updateSettings({ ...settings(), ...patch });
      status.settings = next; saveMessage = "Saved";
    });
    saveQueue = saving.catch(() => {});
    try { await saving; }
    catch (failure) { error = message(failure); saveMessage = "Not saved. Please try again."; }
    finally { savingSettings = --saveCount > 0; updatePanel(); paint(); if (!savingSettings) await refresh().catch(() => {}); }
  }
  function syncPolling() {
    clearInterval(poll); poll = null;
    if (settingsHost || panel?.matches(":popover-open")) poll = setInterval(() => void refresh().catch(() => {}), 1000);
  }
  // Opening a short-lived stream exposes labels and non-default devices in Chromium.
  // It is always stopped, including when permission resolves after leaving this page.
  async function readDevices(current) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (current.cancelled) return;
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "audioinput" && device.deviceId);
      if (!current.cancelled) { devices = inputs; updatePanel(); }
    } finally { stream?.getTracks().forEach(track => track.stop()); }
  }
  async function selectedStream(current) {
    const s = settings();
    if (s.deviceId !== "default") {
      await readDevices(current);
      if (current.cancelled) return null;
      const chosen = devices.find(device => device.deviceId === s.deviceId) || devices.find(device => s.deviceLabel && device.label === s.deviceLabel);
      if (!chosen) throw new Error("The selected microphone is disconnected. Choose another microphone in Settings → Voice.");
      return navigator.mediaDevices.getUserMedia({ audio: audioConstraints(chosen.deviceId), video: false });
    }
    return navigator.mediaDevices.getUserMedia({ audio: audioConstraints(), video: false });
  }
  function stopProbe() {
    if (!probe) return;
    const current = probe; probe = null; current.cancelled = true;
    if (current.mode === "test") inputMessage = current.heard ? `Input detected from ${current.label}. Microphone test stopped.` : "No usable input detected. Check the headset mute switch and macOS input volume, or select another microphone.";
    inputLevel = 0; closing = release(current); updatePanel(); paint();
  }
  async function testOrDiscover(owner, mode = "devices") {
    if (!bridge || job || probe || savingSettings) return;
    const current = { id: `microphone-${crypto.randomUUID()}`, owner, mode, cancelled: false, chunks: [] };
    probe = current; error = ""; inputMessage = mode === "test" ? "Opening microphone…" : "Looking for microphones…"; updatePanel(); paint();
    try {
      await closing;
      if (current.cancelled) return;
      await bridge.requestMicrophone(current.id);
      if (current.cancelled) return;
      if (mode === "devices") {
        await readDevices(current);
        if (current.cancelled) return;
        inputMessage = devices.length ? "Microphones refreshed. Test the selected input to check its level." : "No microphones found. Connect a microphone, then refresh.";
      } else {
        const stream = await selectedStream(current);
        if (current.cancelled) { stream?.getTracks().forEach(track => track.stop()); return; }
        current.stream = stream; const track = stream.getAudioTracks()[0]; current.label = track.label || "selected microphone";
        track.onended = stopProbe;
        current.context = new AudioContext();
        current.source = current.context.createMediaStreamSource(stream);
        const analyser = current.context.createAnalyser(); analyser.fftSize = 2048; current.node = analyser;
        current.source.connect(analyser); // No output connection: the test never plays the microphone back.
        await current.context.resume();
        if (current.cancelled) return;
        const samples = new Float32Array(analyser.fftSize), started = Date.now();
        current.timer = setInterval(() => {
          analyser.getFloatTimeDomainData(samples);
          const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
          inputLevel = Math.min(1, rms * 8); current.heard ||= rms > 0.003;
          inputMessage = `${current.label} · ${track.muted ? 'Microphone is muted or unavailable' : rms > 0.003 ? 'Input detected' : Date.now() - started > 4000 ? 'No usable input. Check mute and input volume, or choose another microphone.' : 'Speak to check the input level'} · test ends after 20 seconds`;
          updateInputLevel();
          if (Date.now() - started >= 20000) stopProbe();
        }, 100);
      }
    } catch (failure) { if (!current.cancelled) { error = microphoneError(failure); inputMessage = "Microphone could not be opened."; } }
    finally {
      if (mode !== "test" || !current.timer || current.cancelled) {
        await release(current);
        if (probe === current) probe = null;
      }
      updatePanel(); paint();
    }
  }
  function microphoneError(failure) {
    if (failure?.name === "NotAllowedError") return "Microphone access is blocked. Allow access in Microphone permissions, then restart the app.";
    if (["NotFoundError", "OverconstrainedError"].includes(failure?.name)) return "The microphone is unavailable. Reconnect it or select another device in Settings → Voice.";
    if (failure?.name === "NotReadableError") return "The microphone could not start. Check the headset connection and whether another app is using it.";
    return message(failure);
  }
  function mountSettings(element) {
    if (!bridge) { element.innerHTML = '<p class="settings-description">Microphone settings and local dictation are available in the desktop app.</p>'; return () => {}; }
    settingsHost = element; element.classList.add('voice-settings'); element.innerHTML = panelMarkup(true);
    element.addEventListener('click', onClick); element.addEventListener('change', onSettingsChange);
    panel?.hidePopover(); updatePanel(); syncPolling();
    void refresh().then(() => { if (settingsHost === element) { updatePanel(); return testOrDiscover(element); } }).catch(failure => { error = message(failure); updatePanel(); });
    return () => {
      if (probe?.owner === element) stopProbe();
      element.removeEventListener('click', onClick); element.removeEventListener('change', onSettingsChange);
      if (settingsHost === element) settingsHost = null;
      syncPolling();
    };
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
    const opening = ++panelEpoch;
    if (!panel) {
      panel = document.createElement("div"); panel.id = "voice-input-settings"; panel.className = "voice-panel"; panel.setAttribute("popover", "auto"); panel.setAttribute("aria-label", "Voice input settings");
      panel.addEventListener("click", onClick);
      panel.addEventListener("change", onSettingsChange);
      panel.addEventListener("toggle", () => {
        if (!panel.matches(":popover-open") && probe?.owner === panel) stopProbe();
        syncPolling(); paint();
      });
      document.body.append(panel);
    }
    try {
      await refresh();
    } catch (failure) { error = message(failure); }
    if (opening !== panelEpoch || !options.isChat()) return;
    panel.innerHTML = panelMarkup(); updatePanel(); panel.showPopover(); positionPanel();
    await testOrDiscover(panel);
  }

  function release(current) {
    clearInterval(current.timer);
    current.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    current.source?.disconnect(); current.node?.disconnect(); current.node?.port?.close();
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
    if (!bridge || job || probe || savingSettings || !options.sessionId()) return;
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
      const stream = await selectedStream(current);
      if (!isCurrent(current)) { stream?.getTracks().forEach(track => track.stop()); await bridge.releaseMicrophone(current.id); return; }
      current.stream = stream;
      current.deviceLabel = stream.getAudioTracks()[0]?.label || settings().deviceLabel || "System default microphone";
      for (const track of stream.getTracks()) track.onended = () => { if (current.phase === "recording") void stop(); };
      // Keep the hardware clock; encodeRecording resamples once to Whisper's 16 kHz input.
      current.context = new AudioContext();
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
        if (detail && current.phase === "recording") detail.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")} · ${current.deviceLabel}`;
        if (seconds >= 300) void stop();
      }, 250);
      panel?.hidePopover(); paint();
    } catch (failure) { fail(current, new Error(microphoneError(failure))); }
  }
  async function recognize(current) {
    try {
      const result = await bridge.transcribe({ id: current.id, sessionId: current.sessionId, language: current.language, pcm: current.pcm });
      if (!isCurrent(current)) return;
      if (result.id !== current.id || result.sessionId !== current.sessionId) throw new Error("The dictation result belongs to another recording.");
      if (result.text && options.hasSession(current.sessionId)) {
        options.appendText(current.sessionId, result.text);
        if (options.sessionId() !== current.sessionId || !options.isChat()) notify("Dictation added to the original chat draft.");
      } else if (!result.text) {
        current.pcm = null;
        fail(current, new Error(result.reason === "quiet-audio"
          ? `No usable audio from ${current.deviceLabel}. Check its level in Settings → Voice or choose another microphone. Your draft is unchanged.`
          : "Audio was received, but no speech was recognized. Check the language in Settings → Voice and try again. Your draft is unchanged."));
        return;
      }
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
      if (action === "devices") await testOrDiscover(event.currentTarget || panel);
      if (action === "test-input") { if (probe?.mode === "test") stopProbe(); else await testOrDiscover(event.currentTarget || panel, "test"); }
      if (action === "full-settings") { panel?.hidePopover(); if (job?.phase === "error") cancel(); location.hash = "#/settings/voice"; }
    } catch (failure) { error = message(failure); updatePanel(); }
  }
  function leaveChat() {
    ++panelEpoch;
    panel?.hidePopover(); stopProbe();
    if (job?.phase === "recording") void stop();
    else if (["preparing", "error"].includes(job?.phase)) cancel();
  }
  function bind() {
    if (!bridge) return;
    if (!options.isChat()) leaveChat();
    if (job && (!options.isChat() || options.sessionId() !== job.sessionId)) {
      if (job.phase === "recording") void stop();
      else if (job.phase === "preparing" || job.phase === "error") cancel();
    }
    document.querySelector("#chat-form")?.addEventListener("click", onClick);
    paint(); positionPanel();
  }
  if (bridge) {
    bridge.onStopCapture(() => { stopProbe(); void stop(); });
    document.addEventListener("visibilitychange", () => { if (document.hidden) { stopProbe(); void stop(); } });
    window.addEventListener("beforeunload", () => { stopProbe(); cancel(); });
    navigator.mediaDevices?.addEventListener("devicechange", () => {
      if (!probe && !job && (settingsHost || panel?.matches(":popover-open"))) {
        // Do not reopen a microphone from a hardware event. Privacy-related devicechange
        // events can themselves be caused by opening/stopping a stream.
        inputMessage = "Microphone devices changed. Refresh microphones to update the list.";
        updateInputLevel();
      }
    });
    window.addEventListener("resize", positionPanel);
  }
  return { renderButton, renderStrip, bind, busy, mountSettings, leaveChat, cancelSession: id => { if (job?.sessionId === id) cancel(); },
    escape: () => { if (panel?.matches(":popover-open")) { panel.hidePopover(); return true; } if (job) { cancel(); return true; } return false; } };
}
