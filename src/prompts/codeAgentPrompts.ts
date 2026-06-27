import { CodeAgentTarget, LanguagePreference, OutputStyle } from "../types";
import { buildLanguageInstruction, buildTextPrompt } from "./common";

const buildCodeAdvisorInstruction = (style: OutputStyle): string => {
  switch (style) {
    case "compact":
      return "Return only short implementation guidance: architecture, file plan, risks, and concrete suggestions.";
    case "detailed":
      return "Return detailed implementation guidance: architecture, file plan, risks, tradeoffs, and concrete suggestions.";
    case "exhaustive":
      return "Return exhaustive implementation guidance: architecture, file plan, risks, tradeoffs, alternatives, and execution details.";
    case "balanced":
    default:
      return "Return practical implementation guidance: architecture, file plan, risks, and concrete suggestions.";
  }
};

const buildCodeWriterRoleInstruction = (style: OutputStyle): string => {
  switch (style) {
    case "compact":
      return "Produce a concise implementation-ready answer.";
    case "detailed":
      return "Produce a detailed implementation-ready answer.";
    case "exhaustive":
      return "Produce an exhaustive implementation-ready answer with strong coverage of risks and edge cases.";
    case "balanced":
    default:
      return "Produce a practical implementation-ready answer.";
  }
};

const buildNoSubagentBoilerplateInstruction = (): string =>
  [
    "Do not say that you are a subagent, that you were spawned, that you woke up, or that you are ready.",
    "Do not restate the user's command.",
    "Start directly with the requested analysis, answer, plan, or implementation result.",
    "If the request is not actionable, ask one concise clarifying question instead of acknowledging readiness."
  ].join("\n");

export const buildSubagentNameInstruction = (agents: CodeAgentTarget[]): string => {
  const names = agents.map((agent) => `@${agent.name}`).join(", ");

  return [
    `Agent display names: ${names || "none"}.`,
    "These @names are routing labels for the orchestration layer, not libraries, modules, decorators, frameworks, or task subjects.",
    "If you mention any agent in the answer, use only its @Name form.",
    "Never write generic numbered labels such as Subagent 1, Sub-agent 1, Подагент 1, Сабагент 1, Агент 1, or Agent 1.",
    "Never assign tasks to these agents in your answer. Execute your own pass instead."
  ].join("\n");
};

export const stripSubagentRoutingSyntax = (input: string): string => {
  const stripped = input
    .replace(/@[\p{L}\p{N}_-]+/gu, " ")
    .replace(/\bspawn\s+sub-?agents?\b/giu, " ")
    .replace(/\bspawn\b/giu, " ")
    .replace(/\bsub-?agents?\b/giu, " ")
    .replace(/заспавн\p{L}*\s*(?:\d+\s*)?(?:[\p{L}.?-]*агент\p{L}*)?/giu, " ")
    .replace(/заспавн(?:и|ить|ь)?\s*(?:\d+\s*)?(?:с[ау]б.?агент(?:а|ов)?|агент(?:а|ов)?)/giu, " ")
    .replace(/[\p{L}.?-]*агент(?:а|ов|ом|ами)?/giu, " ")
    .replace(/с[ау]б.?агент(?:а|ов)?/giu, " ")
    .replace(/\bwith\s+the\s+goal\s+of\b/giu, " ")
    .replace(/\bto\s+analy[sz]e\b/giu, "analyze")
    .replace(/\band\s+then\b/giu, "and")
    .replace(/с\s+ц[её]?лью/giu, " ")
    .replace(/и\s+потом/giu, "и")
    .replace(/\s+/g, " ")
    .trim();

  return stripped || input.trim();
};

const buildSubagentExecutionContract = (
  input: string,
  taskInput: string,
  agents: CodeAgentTarget[]
): string =>
  [
    buildSubagentNameInstruction(agents),
    "",
    "Actual task to execute:",
    taskInput,
    "",
    "Important:",
    "- The original routing text was intentionally stripped before this prompt.",
    "- Do not interpret @Atlas, @Vector, or any @Name as a software package, decorator, module, framework, or data structure.",
    "- Do not describe how to spawn agents, processes, scripts, or subprocesses.",
    "- Do not write 'Задача для @Name', 'Task for @Name', or instructions for another agent.",
    "- Produce findings, critique, risks, and recommendations from your own independent pass."
  ].join("\n");

const buildCodeAdvisorRoleInstruction = (style: OutputStyle): string => {
  switch (style) {
    case "compact":
      return "Provide compact implementation guidance only.";
    case "detailed":
      return "Provide detailed implementation guidance only.";
    case "exhaustive":
      return "Provide exhaustive implementation guidance only.";
    case "balanced":
    default:
      return "Provide practical implementation guidance only.";
  }
};

const buildSubagentAccessInstruction = (agent: CodeAgentTarget): string =>
  agent.accessMode === "full"
    ? "Access mode: full. You may produce outputs intended for filesystem execution when the user asks for it."
    : "Access mode: default. Do not assume filesystem changes will be executed automatically; write plans normally and expect explicit approval for file operations.";

export const buildCodeAdvisorPrompt = (
  input: string,
  memory: string,
  language: LanguagePreference,
  outputStyle: OutputStyle,
  attachmentContext?: string
): string =>
  [
    "Mode: code",
    "Relevant memory:",
    memory,
    ...(attachmentContext ? ["", attachmentContext] : []),
    "",
    `User input: ${input}`,
    "",
    buildLanguageInstruction(language),
    "",
    "You are one of several advisor agents.",
    "Do not emit file blocks, final file contents, markdown fences, or full project scaffolds.",
    buildCodeAdvisorInstruction(outputStyle)
  ].join("\n");

export const buildIndependentAgentPrompt = (
  input: string,
  taskInput: string,
  memory: string,
  language: LanguagePreference,
  outputStyle: OutputStyle,
  attachmentContext: string | undefined,
  agents: CodeAgentTarget[]
): string =>
  [
    "Mode: code",
    "Relevant memory:",
    memory,
    ...(attachmentContext ? ["", attachmentContext] : []),
    "",
    buildSubagentExecutionContract(input, taskInput, agents),
    "",
    buildLanguageInstruction(language),
    "",
    "You are doing an independent pass. Do not wait for other agents and do not summarize their possible work.",
    "Focus on your own findings, risks, and concrete recommendation for the requested task.",
    "Keep the output structured and useful for a later collector model.",
    buildCodeAdvisorInstruction(outputStyle)
  ].join("\n");

export const buildCodeWriterPrompt = (
  input: string,
  taskInput: string,
  memory: string,
  language: LanguagePreference,
  outputStyle: OutputStyle,
  attachmentContext: string | undefined,
  advisorRuns: Array<{ agent: CodeAgentTarget; normalized: string; degraded: boolean }>
): string => {
  const healthyAdvisorNotes = advisorRuns
    .filter((item) => !item.degraded)
    .map((item) => [`@${item.agent.name}:`, item.normalized].join("\n"))
    .join("\n\n");
  const degradedAdvisorNames = advisorRuns
    .filter((item) => item.degraded)
    .map((item) => item.agent.name);

  return [
    buildTextPrompt("code", taskInput, memory, language, outputStyle, attachmentContext),
    "",
    buildSubagentExecutionContract(input, taskInput, advisorRuns.map((item) => item.agent)),
    "",
    "Advisor notes from other coding agents:",
    healthyAdvisorNotes || "No reliable advisor notes were available.",
    ...(degradedAdvisorNames.length
      ? [
          "",
          `Unavailable advisors: ${degradedAdvisorNames.join(", ")}. Ignore any missing advisor output and continue.`
        ]
      : []),
    "",
    "You are the final writer for this code swarm.",
    "Produce one final implementation-ready answer.",
    "Synthesize the independent findings into a clear answer for the user's actual task.",
    "Do not repeat routing metadata or create new tasks for agents.",
    "Do not output code for spawning agents, subprocesses, CLIs, or orchestration unless the actual task explicitly asks to implement an orchestration system.",
    "If the user asked for file edits or project scaffolding, return only the final write-safe output in the requested format.",
    "Do not include per-agent headings, comparisons, or swarm commentary in the final output."
  ].join("\n");
};

export const buildSingleAgentSystemPrompt = (
  agent: CodeAgentTarget,
  input: string,
  taskInput: string,
  outputStyle: OutputStyle
): string =>
  [
    `You are ${agent.name}, a focused coding agent.`,
    buildSubagentExecutionContract(input, taskInput, [agent]),
    buildSubagentNameInstruction([agent]),
    buildSubagentAccessInstruction(agent),
    buildNoSubagentBoilerplateInstruction(),
    buildCodeWriterRoleInstruction(outputStyle)
  ].join("\n");

export const buildFallbackSingleAgentSystemPrompt = (
  agent: CodeAgentTarget,
  input: string,
  taskInput: string,
  outputStyle: OutputStyle
): string =>
  [
    "You are the main model taking over after a spawned subagent failed or timed out.",
    buildSubagentExecutionContract(input, taskInput, [agent]),
    buildSubagentAccessInstruction(agent),
    buildNoSubagentBoilerplateInstruction(),
    buildCodeWriterRoleInstruction(outputStyle),
    "Complete the user's task directly. Mention failed subagents only if it materially affects the result."
  ].join("\n");

export const buildIndependentAgentSystemPrompt = (
  agent: CodeAgentTarget,
  activeAgents: CodeAgentTarget[],
  outputStyle: OutputStyle
): string =>
  [
    `You are ${agent.name}, an independent coding agent in a multi-agent run.`,
    buildSubagentNameInstruction(activeAgents),
    buildSubagentAccessInstruction(agent),
    buildNoSubagentBoilerplateInstruction(),
    buildCodeAdvisorRoleInstruction(outputStyle)
  ].join("\n");

export const buildCollectorSystemPrompt = (
  agent: CodeAgentTarget,
  activeAgents: CodeAgentTarget[],
  outputStyle: OutputStyle
): string =>
  [
    `You are ${agent.name}, the collector for a multi-agent code run.`,
    buildSubagentNameInstruction(activeAgents),
    buildSubagentAccessInstruction(agent),
    buildNoSubagentBoilerplateInstruction(),
    buildCodeWriterRoleInstruction(outputStyle),
    "Use the independent agent notes as source material.",
    "When file output is requested, produce only the final write-safe output."
  ].join("\n");

export const buildFallbackCollectorSystemPrompt = (
  agent: CodeAgentTarget,
  activeAgents: CodeAgentTarget[],
  outputStyle: OutputStyle
): string =>
  [
    "You are the main model taking over after the collector failed or timed out.",
    buildSubagentNameInstruction(activeAgents),
    buildSubagentAccessInstruction(agent),
    buildNoSubagentBoilerplateInstruction(),
    buildCodeWriterRoleInstruction(outputStyle),
    "Complete the task directly using any available advisor notes. Do not wait for failed agents."
  ].join("\n");
