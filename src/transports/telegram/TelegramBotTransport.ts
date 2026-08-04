import { CognitiveEngine } from "../../core/CognitiveEngine";
import { LMStudioManager } from "../../llm/LMStudioManager";
import { ModelCatalogService } from "../../llm/ModelCatalogService";
import { ResponseFormatter } from "../../core/ResponseFormatter";
import { SessionSettingsStore } from "../../session/SessionSettingsStore";
import {
  LanguagePreference,
  ManagedModel,
  ProviderDescriptor,
  SessionMode,
  SessionSettings
} from "../../types";
import { Logger } from "../../utils/Logger";
import { aliasesForModel, buildAliasMap } from "./ModelAliases";
import { TELEGRAM_HELP } from "./TelegramHelp";

interface TelegramTransportOptions {
  token: string;
  ownerUserIds: readonly string[];
  pollTimeoutSec: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat?: {
      id: number;
    };
    from?: {
      id: number;
    };
  };
}

export class TelegramBotTransport {
  private offset = 0;
  private active = false;

  constructor(
    private readonly options: TelegramTransportOptions,
    private readonly engine: CognitiveEngine,
    private readonly formatter: ResponseFormatter,
    private readonly sessionSettingsStore: SessionSettingsStore,
    private readonly modelCatalog: ModelCatalogService,
    private readonly lmStudioManager: LMStudioManager,
    private readonly providers: ProviderDescriptor[],
    private readonly logger: Logger
  ) {}

  start(): void {
    if (this.active) {
      return;
    }

    this.active = true;
    void this.registerCommands();
    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    while (this.active) {
      try {
        const updates = await this.getUpdates();

        for (const update of updates) {
          await this.processUpdate(update);
        }
      } catch (error) {
        this.logger.warn("Telegram poll loop error", {
          error: error instanceof Error ? error.message : "unknown_error"
        });
        await this.delay(2000);
      }
    }
  }

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    this.offset = update.update_id + 1;

    const text = update.message?.text?.trim();
    const chatId = update.message?.chat?.id;
    const userId = update.message?.from?.id;

    if (!text || !chatId) {
      return;
    }

    if (!this.isOwner(userId)) {
      this.logger.warn("Ignored Telegram update from a non-owner", {
        chatId,
        userId: userId ?? "unknown"
      });
      return;
    }

    const sessionId = String(chatId);

    if (text.startsWith("/")) {
      const commandReply = await this.handleCommand(sessionId, text);
      await this.sendMessage(chatId, commandReply);
      return;
    }

    const result = await this.engine.process({
      input: text,
      actor: {
        sessionId,
        userId: String(userId),
        channel: "telegram"
      }
    });

    await this.sendMessage(chatId, this.formatter.formatForChat(result, { maxChars: 3900 }));
  }

  private async handleCommand(sessionId: string, text: string): Promise<string> {
    const [command, ...args] = text.split(/\s+/);

    switch (command) {
      case "/start":
      case "/help":
        return TELEGRAM_HELP;
      case "/presets":
        return [
          "Presets",
          "",
          "- chat_ru",
          "- debate_ru",
          "- technical_ru",
          "- security_ru"
        ].join("\n");
      case "/preset": {
        const preset = args[0];
        const settings = await this.applyPreset(sessionId, preset);
        return settings ? this.formatSettings(settings) : "Usage: /preset chat_ru|debate_ru|technical_ru|security_ru";
      }
      case "/providers":
        return [
          "Providers",
          "",
          ...this.providers.map((provider) => `- ${provider.id}: ${provider.defaultModel}`)
        ]
          .join("\n")
          .slice(0, 3900);
      case "/models": {
        const models = await this.lmStudioManager.listLoadedModels();
        if (models.length === 0) {
          return "Loaded Models\n\nNo loaded models found.";
        }

        const aliasMap = buildAliasMap(models);
        return [
          "Loaded Models",
          "",
          ...models.map((model) =>
            this.formatManagedModel(model, aliasMap)
          )
        ]
          .join("\n");
      }
      case "/all_models": {
        const models = await this.lmStudioManager.listAllModels();
        if (models.length === 0) {
          return "All Models\n\nNo models found.";
        }

        const aliasMap = buildAliasMap(models);
        return [
          "All Models",
          "",
          ...models.map((model) => this.formatManagedModel(model, aliasMap, false))
        ]
          .join("\n")
          .slice(0, 3900);
      }
      case "/load_model": {
        const modelId = await this.resolveModelId(args.join(" ").trim());
        if (!modelId) {
          return "Usage: /load_model <modelOrAlias>";
        }

        await this.lmStudioManager.loadModel(modelId);
        return `Loading model: ${modelId}`;
      }
      case "/unload_model": {
        const modelId = await this.resolveModelId(args.join(" ").trim(), true);
        if (!modelId) {
          return "Usage: /unload_model <modelOrAlias|instanceId>";
        }

        await this.lmStudioManager.unloadModel(modelId);
        return `Unload requested: ${modelId}`;
      }
      case "/settings":
        return this.formatSettings(await this.sessionSettingsStore.get(sessionId));
      case "/reset_settings": {
        const settings = await this.sessionSettingsStore.reset(sessionId);
        return this.formatSettings(settings);
      }
      case "/mode": {
        const mode = args[0];
        if (!this.isSessionMode(mode)) {
          return "Usage: /mode auto|general|code|hypothesis";
        }

        const settings = await this.sessionSettingsStore.update(sessionId, { mode });
        return this.formatSettings(settings);
      }
      case "/language": {
        const language = args[0];
        if (!this.isLanguage(language)) {
          return "Usage: /language auto|ru|en";
        }

        const settings = await this.sessionSettingsStore.update(sessionId, { language });
        return this.formatSettings(settings);
      }
      case "/use": {
        if (!args[0]) {
          return "Usage: /use <providerId> [modelOrAlias]";
        }

        const resolvedModel = args[1]
          ? await this.resolveModelId(args.slice(1).join(" ").trim())
          : undefined;
        const settings = await this.sessionSettingsStore.update(sessionId, {
          defaultTarget: {
            providerId: args[0],
            model: resolvedModel
          }
        });
        return this.formatSettings(settings);
      }
      case "/debate": {
        if (!args[0]) {
          return "Usage: /debate on|off|profile|support|attack|judge";
        }

        if (args[0] === "on" || args[0] === "off") {
          const settings = await this.sessionSettingsStore.update(sessionId, {
            debate: {
              enabled: args[0] === "on"
            }
          });
          return this.formatSettings(settings);
        }

        if (args[0] === "profile") {
          const profile = args[1];
          if (!this.isProfile(profile)) {
            return "Usage: /debate profile general|technical|product|research|security";
          }

          const settings = await this.sessionSettingsStore.update(sessionId, {
            debate: {
              profile
            }
          });
          return this.formatSettings(settings);
        }

        if (args[0] === "support" || args[0] === "attack" || args[0] === "judge") {
          if (!args[1]) {
            return `Usage: /debate ${args[0]} <providerId> [modelOrAlias]`;
          }

          const role = args[0];
          const providerId = args[1];
          const model = args[2]
            ? await this.resolveModelId(args.slice(2).join(" ").trim())
            : undefined;
          const settings = await this.sessionSettingsStore.update(sessionId, {
            debate: {
              [role]: {
                providerId,
                model
              }
            }
          });

          return this.formatSettings(settings);
        }

        return "Usage: /debate on|off|profile|support|attack|judge";
      }
      default:
        return TELEGRAM_HELP;
    }
  }

  private formatSettings(settings: SessionSettings): string {
    return [
      "Session Settings",
      "",
      "General",
      `- Mode: ${settings.mode}`,
      `- Language: ${settings.language}`,
      `- Default: ${this.formatTarget(settings.defaultTarget.providerId, settings.defaultTarget.model)}`,
      "",
      "Debate",
      `- Enabled: ${settings.debate.enabled ? "on" : "off"}`,
      `- Profile: ${settings.debate.profile}`,
      `- Support: ${this.formatTarget(settings.debate.support.providerId, settings.debate.support.model)}`,
      `- Attack: ${this.formatTarget(settings.debate.attack.providerId, settings.debate.attack.model)}`,
      `- Judge: ${this.formatTarget(settings.debate.judge.providerId, settings.debate.judge.model)}`
    ].join("\n");
  }

  private formatTarget(providerId: string, model?: string): string {
    return model ? `${providerId} (${model})` : providerId;
  }

  private formatManagedModel(
    model: ManagedModel,
    aliasMap: Map<string, string>,
    includeLoadedState = true
  ): string {
    const aliases = aliasesForModel(model.id, aliasMap);
    const providerLabel = model.providerName || model.providerId || "local";
    const lines = [`- ${model.id}${includeLoadedState && model.loaded ? " (loaded)" : ""}`];
    lines.push(`  provider: ${providerLabel}`);

    if (aliases.length > 0) {
      lines.push(`  alias: ${aliases.join(", ")}`);
    }

    if (model.loadedInstanceIds.length > 0) {
      lines.push(`  instances: ${model.loadedInstanceIds.join(", ")}`);
    }

    return lines.join("\n");
  }

  private async resolveModelId(
    raw: string,
    allowPassthrough = false
  ): Promise<string | undefined> {
    const normalized = raw.trim();
    if (!normalized) {
      return undefined;
    }

    const models = await this.lmStudioManager.listAllModels();
    const aliasMap = buildAliasMap(models);

    if (aliasMap.has(normalized)) {
      return aliasMap.get(normalized);
    }

    if (models.some((model) => model.id === normalized)) {
      return normalized;
    }

    return allowPassthrough ? normalized : undefined;
  }

  private async applyPreset(
    sessionId: string,
    preset: string | undefined
  ): Promise<SessionSettings | null> {
    switch (preset) {
      case "chat_ru":
        return this.sessionSettingsStore.update(sessionId, {
          mode: "general",
          language: "ru",
          debate: { enabled: false }
        });
      case "debate_ru":
        return this.sessionSettingsStore.update(sessionId, {
          mode: "hypothesis",
          language: "ru",
          debate: {
            enabled: true,
            profile: "general"
          }
        });
      case "technical_ru":
        return this.sessionSettingsStore.update(sessionId, {
          mode: "hypothesis",
          language: "ru",
          debate: {
            enabled: true,
            profile: "technical"
          }
        });
      case "security_ru":
        return this.sessionSettingsStore.update(sessionId, {
          mode: "hypothesis",
          language: "ru",
          debate: {
            enabled: true,
            profile: "security"
          }
        });
      default:
        return null;
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const payload = await this.callTelegram("getUpdates", {
      offset: this.offset,
      timeout: this.options.pollTimeoutSec
    });

    return Array.isArray(payload.result) ? (payload.result as TelegramUpdate[]) : [];
  }

  private async sendMessage(chatId: number, text: string): Promise<void> {
    await this.callTelegram("sendMessage", {
      chat_id: chatId,
      text
    });
  }

  private async callTelegram(
    method: string,
    body: Record<string, unknown>
  ): Promise<{ ok?: boolean; result?: unknown }> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.options.token}/${method}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      throw new Error(`Telegram ${method} failed with status ${response.status}`);
    }

    return (await response.json()) as { ok?: boolean; result?: unknown };
  }

  private async registerCommands(): Promise<void> {
    try {
      await this.callTelegram("setMyCommands", {
        commands: [
          { command: "help", description: "Show command help" },
          { command: "providers", description: "List provider aliases" },
          { command: "models", description: "List loaded models" },
          { command: "all_models", description: "List all available models" },
          { command: "load_model", description: "Load a model in LM Studio" },
          { command: "unload_model", description: "Unload a model in LM Studio" },
          { command: "settings", description: "Show current session settings" },
          { command: "reset_settings", description: "Reset session settings" },
          { command: "mode", description: "Set mode: auto/general/code/hypothesis" },
          { command: "language", description: "Set language: auto/ru/en" },
          { command: "use", description: "Set default provider and model" },
          { command: "debate", description: "Configure debate mode and roles" }
        ]
      });
    } catch (error) {
      this.logger.warn("Failed to register Telegram commands", {
        error: error instanceof Error ? error.message : "unknown_error"
      });
    }
  }

  private isSessionMode(value: string | undefined): value is SessionMode {
    return value === "auto" || value === "general" || value === "code" || value === "hypothesis";
  }

  private isOwner(userId: number | undefined): boolean {
    return userId !== undefined && this.options.ownerUserIds.includes(String(userId));
  }

  private isLanguage(value: string | undefined): value is LanguagePreference {
    return value === "auto" || value === "ru" || value === "en";
  }

  private isProfile(
    value: string | undefined
  ): value is SessionSettings["debate"]["profile"] {
    return (
      value === "general" ||
      value === "technical" ||
      value === "product" ||
      value === "research" ||
      value === "security"
    );
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
