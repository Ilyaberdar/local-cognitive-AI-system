import fs from "fs/promises";
import path from "path";
import {
  ProviderTarget,
  SessionSettings,
  SessionSettingsPatch
} from "../types";

interface SessionSettingsStoreOptions {
  baseDir: string;
}

export class SessionSettingsStore {
  constructor(
    private readonly options: SessionSettingsStoreOptions,
    private readonly defaultTarget: ProviderTarget,
    private readonly providerDefaults: Record<string, string | undefined>
  ) {}

  async get(sessionId: string): Promise<SessionSettings> {
    const filePath = this.getPath(sessionId);

    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SessionSettings>;
      return this.normalize(parsed);
    } catch {
      return this.buildDefaultSettings();
    }
  }

  async update(sessionId: string, patch: SessionSettingsPatch): Promise<SessionSettings> {
    const current = await this.get(sessionId);
    const next = this.normalize({
      ...current,
      ...patch,
      defaultTarget: {
        ...current.defaultTarget,
        ...patch.defaultTarget
      },
      debate: {
        ...current.debate,
        ...patch.debate,
        support: {
          ...current.debate.support,
          ...patch.debate?.support
        },
        attack: {
          ...current.debate.attack,
          ...patch.debate?.attack
        },
        judge: {
          ...current.debate.judge,
          ...patch.debate?.judge
        }
      }
    });

    await this.save(sessionId, next);
    return next;
  }

  async reset(sessionId: string): Promise<SessionSettings> {
    const settings = this.buildDefaultSettings();
    await this.save(sessionId, settings);
    return settings;
  }

  async delete(sessionId: string): Promise<void> {
    try {
      await fs.unlink(this.getPath(sessionId));
    } catch {
      return;
    }
  }

  private async save(sessionId: string, settings: SessionSettings): Promise<void> {
    await fs.mkdir(this.options.baseDir, { recursive: true });
    await fs.writeFile(this.getPath(sessionId), JSON.stringify(settings, null, 2), "utf8");
  }

  private normalize(settings: Partial<SessionSettings>): SessionSettings {
    const fallback = this.buildDefaultSettings();

    return {
      mode: settings.mode ?? fallback.mode,
      language: settings.language ?? fallback.language,
      defaultTarget: this.normalizeTarget(settings.defaultTarget, fallback.defaultTarget),
      debate: {
        enabled: settings.debate?.enabled ?? fallback.debate.enabled,
        profile: settings.debate?.profile ?? fallback.debate.profile,
        support: this.normalizeTarget(settings.debate?.support, fallback.debate.support),
        attack: this.normalizeTarget(settings.debate?.attack, fallback.debate.attack),
        judge: this.normalizeTarget(settings.debate?.judge, fallback.debate.judge)
      }
    };
  }

  private normalizeTarget(
    target: Partial<ProviderTarget> | undefined,
    fallback: ProviderTarget
  ): ProviderTarget {
    const providerId = target?.providerId ?? fallback.providerId;

    if (providerId === "local") {
      return {
        providerId: "local"
      };
    }

    return {
      providerId,
      model: target?.model ?? fallback.model ?? this.providerDefaults[providerId]
    };
  }

  private buildDefaultSettings(): SessionSettings {
    return {
      mode: "auto",
      language: "auto",
      defaultTarget: {
        ...this.defaultTarget
      },
      debate: {
        enabled: false,
        profile: "general",
        support: {
          ...this.defaultTarget
        },
        attack: {
          ...this.defaultTarget
        },
        judge: {
          providerId: "local"
        }
      }
    };
  }

  private getPath(sessionId: string): string {
    return path.join(this.options.baseDir, `${this.normalizeSessionId(sessionId)}.json`);
  }

  private normalizeSessionId(sessionId: string): string {
    return sessionId.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
  }
}
