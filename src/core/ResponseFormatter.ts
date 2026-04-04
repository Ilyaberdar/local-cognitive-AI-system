import { ProcessResult } from "../types";

export class ResponseFormatter {
  formatForChat(result: ProcessResult, options?: { maxChars?: number }): string {
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
            ...(result.result.diagnostics?.agents &&
            (result.result.diagnostics.agents.support?.status === "failed" ||
              result.result.diagnostics.agents.attack?.status === "failed")
              ? [
                  "",
                  "Agent Issues",
                  ...(result.result.diagnostics.agents.support?.status === "failed"
                    ? [
                        `- Support provider failed${
                          result.result.diagnostics.agents.support.providerError
                            ? `: ${result.result.diagnostics.agents.support.providerError}`
                            : ""
                        }`
                      ]
                    : []),
                  ...(result.result.diagnostics.agents.attack?.status === "failed"
                    ? [
                        `- Attack provider failed${
                          result.result.diagnostics.agents.attack.providerError
                            ? `: ${result.result.diagnostics.agents.attack.providerError}`
                            : ""
                        }`
                      ]
                    : [])
                ]
              : []),
            "",
            "Reasoning",
            `${result.result.reasoning}`,
            "",
            "Judge Conclusion",
            `${result.result.conclusion}`,
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

    const content = `${base}${tools}`;
    const maxChars = options?.maxChars;

    if (typeof maxChars === "number" && Number.isFinite(maxChars)) {
      return content.slice(0, maxChars);
    }

    return content;
  }
}
