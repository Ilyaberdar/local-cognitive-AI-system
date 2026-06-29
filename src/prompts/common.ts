import { LanguagePreference, OutputStyle } from "../types";

type TextPromptMode = "code" | "general";

export const buildLanguageInstruction = (language: LanguagePreference): string => {
  switch (language) {
    case "ru":
      return [
        "Respond only in Russian.",
        "Every sentence in the final answer must be in Russian.",
        "Do not switch to English except for product names, model ids, or technical proper nouns."
      ].join(" ");
    case "en":
      return [
        "Respond only in English.",
        "Every sentence in the final answer must be in English.",
        "Do not switch to Russian except for quoted user text or proper nouns."
      ].join(" ");
    default:
      return "Respond in the user's language unless asked otherwise.";
  }
};

export const buildOutputStyleInstruction = (
  style: OutputStyle,
  mode: TextPromptMode
): string => {
  switch (style) {
    case "compact":
      return "Keep the answer compact. Focus on the highest-signal points only.";
    case "detailed":
      return mode === "code"
        ? "Give a detailed implementation-oriented answer. Expand tradeoffs, file plan, and concrete steps."
        : "Give a detailed answer with concrete examples, tradeoffs, and practical next steps.";
    case "exhaustive":
      return mode === "code"
        ? "Give an exhaustive implementation answer. Be thorough, explicit, and cover architecture, files, risks, and edge cases in depth."
        : "Give an exhaustive answer. Cover the topic in depth with examples, caveats, alternatives, and practical guidance.";
    case "balanced":
    default:
      return "Give a balanced answer. Prefer practical steps over theory.";
  }
};

const wantsFilesystemScaffold = (input: string): boolean =>
  /(?:create|build|make).*(?:project|app|api|service|bot|scaffold|files?)|создай.*(?:проект|приложение|api|сервис|бот|структур|файл)/i.test(
    input
  );

const wantsSingleFileWrite = (input: string): boolean =>
  /(?:write|save|overwrite|update|edit|rewrite|append).*(?:file)|(?:запиши|сохрани|перепиши|обнови|измени|добавь|допиши).*(?:файл)/i.test(
    input
  );

const buildFilesystemInstruction = (input: string): string =>
  wantsFilesystemScaffold(input)
    ? [
        "The user wants real files or a project scaffold.",
        "Return one or more file blocks using this exact format and nothing else outside those blocks for file contents:",
        "<<<FILE:relative/path.ext>>>",
        "file content",
        "<<<END FILE>>>",
        "Use relative paths only.",
        "Include all required files for a minimal working scaffold."
      ].join("\n")
    : wantsSingleFileWrite(input)
      ? [
          "The user wants a real file to be written or updated.",
          "Return only the exact file content that should be written.",
          "Do not add explanations, markdown fences, or commentary.",
          "Do not include file markers unless the user explicitly requests multiple files."
        ].join("\n")
      : "";

export const buildTextPrompt = (
  mode: TextPromptMode,
  input: string,
  memory: string,
  language: LanguagePreference,
  outputStyle: OutputStyle,
  attachmentContext?: string
): string =>
  [
    `Mode: ${mode}`,
    "Relevant memory:",
    memory,
    ...(attachmentContext ? ["", attachmentContext] : []),
    "",
    `User input: ${input}`,
    "",
    buildLanguageInstruction(language),
    ...(buildFilesystemInstruction(input) ? ["", buildFilesystemInstruction(input)] : []),
    "",
    buildOutputStyleInstruction(outputStyle, mode)
  ].join("\n");
