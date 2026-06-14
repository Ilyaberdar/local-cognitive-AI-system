import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

type MemoryAdapterName = "local-json" | "openmemory";

export interface ProviderHttpConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  apiKey?: string;
}

export interface AppConfig {
  server: {
    enabled: boolean;
    host: string;
    port: number;
  };
  mcp: {
    server: {
      enabled: boolean;
      transport: "stdio";
      defaultSessionId: string;
    };
  };
  plugins: {
    dir: string;
    overrides: Record<string, { enabled: boolean }>;
  };
  llm: {
    defaultProvider: string;
  };
  providers: {
    ollama: ProviderHttpConfig;
    lmstudio: ProviderHttpConfig;
    openai: ProviderHttpConfig;
    anthropic: ProviderHttpConfig & {
      version: string;
      maxTokens: number;
    };
    gemini: ProviderHttpConfig;
  };
  memory: {
    adapter: MemoryAdapterName;
    baseDir: string;
    topK: number;
    openMemory: {
      enabled: boolean;
      dbPath: string;
    };
  };
  sessions: {
    baseDir: string;
  };
  notion: {
    apiKey?: string;
    parentPageId?: string;
    dataSourceId?: string;
    titleProperty: string;
    version: string;
  };
  telegram: {
    enabled: boolean;
    botToken?: string;
    pollTimeoutSec: number;
  };
  filesystem: {
    accessMode: "restricted" | "full";
    allowedDirectories: string[];
  };
  outputDir: string;
  appDataDir: string;
  ui: {
    publicDir: string;
  };
}

const resolveDir = (dirPath: string, fallback: string): string => {
  const candidate = dirPath.trim() || fallback;
  return path.resolve(process.cwd(), candidate);
};

const toBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

const toOptional = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readFileConfig = (): Record<string, unknown> => {
  const configPath = path.resolve(
    process.cwd(),
    process.env.LOCAL_COGNITIVE_CONFIG ?? "local-cognitive.config.json"
  );

  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const fileConfig = readFileConfig();
const fileMcp = isRecord(fileConfig.mcp) ? fileConfig.mcp : {};
const fileMcpServer = isRecord(fileMcp.server) ? fileMcp.server : {};

const defaultTimeoutMs = Number(process.env.PROVIDER_TIMEOUT_MS ?? 60000);
const defaultLocalTimeoutMs = Number(process.env.LOCAL_PROVIDER_TIMEOUT_MS ?? 300000);

export const config: AppConfig = {
  server: {
    enabled: toBoolean(process.env.HTTP_ENABLED, true),
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3000)
  },
  mcp: {
    server: {
      enabled: toBoolean(
        process.env.MCP_ENABLED,
        typeof fileMcpServer.enabled === "boolean" ? fileMcpServer.enabled : true
      ),
      transport: "stdio",
      defaultSessionId:
        process.env.MCP_DEFAULT_SESSION_ID ??
        (typeof fileMcpServer.defaultSessionId === "string"
          ? fileMcpServer.defaultSessionId
          : "mcp-default")
    }
  },
  plugins: {
    dir: resolveDir(process.env.PLUGINS_DIR ?? "./plugins", "./plugins"),
    overrides: {}
  },
  llm: {
    defaultProvider: process.env.DEFAULT_PROVIDER ?? "ollama"
  },
  providers: {
    ollama: {
      baseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
      model: process.env.OLLAMA_MODEL ?? "llama3.2",
      timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? defaultLocalTimeoutMs)
    },
    lmstudio: {
      baseUrl: process.env.LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1",
      model: process.env.LMSTUDIO_MODEL ?? "openai/gpt-oss-20b",
      timeoutMs: Number(process.env.LMSTUDIO_TIMEOUT_MS ?? defaultLocalTimeoutMs),
      apiKey: toOptional(process.env.LMSTUDIO_API_KEY) ?? "lm-studio"
    },
    openai: {
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
      timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS ?? defaultTimeoutMs),
      apiKey: toOptional(process.env.OPENAI_API_KEY)
    },
    anthropic: {
      baseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
      timeoutMs: Number(process.env.ANTHROPIC_TIMEOUT_MS ?? defaultTimeoutMs),
      apiKey: toOptional(process.env.ANTHROPIC_API_KEY),
      version: process.env.ANTHROPIC_VERSION ?? "2023-06-01",
      maxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS ?? 1024)
    },
    gemini: {
      baseUrl: process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com",
      model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
      timeoutMs: Number(process.env.GEMINI_TIMEOUT_MS ?? defaultTimeoutMs),
      apiKey: toOptional(process.env.GEMINI_API_KEY)
    }
  },
  memory: {
    adapter: (process.env.MEMORY_ADAPTER as MemoryAdapterName) ?? "local-json",
    baseDir: resolveDir(process.env.MEMORY_DIR ?? "./data/memory", "./data/memory"),
    topK: Number(process.env.MEMORY_TOP_K ?? 5),
    openMemory: {
      enabled: toBoolean(process.env.OPENMEMORY_ENABLED, false),
      dbPath: resolveDir(process.env.OPENMEMORY_DB_PATH ?? "./data/openmemory.db", "./data/openmemory.db")
    }
  },
  sessions: {
    baseDir: resolveDir(process.env.SESSION_DIR ?? "./data/sessions", "./data/sessions")
  },
  notion: {
    apiKey: toOptional(process.env.NOTION_API_KEY),
    parentPageId: toOptional(process.env.NOTION_PARENT_PAGE_ID),
    dataSourceId: toOptional(process.env.NOTION_DATA_SOURCE_ID),
    titleProperty: process.env.NOTION_TITLE_PROPERTY ?? "Name",
    version: process.env.NOTION_VERSION ?? "2026-03-11"
  },
  telegram: {
    enabled: toBoolean(process.env.TELEGRAM_ENABLED, false),
    botToken: toOptional(process.env.TELEGRAM_BOT_TOKEN),
    pollTimeoutSec: Number(process.env.TELEGRAM_POLL_TIMEOUT_SEC ?? 25)
  },
  filesystem: {
    accessMode:
      process.env.FILESYSTEM_ACCESS_MODE === "full" ? "full" : "restricted",
    allowedDirectories: [
      resolveDir(process.env.OUTPUT_DIR ?? "./data/output", "./data/output"),
      process.cwd()
    ]
  },
  outputDir: resolveDir(process.env.OUTPUT_DIR ?? "./data/output", "./data/output"),
  appDataDir: resolveDir(process.env.APP_DATA_DIR ?? "./data/app", "./data/app"),
  ui: {
    publicDir: resolveDir(process.env.UI_PUBLIC_DIR ?? "./public", "./public")
  }
};
