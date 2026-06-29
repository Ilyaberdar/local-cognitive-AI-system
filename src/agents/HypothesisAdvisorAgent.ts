import { buildDebateGuidance, buildLanguageInstruction } from "../judge/DebateProfiles";
import { LanguageEnforcer } from "../llm/LanguageEnforcer";
import { LLMService } from "../llm/LLMService";
import {
  AgentDebateResponse,
  DebateProfile,
  OutputStyle,
  ProviderTarget
} from "../types";
import { normalizeDebatePayload } from "./debatePayload";

interface AdvisorPayload {
  stance?: "pro" | "contra";
  summary?: string;
  arguments?: string[];
}

const getStyleTokenBudget = (style: OutputStyle): number => {
  switch (style) {
    case "compact":
      return 1000;
    case "detailed":
      return 3200;
    case "exhaustive":
      return 6000;
    case "balanced":
    default:
      return 1800;
  }
};

export class HypothesisAdvisorAgent {
  constructor(
    private readonly llmService: LLMService,
    private readonly languageEnforcer: LanguageEnforcer
  ) {}

  async generate(
    name: string,
    input: string,
    target: ProviderTarget,
    profile: DebateProfile,
    language: "auto" | "ru" | "en",
    outputStyle: OutputStyle,
    attachmentContext?: string,
    signal?: AbortSignal
  ): Promise<AgentDebateResponse> {
    const { data, response } = await this.llmService.generateObject<AdvisorPayload>(
      {
        systemPrompt: "You are an independent debate advisor producing only structured JSON.",
        model: target.model,
        maxTokens: getStyleTokenBudget(outputStyle),
        signal,
        prompt: [
          "Analyze the hypothesis independently. Choose the stronger position after considering evidence, risks, assumptions, and tradeoffs.",
          buildDebateGuidance(profile),
          buildLanguageInstruction(language),
          ...(attachmentContext ? ["", attachmentContext] : []),
          "",
          `Hypothesis: ${input}`,
          "",
          'Return JSON with keys: "stance" ("pro" or "contra"), "summary" (string), "arguments" (array of strings).'
        ].join("\n")
      },
      target.providerId
    );

    const degraded = Boolean(response.error) || /^Mock response from /i.test(response.text.trim());
    if (degraded) {
      return {
        agent: name,
        stance: "pro",
        provider: response.provider,
        model: response.model,
        summary:
          language === "ru"
            ? `${name} недоступен: провайдер не вернул валидный ответ.`
            : `${name} unavailable: provider did not return a valid response.`,
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
      "Independent advisor analysis generated.",
      outputStyle
    );
    const stance = data?.stance === "contra" ? "contra" : "pro";
    const summary = await this.languageEnforcer.normalizeText(payload.summary, language, target, signal);
    const argumentsList = await this.languageEnforcer.normalizeMany(
      payload.arguments,
      language,
      target,
      signal
    );

    return {
      agent: name,
      stance,
      provider: response.provider,
      model: response.model,
      summary,
      arguments: argumentsList,
      raw: response.text,
      usage: response.usage,
      degraded: false
    };
  }
}
