import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { AppConfig, localModelOptions } from "../config/config";
import { AppSettings, AppSettingsPatch } from "../types";
import { isMissingFile, restrictToOwner, withFileLock, writeJsonAtomically } from "../utils/fileStore";
import { constants } from "node:fs";
import { applyMcpConfigurationPatch, parseMcpConfiguration } from "../mcp/client/configuration";
import { validateSettingsPatch, defaultUiPreferences, readShortcuts, SettingsValidationError } from "./settingsValidation";
import { normalizeAgentLimits } from "../agents/runtime/AgentLimits";
import { defaultLocalGenerationSettings, normalizeLocalGenerationSettings } from "../local/GenerationSettings";
import { CredentialVault, unavailableVault } from "../plugins/contracts";
import type { Logger } from "../utils/Logger";
import { KeyChanges, ProviderKeyStore, ResolvedKeys } from "./ProviderKeyStore";

/** Archives of earlier migrations, kept for recovery: their keys are removed once keys are in the vault. */
const ARCHIVES = ["settings.pre-integrations.json", "settings.pre-llamacpp.json"];
/** What writeJsonAtomically leaves of settings.json or an archive when the process ends mid-write. */
const LEFTOVER = /^settings(?:\.pre-[a-z]+)?\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

export class AppSettingsStore {
  private readonly filePath: string;
  private readonly defaultMemoryProfileId = randomUUID();
  private readonly keys: ProviderKeyStore;
  private readonly logger?: Logger;
  // Once per start: leftovers of interrupted writes go, and (when the vault can be used) keys left in
  // settings.json move to it and leave the archives.
  private started = false;

  /** The vault keeps provider keys and the Telegram bot token: without a usable one (the default),
   * keys cannot be saved, and keys already in settings.json stay there and keep working. */
  constructor(private readonly appDataDir: string, private readonly baseConfig: AppConfig, options: { vault?: CredentialVault; logger?: Logger } = {}) {
    this.filePath = path.join(appDataDir, "settings.json");
    this.keys = new ProviderKeyStore(options.vault ?? unavailableVault, baseConfig);
    this.logger = options.logger;
  }

  async get(): Promise<AppSettings> {
    return withFileLock(this.filePath, () => this.read());
  }

  /** Each provider's key and the bot token for these settings, from the vault or the environment, with
   * its state. Never throws; it holds no lock, so a transaction's build may call it. */
  resolveKeys(settings: AppSettings): Promise<ResolvedKeys> {
    return this.keys.resolve(settings);
  }

  /** Caller holds the shared file lock, including initialization and migration writes. */
  private async read(): Promise<AppSettings> {
    await fs.mkdir(this.appDataDir, { recursive: true });
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      const defaults = this.fromConfig();
      await this.write(defaults);
      return defaults;
    }
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid application settings.");
    await restrictToOwner(this.filePath);
    const settings = this.normalize(parsed);
    const migratePlugins = ["file", "notion", "vscode"].some(id => Object.hasOwn(parsed.plugins ?? {}, id));
    if (migratePlugins) {
      const archive = path.join(this.appDataDir, "settings.pre-integrations.json");
      // Recoverable local archive; legacy secrets never enter normal settings or new OAuth records.
      await fs.writeFile(archive, raw, { mode: 0o600, flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    }
    const requiresMigration = parsed.schemaVersion === undefined || parsed.schemaVersion < 4;
    // Schema 5: GPU layers became "auto". The old platform default (99 on macOS, else 0) was
    // persisted like a choice; it becomes auto, while other explicit values are kept.
    const migrateGpuLayers = (parsed.schemaVersion ?? 0) < 5;
    if (migrateGpuLayers) {
      if (settings.localModels && parsed.localModels?.gpuLayers === (process.platform === "darwin" ? 99 : 0)) settings.localModels.gpuLayers = "auto";
      settings.schemaVersion = 5;
    }
    const migrateLegacyAnthropicOutput = parsed.providers?.anthropic?.maxTokens === 1024 && this.baseConfig.providers.anthropic.maxTokens > 1024;
    if (migrateLegacyAnthropicOutput) settings.providers.anthropic.maxTokens = this.baseConfig.providers.anthropic.maxTokens;
    if (requiresMigration) {
      const archive = path.join(this.appDataDir, "settings.pre-llamacpp.json");
      await fs.copyFile(this.filePath, archive, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      await restrictToOwner(archive);
    }
    // Schema 6: keys move from settings.json into the credential vault, and then out of the archives
    // (checked at every start, so an interrupted or refused rewrite is done later). Without a usable
    // vault nothing changes here: the keys keep working, and this runs at the next start.
    let moved: { changes: KeyChanges; changed: boolean; complete: boolean } | undefined;
    if (!this.started) {
      this.started = true;
      await this.removeLeftovers();
      if (this.keys.available()) {
        moved = await this.keys.moveToVault(settings);
        if (moved.complete && settings.schemaVersion! < 6) settings.schemaVersion = 6;
      }
    }
    if (!parsed.memory?.localProfileId || !parsed.profile || requiresMigration || parsed.mcp?.client === undefined || parsed.agentLimits === undefined || migrateLegacyAnthropicOutput || migratePlugins || !parsed.filesystem || migrateGpuLayers
      || moved?.changed || settings.schemaVersion !== parsed.schemaVersion) {
      try { await this.write(settings); }
      catch (error) { if (moved) await this.keys.remove(moved.changes.written); throw error; }
    }
    if (moved) {
      await this.keys.remove(moved.changes.obsolete);
      await this.scrubArchives();
    }
    return settings;
  }

  /** Temporary files of writes the process did not finish (a crash, a power loss): they may hold keys. */
  private async removeLeftovers(): Promise<void> {
    let names: string[];
    try { names = await fs.readdir(this.appDataDir); } catch { return; }
    for (const name of names.filter(item => LEFTOVER.test(item))) await fs.unlink(path.join(this.appDataDir, name)).catch(() => undefined);
  }

  /** Removes provider keys and the bot token from the archives that still hold any (rewritten
   * atomically, owner-only). An archive that cannot be parsed is left as it is, and the log says so.
   * Their legacy Notion keys stay: they never moved to the vault. */
  private async scrubArchives(): Promise<void> {
    for (const name of ARCHIVES) {
      const file = path.join(this.appDataDir, name);
      try {
        let archive: Partial<AppSettings> | null;
        try { archive = JSON.parse(await fs.readFile(file, "utf8")) as Partial<AppSettings> | null; }
        catch (error) {
          if (isMissingFile(error)) continue;
          this.logger?.warn(`${name} could not be read: any provider keys in it were left there.`);
          continue;
        }
        if (!archive || typeof archive !== "object") { this.logger?.warn(`${name} is not a settings file: any provider keys in it were left there.`); continue; }
        let scrubbed = false;
        for (const provider of Object.values(archive.providers ?? {})) {
          if (provider && typeof provider === "object" && Object.hasOwn(provider, "apiKey")) { delete provider.apiKey; scrubbed = true; }
        }
        if (archive.telegram && typeof archive.telegram === "object" && Object.hasOwn(archive.telegram, "botToken")) { delete archive.telegram.botToken; scrubbed = true; }
        if (scrubbed) await writeJsonAtomically(file, archive, { mode: 0o600 });
      } catch (error) {
        this.logger?.warn(`The provider keys in ${name} could not be removed.`, { message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  async update(patch: AppSettingsPatch): Promise<AppSettings> {
    return withFileLock(this.filePath, () => this.commit(patch));
  }

  async restore(settings: AppSettings): Promise<void> {
    await withFileLock(this.filePath, () => this.write(this.normalize(settings)));
  }

  /** The patched settings, not saved: a key in the patch is left out. */
  async preview(patch: AppSettingsPatch): Promise<AppSettings> {
    return withFileLock(this.filePath, async () => this.patch(await this.read(), patch));
  }

  /** Build/reconfigure against a snapshot, then atomically commit without losing another store's update. */
  async transaction<T>(
    patch: AppSettingsPatch,
    apply: (settings: AppSettings, previous: AppSettings) => Promise<T>
  ): Promise<{ value: T; settings: AppSettings }> {
    return withFileLock(this.filePath, async () => {
      let value!: T;
      const settings = await this.commit(patch, async (next, previous) => { value = await apply(next, previous); });
      return { value, settings };
    });
  }

  /** Caller holds the lock. A key in the patch is saved in the vault first, the settings naming it are
   * committed next, and the record it replaces is removed last; a failure before the commit removes
   * the new record, so the vault keeps no key the settings do not name. */
  private async commit(patch: AppSettingsPatch, apply?: (settings: AppSettings, previous: AppSettings) => Promise<void>): Promise<AppSettings> {
    const previous = await this.read();
    const settings = this.patch(previous, patch);
    const keys = await this.keys.patch(previous, settings, patch);
    try {
      await apply?.(settings, previous);
      await this.write(settings);
    } catch (error) {
      await this.keys.remove(keys.written);
      throw error;
    }
    await this.keys.remove(keys.obsolete);
    return settings;
  }

  private patch(current: AppSettings, patch: AppSettingsPatch): AppSettings {
    validateSettingsPatch(patch);
    const next: AppSettings = {
      ...current,
      filesystem: { ...this.fromConfig().filesystem!, ...current.filesystem, ...patch.filesystem },
      ui: { ...defaultUiPreferences, ...current.ui, ...patch.ui, version: 1 },
      profile: { ...this.defaultProfile(), ...current.profile, ...patch.profile },
      localModels: {
        ...this.localDefaults(),
        ...current.localModels,
        ...patch.localModels,
        generation: {
          ...(current.localModels?.generation ?? this.localDefaults().generation),
          ...(patch.localModels?.generation ?? {})
        }
      },
      agentLimits: { ...current.agentLimits, ...patch.agentLimits },
      llm: {
        ...current.llm,
        defaultProvider: patch.llm?.defaultProvider ?? current.llm.defaultProvider
      },
      mcp: {
        ...current.mcp,
        client: patch.mcp?.client === undefined ? current.mcp.client
          : applyMcpConfigurationPatch(parseMcpConfiguration(current.mcp.client), patch.mcp.client),
        server: {
          ...current.mcp.server,
          enabled: patch.mcp?.server?.enabled ?? current.mcp.server.enabled,
          transport: "stdio",
          defaultSessionId:
            patch.mcp?.server?.defaultSessionId ?? current.mcp.server.defaultSessionId
        }
      },
      // The bot token is the key store's (commit).
      telegram: {
        ...current.telegram,
        enabled: patch.telegram?.enabled ?? current.telegram.enabled,
        ownerUserIds: patch.telegram?.ownerUserIds ?? current.telegram.ownerUserIds,
        pollTimeoutSec: patch.telegram?.pollTimeoutSec ?? current.telegram.pollTimeoutSec
      },
      memory: {
        ...current.memory,
        adapter: patch.memory?.adapter ?? current.memory.adapter,
        baseDir: patch.memory?.baseDir ?? current.memory.baseDir,
        topK: patch.memory?.topK ?? current.memory.topK,
        localProfileId: current.memory.localProfileId,
        worldPartition: {
          ...current.memory.worldPartition,
          crossSessionRecall:
            patch.memory?.worldPartition?.crossSessionRecall ?? current.memory.worldPartition.crossSessionRecall,
          strategy: patch.memory?.worldPartition?.strategy ?? current.memory.worldPartition.strategy,
          activationThreshold:
            patch.memory?.worldPartition?.activationThreshold ?? current.memory.worldPartition.activationThreshold,
          chunkCapacity: patch.memory?.worldPartition?.chunkCapacity ?? current.memory.worldPartition.chunkCapacity,
          initialRadius: patch.memory?.worldPartition?.initialRadius ?? current.memory.worldPartition.initialRadius,
          maxRadius: patch.memory?.worldPartition?.maxRadius ?? current.memory.worldPartition.maxRadius,
          fallbackToGlobalSearch:
            patch.memory?.worldPartition?.fallbackToGlobalSearch ?? current.memory.worldPartition.fallbackToGlobalSearch,
          migrateLegacyOnStart:
            patch.memory?.worldPartition?.migrateLegacyOnStart ?? current.memory.worldPartition.migrateLegacyOnStart
        },
        openMemory: {
          ...current.memory.openMemory,
          enabled: patch.memory?.openMemory?.enabled ?? current.memory.openMemory.enabled,
          dbPath: patch.memory?.openMemory?.dbPath ?? current.memory.openMemory.dbPath
        }
      },
      providers: { ...current.providers },
      plugins: { ...current.plugins }
    };

    for (const [providerId, providerPatch] of Object.entries(patch.providers ?? {})) {
      // A service the environment sets is changed there: its address, key and presence.
      if (next.providers[providerId]?.source === "environment" && (providerPatch === null || providerPatch.baseUrl !== undefined || providerPatch.apiKey !== undefined)) {
        throw new SettingsValidationError(`${next.providers[providerId]!.name ?? providerId} is set in the server's environment file: change or remove it there.`);
      }
      if (providerPatch === null) {
        if (next.llm.defaultProvider === providerId) throw new SettingsValidationError("This is the default provider: choose another default first.");
        delete next.providers[providerId];
        continue;
      }
      const previous = next.providers[providerId] ?? this.defaultProvider(providerId);
      // Its key is the key store's (commit): never kept here as it was given.
      const { apiKey: _apiKey, ...fields } = providerPatch;
      next.providers[providerId] = { ...previous, ...fields };
      // Tool calls were checked at the address the service was added at: another address acts in JSON.
      if (providerPatch.baseUrl !== undefined && providerPatch.baseUrl !== previous.baseUrl && providerPatch.nativeTools === undefined) delete next.providers[providerId]!.nativeTools;
    }

    for (const [pluginName, pluginPatch] of Object.entries(patch.plugins ?? {})) {
      const previous = next.plugins[pluginName] ?? {
        enabled: true,
        values: {}
      };

      next.plugins[pluginName] = {
        ...previous,
        enabled: pluginPatch.enabled ?? previous.enabled,
        values: {
          ...previous.values,
          ...(pluginPatch.values ?? {})
        }
      };
    }

    return this.normalize(next);
  }

  private async write(settings: AppSettings): Promise<void> {
    await fs.mkdir(this.appDataDir, { recursive: true });
    // Provider keys and the bot token are in the credential vault, named by ref; a key saved before
    // that stays here only while the vault cannot be used.
    await writeJsonAtomically(this.filePath, settings, { mode: 0o600 });
  }

  private fromConfig(): AppSettings {
    return {
      schemaVersion: 6,
      filesystem: { outputDir: this.baseConfig.outputDir, ...this.baseConfig.filesystem },
      profile: this.defaultProfile(),
      localModels: this.localDefaults(),
      agentLimits: normalizeAgentLimits(this.baseConfig.agentLimits),
      llm: {
        defaultProvider: this.baseConfig.llm.defaultProvider
      },
      mcp: {
        client: parseMcpConfiguration(this.baseConfig.mcp.client),
        server: {
          enabled: this.baseConfig.mcp.server.enabled,
          transport: this.baseConfig.mcp.server.transport,
          defaultSessionId: this.baseConfig.mcp.server.defaultSessionId
        }
      },
      telegram: {
        enabled: this.baseConfig.telegram.enabled,
        ownerUserIds: this.baseConfig.telegram.ownerUserIds,
        pollTimeoutSec: this.baseConfig.telegram.pollTimeoutSec
      },
      memory: {
        adapter: this.baseConfig.memory.adapter,
        baseDir: this.baseConfig.memory.baseDir,
        topK: this.baseConfig.memory.topK,
        localProfileId: this.defaultMemoryProfileId,
        worldPartition: { ...this.baseConfig.memory.worldPartition },
        openMemory: {
          enabled: this.baseConfig.memory.openMemory.enabled,
          dbPath: this.baseConfig.memory.openMemory.dbPath
        }
      },
      providers: {
        llamacpp: {
          enabled: this.baseConfig.providers.llamacpp?.enabled !== false,
          baseUrl: "",
          model: this.baseConfig.providers.llamacpp?.model ?? "",
          timeoutMs: this.baseConfig.providers.llamacpp?.timeoutMs ?? 600000
        },
        ollama: {
          enabled: this.baseConfig.providers.ollama.enabled !== false,
          baseUrl: this.baseConfig.providers.ollama.baseUrl,
          model: this.baseConfig.providers.ollama.model,
          timeoutMs: this.baseConfig.providers.ollama.timeoutMs
        },
        lmstudio: {
          enabled: this.baseConfig.providers.lmstudio.enabled !== false,
          baseUrl: this.baseConfig.providers.lmstudio.baseUrl,
          model: this.baseConfig.providers.lmstudio.model,
          timeoutMs: this.baseConfig.providers.lmstudio.timeoutMs
        },
        openai: {
          enabled: this.baseConfig.providers.openai.enabled !== false,
          baseUrl: this.baseConfig.providers.openai.baseUrl,
          model: this.baseConfig.providers.openai.model,
          timeoutMs: this.baseConfig.providers.openai.timeoutMs
        },
        anthropic: {
          enabled: this.baseConfig.providers.anthropic.enabled !== false,
          baseUrl: this.baseConfig.providers.anthropic.baseUrl,
          model: this.baseConfig.providers.anthropic.model,
          timeoutMs: this.baseConfig.providers.anthropic.timeoutMs,
          version: this.baseConfig.providers.anthropic.version,
          maxTokens: this.baseConfig.providers.anthropic.maxTokens
        },
        gemini: {
          enabled: this.baseConfig.providers.gemini.enabled !== false,
          baseUrl: this.baseConfig.providers.gemini.baseUrl,
          model: this.baseConfig.providers.gemini.model,
          timeoutMs: this.baseConfig.providers.gemini.timeoutMs
        },
        // OpenAI-compatible services every installation has (Qwen), and those its environment sets:
        // data, shaped by their dialect. No key of the environment is copied here: it is used as it is
        // while no key is saved (src/app/ProviderKeyStore.ts).
        ...Object.fromEntries(Object.entries(this.baseConfig.compatibleProviders ?? {}).map(([id, provider]) => [id, {
          kind: "openai-compatible" as const,
          dialect: provider.dialect,
          name: provider.name,
          enabled: provider.enabled !== false,
          baseUrl: provider.baseUrl,
          ...(provider.source === "environment" ? { source: "environment" as const } : {}),
          ...(provider.preset ? { preset: provider.preset } : {}),
          model: provider.model,
          timeoutMs: provider.timeoutMs
        }]))
      },
      plugins: {}
    };
  }

  private normalize(input: Partial<AppSettings>): AppSettings {
    const defaults = this.fromConfig();
    const settings: AppSettings = {
      ...input,
      // Keep old stores readable; the UI imports its first-paint theme once.
      ...(input.ui ? { ui: this.normalizeUi(input.ui) } : {}),
      profile: this.normalizeProfile(input.profile),
      schemaVersion: Number.isInteger(input.schemaVersion) && input.schemaVersion! >= 3 ? input.schemaVersion : 3,
      filesystem: input.filesystem ?? {
        outputDir: typeof input.plugins?.file?.values.outputDir === "string" ? input.plugins.file.values.outputDir : defaults.filesystem!.outputDir,
        accessMode: input.plugins?.file?.values.accessMode === "full" ? "full" : input.plugins?.file?.values.accessMode === "restricted" ? "restricted" : defaults.filesystem!.accessMode,
        allowedDirectories: typeof input.plugins?.file?.values.allowedDirectories === "string"
          ? input.plugins.file.values.allowedDirectories.split(/\r?\n|,/).map(value => value.trim()).filter(Boolean).map(value => path.resolve(value)) : defaults.filesystem!.allowedDirectories
      },
      localModels: this.normalizeLocalModels(input.localModels),
      agentLimits: normalizeAgentLimits(input.agentLimits ?? defaults.agentLimits),
      llm: {
        ...input.llm,
        defaultProvider: input.llm?.defaultProvider ?? defaults.llm.defaultProvider
      },
      mcp: {
        ...input.mcp,
        client: parseMcpConfiguration(input.mcp?.client === undefined ? defaults.mcp.client : input.mcp.client),
        server: {
          ...input.mcp?.server,
          enabled: input.mcp?.server?.enabled ?? defaults.mcp.server.enabled,
          transport: "stdio",
          defaultSessionId:
            input.mcp?.server?.defaultSessionId ?? defaults.mcp.server.defaultSessionId
        }
      },
      telegram: {
        ...input.telegram,
        enabled: input.telegram?.enabled ?? defaults.telegram.enabled,
        ownerUserIds: this.normalizeTelegramOwnerUserIds(
          input.telegram?.ownerUserIds,
          defaults.telegram.ownerUserIds
        ),
        pollTimeoutSec: input.telegram?.pollTimeoutSec ?? defaults.telegram.pollTimeoutSec
      },
      memory: {
        ...input.memory,
        adapter: this.normalizeMemoryAdapter(input.memory?.adapter, defaults.memory.adapter),
        baseDir: input.memory?.baseDir ?? defaults.memory.baseDir,
        topK: input.memory?.topK ?? defaults.memory.topK,
        localProfileId:
          typeof input.memory?.localProfileId === "string" && input.memory.localProfileId.trim()
            ? input.memory.localProfileId
            : defaults.memory.localProfileId,
        worldPartition: this.normalizeWorldPartition(input.memory?.worldPartition, defaults.memory.worldPartition),
        openMemory: {
          ...input.memory?.openMemory,
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
      if (typeof provider?.apiKeyRef !== "string") delete settings.providers[providerId]!.apiKeyRef;
    }
    if (typeof settings.telegram.botTokenRef !== "string") delete settings.telegram.botTokenRef;

    // A service every installation has stays that service: its kind and dialect come from here, and
    // one the environment sets keeps its address and key from there. A key saved for it before is
    // not used meanwhile, and stays for when the environment no longer sets it.
    for (const [providerId, provider] of Object.entries(defaults.providers)) {
      if (!provider.kind) continue;
      const current = { ...settings.providers[providerId], kind: provider.kind, dialect: provider.dialect };
      if (provider.source === "environment") { delete current.apiKey; Object.assign(current, { source: "environment" as const, baseUrl: provider.baseUrl, ...(provider.preset ? { preset: provider.preset } : {}) }); }
      else delete current.source;
      settings.providers[providerId] = current;
    }
    // One the environment no longer sets is gone: removing it there removes it here. One added here
    // before the environment set it (it has a saved key) is the user's again.
    for (const [providerId, provider] of Object.entries(settings.providers)) {
      if (provider.source !== "environment" || defaults.providers[providerId]?.source === "environment") continue;
      if (provider.apiKeyRef) delete provider.source; else delete settings.providers[providerId];
    }

    // The internal server chooses its own address and token on every launch.
    settings.providers.llamacpp.baseUrl = "";
    delete settings.providers.llamacpp.apiKey;
    delete settings.providers.llamacpp.apiKeyRef;
    settings.providers.llamacpp.timeoutMs = settings.localModels!.generationTimeoutMs;

    for (const [pluginName, plugin] of Object.entries(input.plugins ?? {})) {
      if (["file", "notion", "vscode"].includes(pluginName)) continue;
      const previous = settings.plugins[pluginName] ?? { enabled: true, values: {} };
      settings.plugins[pluginName] = {
        ...previous,
        ...plugin,
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
    const timeoutMs = providerId === "llamacpp" ? 600000 : ["lmstudio", "ollama"].includes(providerId) ? 300000 : 60000;

    return {
      enabled: true,
      baseUrl: "",
      model: "",
      timeoutMs
    };
  }

  private defaultProfile(): NonNullable<AppSettings["profile"]> {
    return { displayName: "Local profile" };
  }

  private normalizeUi(input: AppSettings["ui"]): NonNullable<AppSettings["ui"]> {
    const preferences = { ...defaultUiPreferences, ...input, version: 1 as const };
    preferences.theme = ["dark", "light", "system", "midnight"].includes(preferences.theme) ? preferences.theme : defaultUiPreferences.theme;
    for (const key of ["accentColor", "backgroundColor", "foregroundColor"] as const) {
      if (typeof preferences[key] !== "string" || !/^#[0-9a-f]{6}$/i.test(preferences[key])) delete preferences[key];
    }
    if (!["enter", "mod-enter"].includes(preferences.sendKey)) preferences.sendKey = defaultUiPreferences.sendKey;
    const shortcuts = readShortcuts(preferences.shortcuts);
    if (shortcuts) preferences.shortcuts = shortcuts; else delete preferences.shortcuts;
    return preferences;
  }

  private normalizeProfile(input: AppSettings["profile"]): NonNullable<AppSettings["profile"]> {
    const displayName = typeof input?.displayName === "string" && input.displayName.trim() && input.displayName.trim().length <= 80 && !/[\u0000-\u001f\u007f]/.test(input.displayName)
      ? input.displayName.trim()
      : this.defaultProfile().displayName;
    const avatar = input?.avatarDataUrl;
    const avatarDataUrl = typeof avatar === "string" && avatar.length <= 1_500_000 && /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]+={0,2}$/i.test(avatar)
      ? avatar
      : undefined;
    return { displayName, ...(avatarDataUrl ? { avatarDataUrl } : {}) };
  }

  private localDefaults(): NonNullable<AppSettings["localModels"]> {
    const { modelsDir, contextSize, gpuLayers, loadTimeoutMs, generationTimeoutMs, memoryLimitPercent, generation } = localModelOptions(this.baseConfig);
    return { modelsDir, contextSize, gpuLayers, loadTimeoutMs, generationTimeoutMs, memoryLimitPercent, generation: normalizeLocalGenerationSettings(generation ?? defaultLocalGenerationSettings()) };
  }

  private normalizeLocalModels(input: AppSettings["localModels"]): NonNullable<AppSettings["localModels"]> {
    const defaults = this.localDefaults();
    return {
      ...input,
      modelsDir: typeof input?.modelsDir === "string" && input.modelsDir.trim() ? path.resolve(input.modelsDir.trim()) : defaults.modelsDir,
      contextSize: Math.min(131072, this.positiveInteger(input?.contextSize, defaults.contextSize, 512)),
      gpuLayers: input?.gpuLayers === "auto" ? "auto" : typeof input?.gpuLayers === "number" && Number.isFinite(input.gpuLayers) ? Math.max(0, Math.min(999, Math.floor(input.gpuLayers))) : defaults.gpuLayers,
      loadTimeoutMs: Math.min(1800000, this.positiveInteger(input?.loadTimeoutMs, defaults.loadTimeoutMs, 10000)),
      generationTimeoutMs: Math.min(3600000, this.positiveInteger(input?.generationTimeoutMs, defaults.generationTimeoutMs, 10000)),
      memoryLimitPercent: Math.min(90, this.positiveInteger(input?.memoryLimitPercent, defaults.memoryLimitPercent, 10)),
      generation: normalizeLocalGenerationSettings(input?.generation)
    };
  }

  private normalizeMemoryAdapter(
    value: unknown,
    fallback: AppSettings["memory"]["adapter"]
  ): AppSettings["memory"]["adapter"] {
    return value === "local-json" || value === "openmemory" || value === "world-partition" ? value : fallback;
  }

  private normalizeWorldPartition(
    value: Partial<AppSettings["memory"]["worldPartition"]> | undefined,
    defaults: AppSettings["memory"]["worldPartition"]
  ): AppSettings["memory"]["worldPartition"] {
    const strategy = value?.strategy;
    const initialRadius = this.nonNegativeInteger(value?.initialRadius, defaults.initialRadius);
    const maxRadius = Math.max(initialRadius, this.nonNegativeInteger(value?.maxRadius, defaults.maxRadius));

    return {
      ...value,
      crossSessionRecall:
        typeof value?.crossSessionRecall === "boolean" ? value.crossSessionRecall : defaults.crossSessionRecall,
      strategy: strategy === "global" || strategy === "partitioned" || strategy === "auto" ? strategy : defaults.strategy,
      activationThreshold: this.positiveInteger(value?.activationThreshold, defaults.activationThreshold),
      chunkCapacity: this.positiveInteger(value?.chunkCapacity, defaults.chunkCapacity, 32),
      initialRadius,
      maxRadius,
      fallbackToGlobalSearch:
        typeof value?.fallbackToGlobalSearch === "boolean" ? value.fallbackToGlobalSearch : defaults.fallbackToGlobalSearch,
      migrateLegacyOnStart:
        typeof value?.migrateLegacyOnStart === "boolean" ? value.migrateLegacyOnStart : defaults.migrateLegacyOnStart
    };
  }

  private positiveInteger(value: unknown, fallback: number, minimum = 1): number {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback;
  }

  private nonNegativeInteger(value: unknown, fallback: number): number {
    return this.positiveInteger(value, fallback, 0);
  }

  private normalizeTelegramOwnerUserIds(value: unknown, defaults: string[]): string[] {
    if (!Array.isArray(value)) {
      return defaults;
    }

    return [...new Set(
      value
        .filter((userId): userId is string => typeof userId === "string")
        .map((userId) => userId.trim())
        .filter((userId) => /^(?:0|[1-9]\d*)$/.test(userId))
    )];
  }
}
