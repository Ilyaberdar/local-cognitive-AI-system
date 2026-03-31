import { Judge } from "../judge/Judge";
import { DebateSettings, HypothesisResult } from "../types";
import { AttackAgent } from "./AttackAgent";
import { SupportAgent } from "./SupportAgent";

export class HypothesisAgent {
  constructor(
    private readonly supportAgent: SupportAgent,
    private readonly attackAgent: AttackAgent,
    private readonly judge: Judge
  ) {}

  async runDebate(
    input: string,
    debate: DebateSettings,
    language: "auto" | "ru" | "en"
  ): Promise<HypothesisResult> {
    const [support, attack] = await Promise.all([
      this.supportAgent.generate(input, debate.support, debate.profile, language),
      this.attackAgent.generate(input, debate.attack, debate.profile, language)
    ]);

    return this.judge.evaluate(input, [support, attack], debate.judge, debate.profile, language);
  }
}
