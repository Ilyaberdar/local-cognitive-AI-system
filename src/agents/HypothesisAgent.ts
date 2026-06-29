import { Judge } from "../judge/Judge";
import {
  AgentDebateResponse,
  DebateSettings,
  HypothesisAgentTarget,
  HypothesisResult,
  OutputStyle,
  TokenUsage
} from "../types";
import { AttackAgent } from "./AttackAgent";
import { HypothesisAdvisorAgent } from "./HypothesisAdvisorAgent";
import { SupportAgent } from "./SupportAgent";

const sumUsage = (responses: AgentDebateResponse[]): TokenUsage | undefined => {
  const usage = responses.reduce<TokenUsage>(
    (total, response) => ({
      inputTokens: (total.inputTokens ?? 0) + (response.usage?.inputTokens ?? 0),
      outputTokens: (total.outputTokens ?? 0) + (response.usage?.outputTokens ?? 0),
      totalTokens: (total.totalTokens ?? 0) + (response.usage?.totalTokens ?? 0)
    }),
    {}
  );

  return usage.inputTokens || usage.outputTokens || usage.totalTokens ? usage : undefined;
};

const mergeSide = (
  primary: AgentDebateResponse,
  advisors: AgentDebateResponse[]
): AgentDebateResponse => ({
  ...primary,
  summary: [
    primary.summary,
    ...advisors.map((advisor) => `${advisor.agent}: ${advisor.summary}`)
  ].join("\n"),
  arguments: [
    ...primary.arguments,
    ...advisors.flatMap((advisor) =>
      advisor.arguments.map((argument) => `${advisor.agent}: ${argument}`)
    )
  ],
  raw: [primary.raw, ...advisors.map((advisor) => advisor.raw)].join("\n\n"),
  usage: sumUsage([primary, ...advisors]),
  degraded: primary.degraded && advisors.every((advisor) => advisor.degraded),
  error:
    primary.degraded && advisors.every((advisor) => advisor.degraded)
      ? primary.error ?? advisors.find((advisor) => advisor.error)?.error
      : undefined
});

export class HypothesisAgent {
  constructor(
    private readonly supportAgent: SupportAgent,
    private readonly attackAgent: AttackAgent,
    private readonly advisorAgent: HypothesisAdvisorAgent,
    private readonly judge: Judge
  ) {}

  async runDebate(
    input: string,
    debate: DebateSettings,
    language: "auto" | "ru" | "en",
    outputStyle: OutputStyle,
    attachmentContext?: string,
    advisors: HypothesisAgentTarget[] = [],
    signal?: AbortSignal
  ): Promise<HypothesisResult> {
    const [support, attack, ...advisorResponses] = await Promise.all([
      this.supportAgent.generate(input, debate.support, debate.profile, language, outputStyle, attachmentContext, signal),
      this.attackAgent.generate(input, debate.attack, debate.profile, language, outputStyle, attachmentContext, signal),
      ...advisors.map((advisor) =>
        this.advisorAgent.generate(
          advisor.name,
          input,
          advisor,
          debate.profile,
          language,
          outputStyle,
          attachmentContext,
          signal
        )
      )
    ]);
    const enrichedSupport = mergeSide(
      support,
      advisorResponses.filter((advisor) => !advisor.degraded && advisor.stance === "pro")
    );
    const enrichedAttack = mergeSide(
      attack,
      advisorResponses.filter((advisor) => !advisor.degraded && advisor.stance === "contra")
    );
    const result = await this.judge.evaluate(
      input,
      [enrichedSupport, enrichedAttack],
      debate.judge,
      debate.profile,
      language,
      outputStyle,
      attachmentContext,
      signal
    );

    return {
      ...result,
      participants: {
        ...result.participants,
        advisors: advisorResponses.map((advisor) => `${advisor.provider}:${advisor.model}`)
      },
      subagents: advisorResponses.map((advisor, index) => ({
        id: advisors[index]?.id ?? `hypothesis-advisor-${index + 1}`,
        name: advisors[index]?.name ?? advisor.agent,
        role: "advisor",
        provider: advisor.provider,
        model: advisor.model,
        accessMode: "default",
        status: advisor.degraded ? "degraded" : "ok",
        error: advisor.error,
        output: advisor.degraded
          ? undefined
          : [advisor.summary, ...advisor.arguments.map((argument) => `- ${argument}`)].join("\n")
      }))
    };
  }
}
