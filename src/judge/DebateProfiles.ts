import { DebateProfile } from "../types";

const PROFILE_GUIDANCE: Record<DebateProfile, string[]> = {
  general: [
    "Focus on overall validity, tradeoffs, and hidden assumptions.",
    "Prefer concise, concrete arguments."
  ],
  technical: [
    "Focus on feasibility, architecture risk, scalability, complexity, and maintainability.",
    "Call out implementation constraints and operational cost."
  ],
  product: [
    "Focus on user value, product risk, UX impact, adoption friction, and business tradeoffs.",
    "Consider who benefits and who pays the cost."
  ],
  research: [
    "Focus on evidence quality, falsifiability, uncertainty, and alternative explanations.",
    "Distinguish assumptions from validated facts."
  ],
  security: [
    "Focus on threat models, abuse paths, data exposure, reliability, and failure modes.",
    "Prioritize safety-critical risks over convenience."
  ]
};

export const buildDebateGuidance = (profile: DebateProfile): string =>
  PROFILE_GUIDANCE[profile].join(" ");

export const buildLanguageInstruction = (language: "auto" | "ru" | "en"): string => {
  switch (language) {
    case "ru":
      return [
        "Respond only in Russian.",
        "Every sentence, summary, and argument must be in Russian.",
        "Do not switch to English except for product names, model ids, or technical proper nouns."
      ].join(" ");
    case "en":
      return [
        "Respond only in English.",
        "Every sentence, summary, and argument must be in English.",
        "Do not switch to Russian except for quoted user text or proper nouns."
      ].join(" ");
    default:
      return "Respond in the user's language unless asked otherwise.";
  }
};
