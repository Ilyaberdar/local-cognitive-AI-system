import { ProcessResult } from "../types";

export class ResponseFormatter {
  formatForChat(result: ProcessResult): string {
    const base =
      result.mode === "hypothesis" && "arguments" in result.result
        ? [
            "Debate Result",
            "",
            `Mode: ${result.mode}`,
            `Verdict: ${result.result.verdict}`,
            `Confidence: ${result.result.confidence}`,
            "",
            "Participants",
            `- Support: ${result.result.participants.support}`,
            `- Attack: ${result.result.participants.attack}`,
            `- Judge: ${result.result.participants.judge}`,
            ...(result.result.configuredParticipants?.judge
              ? [`- Configured Judge: ${result.result.configuredParticipants.judge}`]
              : []),
            ...(result.result.fallback?.used
              ? ["", "Judge Fallback", `- Reason: ${result.result.fallback.reason}`]
              : []),
            ...(result.result.diagnostics?.judge
              ? [
                  "",
                  "Judge Diagnostics",
                  `- Requested: ${result.result.diagnostics.judge.requestedTarget}`,
                  ...(result.result.diagnostics.judge.responseTarget
                    ? [`- Response Target: ${result.result.diagnostics.judge.responseTarget}`]
                    : []),
                  `- Provider Call: ${result.result.diagnostics.judge.providerCall}`,
                  `- Structured Output: ${result.result.diagnostics.judge.structuredOutput}`,
                  `- Fallback Used: ${result.result.diagnostics.judge.fallbackUsed ? "yes" : "no"}`,
                  ...(result.result.diagnostics.judge.providerError
                    ? [`- Provider Error: ${result.result.diagnostics.judge.providerError}`]
                    : []),
                  ...(result.result.diagnostics.judge.fallbackReason
                    ? [`- Fallback Reason: ${result.result.diagnostics.judge.fallbackReason}`]
                    : [])
                ]
              : []),
            "",
            "Reasoning",
            `${result.result.reasoning}`,
            "",
            "Pro",
            ...result.result.arguments.pro.map((item) => `- ${item}`),
            "",
            "Contra",
            ...result.result.arguments.contra.map((item) => `- ${item}`)
          ].join("\n")
        : "response" in result.result
          ? [
              "Response",
              "",
              `Provider: ${result.result.provider}`,
              `Model: ${result.result.model}`,
              "",
              result.result.response
            ].join("\n")
          : JSON.stringify(result.result, null, 2);

    const tools =
      result.tools.length > 0
        ? `\n\nTools\n${result.tools.map((tool) => `- ${tool.output}`).join("\n")}`
        : "";

    return `${base}${tools}`.slice(0, 3900);
  }
}
