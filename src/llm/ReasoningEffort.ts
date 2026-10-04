import { ReasoningEffort } from "../types";

export const reasoningEffortLevels: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

export const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  typeof value === "string" && reasoningEffortLevels.includes(value as ReasoningEffort);

/**
 * llama.cpp's Qwen-style thinking budget. 0 disables thinking, so even the
 * lowest visible level keeps a small but useful budget.
 */
export const localThinkingBudgetForEffort = (effort: ReasoningEffort | undefined): number => ({
  low: 128,
  medium: 512,
  high: 1024,
  xhigh: 2048,
  max: 4096
})[effort ?? "medium"];

export const reasoningEffortLabel = (effort: ReasoningEffort): string => ({
  low: "Low",
  medium: "Balanced",
  high: "High",
  xhigh: "Extra high",
  max: "Max"
})[effort];
