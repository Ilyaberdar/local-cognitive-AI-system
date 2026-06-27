import { CodeAgentTarget } from "../../types";

export const hasSubagentTrigger = (input: string): boolean =>
  /spawn\s+sub-?agent|sub-?agent|заспавн.*с[ау]б.?агент|с[ау]б.?агент/i.test(input);

export const parseMentionedSubagentNames = (input: string): string[] =>
  Array.from(input.matchAll(/@([\p{L}\p{N}_-]+)/gu)).map((match) => match[1].toLowerCase());

const rankSubagentCost = (agent: CodeAgentTarget): number => {
  const providerScore =
    agent.providerId === "lmstudio" || agent.providerId === "ollama"
      ? 0
      : agent.providerId === "gemini"
        ? 20
        : agent.providerId === "openai"
          ? 30
          : agent.providerId === "anthropic"
            ? 40
            : 50;
  const model = (agent.model ?? "").toLowerCase();
  const modelScore =
    /nano|mini|flash|haiku|small|lite|3b|4b|7b|8b/.test(model)
      ? -5
      : /pro|sonnet|medium|14b|20b|32b/.test(model)
        ? 5
        : /opus|large|70b|120b/.test(model)
          ? 15
          : 0;

  return providerScore + modelScore;
};

export const selectConfiguredSubagents = (
  input: string,
  configuredAgents: CodeAgentTarget[]
): CodeAgentTarget[] => {
  const mentionedNames = parseMentionedSubagentNames(input);

  if (mentionedNames.length > 0) {
    const selected = configuredAgents.filter((agent) =>
      mentionedNames.includes(agent.name.toLowerCase())
    );

    return selected.length > 0 ? selected.slice(0, 4) : [];
  }

  if (!hasSubagentTrigger(input)) {
    return [];
  }

  return configuredAgents
    .slice()
    .sort((left, right) => rankSubagentCost(left) - rankSubagentCost(right))
    .slice(0, 1);
};
