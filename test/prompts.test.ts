import assert from "node:assert/strict";
import test from "node:test";
import { selectConfiguredSubagents } from "../src/agents/code/codeAgentRouting";
import {
  buildSingleAgentSystemPrompt,
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
