import type { LLMService } from "../../llm/LLMService";
import { LLMRequest, LLMResponse } from "../../types";

/** A provider's answer that says to slow down: a rate limit or an overload, not a refusal of the request. */
export const slowDown = (text: string | undefined): boolean => !!text && /\bHTTP (?:429|503|529)\b|rate.?limit|too many requests|overloaded/i.test(text);
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(signal!.reason); };
  signal?.addEventListener("abort", stop, { once: true });
});

/** How many requests a provider takes at once: halved on every "slow down" answer, raised by one after
 * each answer that came through, between 1 and the most the run allows. */
class Gate {
  private active = 0;
  private waiting: Array<() => void> = [];
  limit: number;
  constructor(readonly most: number) { this.limit = most; }
  async acquire(signal?: AbortSignal): Promise<void> {
    while (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => { signal?.removeEventListener("abort", stop); resolve(); };
        const stop = () => { this.waiting = this.waiting.filter(item => item !== wake); reject(signal!.reason); };
        this.waiting.push(wake);
        signal?.addEventListener("abort", stop, { once: true });
      });
      signal?.throwIfAborted();
    }
    this.active++;
  }
  release(): void { this.active--; this.waiting.shift()?.(); }
  slower(): void { this.limit = Math.max(1, Math.floor(this.limit / 2)); }
  faster(): void { if (this.limit < this.most) { this.limit++; this.waiting.shift()?.(); } }
}

/** The model service as a run's agents use it: requests to each provider go through its gate, and a
 * "slow down" answer is waited out and the request sent again (its Retry-After, else 2 s doubling up to
 * 60 s, six times at most) without spending the agent's step. */
export function gatedLlm(llm: LLMService, most: number, options: { retries?: number; baseDelayMs?: number; waited?: (providerId: string, ms: number) => void } = {}): LLMService {
  const gates = new Map<string, Gate>();
  const gate = (providerId: string) => { let found = gates.get(providerId); if (!found) { found = new Gate(most); gates.set(providerId, found); } return found; };
  const retries = options.retries ?? 6, base = options.baseDelayMs ?? 2000;
  const send = async <T>(providerId: string | undefined, request: LLMRequest, call: () => Promise<T>, error: (result: T) => string | undefined): Promise<T> => {
    const id = providerId ?? "default";
    for (let attempt = 0; ; attempt++) {
      const current = gate(id);
      await current.acquire(request.signal);
      let result: T | undefined, failure: unknown;
      try { result = await call(); } catch (thrown) { failure = thrown; } finally { current.release(); }
      const message = failure !== undefined ? (failure instanceof Error ? failure.message : String(failure)) : error(result as T);
      if (!slowDown(message) || attempt >= retries || request.signal?.aborted) {
        if (failure === undefined && !message) current.faster();
        if (failure !== undefined) throw failure;
        return result as T;
      }
      current.slower();
      const after = /retry.?after\D{0,4}(\d+(?:\.\d+)?)/i.exec(message ?? "")?.[1];
      const delay = Math.min(60_000, after ? Number(after) * 1000 : base * 2 ** attempt) + Math.floor(Math.random() * 500);
      options.waited?.(id, delay);
      await sleep(delay, request.signal);
    }
  };
  return new Proxy(llm, {
    get(target, property, receiver) {
      if (property === "generateObject") return <T extends object>(request: LLMRequest, providerId?: string) =>
        send(providerId, request, () => target.generateObject<T>(request, providerId), (result: { response: LLMResponse }) => result.response.error);
      if (property === "generateText") return (request: LLMRequest, providerId?: string) =>
        send(providerId, request, () => target.generateText(request, providerId), (result: LLMResponse) => result.error);
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
