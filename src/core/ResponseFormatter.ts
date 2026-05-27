import { ProcessResult } from "../types";

export class ResponseFormatter {
  formatForChat(result: ProcessResult, options?: { maxChars?: number }): string {
    const textResponse =
      "response" in result.result
        ? this.renderTextResponse(result.result.response, result.result.provider, result.result.model)
        : "";
    const hasSubagents = "response" in result.result && Boolean(result.result.subagents?.length);
    const collector = hasSubagents && "response" in result.result
      ? result.result.subagents?.find((agent) => agent.role === "writer") ?? result.result.subagents?.[0]
      : undefined;
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
          ? hasSubagents
            ? [
                "Response",
                "",
                ...this.renderMultiAgentSummary(result.result.subagents ?? [], {
                  provider: result.result.provider,
                  model: result.result.model,
                  collectorName: collector?.name
                }),
                "",
                "Agent outputs",
                ...this.renderSubagentOutputs(result.result.subagents ?? []),
                "",
                "Final answer",
                "",
                textResponse
              ]
                .filter((line): line is string => line !== undefined)
                .join("\n")
            : [
                "Response",
                "",
                `Provider: ${result.result.provider}`,
                `Model: ${result.result.model}`,
                "",
                textResponse
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

  private renderTextResponse(response: string, provider: string, model: string): string {
    if (!/^Mock response from /i.test(response.trim())) {
      return response;
    }

    const providerLabel = provider === "lmstudio" ? "LM Studio" : provider;
    const modelLabel = model ? ` (${model})` : "";

    return [
      `Provider request failed or timed out for ${providerLabel}${modelLabel}.`,
      "Check that the provider is running, the selected model is loaded, and the timeout is high enough for this model."
    ].join("\n");
  }

  private renderMultiAgentSummary(
    subagents: NonNullable<ProcessResult["result"] extends infer Result
      ? Result extends { subagents?: infer Agents }
        ? Agents
        : never
      : never>,
    collector: { provider: string; model: string; collectorName?: string }
  ): string[] {
    const researchAgents = subagents.filter((agent) => agent.role === "advisor");
    const okCount = researchAgents.filter((agent) => agent.status === "ok").length;
    const failedCount = researchAgents.length - okCount;
    const names = researchAgents.map((agent) => `@${agent.name}`).join(", ") || "none";
    const status = failedCount > 0 ? `${okCount} ok / ${failedCount} failed` : `${okCount} ok`;
    const collectorLabel = collector.collectorName
      ? `@${collector.collectorName} via ${collector.provider}:${collector.model}`
      : `${collector.provider}:${collector.model}`;

    return [
      "Multi-agent run",
      `Research agents: ${names}`,
      `Research status: ${status}`,
      `Final collector: ${collectorLabel}`
    ];
  }

  private renderSubagentOutputs(subagents: NonNullable<ProcessResult["result"] extends infer Result
    ? Result extends { subagents?: infer Agents }
      ? Agents
      : never
    : never>): string[] {
    return subagents
      .filter((agent) => agent.output?.trim() || agent.status === "degraded")
      .flatMap((agent) => {
      const roleLabel = agent.role === "advisor" ? "research" : agent.role;
      const label = `@${agent.name} (${roleLabel})`;
      const body =
        agent.output?.trim() ||
        (agent.error
          ? `Provider request failed or timed out: ${agent.error}`
          : agent.status === "degraded"
            ? "Provider request failed or timed out."
            : "No separate note was returned.");

      return ["", label, this.truncateAgentOutput(body)];
    });
  }

  private truncateAgentOutput(value: string): string {
    const maxChars = 2200;
    const normalized = value.trim();

    if (normalized.length <= maxChars) {
      return normalized;
    }

    return `${normalized.slice(0, maxChars).replace(/\s+$/g, "")}\n...[trimmed]`;
  }
}
