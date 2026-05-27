import fs from "fs/promises";
import path from "path";
import {
  CodeAgentTarget,
  HypothesisAgentTarget,
  ProviderTarget,
  SessionSettings,
  SessionSettingsPatch
} from "../types";

interface SessionSettingsStoreOptions {
  baseDir: string;
}

const maxHypothesisAdvisors = 5;
const maxHypothesisAgents = 3 + maxHypothesisAdvisors;

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
      codeAgents: patch.subagents ?? patch.codeAgents ?? current.codeAgents,
      hypothesisAgents: patch.hypothesisAgents ?? current.hypothesisAgents,
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
	      outputStyle: settings.outputStyle ?? fallback.outputStyle,
	      defaultTarget: this.normalizeTarget(settings.defaultTarget, fallback.defaultTarget),
	      defaultAccessMode: settings.defaultAccessMode === "full" ? "full" : "default",
	      codeAgents: this.normalizeCodeAgents(settings.codeAgents, fallback.codeAgents),
      hypothesisAgents: this.normalizeHypothesisAgents(settings.hypothesisAgents, fallback.hypothesisAgents),
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
      outputStyle: "balanced",
	      defaultTarget: {
	        ...this.defaultTarget
	      },
	      defaultAccessMode: "default",
	      codeAgents: [],
      hypothesisAgents: [
        {
          id: "hypothesis-support",
          name: "Support",
          role: "support",
          ...this.defaultTarget
        },
        {
          id: "hypothesis-attack",
          name: "Attack",
          role: "attack",
          ...this.defaultTarget
        },
        {
          id: "hypothesis-judge",
          name: "Judge",
          role: "judge",
          providerId: "local"
        }
      ],
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

  private normalizeCodeAgents(
    agents: CodeAgentTarget[] | undefined,
    fallback: CodeAgentTarget[]
  ): CodeAgentTarget[] {
    if (Array.isArray(agents)) {
      return agents.slice(0, 4).map((agent, index) => {
        const normalizedTarget = this.normalizeTarget(agent, fallback[0] ?? this.defaultTarget);

        return {
          id: agent.id?.trim() || `agent-${index + 1}`,
          name: agent.name?.trim() || this.defaultSubagentName(index),
          providerId: normalizedTarget.providerId,
          model: normalizedTarget.model,
          accessMode: agent.accessMode === "full" ? "full" : "default"
        };
      });
    }

    const source = fallback;

    return source.map((agent, index) => {
      const normalizedTarget = this.normalizeTarget(agent, fallback[0] ?? this.defaultTarget);

      return {
        id: agent.id?.trim() || `agent-${index + 1}`,
        name: agent.name?.trim() || this.defaultSubagentName(index),
        providerId: normalizedTarget.providerId,
        model: normalizedTarget.model,
        accessMode: agent.accessMode === "full" ? "full" : "default"
      };
    });
  }

  private normalizeHypothesisAgents(
    agents: HypothesisAgentTarget[] | undefined,
    fallback: HypothesisAgentTarget[]
  ): HypothesisAgentTarget[] {
    const source = Array.isArray(agents) ? agents : fallback;
    const normalized = source.slice(0, maxHypothesisAgents).map((agent, index) => {
      const normalizedTarget = this.normalizeTarget(agent, fallback[index] ?? fallback[0] ?? this.defaultTarget);
      const role = ["support", "attack", "judge", "advisor"].includes(agent.role)
        ? agent.role
        : index === 0
          ? "support"
          : index === 1
            ? "attack"
            : index === 2
              ? "judge"
              : "advisor";

      return {
        id: agent.id?.trim() || `hypothesis-${index + 1}`,
        name: agent.name?.trim() || this.defaultHypothesisName(role, index),
        role,
        providerId: normalizedTarget.providerId,
        model: normalizedTarget.model
      };
    });

    if (normalized.length === 0) {
      return fallback;
    }

    const requiredRoles = ["support", "attack", "judge"] as const;
    const requiredAgents = requiredRoles.map((role, index) => {
      return normalized.find((agent) => agent.role === role) ?? fallback[index];
    });
    const advisors = normalized.filter((agent) => agent.role === "advisor").slice(0, maxHypothesisAdvisors);

    return [...requiredAgents, ...advisors];
  }

  private defaultSubagentName(index: number): string {
    return ["Atlas", "Nova", "Vector", "Echo", "Orion", "Lyra", "Kepler", "Sable", "Rook", "Mira"][index % 10];
  }

  private defaultHypothesisName(role: HypothesisAgentTarget["role"], index: number): string {
    if (role === "support") {
      return "Support";
    }

    if (role === "attack") {
      return "Attack";
    }

    if (role === "judge") {
      return "Judge";
    }

    return `Advisor${index - 2}`;
  }

  private getPath(sessionId: string): string {
    return path.join(this.options.baseDir, `${this.normalizeSessionId(sessionId)}.json`);
  }

  private normalizeSessionId(sessionId: string): string {
    return sessionId.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
  }
}
