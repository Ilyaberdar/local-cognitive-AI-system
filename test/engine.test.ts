import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import test from "node:test";
import { buildRuntime } from "../src/app/buildRuntime";
import { AppConfig } from "../src/config/config";
import { OutputSanitizer } from "../src/llm/OutputSanitizer";
import { Logger } from "../src/utils/Logger";

const createTestConfig = (root: string): AppConfig => ({
  server: {
    enabled: false,
    host: "127.0.0.1",
    port: 0
  },
  plugins: {
    dir: path.resolve(process.cwd(), "plugins"),
    overrides: {}
  },
  llm: {
    defaultProvider: "ollama"
  },
  providers: {
    ollama: {
      baseUrl: "http://127.0.0.1:11434",
      model: "llama3.2",
      timeoutMs: 10
    },
    lmstudio: {
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "openai/gpt-oss-20b",
      timeoutMs: 10,
      apiKey: "lm-studio"
    },
    openai: {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      timeoutMs: 10,
      apiKey: undefined
    },
    anthropic: {
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-5",
      timeoutMs: 10,
      apiKey: undefined,
      version: "2023-06-01",
      maxTokens: 256
    },
    gemini: {
      baseUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-2.5-flash",
      timeoutMs: 10,
      apiKey: undefined
    }
  },
  memory: {
    adapter: "local-json",
    baseDir: path.join(root, "memory"),
    topK: 5,
    openMemory: {
      enabled: false,
      dbPath: path.join(root, "openmemory.db")
    }
  },
  sessions: {
    baseDir: path.join(root, "sessions")
  },
  notion: {
    apiKey: undefined,
    parentPageId: undefined,
    dataSourceId: undefined,
    titleProperty: "Name",
    version: "2026-03-11"
  },
  telegram: {
    enabled: false,
    botToken: undefined,
    pollTimeoutSec: 1
  },
  outputDir: path.join(root, "output"),
  appDataDir: path.join(root, "app"),
  ui: {
    publicDir: path.join(root, "public")
  }
});

test("runtime processes hypothesis requests and triggers notion plugin", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcai-engine-"));
  const runtime = await buildRuntime(createTestConfig(tmpDir), new Logger());

  const result = await runtime.engine.process({
    input: "Debate this hypothesis and make a note in Notion: local JSON memory is good for bootstrap.",
    actor: {
      sessionId: "test-session",
      channel: "http"
    }
  });

  assert.equal(result.mode, "hypothesis");
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].tool, "notion");
  assert.match(result.tools[0].output, /Notion/i);
  assert.ok(runtime.plugins.some((plugin) => plugin.manifest.name === "notion"));
});

test("memory persists per session and provider selection works", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcai-memory-"));
  const runtime = await buildRuntime(createTestConfig(tmpDir), new Logger());

  await runtime.engine.process({
    input: "Remember that I prefer local-first tooling.",
    actor: {
      sessionId: "memory-session",
      channel: "http"
    }
  });

  const result = await runtime.engine.process({
    input: "Summarize my preference and save to file",
    providerId: "lmstudio",
    actor: {
      sessionId: "memory-session",
      channel: "http"
    }
  });

  assert.equal(result.providerId, "lmstudio");
  assert.ok(result.conversationSize >= 1);
  assert.ok(result.memory.length >= 1);
  assert.ok(result.tools.some((tool) => tool.tool === "file"));
});

test("session settings can force multi-provider debate roles", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcai-debate-"));
  const runtime = await buildRuntime(createTestConfig(tmpDir), new Logger());

  await runtime.sessionSettingsStore.update("debate-session", {
    debate: {
      enabled: true,
      profile: "technical",
      support: {
        providerId: "lmstudio",
        model: "qwen/qwen3.5-9b"
      },
      attack: {
        providerId: "openai",
        model: "zai-org/glm-4.6v-flash"
      },
      judge: {
        providerId: "local"
      }
    }
  });

  const result = await runtime.engine.process({
    input: "Should we use a local vector store for early-stage memory?",
    actor: {
      sessionId: "debate-session",
      channel: "http"
    }
  });

  assert.equal(result.mode, "hypothesis");
  assert.equal(result.sessionSettings.debate.enabled, true);
  assert.ok("participants" in result.result);
  assert.match(result.result.participants.support, /lmstudio:qwen\/qwen3\.5-9b/);
  assert.match(result.result.participants.attack, /openai:zai-org\/glm-4\.6v-flash/);
  assert.equal(result.result.participants.judge, "local");
});

test("local judge reasoning respects Russian language preference", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcai-language-"));
  const runtime = await buildRuntime(createTestConfig(tmpDir), new Logger());

  await runtime.sessionSettingsStore.update("ru-session", {
    language: "ru",
    debate: {
      enabled: true,
      judge: {
        providerId: "local"
      }
    }
  });

  const result = await runtime.engine.process({
    input: "Проверь гипотезу: локальная память полезна на первом этапе.",
    actor: {
      sessionId: "ru-session",
      channel: "http"
    }
  });

  assert.equal(result.mode, "hypothesis");
  assert.ok("reasoning" in result.result);
  assert.match(result.result.reasoning, /локальн|эвристическ|аргумент/i);
});

test("output sanitizer keeps only final answer when reasoning noise is present", () => {
  const sanitizer = new OutputSanitizer();
  const sanitized = sanitizer.sanitize([
    "Thinking Process:",
    "The user wants a short answer.",
    "",
    "Qwen3.5"
  ].join("\n"));

  assert.equal(sanitized, "Qwen3.5");
});
