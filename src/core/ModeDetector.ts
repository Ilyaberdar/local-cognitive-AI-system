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
    return /bug|fix|refactor|typescript|javascript|function|class|api|code|stack trace|error|spawn\s+sub-?agent|sub-?agent|заспавн.*с[ау]б.?агент|с[ау]б.?агент/i.test(
      input
    );
  }
}
