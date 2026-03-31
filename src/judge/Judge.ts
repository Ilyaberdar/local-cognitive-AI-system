import { LLMService } from "../llm/LLMService";
import { LanguageEnforcer } from "../llm/LanguageEnforcer";
import { buildDebateGuidance, buildLanguageInstruction } from "./DebateProfiles";
import {
  AgentDebateResponse,
  DebateProfile,
  HypothesisResult,
  ProviderTarget,
  TokenUsage
} from "../types";

interface JudgePayload {
  verdict?: string;
  confidence?: number;
  reasoning?: string;
  winner?: string;
  decision?: string;
  rationale?: string;
  explanation?: string;
}

export class Judge {
  constructor(
    private readonly llmService: LLMService,
    private readonly languageEnforcer: LanguageEnforcer
  ) {}

  async evaluate(
    input: string,
    [support, attack]: [AgentDebateResponse, AgentDebateResponse],
    judgeTarget: ProviderTarget,
    profile: DebateProfile,
    language: "auto" | "ru" | "en"
  ): Promise<HypothesisResult> {
    if (judgeTarget.providerId === "local") {
      return this.evaluateLocally([support, attack], language, undefined);
    }

    const { data, response } = await this.llmService.generateObject<JudgePayload>(
      {
        systemPrompt: "You are an impartial judge producing only structured JSON.",
        model: judgeTarget.model,
        prompt: [
          "Evaluate the two debate sides and choose the stronger one.",
          buildDebateGuidance(profile),
          buildLanguageInstruction(language),
          "",
          `Hypothesis: ${input}`,
          "",
          `Support summary: ${support.summary}`,
          ...support.arguments.map((item) => `Support argument: ${item}`),
          "",
          `Attack summary: ${attack.summary}`,
          ...attack.arguments.map((item) => `Attack argument: ${item}`),
          "",
          'Return JSON with keys: "verdict" ("support" or "attack"), "confidence" (0-1), "reasoning" (string).'
        ].join("\n")
      },
      judgeTarget.providerId
    );

    const normalizedPayload = this.normalizePayload(data);

    if (!normalizedPayload) {
      const likelyProviderFailure =
        !response.raw &&
        typeof response.text === "string" &&
        response.text.startsWith(`Mock response from ${response.provider}`);

      return this.evaluateLocally(
        [support, attack],
        language,
        `${judgeTarget.providerId}:${judgeTarget.model ?? "default"}`,
        likelyProviderFailure
          ? `Judge provider request failed or timed out`
          : `Judge model returned invalid JSON or incomplete fields`,
        {
          requestedTarget: `${judgeTarget.providerId}:${judgeTarget.model ?? "default"}`,
          responseTarget: `${response.provider}:${response.model}`,
          providerCall: likelyProviderFailure ? "failed" : "ok",
          structuredOutput: "rejected",
          fallbackUsed: true,
          fallbackReason: likelyProviderFailure
            ? `Judge provider request failed or timed out`
            : `Judge model returned invalid JSON or incomplete fields`,
          providerError: response.error
        }
      );
    }

    const normalizedReasoning = await this.languageEnforcer.normalizeText(
      normalizedPayload.reasoning,
      language,
      judgeTarget
    );

    return {
      verdict: normalizedPayload.verdict,
      confidence: Number(Math.max(0, Math.min(1, normalizedPayload.confidence)).toFixed(2)),
      reasoning: normalizedReasoning,
      participants: {
        support: `${support.provider}:${support.model}`,
        attack: `${attack.provider}:${attack.model}`,
        judge: `${response.provider}:${response.model}`
      },
      configuredParticipants: {
        judge: `${judgeTarget.providerId}:${judgeTarget.model ?? "default"}`
      },
      fallback: {
        used: false,
        reason: "Judge model response accepted."
      },
      diagnostics: {
        judge: {
          requestedTarget: `${judgeTarget.providerId}:${judgeTarget.model ?? "default"}`,
          responseTarget: `${response.provider}:${response.model}`,
          providerCall: "ok",
          structuredOutput: "accepted",
          fallbackUsed: false
        }
      },
      metrics: {
        startedAt: new Date(0).toISOString(),
        completedAt: new Date(0).toISOString(),
        durationMs: 0,
        usage: this.sumUsage([support.usage, attack.usage, response.usage])
      },
      arguments: {
        pro: support.arguments,
        contra: attack.arguments
      }
    };
  }

  private evaluateLocally(
    [support, attack]: [AgentDebateResponse, AgentDebateResponse],
    language: "auto" | "ru" | "en",
    configuredJudge?: string,
    fallbackReason?: string,
    judgeDiagnostics?: NonNullable<HypothesisResult["diagnostics"]>["judge"]
  ): HypothesisResult {
    const supportScore = this.score(support);
    const attackScore = this.score(attack);
    const supportWins = supportScore >= attackScore;
    const winningSide = supportWins ? support : attack;
    const losingSide = supportWins ? attack : support;
    const confidence = Number(
      Math.min(0.95, 0.55 + Math.abs(supportScore - attackScore) / 10).toFixed(2)
    );

    return {
      verdict: supportWins ? "support" : "attack",
      confidence,
      reasoning: this.buildLocalReasoning(winningSide, losingSide, language),
      participants: {
        support: `${support.provider}:${support.model}`,
        attack: `${attack.provider}:${attack.model}`,
        judge: "local"
      },
      configuredParticipants: configuredJudge
        ? {
            judge: configuredJudge
          }
        : undefined,
      fallback: {
        used: Boolean(configuredJudge),
        reason:
          fallbackReason ??
          (language === "ru"
            ? "Сработал локальный judge без model-based fallback."
            : "Local judge was used directly.")
      },
      diagnostics: {
        judge:
          judgeDiagnostics ??
          {
            requestedTarget: configuredJudge ?? "local",
            responseTarget: "local",
            providerCall: configuredJudge ? "failed" : "local",
            structuredOutput: configuredJudge ? "rejected" : "n/a",
            fallbackUsed: Boolean(configuredJudge),
            fallbackReason:
              fallbackReason ??
              (language === "ru"
                ? "Сработал локальный judge без model-based fallback."
                : "Local judge was used directly.")
          }
      },
      metrics: {
        startedAt: new Date(0).toISOString(),
        completedAt: new Date(0).toISOString(),
        durationMs: 0,
        usage: this.sumUsage([support.usage, attack.usage])
      },
      arguments: {
        pro: support.arguments,
        contra: attack.arguments
      }
    };
  }

  private normalizePayload(
    payload: JudgePayload | null
  ): { verdict: "support" | "attack"; confidence: number; reasoning: string } | null {
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const verdictCandidate = [payload.verdict, payload.winner, payload.decision]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0)
      ?.toLowerCase()
      .trim();

    const verdict =
      verdictCandidate === "attack" || verdictCandidate === "contra" || verdictCandidate === "con"
        ? "attack"
        : verdictCandidate === "support" || verdictCandidate === "pro"
          ? "support"
          : null;

    const reasoning = [payload.reasoning, payload.rationale, payload.explanation]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0)
      ?.trim();

    const confidence = this.normalizeConfidence(payload.confidence);

    if (!verdict || typeof confidence !== "number" || !reasoning) {
      return null;
    }

    return {
      verdict,
      confidence,
      reasoning
    };
  }

  private normalizeConfidence(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 1 ? value / 100 : value;
    }

    if (typeof value === "string") {
      const normalized = value.trim().replace("%", "");
      const numeric = Number(normalized);

      if (Number.isFinite(numeric)) {
        return numeric > 1 ? numeric / 100 : numeric;
      }
    }

    return null;
  }

  private score(response: AgentDebateResponse): number {
    const argumentWeight = response.arguments.length * 2;
    const summaryWeight = Math.min(response.summary.length / 80, 3);
    return argumentWeight + summaryWeight;
  }

  private buildLocalReasoning(
    winningSide: AgentDebateResponse,
    losingSide: AgentDebateResponse,
    language: "auto" | "ru" | "en"
  ): string {
    if (language === "ru") {
      return [
        `${winningSide.agent} дал ${winningSide.arguments.length} более сильных аргумента(ов).`,
        `${losingSide.agent} дал ${losingSide.arguments.length} контраргумента(ов).`,
        "Судья использовал локальную эвристическую оценку."
      ].join(" ");
    }

    return [
      `${winningSide.agent} produced ${winningSide.arguments.length} stronger argument(s).`,
      `${losingSide.agent} produced ${losingSide.arguments.length} counterpoint(s).`,
      "Judge used local heuristic scoring."
    ].join(" ");
  }

  private sumUsage(items: Array<TokenUsage | undefined>): TokenUsage | undefined {
    const totals = items.reduce<{
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      seen: boolean;
    }>(
      (acc, usage) => {
        if (!usage) {
          return acc;
        }

        if (typeof usage.inputTokens === "number") {
          acc.inputTokens += usage.inputTokens;
        }

        if (typeof usage.outputTokens === "number") {
          acc.outputTokens += usage.outputTokens;
        }

        if (typeof usage.totalTokens === "number") {
          acc.totalTokens += usage.totalTokens;
        }

        acc.seen = true;
        return acc;
      },
      { inputTokens: 0, outputTokens: 0, totalTokens: 0, seen: false }
    );

    if (!totals.seen) {
      return undefined;
    }

    return {
      inputTokens: totals.inputTokens || undefined,
      outputTokens: totals.outputTokens || undefined,
      totalTokens: totals.totalTokens || undefined
    };
  }
}
