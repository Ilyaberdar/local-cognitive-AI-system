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

  // Whole words only: "improve" or "confirm" is not "pro"/"con", "rapid" is not "api", "decode"
  // is not "code" (an editor task once went to a debate this way).
  private isHypothesis(input: string): boolean {
    return /\b(?:hypothes[ie]s|assumptions?|suppose|debate|pros|cons|should we|what if)\b/i.test(input);
  }

  private isCode(input: string): boolean {
    return /\b(?:bugs?|fix(?:es|ed|ing)?|refactor\w*|typescript|javascript|functions?|class(?:es)?|apis?|code|stack trace|errors?|spawn\s+sub-?agents?|sub-?agents?)\b|заспавн.*с[ау]б.?агент|с[ау]б.?агент/i.test(
      input
    );
  }
}
