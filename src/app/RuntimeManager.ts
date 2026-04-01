import path from "path";
import { buildRuntime, AppRuntime } from "./buildRuntime";
import { AppConfig } from "../config/config";
import { Logger } from "../utils/Logger";
import { AppSettings, AppSettingsPatch } from "../types";
import { AppSettingsStore } from "./AppSettingsStore";
import { extractNotionId } from "../utils/notion";

export class RuntimeManager {
  private runtime: AppRuntime | null = null;
  private reloadPromise: Promise<AppRuntime> | null = null;

  constructor(
    private readonly baseConfig: AppConfig,
    private readonly settingsStore: AppSettingsStore,
    private readonly logger: Logger
  ) {}

  async init(): Promise<AppRuntime> {
    return this.reload();
  }

  getRuntime(): AppRuntime {
    if (!this.runtime) {
      throw new Error("Runtime has not been initialized");
    }

    return this.runtime;
  }

  async getSettings(): Promise<AppSettings> {
    return this.settingsStore.get();
  }

  async updateSettings(patch: AppSettingsPatch): Promise<{ runtime: AppRuntime; settings: AppSettings }> {
    const settings = await this.settingsStore.update(patch);
    const runtime = await this.reload(settings);
    return { runtime, settings };
  }

  async reload(settingsOverride?: AppSettings): Promise<AppRuntime> {
    if (this.reloadPromise) {
      return this.reloadPromise;
    }

    this.reloadPromise = (async () => {
      const settings = settingsOverride ?? (await this.settingsStore.get());
      const mergedConfig = this.applySettings(settings);
      const runtime = await buildRuntime(mergedConfig, this.logger);
      this.runtime = runtime;
      this.logger.info("Runtime reloaded", {
        defaultProvider: mergedConfig.llm.defaultProvider
      });
      return runtime;
    })();

    try {
      return await this.reloadPromise;
    } finally {
      this.reloadPromise = null;
    }
  }

  private applySettings(settings: AppSettings): AppConfig {
    return {
      ...this.baseConfig,
      llm: {
        defaultProvider: settings.llm.defaultProvider
      },
      telegram: {
        ...this.baseConfig.telegram,
        enabled: settings.telegram.enabled,
        botToken: settings.telegram.botToken ?? this.baseConfig.telegram.botToken,
        pollTimeoutSec: settings.telegram.pollTimeoutSec
      },
      filesystem: {
        accessMode:
          this.asString(settings.plugins.file?.values.accessMode) === "full" ? "full" : "restricted",
        allowedDirectories:
          this.parseDirectories(settings.plugins.file?.values.allowedDirectories) ??
          this.baseConfig.filesystem.allowedDirectories
      },
      memory: {
        ...this.baseConfig.memory,
        adapter: settings.memory.adapter,
        baseDir: settings.memory.baseDir,
        topK: settings.memory.topK,
        openMemory: {
          ...this.baseConfig.memory.openMemory,
          enabled: settings.memory.openMemory.enabled,
          dbPath: settings.memory.openMemory.dbPath
        }
      },
      providers: {
        ollama: {
          ...this.baseConfig.providers.ollama,
          ...settings.providers.ollama
        },
        lmstudio: {
          ...this.baseConfig.providers.lmstudio,
          ...settings.providers.lmstudio,
          apiKey:
            settings.providers.lmstudio?.apiKey ?? this.baseConfig.providers.lmstudio.apiKey
        },
        openai: {
          ...this.baseConfig.providers.openai,
          ...settings.providers.openai,
          apiKey: settings.providers.openai?.apiKey ?? this.baseConfig.providers.openai.apiKey
        },
        anthropic: {
          ...this.baseConfig.providers.anthropic,
          ...settings.providers.anthropic,
          apiKey:
            settings.providers.anthropic?.apiKey ?? this.baseConfig.providers.anthropic.apiKey,
          version:
            settings.providers.anthropic?.version ?? this.baseConfig.providers.anthropic.version,
          maxTokens:
            settings.providers.anthropic?.maxTokens ??
            this.baseConfig.providers.anthropic.maxTokens
        },
        gemini: {
          ...this.baseConfig.providers.gemini,
          ...settings.providers.gemini,
          apiKey: settings.providers.gemini?.apiKey ?? this.baseConfig.providers.gemini.apiKey
        }
      },
      notion: {
        ...this.baseConfig.notion,
        apiKey: this.asString(settings.plugins.notion?.values.apiKey) ?? this.baseConfig.notion.apiKey,
        parentPageId:
          extractNotionId(this.asString(settings.plugins.notion?.values.parentPageUrl)) ??
          this.asString(settings.plugins.notion?.values.parentPageId) ??
          this.baseConfig.notion.parentPageId,
        dataSourceId:
          extractNotionId(this.asString(settings.plugins.notion?.values.dataSourceUrl)) ??
          this.asString(settings.plugins.notion?.values.dataSourceId) ??
          this.baseConfig.notion.dataSourceId,
        titleProperty:
          this.asString(settings.plugins.notion?.values.titleProperty) ??
          this.baseConfig.notion.titleProperty,
        version:
          this.asString(settings.plugins.notion?.values.version) ?? this.baseConfig.notion.version
      },
      outputDir:
        this.asAbsolutePath(settings.plugins.file?.values.outputDir) ?? this.baseConfig.outputDir,
      plugins: {
        ...this.baseConfig.plugins,
        overrides: {
          file: {
            enabled: settings.plugins.file?.enabled ?? true
          },
          notion: {
            enabled: settings.plugins.notion?.enabled ?? true
          }
        }
      }
    };
  }

  private asString(value: string | number | boolean | undefined): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private asAbsolutePath(value: string | number | boolean | undefined): string | undefined {
    const normalized = this.asString(value);
    return normalized ? path.resolve(process.cwd(), normalized) : undefined;
  }

  private parseDirectories(
    value: string | number | boolean | undefined
  ): string[] | undefined {
    const normalized = this.asString(value);

    if (!normalized) {
      return undefined;
    }

    const directories = normalized
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => path.resolve(process.cwd(), item));

    return directories.length ? Array.from(new Set(directories)) : undefined;
  }
}
