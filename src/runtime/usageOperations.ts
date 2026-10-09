import os from "node:os";
import { z } from "zod";
import { RemoteOperationError, type RemoteOperation } from "../remote/host/RemoteHost";
import type { UsageLedger } from "../usage/UsageLedger";
import type { UsageOutbox } from "../usage/UsageOutbox";
import { addTotals, daysFromQuarters, emptyTotals, knownTimeZone } from "../usage/UsageProjection";

const pendingInput = z.object({
  timeZone: z.string().max(64),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** The Cloud's cut-off; without it (Cloud unreachable) everything of the owner. */
  asOf: z.iso.datetime({ offset: true }).optional()
}).strict();

/** The server's part of its owner's Usage page (spec §10): what the Cloud had not received from it
 * by the page's cut-off, by day in the page's time zone. Sent first, so usually nothing. Only for
 * the owner's devices, and only counts. */
export const createUsageOperations = (deps: { ledger?: UsageLedger; outbox?: UsageOutbox; owner: () => string | undefined }): Record<string, RemoteOperation> => ({
  "usage.pending": async (payload, context) => {
    const input = pendingInput.safeParse(payload);
    if (!input.success) throw new RemoteOperationError("The request is not valid.", "invalid_request");
    const owner = deps.owner();
    if (!owner || owner !== context.accountId) throw new RemoteOperationError("Usage of this server is its owner's.", "forbidden");
    if (!deps.ledger) return { available: false };
    await deps.outbox?.flush(3_000, true).catch(() => undefined);
    const timeZone = knownTimeZone(input.data.timeZone);
    const ledger = deps.ledger.quarters({ accountId: owner, ...(input.data.asOf ? { missingFromCloudAt: input.data.asOf } : {}) });
    const { days, before } = daysFromQuarters(ledger.quarters, timeZone, input.data.from);
    return { available: true, name: os.hostname().slice(0, 120), runtimeId: deps.ledger.runtimeId, timeZone, days, before,
      lifetime: ledger.quarters.reduce((total, quarter) => addTotals(total, quarter), emptyTotals()), firstEventAt: ledger.firstEventAt,
      unsent: deps.ledger.pendingCount(owner) };
  }
});
