import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

export const SPEECH_MODELS = [
  {
    id: "whisper-large-v3-turbo", name: "Whisper Large v3 Turbo", label: "Higher accuracy", beamSize: 5,
    file: "ggml-large-v3-turbo.bin", sizeBytes: 1624555275,
    sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo.bin"
  },
  {
    id: "whisper-small", name: "Whisper Small", label: "Faster · less memory", beamSize: 1,
    file: "ggml-small.bin", sizeBytes: 487601967,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.bin"
  }
];
export const MAX_AUDIO_SECONDS = 300;
export const SPEECH_LANGUAGES = ["auto", "ru", "uk", "en"];
export interface SpeechSettings { language: string; deviceId: string; deviceLabel?: string; modelId?: string; }
export interface SpeechRequest { id: string; sessionId: string; pcm: Uint8Array; language: string; }

/** The renderer supplies raw mono 16-bit PCM at 16 kHz, never paths or shell arguments. */
export function pcmToWav(pcm: Uint8Array): Buffer {
  if (!(pcm instanceof Uint8Array) || pcm.byteLength < 3200 || pcm.byteLength > MAX_AUDIO_SECONDS * 32000 || pcm.byteLength % 2) {
    throw new Error("Record between 0.1 seconds and 5 minutes of audio.");
  }
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(36 + pcm.byteLength, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

export function hasAudibleSpeech(pcm: Uint8Array): boolean {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let audible = 0;
  for (let offset = 0; offset + 640 <= pcm.byteLength; offset += 640) {
    let energy = 0;
    for (let i = offset; i < offset + 640; i += 2) energy += (view.getInt16(i, true) / 32768) ** 2;
    if (Math.sqrt(energy / 320) > 0.003) audible++;
  }
  return audible >= 10; // Reject silence before decoding; Whisper also applies its no-speech threshold.
}

async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export class SpeechService {
  private initialized?: Promise<void>;
  private installed = new Set<string>();
  private removingModel = false;
  private available = false;
  private disposed = false;
  private settings: SpeechSettings = { language: "auto", deviceId: "default", modelId: SPEECH_MODELS[0]!.id };
  private download?: { modelId: string; total: number; controller: AbortController; promise: Promise<void>; received: number; state: string; error?: string };
  private active?: { id: string; controller: AbortController; done: Promise<unknown> };
  constructor(private readonly root: string, private readonly runtimeDir: string, private readonly fetcher: typeof fetch = fetch) {}
  private executable(): string { return path.join(this.runtimeDir, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli"); }
  private model() { return SPEECH_MODELS.find(model => model.id === this.settings.modelId)!; }
  private modelPath(model = this.model()): string { return path.join(this.root, model.file); }
  private init(): Promise<void> {
    return this.initialized ??= (async () => {
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      // Only this application's temporary recordings are removed after an interrupted run.
      for (const name of await fs.readdir(this.root)) if (/^recording-[a-f0-9-]+$/.test(name)) await fs.rm(path.join(this.root, name), { recursive: true, force: true });
      this.available = await fs.access(this.executable(), fs.constants.X_OK).then(() => true, () => false);
      for (const model of SPEECH_MODELS) {
        const stat = await fs.stat(this.modelPath(model)).catch(() => undefined);
        if (stat?.size === model.sizeBytes && await digest(this.modelPath(model)) === model.sha256) this.installed.add(model.id);
      }
      // Keep an existing Small installation usable until the user chooses to upgrade.
      this.settings.modelId = SPEECH_MODELS.find(model => this.installed.has(model.id))?.id ?? SPEECH_MODELS[0]!.id;
      try { this.settings = this.validateSettings(JSON.parse(await fs.readFile(path.join(this.root, "settings.json"), "utf8"))); } catch {}
    })();
  }
  async status() {
    await this.init();
    return { available: this.available, installed: this.installed.has(this.model().id), model: this.model(), settings: this.settings,
      models: SPEECH_MODELS.map(model => ({ ...model, installed: this.installed.has(model.id) })),
      busy: Boolean(this.active), maxSeconds: MAX_AUDIO_SECONDS,
      download: this.download ? { modelId: this.download.modelId, received: this.download.received, total: this.download.total, state: this.download.state, error: this.download.error } : null };
  }
  private validateSettings(value: Partial<SpeechSettings>): SpeechSettings {
    if (!value || !SPEECH_LANGUAGES.includes(value.language ?? "") || typeof value.deviceId !== "string" || value.deviceId.length > 512) throw new Error("Invalid voice settings.");
    if (value.deviceLabel !== undefined && (typeof value.deviceLabel !== "string" || value.deviceLabel.length > 512)) throw new Error("Invalid microphone name.");
    const modelId = value.modelId ?? this.settings.modelId;
    if (!SPEECH_MODELS.some(model => model.id === modelId)) throw new Error("Invalid voice model.");
    return { language: value.language!, deviceId: value.deviceId || "default", deviceLabel: value.deviceLabel || "", modelId };
  }
  async updateSettings(value: SpeechSettings) {
    await this.init();
    const next = this.validateSettings(value);
    if (next.modelId !== this.settings.modelId && (this.active || this.removingModel || this.isDownloading())) throw new Error("Finish dictation or the model download before switching voice models.");
    await fs.writeFile(path.join(this.root, "settings.json"), JSON.stringify(next), { mode: 0o600 });
    this.settings = next;
    return next;
  }
  private isDownloading() { return Boolean(this.download && ["downloading", "verifying"].includes(this.download.state)); }
  async install(): Promise<void> {
    await this.init();
    if (this.disposed) throw new Error("Voice input is shutting down.");
    if (!this.available) throw new Error("This build does not contain the speech runtime for your platform.");
    if (this.removingModel) throw new Error("Wait for model removal to finish.");
    const model = this.model();
    if (this.installed.has(model.id) || this.isDownloading()) return;
    const job = { modelId: model.id, total: model.sizeBytes, controller: new AbortController(), promise: Promise.resolve(), received: 0, state: "downloading", error: undefined as string | undefined };
    this.download = job;
    job.promise = (async () => {
      const partial = `${this.modelPath(model)}.part`;
      try {
        const response = await this.fetcher(model.url, { signal: AbortSignal.any([job.controller.signal, AbortSignal.timeout(1800000)]) });
        if (!response.ok || !response.body) throw new Error(`Model download failed (HTTP ${response.status}).`);
        const count = new Transform({ transform(chunk, _encoding, callback) {
          job.received += chunk.length;
          callback(job.received > model.sizeBytes ? new Error("Unexpected model size.") : null, chunk);
        } });
        await pipeline(Readable.fromWeb(response.body as any), count, createWriteStream(partial, { mode: 0o600 }), { signal: job.controller.signal });
        job.state = "verifying";
        if (job.received !== model.sizeBytes || await digest(partial) !== model.sha256) throw new Error("Model checksum verification failed. Please download again.");
        job.controller.signal.throwIfAborted();
        await fs.rename(partial, this.modelPath(model));
        this.installed.add(model.id); job.state = "complete";
      } catch (error) {
        job.state = job.controller.signal.aborted ? "cancelled" : "error";
        job.error = job.controller.signal.aborted ? undefined : error instanceof Error ? error.message : "Download failed.";
      } finally { await fs.rm(partial, { force: true }); }
    })();
  }
  async cancelDownload() { this.download?.controller.abort(); await this.download?.promise; }
  async removeModel() {
    if (this.active || this.removingModel) throw new Error("Finish or cancel dictation before removing its model.");
    this.removingModel = true;
    try {
      await this.init();
      const model = this.model();
      await this.cancelDownload();
      await fs.rm(this.modelPath(model), { force: true }); this.installed.delete(model.id); this.download = undefined;
    } finally { this.removingModel = false; }
  }
  async transcribe(request: SpeechRequest): Promise<{ id: string; sessionId: string; text: string }> {
    // Reserve the slot before the first await, so cancellation also works during initialization.
    if (this.active || this.disposed || this.removingModel) throw new Error("Speech recognition is busy. Please try again.");
    if (!request || !/^[a-zA-Z0-9-]{1,100}$/.test(request.id) || !/^[a-zA-Z0-9-]{1,100}$/.test(request.sessionId) || !SPEECH_LANGUAGES.includes(request.language)) throw new Error("Invalid dictation request.");
    const wav = pcmToWav(request.pcm);
    const operation = { id: request.id, controller: new AbortController(), done: Promise.resolve() as Promise<unknown> };
    this.active = operation;
    operation.done = (async () => {
      const directory = path.join(this.root, `recording-${randomUUID()}`);
      try {
        await this.init(); operation.controller.signal.throwIfAborted();
        const model = this.model();
        if (!this.available || !this.installed.has(model.id)) throw new Error("Download the voice model before recording.");
        if (!hasAudibleSpeech(request.pcm)) return { id: request.id, sessionId: request.sessionId, text: "", reason: "quiet-audio" };
        await fs.mkdir(directory, { mode: 0o700 });
        const input = path.join(directory, "input.wav"), output = path.join(directory, "result");
        await fs.writeFile(input, wav, { mode: 0o600 });
        const args = ["-m", this.modelPath(model), "-f", input, "-l", request.language, "-oj", "-of", output,
          "-t", String(Math.min(4, os.availableParallelism())), "-bo", String(model.beamSize), "-bs", String(model.beamSize), "-nt", "-np", "-sns", "-nth", "0.6"];
        await runSpeechProcess(this.executable(), args, operation.controller.signal);
        operation.controller.signal.throwIfAborted();
        const result = JSON.parse(await fs.readFile(`${output}.json`, "utf8")) as { transcription?: Array<{ text?: string }> };
        const text = (result.transcription ?? []).map(segment => segment.text ?? "").join(" ").replace(/\s+/g, " ").trim();
        return { id: request.id, sessionId: request.sessionId, text };
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
        if (this.active === operation) this.active = undefined;
      }
    })();
    return operation.done as Promise<{ id: string; sessionId: string; text: string; reason?: "quiet-audio" }>;
  }
  async cancel(id?: string) {
    const active = this.active;
    if (active && (!id || active.id === id)) { active.controller.abort(); await active.done.catch(() => {}); }
  }
  async dispose() { this.disposed = true; await Promise.all([this.cancel(), this.cancelDownload()]); }
}

async function runSpeechProcess(executable: string, args: string[], cancellation: AbortSignal): Promise<void> {
  cancellation.throwIfAborted();
  const signal = AbortSignal.any([cancellation, AbortSignal.timeout(300000)]);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "../local/RuntimeProcessHost.js"), executable, JSON.stringify(args)], {
      stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    });
    // Native output may contain recognized speech. Never forward it to application logs.
    child.stderr?.resume();
    const stop = () => { child.kill("SIGTERM"); };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.once("error", error => { signal.removeEventListener("abort", stop); reject(error); });
    child.once("close", code => {
      signal.removeEventListener("abort", stop);
      if (signal.aborted) reject(new Error(cancellation.aborted ? "Dictation cancelled." : "Recognition timed out. Try a shorter recording."));
      else if (code !== 0) reject(new Error("Speech recognition failed. Try again or reinstall the voice model."));
      else resolve();
    });
  });
}
