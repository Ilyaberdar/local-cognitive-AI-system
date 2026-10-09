import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { resolveProviderTarget } from "../llm/ProviderTargetResolver";
import {
  CodeAgentTarget,
  HypothesisAgentTarget,
  ProviderTarget,
  SessionSettings,
  SessionSettingsPatch
} from "../types";
import { isReasoningEffort } from "../llm/ReasoningEffort";

interface SessionSettingsStoreOptions {
  baseDir: string;
}

const maxHypothesisAdvisors = 5;
const maxHypothesisAgents = 3 + maxHypothesisAdvisors;

export class SessionSettingsStore {
  /** One read-modify-write at a time per chat: two updates never lose each other's fields. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly options: SessionSettingsStoreOptions,
    private readonly defaultTarget: ProviderTarget,
    private readonly providerDefaults: Record<string, string | undefined>,
    private readonly resolveLocalModel?: (id?: string) => string | undefined
  ) {}

  async get(sessionId: string): Promise<SessionSettings> {
    const filePath = this.getPath(sessionId);

    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SessionSettings>;
      return this.normalize(parsed);
    } catch {
      return this.normalize(this.buildDefaultSettings());
    }
  }

  update(sessionId: string, patch: SessionSettingsPatch): Promise<SessionSettings> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.applyUpdate(sessionId, patch));
    const settled = next.catch(() => undefined);
    this.queues.set(sessionId, settled);
    void settled.then(() => { if (this.queues.get(sessionId) === settled) this.queues.delete(sessionId); });
    return next;
  }

  private async applyUpdate(sessionId: string, patch: SessionSettingsPatch): Promise<SessionSettings> {
    const current = await this.get(sessionId);
    const next = this.normalize({
      ...current,
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
      defaultTarget: this.normalizeTarget(patch.defaultTarget, current.defaultTarget),
      codeAgents: patch.subagents ?? patch.codeAgents ?? current.codeAgents,
      hypothesisAgents: patch.hypothesisAgents ?? current.hypothesisAgents,
      debate: {
        ...current.debate,
        ...patch.debate,
        support: this.normalizeTarget(patch.debate?.support, current.debate.support),
        attack: this.normalizeTarget(patch.debate?.attack, current.debate.attack),
        judge: this.normalizeTarget(patch.debate?.judge, current.debate.judge)
      }
    });

    await this.save(sessionId, next);
    return next;
  }

  async reset(sessionId: string): Promise<SessionSettings> {
    const settings = this.normalize(this.buildDefaultSettings());
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

  /** Written beside the file and renamed over it: a reader sees the old settings or the new ones,
   * never an empty or half-written file (which would read as the defaults). */
  private async save(sessionId: string, settings: SessionSettings): Promise<void> {
    await fs.mkdir(this.options.baseDir, { recursive: true });
    const file = this.getPath(sessionId), temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(settings, null, 2), "utf8");
      await fs.rename(temporary, file);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }

  private normalize(settings: Partial<SessionSettings>): SessionSettings {
    const fallback = this.buildDefaultSettings();

    return {
      mode: settings.mode ?? fallback.mode,
      language: settings.language ?? fallback.language,
	      outputStyle: settings.outputStyle ?? fallback.outputStyle,
      reasoningEffort: isReasoningEffort(settings.reasoningEffort) ? settings.reasoningEffort : fallback.reasoningEffort,
	      defaultTarget: this.normalizeTarget(settings.defaultTarget, fallback.defaultTarget),
	      defaultAccessMode: settings.defaultAccessMode === "ask" ? "ask" : settings.defaultAccessMode === "full" ? "full" : "default",
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
    const resolved = resolveProviderTarget(target, fallback, this.providerDefaults);
    return resolved.providerId === "llamacpp" && this.resolveLocalModel
      ? { ...resolved, model: this.resolveLocalModel(resolved.model) } : resolved;
  }

  private buildDefaultSettings(): SessionSettings {
    return {
      mode: "auto",
      language: "auto",
      outputStyle: "balanced",
	      reasoningEffort: "medium",
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
          accessMode: agent.accessMode === "ask" ? "ask" : agent.accessMode === "full" ? "full" : "default"
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
        accessMode: agent.accessMode === "ask" ? "ask" : agent.accessMode === "full" ? "full" : "default"
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
    const seenIds = new Set(requiredAgents.map((agent) => agent.id));
    const seenNames = new Set(requiredAgents.map((agent) => agent.name.trim().toLowerCase()));
    const advisors = normalized
      .filter((agent) => agent.role === "advisor")
      .filter((agent) => {
        const name = agent.name.trim().toLowerCase();
        if (seenIds.has(agent.id) || seenNames.has(name)) {
          return false;
        }

        seenIds.add(agent.id);
        seenNames.add(name);
        return true;
      })
      .slice(0, maxHypothesisAdvisors);

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
