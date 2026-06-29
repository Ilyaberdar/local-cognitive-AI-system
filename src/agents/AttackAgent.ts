import { LLMService } from "../llm/LLMService";
import { AgentDebateResponse, DebateProfile, OutputStyle, ProviderTarget } from "../types";
import { buildDebateGuidance, buildLanguageInstruction } from "../judge/DebateProfiles";
import { LanguageEnforcer } from "../llm/LanguageEnforcer";
import { normalizeDebatePayload } from "./debatePayload";

interface DebatePayload {
  summary?: string;
  arguments?: string[];
}

const getStyleTokenBudget = (style: OutputStyle): number => {
  switch (style) {
    case "compact":
      return 1200;
    case "detailed":
      return 4500;
    case "exhaustive":
      return 9000;
    case "balanced":
    default:
      return 2200;
  }
};

const buildAttackInstruction = (style: OutputStyle): string => {
  switch (style) {
    case "compact":
      return "Generate a compact critical case against the hypothesis below with 2 to 3 strong counterarguments.";
    case "detailed":
      return "Generate a detailed critical case against the hypothesis below with 6 to 8 strong counterarguments. Expand each objection with concrete reasoning.";
    case "exhaustive":
      return "Generate an exhaustive critical case against the hypothesis below with 10 to 12 strong counterarguments. Cover multiple angles, tradeoffs, hidden assumptions, and edge cases in depth.";
    case "balanced":
    default:
      return "Generate a balanced critical case against the hypothesis below with 4 to 5 practical counterarguments.";
  }
};

export class AttackAgent {
  constructor(
    private readonly llmService: LLMService,
    private readonly languageEnforcer: LanguageEnforcer
  ) {}

  async generate(
    input: string,
    target: ProviderTarget,
    profile: DebateProfile,
    language: "auto" | "ru" | "en",
    outputStyle: OutputStyle,
    attachmentContext?: string,
    signal?: AbortSignal
  ): Promise<AgentDebateResponse> {
    const { data, response } = await this.llmService.generateObject<DebatePayload>(
      {
        systemPrompt: "You are a rigorous critic producing only structured JSON.",
        model: target.model,
        maxTokens: getStyleTokenBudget(outputStyle),
        signal,
        prompt: [
          buildAttackInstruction(outputStyle),
          buildDebateGuidance(profile),
          buildLanguageInstruction(language),
          ...(attachmentContext ? ["", attachmentContext] : []),
          "",
          `Hypothesis: ${input}`,
          "",
          'Return JSON with keys: "summary" (string), "arguments" (array of strings). The arguments array should match the requested level of detail.'
        ].join("\n")
      },
      target.providerId
    );

    const degraded = Boolean(response.error) || /^Mock response from /i.test(response.text.trim());

    if (degraded) {
      return {
        agent: "AttackAgent",
        stance: "contra",
        provider: response.provider,
        model: response.model,
        summary:
          language === "ru"
            ? "AttackAgent недоступен: провайдер не вернул валидный ответ."
            : "AttackAgent unavailable: provider did not return a valid response.",
        arguments: [],
        raw: response.text,
        usage: response.usage,
        degraded: true,
        error: response.error ?? "Provider request failed or timed out"
      };
    }

    const payload = normalizeDebatePayload(
      data,
      response.text,
      "Counter-case generated.",
      outputStyle
    );
    const argumentsList = payload.arguments;
    const normalizedSummary = await this.languageEnforcer.normalizeText(
      payload.summary,
      language,
      target,
      signal
    );
    const normalizedArguments = await this.languageEnforcer.normalizeMany(
      argumentsList,
      language,
      target,
      signal
    );

    return {
      agent: "AttackAgent",
      stance: "contra",
      provider: response.provider,
      model: response.model,
      summary: normalizedSummary,
      arguments: normalizedArguments,
      raw: response.text,
      usage: response.usage,
      degraded: false
    };
  }
}
