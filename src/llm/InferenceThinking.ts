import { AsyncLocalStorage } from "node:async_hooks";
import type { ReasoningEffort } from "../types";

// Keep every inference inside a workflow node on its selected budget, including
// hypothesis/translation calls, without changing simultaneous ordinary chats.
const budgets = new AsyncLocalStorage<number | undefined>();
export const withLocalThinkingBudget = <T>(budget: number | undefined, action: () => T): T => budgets.run(budget, action);
export const currentLocalThinkingBudget = (): number | undefined => budgets.getStore();

// A chat turn's reasoning effort reaches every model call it makes: the agent's steps, debate
// agents, the judge, advisors.
const efforts = new AsyncLocalStorage<ReasoningEffort | undefined>();
export const withReasoningEffort = <T>(effort: ReasoningEffort | undefined, action: () => T): T => efforts.run(effort, action);
export const currentReasoningEffort = (): ReasoningEffort | undefined => efforts.getStore();
