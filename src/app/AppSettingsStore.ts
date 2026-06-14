import fs from "fs/promises";
import path from "path";
import { AppConfig } from "../config/config";
import { AppSettings, AppSettingsPatch } from "../types";

export class AppSettingsStore {
  private readonly filePath: string;

  constructor(private readonly appDataDir: string, private readonly baseConfig: AppConfig) {
    this.filePath = path.join(appDataDir, "settings.json");
  }

  async get(): Promise<AppSettings> {
    await fs.mkdir(this.appDataDir, { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      return this.normalize(parsed);
    } catch {
      const defaults = this.fromConfig();
      await this.write(defaults);
      return defaults;
    }
  }

  async update(patch: AppSettingsPatch): Promise<AppSettings> {
    const current = await this.get();
    const next: AppSettings = {
      llm: {
        defaultProvider: patch.llm?.defaultProvider ?? current.llm.defaultProvider
      },
      mcp: {
        server: {
          enabled: patch.mcp?.server?.enabled ?? current.mcp.server.enabled,
          transport: "stdio",
          defaultSessionId:
            patch.mcp?.server?.defaultSessionId ?? current.mcp.server.defaultSessionId
        }
      },
      telegram: {
        enabled: patch.telegram?.enabled ?? current.telegram.enabled,
        botToken: patch.telegram?.botToken ?? current.telegram.botToken,
        pollTimeoutSec: patch.telegram?.pollTimeoutSec ?? current.telegram.pollTimeoutSec
      },
      memory: {
        adapter: patch.memory?.adapter ?? current.memory.adapter,
        baseDir: patch.memory?.baseDir ?? current.memory.baseDir,
        topK: patch.memory?.topK ?? current.memory.topK,
        openMemory: {
          enabled: patch.memory?.openMemory?.enabled ?? current.memory.openMemory.enabled,
          dbPath: patch.memory?.openMemory?.dbPath ?? current.memory.openMemory.dbPath
        }
      },
      providers: { ...current.providers },
      plugins: { ...current.plugins }
    };

    for (const [providerId, providerPatch] of Object.entries(patch.providers ?? {})) {
      next.providers[providerId] = {
        ...(next.providers[providerId] ?? this.defaultProvider(providerId)),
        ...providerPatch
      };
    }

    for (const [pluginName, pluginPatch] of Object.entries(patch.plugins ?? {})) {
      const previous = next.plugins[pluginName] ?? {
        enabled: true,
        values: {}
      };

      next.plugins[pluginName] = {
        enabled: pluginPatch.enabled ?? previous.enabled,
        values: {
          ...previous.values,
          ...(pluginPatch.values ?? {})
        }
      };
    }

    const normalized = this.normalize(next);
    await this.write(normalized);
    return normalized;
  }

  private async write(settings: AppSettings): Promise<void> {
    await fs.mkdir(this.appDataDir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(settings, null, 2), "utf8");
  }

  private fromConfig(): AppSettings {
    return {
      llm: {
        defaultProvider: this.baseConfig.llm.defaultProvider
      },
      mcp: {
        server: {
          enabled: this.baseConfig.mcp.server.enabled,
          transport: this.baseConfig.mcp.server.transport,
          defaultSessionId: this.baseConfig.mcp.server.defaultSessionId
        }
      },
      telegram: {
        enabled: this.baseConfig.telegram.enabled,
        botToken: this.baseConfig.telegram.botToken,
        pollTimeoutSec: this.baseConfig.telegram.pollTimeoutSec
      },
      memory: {
        adapter: this.baseConfig.memory.adapter,
        baseDir: this.baseConfig.memory.baseDir,
        topK: this.baseConfig.memory.topK,
        openMemory: {
          enabled: this.baseConfig.memory.openMemory.enabled,
          dbPath: this.baseConfig.memory.openMemory.dbPath
        }
      },
      providers: {
        ollama: {
          enabled: true,
          baseUrl: this.baseConfig.providers.ollama.baseUrl,
          model: this.baseConfig.providers.ollama.model,
          timeoutMs: this.baseConfig.providers.ollama.timeoutMs
        },
        lmstudio: {
          enabled: true,
          baseUrl: this.baseConfig.providers.lmstudio.baseUrl,
          apiKey: this.baseConfig.providers.lmstudio.apiKey,
          model: this.baseConfig.providers.lmstudio.model,
          timeoutMs: this.baseConfig.providers.lmstudio.timeoutMs
        },
        openai: {
          enabled: true,
          baseUrl: this.baseConfig.providers.openai.baseUrl,
          apiKey: this.baseConfig.providers.openai.apiKey,
          model: this.baseConfig.providers.openai.model,
          timeoutMs: this.baseConfig.providers.openai.timeoutMs
        },
        anthropic: {
          enabled: true,
          baseUrl: this.baseConfig.providers.anthropic.baseUrl,
          apiKey: this.baseConfig.providers.anthropic.apiKey,
          model: this.baseConfig.providers.anthropic.model,
          timeoutMs: this.baseConfig.providers.anthropic.timeoutMs,
          version: this.baseConfig.providers.anthropic.version,
          maxTokens: this.baseConfig.providers.anthropic.maxTokens
        },
        gemini: {
          enabled: true,
          baseUrl: this.baseConfig.providers.gemini.baseUrl,
          apiKey: this.baseConfig.providers.gemini.apiKey,
          model: this.baseConfig.providers.gemini.model,
          timeoutMs: this.baseConfig.providers.gemini.timeoutMs
        }
      },
      plugins: {
        file: {
          enabled: true,
          values: {
            outputDir: this.baseConfig.outputDir,
            accessMode: this.baseConfig.filesystem.accessMode,
            allowedDirectories: this.baseConfig.filesystem.allowedDirectories.join("\n")
          }
        },
        notion: {
          enabled: true,
          values: {
            apiKey: this.baseConfig.notion.apiKey,
            parentPageId: this.baseConfig.notion.parentPageId,
            dataSourceId: this.baseConfig.notion.dataSourceId,
            titleProperty: this.baseConfig.notion.titleProperty,
            version: this.baseConfig.notion.version
          }
        },
        vscode: {
          enabled: false,
          values: {
            workspaceRoot: process.cwd(),
            accessMode: this.baseConfig.filesystem.accessMode,
            allowedDirectories: this.baseConfig.filesystem.allowedDirectories.join("\n"),
            bridgeCommand: "",
            notes: "Reserved for future editor bridge."
          }
        }
      }
    };
  }

  private normalize(input: Partial<AppSettings>): AppSettings {
    const defaults = this.fromConfig();
    const settings: AppSettings = {
      llm: {
        defaultProvider: input.llm?.defaultProvider ?? defaults.llm.defaultProvider
      },
      mcp: {
        server: {
          enabled: input.mcp?.server?.enabled ?? defaults.mcp.server.enabled,
          transport: "stdio",
          defaultSessionId:
            input.mcp?.server?.defaultSessionId ?? defaults.mcp.server.defaultSessionId
        }
      },
      telegram: {
        enabled: input.telegram?.enabled ?? defaults.telegram.enabled,
        botToken: input.telegram?.botToken ?? defaults.telegram.botToken,
        pollTimeoutSec: input.telegram?.pollTimeoutSec ?? defaults.telegram.pollTimeoutSec
      },
      memory: {
        adapter: input.memory?.adapter ?? defaults.memory.adapter,
        baseDir: input.memory?.baseDir ?? defaults.memory.baseDir,
        topK: input.memory?.topK ?? defaults.memory.topK,
        openMemory: {
          enabled: input.memory?.openMemory?.enabled ?? defaults.memory.openMemory.enabled,
          dbPath: input.memory?.openMemory?.dbPath ?? defaults.memory.openMemory.dbPath
        }
      },
      providers: { ...defaults.providers },
      plugins: { ...defaults.plugins }
    };

    for (const [providerId, provider] of Object.entries(input.providers ?? {})) {
      settings.providers[providerId] = {
        ...(settings.providers[providerId] ?? this.defaultProvider(providerId)),
        ...provider
      };
    }

    for (const [pluginName, plugin] of Object.entries(input.plugins ?? {})) {
      const previous = settings.plugins[pluginName] ?? { enabled: true, values: {} };
      settings.plugins[pluginName] = {
        enabled: plugin.enabled ?? previous.enabled,
        values: {
          ...previous.values,
          ...(plugin.values ?? {})
        }
      };
    }

    return settings;
  }

  private defaultProvider(providerId: string) {
    const timeoutMs = ["lmstudio", "ollama"].includes(providerId) ? 300000 : 60000;

    return {
      enabled: true,
      baseUrl: "",
      model: "",
      timeoutMs,
      apiKey: providerId === "lmstudio" ? "lm-studio" : undefined
    };
  }
}
