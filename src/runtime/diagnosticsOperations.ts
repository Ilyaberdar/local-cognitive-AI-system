import { z } from "zod";
import type { RuntimeManager } from "../app/RuntimeManager";
import type { DiagnosticLog } from "../diagnostics/DiagnosticLog";
import { readConsent, writeConsent } from "../diagnostics/consentFile";
import { collectRuntimeDiagnostics } from "../diagnostics/snapshot";
import { RemoteOperationError, type RemoteOperation } from "../remote/host/RemoteHost";

const input = z.object({ includeLog: z.boolean().optional() }).strict();
const LOG_BYTES = 256 * 1024;

/** The server's part of a bug report (spec §11), for its owner's devices only and only when the
 * user asks: the same strict diagnostics as a computer's, the server's phase and work counts, and,
 * if wanted, its technical log (codes and counts). Its own disclosure, shown before sending. */
const consentInput = z.object({ automatic: z.boolean() }).strict();

export const createDiagnosticsOperations = (deps: { runtimeManager: RuntimeManager; diagnosticLog?: Pick<DiagnosticLog, "tail">; owner: () => string | undefined;
  status: () => { phase: string; activeWork: object }; consentFile?: string }): Record<string, RemoteOperation> => {
  const ownerOnly = (context: { accountId: string }) => {
    const owner = deps.owner();
    if (!owner || owner !== context.accountId) throw new RemoteOperationError("Diagnostics of this server are its owner's.", "forbidden");
  };
  return {
  // The server's error reports to the developer: its owner's choice, from their computer.
  "diagnostics.consent.get": (_payload, context) => {
    ownerOnly(context);
    return { available: Boolean(deps.consentFile), ...(deps.consentFile ? readConsent(deps.consentFile) : { automatic: false, decidedAt: null }) };
  },
  "diagnostics.consent.set": (payload, context) => {
    const request = consentInput.safeParse(payload);
    if (!request.success) throw new RemoteOperationError("The request is not valid.", "invalid_request");
    ownerOnly(context);
    if (!deps.consentFile) throw new RemoteOperationError("Error reports are not available on this server.", "unavailable");
    return { available: true, ...writeConsent(deps.consentFile, request.data.automatic) };
  },
  "diagnostics.collect": async (payload, context) => {
    const request = input.safeParse(payload ?? {});
    if (!request.success) throw new RemoteOperationError("The request is not valid.", "invalid_request");
    ownerOnly(context);
    const snapshot = await collectRuntimeDiagnostics({ runtimeManager: deps.runtimeManager, diagnosticLog: deps.diagnosticLog, runtimeKind: "server" });
    const { phase, activeWork } = deps.status();
    // Work in progress as numbers and flags only.
    const work = Object.fromEntries(Object.entries(activeWork).filter(([, value]) => typeof value === "number" || typeof value === "boolean"));
    return { snapshot, server: { phase: phase === "draining" ? "draining" : "running", activeWork: work },
      ...(request.data.includeLog ? { log: deps.diagnosticLog?.tail({ days: 14, maxBytes: LOG_BYTES }) ?? [] } : {}) };
  }
  };
};
