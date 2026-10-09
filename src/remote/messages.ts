import { z } from "zod";

/** Messages inside the end-to-end channel (spec §6.3). The relay never sees them. */
const id = z.string().min(1).max(128);
export const helloMessage = z.object({
  type: z.literal("hello"), protocol: z.number().int().positive(), purpose: z.enum(["pair", "connect"]),
  accountId: id, deviceId: id, deviceName: z.string().max(120).optional(), invitationId: id.optional(), proof: z.string().max(128).optional()
}).strict();
export type HelloMessage = z.infer<typeof helloMessage>;

export const welcomeMessage = z.object({
  type: z.literal("welcome"), protocol: z.number().int().positive(), hostId: id, hostName: z.string().max(120), serverVersion: z.string().max(64),
  capabilities: z.array(z.string().max(64)).max(256), authExpiresAt: z.number().int().positive()
});
export type WelcomeMessage = z.infer<typeof welcomeMessage>;

export const deniedMessage = z.object({ type: z.literal("denied"), code: z.string().max(64), message: z.string().max(500) });
export const requestMessage = z.object({ type: z.literal("request"), id: z.number().int().nonnegative(), op: z.string().min(1).max(64), payload: z.unknown().optional() }).strict();
export const responseMessage = z.object({ type: z.literal("response"), id: z.number().int().nonnegative(), result: z.unknown().optional() });
export const errorMessage = z.object({ type: z.literal("error"), id: z.number().int().nonnegative(), code: z.string().max(64), message: z.string().max(2000) });
export const closingMessage = z.object({ type: z.literal("closing"), reason: z.string().max(64) });

export const MAX_REQUESTS_IN_FLIGHT = 16;

/** Contexts of host signatures toward the Cloud (apps/cloud/src/remote/signatures.ts). */
export const SIGNATURE_CONTEXT = {
  register: "lc-host-register/v1",
  relayAuth: "lc-relay-host-auth/v1",
  usageBatch: "lc-usage-batch/v1",
  claim: "lc-claim-receipt/v1",
  revoke: "lc-host-revoke/v1"
} as const;
export const relayAuthMessage = (hostId: string, nonce: string, origin: string): Buffer => Buffer.from(JSON.stringify([hostId, nonce, origin]));
