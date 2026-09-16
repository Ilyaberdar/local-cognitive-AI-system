import fs from "fs/promises";
import path from "path";
import net from "net";
import { randomBytes } from "crypto";
import { spawn, ChildProcess } from "child_process";
import { setTimeout as delay } from "timers/promises";
import { LLMRequest, LLMResponse } from "../types";
import { Logger } from "../utils/Logger";
import { OpenAICompatibleProvider } from "../llm/OpenAICompatibleProvider";
import { LocalModelError, LocalModelOptions, LocalRuntimeSnapshot } from "./types";

export class LlamaCppRuntime {
  private child?: ChildProcess;
  private endpoint?: string;
  private token = "";
  private state: LocalRuntimeSnapshot["status"] = "stopped";
  private modelId?: string;
  private projectorPath?: string;
  private error?: string;
  private logTail = "";
  private stopping?: Promise<void>;
  private nativeCleanup: Promise<void> = Promise.resolve();
  private lifetime = new AbortController();

  constructor(private options: LocalModelOptions, private readonly logger: Logger, private readonly changed: () => void = () => {}) {}
  get currentModelId(): string | undefined { return this.modelId; }
  get status(): LocalRuntimeSnapshot["status"] { return this.state; }
  snapshot(): LocalRuntimeSnapshot {
    return { status: this.state, version: "b10809", backend: process.platform === "darwin" && this.options.gpuLayers !== 0 ? "Metal" : "CPU",
      platform: process.platform, architecture: process.arch, modelId: this.modelId, error: this.error,
      queueLength: 0, busy: false, contextSize: this.options.contextSize, memoryLimitPercent: this.options.memoryLimitPercent, modelsDir: this.options.modelsDir };
  }
  async init(): Promise<void> {
    if (!this.options.enabled) { this.setState("unavailable", "Local models are disabled in Settings."); return; }
    try { await fs.access(this.executable(), fs.constants.X_OK); this.setState("stopped"); }
    catch { this.setState("unavailable", "The bundled llama.cpp runtime is missing for this platform. Prepare the runtime or install a complete desktop build."); }
  }
  async reconfigure(options: LocalModelOptions): Promise<void> { await this.stop(); this.options = options; this.lifetime = new AbortController(); await this.init(); }

  async load(modelId: string, modelPath: string, signal?: AbortSignal, projectorPath?: string): Promise<void> {
    signal?.throwIfAborted();
    if (!this.options.enabled) throw new LocalModelError("Local models are disabled.", 503);
    if (this.state === "ready" && this.modelId === modelId && this.projectorPath === projectorPath && this.child) return;
    await this.stop();
    try { await fs.access(this.executable(), fs.constants.X_OK); } catch { await this.init(); throw new LocalModelError(this.error ?? "The llama.cpp runtime is unavailable.", 503); }
    const port = await freePort();
    signal?.throwIfAborted();
    this.token = randomBytes(32).toString("hex");
    this.endpoint = `http://127.0.0.1:${port}/v1`;
    this.modelId = modelId;
    this.projectorPath = projectorPath;
    this.logTail = "";
    this.setState("loading");
    const args = ["--model", modelPath, "--alias", modelId, "--host", "127.0.0.1", "--port", String(port),
      "--ctx-size", String(this.options.contextSize), "--n-gpu-layers", String(this.options.gpuLayers), "--parallel", "1", "--jinja", "--no-webui", "--no-agent"];
    if (projectorPath) args.push("--mmproj", projectorPath);
    const compiledHost = path.join(__dirname, "RuntimeProcessHost.js");
    const compiled = await fs.access(compiledHost).then(() => true, () => false);
    const hostArgs = compiled ? [compiledHost] : [require.resolve("tsx/cli"), path.join(__dirname, "RuntimeProcessHost.ts")];
    const child = spawn(process.execPath, [...hostArgs, this.executable(), JSON.stringify(args)], {
      stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true, shell: false,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", LLAMA_API_KEY: this.token, LLAMA_ARG_MCP_SERVERS: "", LLAMA_ARG_TOOLS: "", LLAMA_ARG_AGENT: "0" }
    });
    this.child = child;
    let nativePid: number | undefined;
    child.on("message", (message) => {
      const event = message as { type?: string; pid?: number };
      if (event?.type === "native-started" && Number.isSafeInteger(event.pid) && event.pid! > 0) nativePid = event.pid;
    });
    const append = (chunk: Buffer) => { this.logTail = (this.logTail + chunk.toString("utf8")).slice(-4000); };
    child.stderr?.on("data", append); child.stdout?.on("data", append);
    child.once("error", (error) => { if (this.child === child) this.setState("error", `Local runtime failed to start: ${error.message}`); });
    child.once("exit", (code) => {
      // A SIGKILL of the guardian must not leave a second native model consuming memory.
      if (nativePid) this.nativeCleanup = this.terminateNative(nativePid);
      if (this.child !== child) return;
      this.child = undefined; this.endpoint = undefined;
      if (this.state !== "stopping") {
        this.setState("error", `Local runtime exited (${code ?? "signal"}). ${this.logTail.slice(-1600)}`);
        this.logger.warn("Local inference runtime exited", { code, modelId });
      }
    });
    const deadline = AbortSignal.any([AbortSignal.timeout(this.options.loadTimeoutMs), this.lifetime.signal, ...(signal ? [signal] : [])]);
    try {
      while (true) {
        deadline.throwIfAborted();
        if (!this.child || this.state === "error") throw new LocalModelError(this.error ?? "Local runtime exited during model loading.", 503);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.any([deadline, AbortSignal.timeout(1500)]) });
          if (response.ok && (await response.json() as { status?: string }).status === "ok") break;
        } catch (error) { if (deadline.aborted) throw error; }
        await delay(100, undefined, { signal: deadline });
      }
      deadline.throwIfAborted(); this.setState("ready");
    } catch (error) {
      const message = signal?.aborted ? "Model loading cancelled." : deadline.aborted ? "Model loading timed out. Choose a smaller model or increase the load timeout." : error instanceof Error ? error.message : "Model loading failed.";
      await this.stop(); this.modelId = modelId; this.setState("error", message);
      throw new LocalModelError(message, signal?.aborted ? 499 : 503);
    }
  }

  async generateText(request: LLMRequest): Promise<LLMResponse> {
    if (!this.endpoint || !this.child || this.state !== "ready" || request.model !== this.modelId) throw new LocalModelError("The selected local model is not ready.", 503);
    if (request.images?.length && !this.projectorPath) throw new LocalModelError("This local model has no vision adapter. Attach its matching mmproj GGUF before sending images.", 400, "vision_unavailable");
    const provider = new OpenAICompatibleProvider({ id: "llamacpp", name: "Local models", model: this.modelId!,
      baseUrl: this.endpoint, apiKey: this.token, timeoutMs: this.options.generationTimeoutMs }, this.logger);
    const signal = AbortSignal.any([this.lifetime.signal, ...(request.signal ? [request.signal] : [])]);
    const result = await provider.generateText({ ...request, signal, previousResponseId: undefined });
    signal.throwIfAborted();
    if (!this.child || this.state !== "ready") throw new LocalModelError(this.error ?? "The local runtime stopped during generation.", 503);
    // llama.cpp does not persist Responses IDs between calls. Conversation is composed by the app.
    return { ...result, responseId: undefined };
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopChild();
    try { await this.stopping; } finally { this.stopping = undefined; }
  }
  async dispose(): Promise<void> { this.lifetime.abort(); await this.stop(); }
  private async stopChild(): Promise<void> {
    const child = this.child;
    if (child) {
      this.setState("stopping");
      await new Promise<void>((resolve) => {
        let finished = false;
        const done = () => { if (finished) return; finished = true; clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { child.kill("SIGTERM"); setTimeout(() => { child.kill("SIGKILL"); done(); }, 2000).unref(); }, 3000);
        child.once("exit", done);
        try { if (child.connected) child.send("stop"); else child.kill("SIGTERM"); } catch { child.kill("SIGTERM"); }
        if (child.exitCode !== null || child.signalCode !== null) done();
      });
    }
    await this.nativeCleanup;
    this.child = undefined; this.endpoint = undefined; this.token = ""; this.modelId = undefined; this.projectorPath = undefined;
    this.setState("stopped");
  }
  private executable(): string { return this.options.executablePath || path.join(this.options.runtimeDir, process.platform === "win32" ? "llama-server.exe" : "llama-server"); }
  private async terminateNative(pid: number): Promise<void> {
    if (process.platform !== "win32") { try { process.kill(-pid, "SIGKILL"); } catch {} return; }
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      killer.once("exit", () => resolve()); killer.once("error", () => { try { process.kill(pid, "SIGKILL"); } catch {} resolve(); });
    });
  }
  private setState(state: LocalRuntimeSnapshot["status"], error?: string): void { this.state = state; this.error = error; this.changed(); }
}

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = net.createServer(); server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const address = server.address(); const port = typeof address === "object" && address ? address.port : 0;
    server.close((error) => { if (error || !port) reject(error ?? new Error("No local port is available.")); else resolve(port); }); });
});
