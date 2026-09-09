import { AgentProgressReporter } from "../core/AgentProgressReporter";
import { Judge } from "../judge/Judge";
import {
  AgentDebateResponse,
  DebateSettings,
  HypothesisAgentTarget,
  HypothesisResult,
  OutputStyle,
  ProcessProgressEvent,
  ProviderTarget,
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
    signal?: AbortSignal,
    onProgress?: (event: ProcessProgressEvent) => void
  ): Promise<HypothesisResult> {
    const participants = [
      { id: "support", name: "Support", role: "support", target: debate.support },
      { id: "attack", name: "Attack", role: "attack", target: debate.attack },
      ...advisors.map((advisor) => ({ id: `advisor:${advisor.id}`, name: advisor.name, role: "advisor", target: advisor })),
      { id: "judge", name: "Judge", role: "judge", target: debate.judge }
    ];
    const progress = new AgentProgressReporter(participants.map((item) => ({
      id: item.id, name: item.name, role: item.role, provider: item.target.providerId,
      model: item.target.model, status: "queued", phase: "Waiting"
    })), onProgress);
    const runParticipant = async (
      id: string, target: ProviderTarget, stance: "pro" | "contra", generate: () => Promise<AgentDebateResponse>
    ): Promise<AgentDebateResponse> => {
      signal?.throwIfAborted();
      progress.update(id, "running", "Analyzing");
      let response: AgentDebateResponse;
      try {
        response = await generate();
        signal?.throwIfAborted();
      } catch (error) {
        signal?.throwIfAborted();
        const message = error instanceof Error ? error.message : "Participant failed";
        response = { agent: id, stance, provider: target.providerId, model: target.model || "default",
          summary: message, arguments: [], raw: "", degraded: true, error: message };
      }
      progress.update(id, response.degraded ? "degraded" : "completed", response.degraded ? "Failed" : "Complete", response.error);
      return response;
    };
    const [support, attack, ...advisorResponses] = await Promise.all([
      runParticipant("support", debate.support, "pro", () => this.supportAgent.generate(input, debate.support, debate.profile, language, outputStyle, attachmentContext, signal)),
      runParticipant("attack", debate.attack, "contra", () => this.attackAgent.generate(input, debate.attack, debate.profile, language, outputStyle, attachmentContext, signal)),
      ...advisors.map((advisor) => runParticipant(`advisor:${advisor.id}`, advisor, "pro", () =>
        this.advisorAgent.generate(advisor.name, input, advisor, debate.profile, language, outputStyle, attachmentContext, signal)))
    ]);
    const enrichedSupport = mergeSide(
      support,
      advisorResponses.filter((advisor) => !advisor.degraded && advisor.stance === "pro")
    );
    const enrichedAttack = mergeSide(
      attack,
      advisorResponses.filter((advisor) => !advisor.degraded && advisor.stance === "contra")
    );
    signal?.throwIfAborted();
    progress.update("judge", "running", "Judging");
    let result: HypothesisResult;
    try {
      result = await this.judge.evaluate(input, [enrichedSupport, enrichedAttack], debate.judge,
        debate.profile, language, outputStyle, attachmentContext, signal);
    } catch (error) {
      signal?.throwIfAborted();
      result = await this.judge.evaluate(input, [enrichedSupport, enrichedAttack], { providerId: "local" },
        debate.profile, language, outputStyle, attachmentContext, signal);
      result.fallback = { used: true, reason: error instanceof Error ? error.message : "Judge failed" };
      result.configuredParticipants = { judge: `${debate.judge.providerId}:${debate.judge.model || "default"}` };
    }
    const error = enrichedSupport.degraded && enrichedAttack.degraded
      ? "No hypothesis participant returned usable evidence." : undefined;
    if (error) {
      result = { ...result, error, verdict: "unavailable", confidence: 0, reasoning: error, conclusion: error };
    }
    progress.update("judge", result.fallback?.used || error ? "degraded" : "completed", result.fallback?.used || error ? "Fallback" : "Complete", error || (result.fallback?.used ? result.fallback.reason : undefined));

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
