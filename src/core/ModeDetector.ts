import { Mode } from "../types";

export class ModeDetector {
  detect(input: string): Mode {
    const normalized = input.toLowerCase();

    if (this.isHypothesis(normalized)) {
      return "hypothesis";
    }

    if (this.isCode(normalized)) {
      return "code";
    }

    return "general";
  }

  private isHypothesis(input: string): boolean {
    return /hypothesis|assumption|suppose|debate|pros?|cons?|should we|what if/i.test(input);
  }

  private isCode(input: string): boolean {
    return /bug|fix|refactor|typescript|javascript|function|class|api|code|stack trace|error/i.test(
      input
    );
  }
}
