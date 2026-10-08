import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import express, { NextFunction, Request, Response } from "express";
import { createApiRouter } from "../../src/api/routes";
import { buildRuntime } from "../../src/app/buildRuntime";
import type { RuntimeManager } from "../../src/app/RuntimeManager";
import type { AppConfig } from "../../src/config/config";
import type { LLMRequest, LLMResponse } from "../../src/types";
import { Logger } from "../../src/utils/Logger";

/** Pins the legacy HTTP chat contract (/chat, /process, /process-runs, session history)
 * before chat moves to durable runs. No network: every model call goes through the
 * scripted stub and providers point at a closed port. */

export const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

export const untilAborted = (signal?: AbortSignal) => new Promise<never>((_, reject) => {
  if (!signal) return;
  if (signal.aborted) { reject(signal.reason); return; }
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

const closed = "http://127.0.0.1:9";
export const createChatTestConfig = (root: string): AppConfig => ({
  server: { enabled: false, host: "127.0.0.1", port: 0 },
  mcp: { server: { enabled: false, transport: "stdio", defaultSessionId: "mcp-test" } },
  plugins: { dir: path.resolve(process.cwd(), "plugins"), overrides: {} },
  llm: { defaultProvider: "ollama" },
  providers: {
    ollama: { baseUrl: closed, model: "llama3.2", timeoutMs: 10 },
    lmstudio: { baseUrl: `${closed}/v1`, model: "fixture", timeoutMs: 10, apiKey: "lm-studio" },
    openai: { baseUrl: closed, model: "fixture", timeoutMs: 10, apiKey: undefined },
    anthropic: { baseUrl: closed, model: "fixture", timeoutMs: 10, apiKey: undefined, version: "2023-06-01", maxTokens: 256 },
    gemini: { baseUrl: closed, model: "fixture", timeoutMs: 10, apiKey: undefined }
  },
  memory: {
    adapter: "world-partition",
    baseDir: path.join(root, "memory"),
    topK: 5,
    worldPartition: { crossSessionRecall: true, strategy: "auto", activationThreshold: 10000, chunkCapacity: 1024,
      initialRadius: 1, maxRadius: 3, fallbackToGlobalSearch: true, migrateLegacyOnStart: true },
    openMemory: { enabled: false, dbPath: path.join(root, "openmemory.db") }
  },
  sessions: { baseDir: path.join(root, "sessions") },
  notion: { apiKey: undefined, parentPageId: undefined, dataSourceId: undefined, titleProperty: "Name", version: "2026-03-11" },
  telegram: { enabled: false, botToken: undefined, ownerUserIds: [], pollTimeoutSec: 1 },
  filesystem: { accessMode: "restricted", allowedDirectories: [path.join(root, "output"), root] },
  outputDir: path.join(root, "output"),
  appDataDir: path.join(root, "app"),
  ui: { publicDir: path.join(root, "public") }
});

export type Script = (request: LLMRequest, providerId?: string) => Partial<LLMResponse> | Promise<Partial<LLMResponse>>;
export interface HttpResult { status: number; body: any }

export async function startChatHarness(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lcai-chat-regression-")));
  const config = createChatTestConfig(root);
  const runtime = await buildRuntime(config, new Logger());
  const calls: Array<{ request: LLMRequest; providerId?: string }> = [];
  let script: Script = () => { throw new Error("Unscripted model call"); };
  runtime.llmService.generateText = async (request, providerId) => {
    calls.push({ request, providerId });
    request.signal?.throwIfAborted();
    return { provider: providerId ?? "ollama", model: request.model ?? "fixture", text: "", ...(await script(request, providerId)) };
  };
  let profileId = "profile-a";
  const manager = { getRuntime: () => runtime, getSettings: async () => ({ memory: { localProfileId: profileId } }) } as unknown as RuntimeManager;

  const app = express();
  app.use(express.json({ limit: "8mb" }));
  app.use("/", createApiRouter(manager, runtime.sessionIndexStore));
  // Mirrors the error handler in src/index.ts.
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    const statusCode = "statusCode" in error && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
    res.status(statusCode).json({ error: statusCode < 500 ? error.message : "Internal server error", message: error.message });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });

  const call = async (method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<HttpResult> => {
    const response = await fetch(`${base}${url}`, { method, signal,
      headers: { "content-type": "application/json", "x-local-cognitive": "1" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const waitForRun = async (id: string, predicate: (run: any) => boolean) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const response = await call("GET", `/process-runs/${id}`);
      if (response.status === 200 && predicate(response.body)) return response.body;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`run ${id} never matched`);
  };

  return { root, outputDir: config.outputDir, runtime, manager, calls, call, waitForRun,
    setScript: (next: Script) => { script = next; }, setProfile: (next: string) => { profileId = next; } };
}
