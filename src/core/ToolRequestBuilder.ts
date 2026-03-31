import { MemoryEntry, Mode, ModeResult, ToolExecutionRequest } from "../types";

interface BuildToolRequestInput {
  rawInput: string;
  mode: Mode;
  result: ModeResult;
  context: ToolExecutionRequest["context"];
}

const renderModeResult = (mode: Mode, result: ModeResult): string => {
  if (mode === "hypothesis" && "arguments" in result) {
    return [
      `Verdict: ${result.verdict}`,
      `Confidence: ${result.confidence}`,
      `Reasoning: ${result.reasoning}`,
      "",
      "Pro arguments:",
      ...result.arguments.pro.map((item) => `- ${item}`),
      "",
      "Contra arguments:",
      ...result.arguments.contra.map((item) => `- ${item}`)
    ].join("\n");
  }

  return "response" in result ? result.response : JSON.stringify(result, null, 2);
};

const renderConversation = (entries: MemoryEntry[]): string => {
  if (entries.length === 0) {
    return "No prior conversation entries were found for this session.";
  }

  return entries
    .slice()
    .reverse()
    .map((entry) => {
      const output =
        typeof entry.output === "string"
          ? entry.output
          : JSON.stringify(entry.output, null, 2).slice(0, 600);

      return [
        `At: ${entry.createdAt}`,
        `Input: ${entry.input}`,
        `Output: ${output}`
      ].join("\n");
    })
    .join("\n\n---\n\n");
};

export class ToolRequestBuilder {
  build(input: BuildToolRequestInput): ToolExecutionRequest {
    const title = this.buildTitle(input.rawInput, input.mode);
    const content = [
      `Mode: ${input.mode}`,
      `Session: ${input.context.actor.sessionId}`,
      `Channel: ${input.context.actor.channel}`,
      "",
      "Current request:",
      input.rawInput,
      "",
      "Current result:",
      renderModeResult(input.mode, input.result),
      "",
      "Conversation context:",
      renderConversation(input.context.conversation)
    ].join("\n");

    return {
      rawInput: input.rawInput,
      title,
      content,
      context: input.context,
      result: input.result
    };
  }

  private buildTitle(rawInput: string, mode: Mode): string {
    const cleaned = rawInput
      .replace(/(?:save|write|make|create|export|сделай|создай|сохрани).*/i, "")
      .replace(/\s+/g, " ")
      .trim();

    if (cleaned) {
      return cleaned.slice(0, 80);
    }

    return `${mode} session note`;
  }
}
