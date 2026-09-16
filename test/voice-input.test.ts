import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { hasAudibleSpeech, MAX_AUDIO_SECONDS, pcmToWav, SPEECH_MODELS, SpeechService } from "../src/speech/SpeechService";

const deferred = () => {
  let resolve!: (value?: any) => void, reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

test("speech input is bounded mono PCM and preserves signed samples in WAV", () => {
  const pcm = new Uint8Array(32000), view = new DataView(pcm.buffer);
  view.setInt16(0, -32768, true); view.setInt16(2, 32767, true);
  const wav = pcmToWav(pcm);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(40), pcm.byteLength); assert.equal(wav.readInt16LE(44), -32768);
  assert.throws(() => pcmToWav(new Uint8Array(MAX_AUDIO_SECONDS * 32000 + 2)));
  assert.throws(() => pcmToWav(new Uint8Array(3201)));
  assert.throws(() => pcmToWav(new Uint8Array(100)));
  assert.equal(hasAudibleSpeech(new Uint8Array(32000)), false);
  for (let i = 0; i < 16000; i++) view.setInt16(i * 2, Math.sin(i / 8) * 4000, true);
  assert.equal(hasAudibleSpeech(pcm), true);
});

test("speech service rejects invalid identities and cancellation owns the initialization slot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-service-test-"));
  const service = new SpeechService(root, root);
  try {
    await assert.rejects(service.transcribe({ id: "../escape", sessionId: "a", language: "ru", pcm: new Uint8Array(32000) }), /Invalid/);
    const pending = service.transcribe({ id: "recording-a", sessionId: "chat-a", language: "ru", pcm: new Uint8Array(32000) });
    await assert.rejects(service.transcribe({ id: "recording-b", sessionId: "chat-b", language: "ru", pcm: new Uint8Array(32000) }), /busy/);
    await service.cancel("recording-a");
    await assert.rejects(pending, /abort/i);
    assert.equal((await service.status()).busy, false);
    await assert.rejects(service.updateSettings({ language: "shell-command", deviceId: "default" }), /Invalid/);
    await service.updateSettings({ language: "ru", deviceId: "old-origin-id", deviceLabel: "USB Microphone" });
    const reloaded = new SpeechService(root, root);
    assert.equal((await reloaded.status()).settings.deviceLabel, "USB Microphone");
    await reloaded.dispose();
  } finally { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test("voice model selection persists, rejects unknown models, and deletes only the selected model", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-model-test-"));
  const service = new SpeechService(root, root);
  try {
    assert.equal((await service.status()).model.id, "whisper-large-v3-turbo");
    await assert.rejects(service.updateSettings({ language: "ru", deviceId: "default", modelId: "../../other" }), /Invalid voice model/);
    await service.updateSettings({ language: "ru", deviceId: "default", modelId: "whisper-small" });
    // Older callers saving language/microphone must not accidentally switch models.
    await service.updateSettings({ language: "uk", deviceId: "default" });
    const reloaded = new SpeechService(root, root);
    assert.equal((await reloaded.status()).model.id, "whisper-small");
    await reloaded.dispose();
    for (const model of SPEECH_MODELS) await fs.writeFile(path.join(root, model.file), "fixture");
    await service.removeModel();
    await assert.rejects(fs.access(path.join(root, "ggml-small.bin")));
    assert.equal(await fs.readFile(path.join(root, "ggml-large-v3-turbo.bin"), "utf8"), "fixture");
  } finally { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test("a voice download retains its model identity and can be cancelled without removing other models", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-download-test-"));
  let requestedUrl = "";
  const fetcher = (async (url: string, options: RequestInit) => {
    requestedUrl = url;
    return await new Promise<Response>((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }));
  }) as typeof fetch;
  const service = new SpeechService(root, root, fetcher);
  try {
    await fs.writeFile(path.join(root, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli"), "fixture", { mode: 0o700 });
    await service.updateSettings({ language: "ru", deviceId: "default", modelId: "whisper-small" });
    await service.install();
    assert.ok(requestedUrl.endsWith("/ggml-small.bin"));
    assert.equal((await service.status()).download?.modelId, "whisper-small");
    await assert.rejects(service.updateSettings({ language: "ru", deviceId: "default", modelId: "whisper-large-v3-turbo" }), /Finish/);
    await service.cancelDownload();
    await service.updateSettings({ language: "ru", deviceId: "default", modelId: "whisper-large-v3-turbo" });
    assert.equal((await service.status()).model.id, "whisper-large-v3-turbo");
    assert.equal((await service.status()).download?.state, "cancelled");
    assert.equal((await service.status()).installed, false);
  } finally { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

async function uiHarness() {
  const source = (await fs.readFile("public/assets/voice-input.js", "utf8")).replace(/export /g, "");
  let click!: (event: any) => Promise<void>, session = "a", streams = 0, stopped = 0, nodes: any[] = [];
  const drafts: Record<string, string> = { a: "Existing draft.", b: "Second chat." }, notices: string[] = [];
  const permission = deferred(), result = deferred(), settingsSaved = deferred();
  let delayedPermission = false, request: any, requests = 0;
  const released: string[] = [];
  let settings = { language: "ru", deviceId: "default", modelId: "whisper-small" };
  const bridge: any = {
    status: async () => ({ installed: true, available: true, settings: { ...settings }, models: SPEECH_MODELS, model: SPEECH_MODELS.find(model => model.id === settings.modelId) }),
    updateSettings: async (next: typeof settings) => { await settingsSaved.promise; settings = next; return { ...settings }; },
    requestMicrophone: () => delayedPermission ? permission.promise : Promise.resolve(true),
    releaseMicrophone: async (id: string) => { released.push(id); }, cancel: async () => {}, onStopCapture: () => {},
    transcribe: (value: any) => { request = value; requests++; return result.promise; }
  };
  const form = { dataset: {}, addEventListener: (_name: string, callback: any) => { click = callback; } };
  let settingsChanged!: () => Promise<void>;
  const fields = new Map<string, any>();
  const field = (selector: string) => {
    if (!fields.has(selector)) fields.set(selector, {});
    return fields.get(selector);
  };
  field("[data-voice-language]").value = settings.language;
  field("[data-voice-device]").value = settings.deviceId;
  const trigger = { disabled: false, classList: { toggle() {} } };
  const panel = {
    setAttribute() {}, matches: () => false, showPopover() {}, hidePopover() {},
    addEventListener: (name: string, callback: any) => { if (name === "change") settingsChanged = callback; },
    querySelector: field,
    querySelectorAll: () => [field("[data-voice-language]"), field("[data-voice-device]"), field("[data-voice-model]")]
  };
  const context: any = {
    console, Uint8Array, Float32Array, DataView, Math, Date, Promise, crypto: { randomUUID }, setTimeout, clearTimeout, setInterval, clearInterval,
    document: { querySelector: (selector: string) => selector === "#chat-form" ? form : selector === ".voice-trigger" ? trigger : null,
      createElement: () => panel, body: { append() {} }, addEventListener() {} },
    window: { addEventListener() {} },
    navigator: { mediaDevices: { getUserMedia: async () => { streams++; const track = { onended: null, stop: () => { stopped++; } }; return { getTracks: () => [track] }; } } },
    AudioContext: class {
      state = "running"; sampleRate = 16000;
      audioWorklet = { addModule: async () => {} };
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      async resume() { nodes.at(-1).port.onmessage({ data: { samples: new Float32Array(4000).fill(0.1) } }); }
      async close() { this.state = "closed"; }
    },
    AudioWorkletNode: class {
      port: any = { close() {}, postMessage: () => this.port.onmessage({ data: { flushed: true } }) };
      constructor() { nodes.push(this); } connect() {} disconnect() {}
    },
    options: { bridge, icon: () => "", sessionId: () => session, isChat: () => true, sendBusy: () => false,
      hasSession: (id: string) => id in drafts, appendText: (id: string, text: string) => { drafts[id] += ` ${text}`; }, notify: (text: string) => notices.push(text) }
  };
  vm.runInNewContext(source + "\nvar controller = createVoiceInput(options);", context);
  context.controller.bind();
  return {
    controller: context.controller, drafts, notices, permission, result, released, settingsSaved, trigger,
    changeModel: (modelId: string) => { field("[data-voice-model]").value = modelId; return settingsChanged(); },
    click: (action: string) => click({ preventDefault() {}, target: { closest: () => ({ dataset: { voiceAction: action } }) } }),
    delayPermission: () => { delayedPermission = true; }, session: (id: string) => { session = id; context.controller.bind(); },
    streams: () => streams, stopped: () => stopped, request: () => request, requests: () => requests
  };
}

test("a model selection must finish saving before recording can start", async () => {
  const h = await uiHarness();
  await h.click("options");
  const saving = h.changeModel("whisper-large-v3-turbo");
  try {
    await h.click("close-panel");
    assert.equal(h.trigger.disabled, true);
    await h.click("record");
    assert.equal(h.streams(), 0);
    assert.equal(h.controller.busy(), false);
    h.settingsSaved.resolve();
    await saving;
    assert.equal(h.trigger.disabled, false);
    await h.click("record");
    assert.equal(h.streams(), 1);
  } finally {
    h.settingsSaved.resolve();
    await saving;
    await h.click("cancel");
  }
});

test("cancel before microphone permission resolves never starts capture", async () => {
  const h = await uiHarness(); h.delayPermission();
  const starting = h.click("record"); await tick();
  assert.equal(h.controller.busy("a"), true);
  await h.click("cancel"); h.permission.resolve(true); await starting;
  assert.equal(h.streams(), 0); assert.equal(h.controller.busy(), false);
  assert.equal(h.drafts.a, "Existing draft.");
});

test("dictation survives rerender and appends exactly once to its original session", async () => {
  const h = await uiHarness(); await h.click("record");
  h.controller.bind(); h.controller.bind(); assert.equal(h.streams(), 1);
  h.session("b"); await tick(); await tick();
  assert.equal(h.requests(), 1); assert.ok(h.stopped() > 0);
  h.result.resolve({ id: h.request().id, sessionId: "a", text: "Новая фраза." }); await tick();
  assert.equal(h.drafts.a, "Existing draft. Новая фраза."); assert.equal(h.drafts.b, "Second chat.");
  assert.equal(h.controller.busy(), false); assert.match(h.notices[0], /original chat/);
});

test("cancelled transcription cannot overwrite a newer draft", async () => {
  const h = await uiHarness(); await h.click("record"); const finishing = h.click("stop"); await tick();
  await h.click("cancel"); h.drafts.a = "Changed manually.";
  h.result.resolve({ id: h.request().id, sessionId: "a", text: "Stale result" }); await finishing;
  assert.equal(h.drafts.a, "Changed manually."); assert.equal(h.controller.busy(), false);
});

test("background recognition failure releases the microphone control and reports the error", async () => {
  const h = await uiHarness(); await h.click("record"); h.session("b"); await tick(); await tick();
  h.result.reject(new Error("Runtime stopped")); await tick();
  assert.equal(h.controller.busy(), false); assert.match(h.notices[0], /Runtime stopped/);
  assert.equal(h.drafts.a, "Existing draft.");
});

test("IPC microphone grants are bound to recording identity and reject foreign frames", async () => {
  const source = await fs.readFile("electron/voice-input.cjs", "utf8");
  const handlers: any = {}, permissions = [deferred(), deferred()]; let consent = 0, check: any;
  const frame = { origin: "http://127.0.0.1:1234" };
  const contents: any = { mainFrame: frame, session: { setPermissionCheckHandler: (handler: any) => { check = handler; }, setPermissionRequestHandler() {} }, on() {} };
  const window = { webContents: contents, on() {} };
  const context: any = { URL, module: { exports: {} }, process: { platform: "darwin" }, require: () => ({ SpeechService: class {
    async status() { return { installed: true, available: true }; } async cancel() {} async dispose() {}
  } }) };
  vm.runInNewContext(source, context);
  const voice = context.module.exports.registerVoiceInput({ ipcMain: { handle: (name: string, fn: any) => { handlers[name] = fn; } },
    systemPreferences: { askForMediaAccess: () => permissions[consent++].promise }, getWindow: () => window, origin: frame.origin, powerMonitor: { on() {} } });
  voice.attach(window);
  const event = { sender: contents, senderFrame: frame };
  const first = handlers["voice:microphone"](event, "first"); await tick();
  await handlers["voice:cancel"](event, "first");
  const second = handlers["voice:microphone"](event, "second"); await tick();
  permissions[1].resolve(true); await second;
  permissions[0].resolve(true); await assert.rejects(first, /cancelled/);
  await handlers["voice:release-microphone"](event, "first");
  assert.equal(check(contents, "media", frame.origin, { mediaType: "audio" }), true);
  assert.equal(check(contents, "media", frame.origin, { mediaType: "video" }), false);
  await assert.rejects(handlers["voice:status"]({ sender: contents, senderFrame: { origin: frame.origin } }), /application window/);
  await handlers["voice:release-microphone"](event, "second");
  assert.equal(check(contents, "media", frame.origin, { mediaType: "audio" }), false);
});
