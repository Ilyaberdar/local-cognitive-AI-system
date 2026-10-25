import { MCP_CREDENTIAL_PREFIX, VaultMcpCredentialProvider } from "../mcp/client/credentials";
import type { UsageRecorder } from "../usage/UsageCall";
import path from "path";
import { SynthesisService } from "../synthesis/SynthesisService";
import { buildRuntime, AppRuntime } from "./buildRuntime";
import { AppConfig, localModelOptions } from "../config/config";
import { Logger } from "../utils/Logger";
import { AppSettings, AppSettingsPatch, StoredProviderSettings } from "../types";
import { AppSettingsStore } from "./AppSettingsStore";
import { LMSTUDIO_PLACEHOLDER, ResolvedKeys } from "./ProviderKeyStore";
import { localSettingsView } from "../runtime/settingsDto";
import { BUILT_IN_PROVIDER_IDS } from "../llm/providerCatalog";
import { PluginManager } from "../plugins/PluginManager";
import { DirectIntegrationAdapter } from "../plugins/DirectIntegrationAdapter";
import { OAuthClientRegistrations } from "../plugins/OAuthConnections";
import { CredentialVault, unavailableVault } from "../plugins/contracts";
import { LocalModelService } from "../local/LocalModelService";
import { McpClientManager, McpClientManagerOptions } from "../mcp/client/McpClientManager";
import { emptyMcpConfiguration } from "../mcp/client/configuration";
import { validateSettingsPatch } from "./settingsValidation";

export interface IntegrationRuntimeOptions { vault?: CredentialVault; openExternal?: (url: string) => Promise<void>; oauthClients?: OAuthClientRegistrations;
  /** Records every model call of this runtime (the usage ledger in host.db). */
  usage?: UsageRecorder; }

export class RuntimeManager {
  private runtime: AppRuntime | null = null;
  private operations: Promise<unknown> = Promise.resolve();
  private localModelService?: LocalModelService;
  private synthesis?: SynthesisService;
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
  ) {
    this.mcpSecrets = new VaultMcpCredentialProvider(integrations.vault ?? unavailableVault);
    this.mcpClients = new McpClientManager({ ...mcpOptions, credentialProvider: { resolve: async context =>
      context.binding.credentialRef?.startsWith("plugin:") ? this.direct?.resolve(context)
        : context.binding.credentialRef?.startsWith(MCP_CREDENTIAL_PREFIX) ? this.mcpSecrets.resolve(context)
        : mcpOptions.credentialProvider?.resolve(context) } });
  }
  /** Secrets of external MCP servers (env, headers, bearer tokens), in the vault. */
  readonly mcpSecrets: VaultMcpCredentialProvider;

  /** Where the app keeps its data (settings, provider checks). */
  dataDir(): string { return this.baseConfig.appDataDir; }

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

  /** Each provider's key and the bot token, with its state, for these settings (or the saved ones). */
  async providerKeys(settings?: AppSettings): Promise<ResolvedKeys> {
    return this.settingsStore.resolveKeys(settings ?? await this.settingsStore.get());
  }

  /** The settings as this computer's API returns them: no key, bot token or vault record. */
  async settingsView(settings?: AppSettings) {
    const current = settings ?? await this.settingsStore.get();
    return localSettingsView(current, await this.providerKeys(current));
  }

  async updateSettings(patch: AppSettingsPatch): Promise<{ runtime: AppRuntime; settings: AppSettings }> {
    validateSettingsPatch(patch);
    return this.enqueue(async () => {
      if (patch && Object.keys(patch).every(key => key === "ui" || key === "profile")) {
        return { runtime: this.getRuntime(), settings: await this.settingsStore.update(patch) };
      }
      // Sampler settings are sent with each request. Persist them and update the
      // service in place rather than rebuilding the runtime/unloading a model.
      const localKeys = patch.localModels ? Object.keys(patch.localModels) : [];
      // Generation and multi-GPU settings apply to the next request or load: nothing is unloaded.
      const generationOnly = Boolean(patch.localModels) && localKeys.every(key => key === "generation" || key === "multiGpu") &&
        Object.keys(patch).every(key => key === "ui" || key === "profile" || key === "localModels");
      if (generationOnly && this.localModelService) {
        const settings = await this.settingsStore.update(patch);
        if (localKeys.includes("generation")) await this.localModelService.setGenerationSettings(settings.localModels!.generation);
        if (localKeys.includes("multiGpu")) await this.localModelService.setPlacementSettings(settings.localModels!.multiGpu);
        return { runtime: this.getRuntime(), settings };
      }
      try {
        const before = patch.mcp ? (await this.settingsStore.get()).mcp?.client : undefined;
        const { value: runtime, settings } = await this.settingsStore.transaction(patch, settings => this.build(settings));
        // Secrets a server no longer names (it was removed, or a name taken off) leave the vault.
        if (before) await this.mcpSecrets.prune(before, settings.mcp?.client ?? emptyMcpConfiguration()).catch(() => this.logger.warn("Removed MCP secrets could not all be deleted."));
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
    // Each key is read on its own: one that cannot be read leaves only that provider without a key.
    const keys = await this.settingsStore.resolveKeys(settings);
    for (const [id, key] of Object.entries(keys.providers)) if (key.state === "unreadable") this.logger.warn("A provider's saved key cannot be read on this computer: enter it again in Settings.", { provider: id });
    const mergedConfig = this.applySettings(settings, keys);
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
    // Synthesis is made once and reaches the current runtime's services: saving settings (which
    // rebuilds the runtime) must not interrupt its runs.
    if (!this.synthesis) {
      const current = () => this.runtime ?? (() => { throw new Error("Runtime is not ready"); })();
      const synthesis = new SynthesisService(mergedConfig.appDataDir, {
        get projects() { return current().projectStore; },
        models: { listAllModels: (...args) => current().localModelManager.listAllModels(...args) },
        llm: { generateObject: (...args) => current().llmService.generateObject(...args), generateText: (...args) => current().llmService.generateText(...args) },
        loadModel: (model, signal, shape, queue) => current().localModelService.loadModel(model.id, signal, shape, queue),
        contextWindow: model => current().localModelService.getContextWindow(model.id),
        catalog: { listAll: (...args) => current().modelCatalog.listAll(...args) },
        providers: () => current().providerDescriptors,
        agents: { get llm() { return current().llmService; } }
      });
      await synthesis.init();
      this.synthesis = synthesis;
    }
    const runtime = await buildRuntime(mergedConfig, this.logger, this.localModelService, this.mcpClients, this.plugins, this.synthesis, this.integrations.usage);
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
    const disposing = Promise.all([this.synthesis?.dispose(), this.localModelService?.dispose(),
      (async () => { await this.plugins?.dispose(); await this.mcpClients.dispose(); })()]);
    this.disposing = (async () => { await this.operations; await disposing; })();
    return this.disposing;
  }

  private applySettings(settings: AppSettings, keys: ResolvedKeys): AppConfig {
    const { dataDir: _dataDir, enabled: _enabled, ...baseLocalModels } = localModelOptions(this.baseConfig);
    const local = settings.localModels;
    // A provider's settings without its key's record (or a key kept from before): its key is `keys`'.
    const fields = (provider: StoredProviderSettings | undefined) => {
      const { apiKey: _apiKey, apiKeyRef: _apiKeyRef, ...rest } = provider ?? ({} as StoredProviderSettings);
      return rest;
    };
    const key = (id: string) => keys.providers[id]?.key;
    return {
      ...this.baseConfig,
      // Saved forward-compatible fields must not override backend-only executable/ownership settings.
      localModels: { ...baseLocalModels, ...(local ? {
        modelsDir: local.modelsDir, contextSize: local.contextSize, gpuLayers: local.gpuLayers,
        loadTimeoutMs: local.loadTimeoutMs, generationTimeoutMs: local.generationTimeoutMs,
        memoryLimitPercent: local.memoryLimitPercent, generation: local.generation, ...(local.multiGpu ? { multiGpu: local.multiGpu } : {})
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
        botToken: keys.telegram.key,
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
          ...fields(settings.providers.ollama)
        },
        // LM Studio takes any key: without one it is sent its stand-in.
        lmstudio: {
          ...this.baseConfig.providers.lmstudio,
          ...fields(settings.providers.lmstudio),
          apiKey: key("lmstudio") ?? LMSTUDIO_PLACEHOLDER
        },
        openai: {
          ...this.baseConfig.providers.openai,
          ...fields(settings.providers.openai),
          apiKey: key("openai")
        },
        anthropic: {
          ...this.baseConfig.providers.anthropic,
          ...fields(settings.providers.anthropic),
          apiKey: key("anthropic"),
          version:
            settings.providers.anthropic?.version ?? this.baseConfig.providers.anthropic.version,
          maxTokens:
            settings.providers.anthropic?.maxTokens ??
            this.baseConfig.providers.anthropic.maxTokens
        },
        gemini: {
          ...this.baseConfig.providers.gemini,
          ...fields(settings.providers.gemini),
          apiKey: key("gemini")
        }
      },
      // Every OpenAI-compatible service in the settings; a key from the environment is used while none is saved.
      compatibleProviders: Object.fromEntries(Object.entries(settings.providers)
        .filter(([id, provider]) => provider.kind === "openai-compatible" && !BUILT_IN_PROVIDER_IDS.includes(id))
        .map(([id, provider]) => {
          const base = this.baseConfig.compatibleProviders?.[id];
          // One the environment sets takes its address and key from there (a key changed there counts).
          const fromEnvironment = base?.source === "environment";
          return [id, {
            enabled: provider.enabled,
            baseUrl: (fromEnvironment ? base?.baseUrl : provider.baseUrl || base?.baseUrl) || "",
            model: provider.model || base?.model || "",
            timeoutMs: provider.timeoutMs ?? base?.timeoutMs ?? 300000,
            apiKey: key(id),
            name: provider.name || base?.name || id,
            dialect: provider.dialect || base?.dialect || "chat",
            ...(provider.preset ? { preset: provider.preset } : {}),
            ...(provider.nativeTools === "chat" ? { nativeTools: "chat" as const } : {})
          }];
        })),
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
