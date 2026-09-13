import { AsyncLocalStorage } from "node:async_hooks";
import { LLMRequest } from "../types";

// Each concurrently running agent keeps its own observer, including nested translation calls.
const observers = new AsyncLocalStorage<LLMRequest["onProgress"]>();
export const withInferenceProgress = <T>(observer: LLMRequest["onProgress"], action: () => T): T => observers.run(observer, action);
export const currentInferenceProgress = (): LLMRequest["onProgress"] => observers.getStore();
