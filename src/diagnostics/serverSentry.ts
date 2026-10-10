import * as Sentry from "@sentry/node";
import { appVersion, releaseRoot } from "../utils/appVersion";
import type { DiagnosticLog } from "./DiagnosticLog";
import { DIAGNOSTIC_BREADCRUMB, rewriteAppFrames, scrubSentryBreadcrumb, scrubSentryEvent, SENTRY_DSN } from "./sentryScrub";

/** A server's error reports (Sentry, EU region): only while its owner's consent is on, through the
 * same rules as the desktop's (src/diagnostics/sentryScrub.ts). Uncaught errors only; no console
 * lines, requests, local variables or host name. LOCAL_COGNITIVE_SENTRY=off never loads it. */
export const startServerErrorReports = (options: { consent: () => boolean; diagnosticLog?: Pick<DiagnosticLog, "onRecord"> }): boolean => {
  if (process.env.LOCAL_COGNITIVE_SENTRY === "off") return false;
  const root = releaseRoot();
  Sentry.init({
    dsn: SENTRY_DSN,
    release: `local-cognitive-server@${appVersion()}`,
    environment: process.env.LOCAL_COGNITIVE_SENTRY_ENVIRONMENT || "production",
    sendClientReports: false,
    includeServerName: false,
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, genAI: { inputs: false, outputs: false }, databaseQueryData: false },
    defaultIntegrations: false,
    integrations: [Sentry.eventFiltersIntegration(), Sentry.functionToStringIntegration(), Sentry.linkedErrorsIntegration(), Sentry.contextLinesIntegration(),
      Sentry.nodeContextIntegration({ cloudResource: false }), Sentry.onUncaughtExceptionIntegration(), Sentry.onUnhandledRejectionIntegration({ mode: "warn" })],
    maxBreadcrumbs: 50,
    initialScope: { tags: { runtime: "server" } },
    beforeSend: event => scrubSentryEvent(rewriteAppFrames(event as unknown as Record<string, unknown>, root), options.consent()) as unknown as typeof event | null,
    beforeBreadcrumb: crumb => scrubSentryBreadcrumb(crumb as unknown as Record<string, unknown>) as unknown as typeof crumb | null
  });
  options.diagnosticLog?.onRecord(entry => Sentry.addBreadcrumb({ category: DIAGNOSTIC_BREADCRUMB, message: entry.event, data: entry.fields, level: "info", timestamp: Date.parse(entry.at) / 1000 }));
  return true;
};

export const flushServerErrorReports = (timeoutMs = 2_000): Promise<boolean> => Sentry.flush(timeoutMs);
