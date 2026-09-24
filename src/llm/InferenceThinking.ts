import { AsyncLocalStorage } from "node:async_hooks";

// Keep every inference inside a workflow node on its selected budget, including
// hypothesis/translation calls, without changing simultaneous ordinary chats.
const budgets = new AsyncLocalStorage<number | undefined>();
export const withLocalThinkingBudget = <T>(budget: number | undefined, action: () => T): T => budgets.run(budget, action);
export const currentLocalThinkingBudget = (): number | undefined => budgets.getStore();
