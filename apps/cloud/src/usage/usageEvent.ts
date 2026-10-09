import { z } from "zod";

const count = z.number().int().min(0).max(1e13).nullable().optional();
const reference = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable().optional();
const time = z.iso.datetime({ offset: true });

/** One request to a model as a runtime sends it: counts and opaque references, no content. */
export const usageEvent = z.object({
  eventId: z.uuid(), accountId: z.uuid(), callId: z.uuid(), attempt: z.number().int().min(1).max(1000),
  runRef: reference, sessionRef: reference,
  origin: z.string().regex(/^[a-z-]{1,32}$/).nullable().optional(),
  purpose: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/).nullable().optional(),
  provider: z.string().min(1).max(64), model: z.string().min(1).max(128),
  startedAt: time, occurredAt: time,
  outcome: z.enum(["completed", "rejected", "failed", "cancelled"]),
  httpStatus: z.number().int().min(100).max(599).nullable().optional(),
  usageSource: z.enum(["reported", "estimated", "unknown"]),
  inputTokens: count, outputTokens: count, totalTokens: count, cachedInputTokens: count, cacheWriteTokens: count, reasoningTokens: count
}).strict();
export type UsageEvent = z.infer<typeof usageEvent>;

export const MAX_BATCH_EVENTS = 50;
/** Events from the future are refused: a host's clock may run ahead a little, not hours. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
