import { AsyncLocalStorage } from "node:async_hooks";

/** Where a model call was made: a chat turn or a workflow run, with its session and run. Every
 * model call inside, nested ones too, is recorded with it; a request's `usagePurpose` says which
 * role made the call (an agent, the judge, a translation, a synthesis step, a provider test). */
export interface UsageScope {
  origin?: "chat" | "workflow";
  purpose?: string;
  runId?: string;
  sessionId?: string;
}

const scopes = new AsyncLocalStorage<UsageScope>();
/** Runs an action with the current scope narrowed by these fields. */
export const withUsageScope = <T>(scope: UsageScope, action: () => T): T =>
  scopes.run({ ...scopes.getStore(), ...Object.fromEntries(Object.entries(scope).filter(([, value]) => value !== undefined)) }, action);
export const currentUsageScope = (): UsageScope => scopes.getStore() ?? {};
