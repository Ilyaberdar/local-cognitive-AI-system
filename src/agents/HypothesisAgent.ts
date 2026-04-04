import { Judge } from "../judge/Judge";
import { DebateSettings, HypothesisResult, OutputStyle } from "../types";
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
    language: "auto" | "ru" | "en",
    outputStyle: OutputStyle,
    attachmentContext?: string
  ): Promise<HypothesisResult> {
    const [support, attack] = await Promise.all([
      this.supportAgent.generate(input, debate.support, debate.profile, language, outputStyle, attachmentContext),
      this.attackAgent.generate(input, debate.attack, debate.profile, language, outputStyle, attachmentContext)
    ]);

    return this.judge.evaluate(
      input,
      [support, attack],
      debate.judge,
      debate.profile,
      language,
      outputStyle,
      attachmentContext
    );
  }
}
