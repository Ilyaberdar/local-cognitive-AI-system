import path from "path";
import { buildRuntime, AppRuntime } from "./buildRuntime";
import { AppConfig, localModelOptions } from "../config/config";
import { Logger } from "../utils/Logger";
import { AppSettings, AppSettingsPatch } from "../types";
import { AppSettingsStore } from "./AppSettingsStore";
import { extractNotionId } from "../utils/notion";
import { LocalModelService } from "../local/LocalModelService";
import { McpClientManager, McpClientManagerOptions } from "../mcp/client/McpClientManager";
import { emptyMcpConfiguration } from "../mcp/client/configuration";
import { validateSettingsPatch } from "./settingsValidation";

export class RuntimeManager {
  private runtime: AppRuntime | null = null;
  private operations: Promise<unknown> = Promise.resolve();
  private localModelService?: LocalModelService;
  private readonly mcpClients: McpClientManager;
  private disposed = false;
  private disposing?: Promise<void>;

  constructor(
    private readonly baseConfig: AppConfig,
    private readonly settingsStore: AppSettingsStore,
    private readonly logger: Logger,
    mcpOptions: McpClientManagerOptions = {}
  ) { this.mcpClients = new McpClientManager(mcpOptions); }

  async init(): Promise<AppRuntime> {
    try { return await this.reload(); }
    catch (error) { await this.dispose(); throw error; }
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
    validateSettingsPatch(patch);
    return this.enqueue(async () => {
      if (patch && Object.keys(patch).every(key => key === "ui")) {
        return { runtime: this.getRuntime(), settings: await this.settingsStore.update(patch) };
      }
      try {
        const { value: runtime, settings } = await this.settingsStore.transaction(patch, settings => this.build(settings));
        return { runtime, settings };
      } catch (error) {
        // The transaction never publishes failed settings. Read the latest committed
        // state for rollback, so a concurrent store update is not overwritten.
        if (!this.disposed) {
          try { await this.build(await this.settingsStore.get()); }
          catch { this.logger.error("Runtime settings rollback failed"); }
        }
        throw error;
      }
    });
  }

  async reload(settingsOverride?: AppSettings): Promise<AppRuntime> {
    return this.enqueue(async () => this.build(settingsOverride ?? await this.settingsStore.get()));
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.operations.then(() => {
      if (this.disposed) throw new Error("Runtime has been disposed");
      return action();
    });
    this.operations = operation.catch(() => {});
    return operation;
  }

  private async build(settings: AppSettings): Promise<AppRuntime> {
    if (this.disposed) throw new Error("Runtime has been disposed");
    const mergedConfig = this.applySettings(settings);
    if (!this.localModelService) {
      const service = new LocalModelService(localModelOptions(mergedConfig), this.logger);
      try { await service.init(); } catch (error) { await service.dispose(); throw error; }
      if (this.disposed) { await service.dispose(); throw new Error("Runtime has been disposed"); }
      this.localModelService = service;
    } else await this.localModelService.reconfigure(localModelOptions(mergedConfig));
    if (this.disposed) throw new Error("Runtime has been disposed");
    const runtime = await buildRuntime(mergedConfig, this.logger, this.localModelService, this.mcpClients);
    if (this.disposed) throw new Error("Runtime has been disposed");
    await this.mcpClients.reconcile(settings.mcp.client ?? emptyMcpConfiguration());
    if (this.disposed) throw new Error("Runtime has been disposed");
    this.runtime = runtime;
    return runtime;
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    // Abort active inference before awaiting a settings operation queued behind it.
    const disposing = Promise.all([this.localModelService?.dispose(), this.mcpClients.dispose()]);
    this.disposing = (async () => { await this.operations; await disposing; })();
    return this.disposing;
  }

  private applySettings(settings: AppSettings): AppConfig {
    const { dataDir: _dataDir, enabled: _enabled, ...baseLocalModels } = localModelOptions(this.baseConfig);
    const local = settings.localModels;
    return {
      ...this.baseConfig,
      // Saved forward-compatible fields must not override backend-only executable/ownership settings.
      localModels: { ...baseLocalModels, ...(local ? {
        modelsDir: local.modelsDir, contextSize: local.contextSize, gpuLayers: local.gpuLayers,
        loadTimeoutMs: local.loadTimeoutMs, generationTimeoutMs: local.generationTimeoutMs,
        memoryLimitPercent: local.memoryLimitPercent
      } : {}) },
      llm: {
        defaultProvider: settings.llm.defaultProvider
      },
      mcp: {
        client: settings.mcp.client ?? emptyMcpConfiguration(),
        server: {
          ...this.baseConfig.mcp.server,
          enabled: settings.mcp.server.enabled,
          transport: settings.mcp.server.transport,
          defaultSessionId: settings.mcp.server.defaultSessionId
        }
      },
      telegram: {
        ...this.baseConfig.telegram,
        enabled: settings.telegram.enabled,
        botToken: settings.telegram.botToken ?? this.baseConfig.telegram.botToken,
        ownerUserIds: settings.telegram.ownerUserIds,
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
        worldPartition: {
          ...this.baseConfig.memory.worldPartition,
          ...settings.memory.worldPartition
        },
        openMemory: {
          ...this.baseConfig.memory.openMemory,
          enabled: settings.memory.openMemory.enabled,
          dbPath: settings.memory.openMemory.dbPath
        }
      },
      providers: {
        llamacpp: {
          baseUrl: "",
          model: settings.providers.llamacpp?.model ?? "",
          timeoutMs: settings.localModels?.generationTimeoutMs ?? 600000,
          enabled: settings.providers.llamacpp?.enabled !== false
        },
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
        apiKey: typeof settings.plugins.notion?.values.apiKey === "string"
          ? settings.plugins.notion.values.apiKey.trim() : this.baseConfig.notion.apiKey,
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
