import assert from "node:assert/strict";
import test from "node:test";
import { selectConfiguredSubagents } from "../src/agents/code/codeAgentRouting";
import {
  buildReviewAgentPrompt,
  buildSingleAgentSystemPrompt,
  extractMainExecutionOutput,
  parseMainDelegationPlan,
  parseMainUserSummary,
  stripSubagentRoutingSyntax
} from "../src/prompts/codeAgentPrompts";
import { buildTextPrompt } from "../src/prompts/common";
import { CodeAgentTarget } from "../src/types";

const agents: CodeAgentTarget[] = [
  {
    id: "atlas",
    name: "Atlas",
    providerId: "lmstudio",
    model: "local-small",
    accessMode: "default"
  },
  {
    id: "nova",
    name: "Nova",
    providerId: "openai",
    model: "gpt-4.1-mini",
    accessMode: "full"
  }
];

test("text prompt renderer keeps language, filesystem, and style instructions", () => {
  const prompt = buildTextPrompt(
    "general",
    "write file report.md",
    "- No relevant memory found.",
    "ru",
    "compact"
  );

  assert.match(prompt, /^Mode: general/);
  assert.match(prompt, /Relevant memory:\n- No relevant memory found\./);
  assert.match(prompt, /Respond only in Russian\./);
  assert.match(prompt, /Return only the exact file content that should be written\./);
  assert.match(prompt, /Keep the answer compact\./);
});

test("create file requests require write-safe file markers", () => {
  const prompt = buildTextPrompt(
    "code",
    "Create a file in a current directory and write a neural network",
    "- No relevant memory found.",
    "en",
    "balanced"
  );

  assert.match(prompt, /<<<FILE:relative\/path\.ext>>>/);
  assert.match(prompt, /nothing else outside those blocks/);
});

test("subagent routing syntax is stripped before task prompt construction", () => {
  const stripped = stripSubagentRoutingSyntax(
    "заспавни сабагента @Atlas с целью review src/app/buildRuntime.ts"
  );

  assert.equal(stripped, "review src/app/buildRuntime.ts");
});

test("configured subagent selection respects explicit mentions", () => {
  const selected = selectConfiguredSubagents("Ask @Nova to review this", agents);

  assert.equal(selected.length, 1);
  assert.equal(selected[0].name, "Nova");
});

test("main model delegation plan assigns each agent a separate bounded task", () => {
  const plan = parseMainDelegationPlan(
    [
      "<<<DRAFT>>>",
      "main implementation",
      "<<<END_DRAFT>>>",
      "<<<TASK:atlas>>>",
      "Review numerical correctness only.",
      "<<<END_TASK>>>",
      "<<<TASK:nova>>>",
      "Check tests and edge cases only.",
      "<<<END_TASK>>>"
    ].join("\n"),
    agents
  );

  assert.equal(plan.draft, "main implementation");
  assert.equal(plan.assignments.get("atlas"), "Review numerical correctness only.");
  assert.equal(plan.assignments.get("nova"), "Check tests and edge cases only.");
});

test("missing main-model assignment does not invent work for an agent", () => {
  const plan = parseMainDelegationPlan(
    ["<<<DRAFT>>>", "main implementation", "<<<END_DRAFT>>>"].join("\n"),
    agents
  );

  assert.equal(plan.assignments.has("atlas"), false);
  assert.equal(plan.assignments.has("nova"), false);
});

test("delegated agent prompt contains only its main-model assignment", () => {
  const prompt = buildReviewAgentPrompt(
    "Create code and ask @Atlas to review it",
    "Create code and review it",
    "Check tensor dimensions only.",
    "main implementation",
    "- No relevant memory found.",
    "en",
    "balanced",
    undefined,
    agents
  );

  assert.match(prompt, /Your task, assigned by the main model:\nCheck tensor dimensions only\./);
  assert.match(prompt, /Do not broaden your role/);
  assert.doesNotMatch(prompt, /Check tests and edge cases/);
});

test("final response parsing separates execution payload from user summary", () => {
  const leakedDraft = [
    "<<<DRAFT>>>",
    "<<<FILE:main.py>>>",
    "print('hidden')",
    "<<<END FILE>>>",
    "<<<END_DRAFT>>>",
    "<<<TASK:atlas>>>",
    "Review the code",
    "<<<END_TASK>>>"
  ].join("\n");

  assert.equal(
    extractMainExecutionOutput(leakedDraft, "fallback"),
    ["<<<FILE:main.py>>>", "print('hidden')", "<<<END FILE>>>"].join("\n")
  );
  assert.equal(
    parseMainUserSummary(
      ["<<<USER_SUMMARY>>>", "Implemented and validated the requested file.", "<<<END_USER_SUMMARY>>>"].join("\n")
    ),
    "Implemented and validated the requested file."
  );
});

test("single agent system prompt is built outside runtime composition", () => {
  const prompt = buildSingleAgentSystemPrompt(
    agents[0],
    "spawn subagent @Atlas to inspect code",
    "inspect code",
    "balanced"
  );

  assert.match(prompt, /You are Atlas, a focused coding agent\./);
  assert.match(prompt, /Actual task to execute:\ninspect code/);
  assert.match(prompt, /Access mode: default\./);
  assert.match(prompt, /Produce a practical implementation-ready answer\./);
});
