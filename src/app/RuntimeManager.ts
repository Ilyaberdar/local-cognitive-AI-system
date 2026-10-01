import path from "path";
import { buildRuntime, AppRuntime } from "./buildRuntime";
import { AppConfig, localModelOptions } from "../config/config";
import { Logger } from "../utils/Logger";
import { AppSettings, AppSettingsPatch } from "../types";
import { AppSettingsStore } from "./AppSettingsStore";
import { PluginManager } from "../plugins/PluginManager";
import { DirectIntegrationAdapter } from "../plugins/DirectIntegrationAdapter";
import { OAuthClientRegistrations } from "../plugins/OAuthConnections";
import { CredentialVault, unavailableVault } from "../plugins/contracts";
import { LocalModelService } from "../local/LocalModelService";
import { McpClientManager, McpClientManagerOptions } from "../mcp/client/McpClientManager";
import { emptyMcpConfiguration } from "../mcp/client/configuration";
import { validateSettingsPatch } from "./settingsValidation";

export interface IntegrationRuntimeOptions { vault?: CredentialVault; openExternal?: (url: string) => Promise<void>; oauthClients?: OAuthClientRegistrations; }

export class RuntimeManager {
  private runtime: AppRuntime | null = null;
  private operations: Promise<unknown> = Promise.resolve();
  private localModelService?: LocalModelService;
  private readonly mcpClients: McpClientManager;
  private disposed = false;
  private disposing?: Promise<void>;
  private plugins?: PluginManager;
  private direct?: DirectIntegrationAdapter;
  private integrationOwner?: string;

  constructor(
    private readonly baseConfig: AppConfig,
    private readonly settingsStore: AppSettingsStore,
    private readonly logger: Logger,
    mcpOptions: McpClientManagerOptions = {},
    readonly integrations: IntegrationRuntimeOptions = {}
  ) { this.mcpClients = new McpClientManager({ ...mcpOptions, credentialProvider: { resolve: async context =>
    context.binding.credentialRef?.startsWith("plugin:") ? this.direct?.resolve(context) : mcpOptions.credentialProvider?.resolve(context) } }); }

  getPluginManager() { if (!this.plugins) throw new Error("Plugins are not initialized."); return this.plugins; }
  getConnectionService() { if (!this.direct) throw new Error("Connections are not initialized."); return this.direct.oauth; }

  /** Called only by a future authenticated account service, never by a renderer-supplied owner ID. */
  async switchIntegrationOwner(ownerId: string) {
    if (!/^(local|account):[^\s]{1,200}$/.test(ownerId)) throw new Error("Invalid account identity.");
    return this.enqueue(async () => {
      await this.plugins?.dispose(); this.plugins = undefined; this.direct = undefined;
      this.integrationOwner = ownerId;
      return this.build(await this.settingsStore.get());
    });
  }

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
    await this.runtime?.synthesis.dispose();
    const mergedConfig = this.applySettings(settings);
    if (!this.plugins) {
      const ownerId = this.integrationOwner ?? `local:${settings.memory.localProfileId}`;
      this.direct = new DirectIntegrationAdapter(this.integrations.vault ?? unavailableVault, ownerId, this.mcpClients, this.integrations.oauthClients);
      this.plugins = new PluginManager(mergedConfig.appDataDir, ownerId, [this.direct]);
      void this.plugins.restore().catch(() => this.logger.warn("Plugin accounts could not be restored. Open Connections to reconnect."));
    }
    if (!this.localModelService) {
      const service = new LocalModelService(localModelOptions(mergedConfig), this.logger);
      try { await service.init(); } catch (error) { await service.dispose(); throw error; }
      if (this.disposed) { await service.dispose(); throw new Error("Runtime has been disposed"); }
      this.localModelService = service;
    } else await this.localModelService.reconfigure(localModelOptions(mergedConfig));
    if (this.disposed) throw new Error("Runtime has been disposed");
    const runtime = await buildRuntime(mergedConfig, this.logger, this.localModelService, this.mcpClients, this.plugins);
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
    const disposing = Promise.all([this.runtime?.synthesis.dispose(), this.localModelService?.dispose(),
      (async () => { await this.plugins?.dispose(); await this.mcpClients.dispose(); })()]);
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
      agentLimits: settings.agentLimits,
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
        accessMode: settings.filesystem?.accessMode ?? this.baseConfig.filesystem.accessMode,
        allowedDirectories: settings.filesystem?.allowedDirectories ?? this.baseConfig.filesystem.allowedDirectories
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
      outputDir: settings.filesystem?.outputDir ?? this.baseConfig.outputDir
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
