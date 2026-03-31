import { LLMService } from "../llm/LLMService";
import { AgentDebateResponse, DebateProfile, ProviderTarget } from "../types";
import { buildDebateGuidance, buildLanguageInstruction } from "../judge/DebateProfiles";
import { LanguageEnforcer } from "../llm/LanguageEnforcer";
import { normalizeDebatePayload } from "./debatePayload";

interface DebatePayload {
  summary?: string;
  arguments?: string[];
}

export class SupportAgent {
  constructor(
    private readonly llmService: LLMService,
    private readonly languageEnforcer: LanguageEnforcer
  ) {}

  async generate(
    input: string,
    target: ProviderTarget,
    profile: DebateProfile,
    language: "auto" | "ru" | "en"
  ): Promise<AgentDebateResponse> {
    const { data, response } = await this.llmService.generateObject<DebatePayload>(
      {
        systemPrompt: "You are a rigorous analyst producing only structured JSON.",
        model: target.model,
        prompt: [
          "Generate concise supporting arguments for the hypothesis below.",
          buildDebateGuidance(profile),
          buildLanguageInstruction(language),
          "",
          `Hypothesis: ${input}`,
          "",
          'Return JSON with keys: "summary" (string), "arguments" (array of strings).'
        ].join("\n")
      },
      target.providerId
    );

    const payload = normalizeDebatePayload(data, response.text, "Supportive case generated.");
    const argumentsList = payload.arguments;
    const normalizedSummary = await this.languageEnforcer.normalizeText(
      payload.summary,
      language,
      target
    );
    const normalizedArguments = await this.languageEnforcer.normalizeMany(
      argumentsList,
      language,
      target
    );

    return {
      agent: "SupportAgent",
      stance: "pro",
      provider: response.provider,
      model: response.model,
      summary: normalizedSummary,
      arguments: normalizedArguments,
      raw: response.text,
      usage: response.usage
    };
  }
}
