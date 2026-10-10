const fs = require("fs");
const path = require("path");
const { app } = require("electron");

// Error and crash reports (Sentry, EU region). Started at the top of main.cjs: the native crash
// handler must run before the app is ready. Nothing automatic is sent without the user's consent
// (Settings → Data & Privacy); a bug report is sent when the user presses Send. What may leave is
// decided in src/diagnostics/sentryScrub.ts. No Session Replay, no screenshots attached to errors.
const disabled = { enabled: false, consent: () => ({ automatic: false, decidedAt: null, available: false }), setConsent: () => ({ automatic: false, decidedAt: null, available: false }),
  rendererError: () => {}, attachLog: () => {}, sendFeedback: async () => { throw new Error("Bug reports are not available in this build."); } };

function startSentry() {
  // Tests and an explicit opt-out never load the SDK.
  if (process.env.LOCAL_COGNITIVE_TEST_DATA_DIR || process.env.LOCAL_COGNITIVE_SENTRY === "off") return disabled;
  const Sentry = require("@sentry/electron/main");
  const { SENTRY_DSN, DIAGNOSTIC_BREADCRUMB, maskText, scrubSentryBreadcrumb, scrubSentryEvent } = require("../dist/src/diagnostics/sentryScrub.js");
  const file = path.join(app.getPath("userData"), "diagnostics-consent.json");
  const read = () => {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      return { automatic: value.automatic === true, decidedAt: typeof value.decidedAt === "string" ? value.decidedAt : null };
    } catch { return { automatic: false, decidedAt: null }; }
  };
  let consent = read();
  // Crash dumps, uncaught errors and crashed helper processes: only once the user agreed.
  const automatic = () => [Sentry.sentryMinidumpIntegration(), Sentry.onUncaughtExceptionIntegration(), Sentry.onUnhandledRejectionIntegration(), Sentry.childProcessIntegration()];
  let automaticAdded = consent.automatic;
  // The last error report sent: a bug report soon after it is tied to it in Sentry.
  let lastError;
  Sentry.init({
    dsn: SENTRY_DSN,
    release: `local-cognitive@${app.getVersion()}`,
    environment: app.isPackaged ? "production" : "development",
    sendDefaultPii: false,
    sendClientReports: false,
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, genAI: { inputs: false, outputs: false }, databaseQueryData: false },
    // No console lines, requests, window events, local variables, renderer injection or screenshots.
    defaultIntegrations: false,
    integrations: [
      Sentry.eventFiltersIntegration(), Sentry.functionToStringIntegration(), Sentry.linkedErrorsIntegration(), Sentry.contextLinesIntegration(),
      Sentry.nodeContextIntegration({ cloudResource: false }), Sentry.electronContextIntegration(), Sentry.additionalContextIntegration(), Sentry.gpuContextIntegration(),
      ...(consent.automatic ? [...automatic(), Sentry.mainProcessSessionIntegration()] : []),
      Sentry.normalizePathsIntegration()
    ],
    attachScreenshot: false,
    maxBreadcrumbs: 50,
    initialScope: { tags: { runtime: "desktop" } },
    beforeSend: event => {
      const out = scrubSentryEvent(event, consent.automatic);
      if (out?.event_id) lastError = { id: out.event_id, at: Date.now() };
      return out;
    },
    beforeBreadcrumb: crumb => scrubSentryBreadcrumb(crumb)
  });
  // beforeSend does not see bug reports (feedback events): the same rules, after the scope is applied.
  Sentry.addEventProcessor(event => event.type === "feedback" ? scrubSentryEvent(event, consent.automatic) : event);

  let rendererErrors = 0;
  setInterval(() => { rendererErrors = 0; }, 60_000).unref();
  return {
    enabled: true,
    consent: () => ({ ...consent, available: true }),
    setConsent(value) {
      consent = { automatic: value === true, decidedAt: new Date().toISOString() };
      try { fs.writeFileSync(file, JSON.stringify(consent), { mode: 0o600 }); } catch { /* Kept for this run only. */ }
      // Turned on: errors and crashes are reported from now on; turned off, beforeSend drops them.
      if (consent.automatic && !automaticAdded) {
        automaticAdded = true;
        const client = Sentry.getClient();
        for (const integration of automatic()) client?.addIntegration(integration);
      }
      return { ...consent, available: true };
    },
    /** A window's uncaught error, forwarded by the app's own code (no Sentry SDK in the window). */
    rendererError(report, log) {
      if (!report || typeof report !== "object" || rendererErrors++ >= 10) return;
      const name = typeof report.name === "string" && /^[A-Za-z]{1,40}$/.test(report.name) ? report.name : "Error";
      log?.record("renderer.error", { category: ["TypeError", "RangeError", "ReferenceError", "SyntaxError"].includes(name) ? `js_${name.toLowerCase()}` : "unknown" });
      if (!consent.automatic) return;
      const error = new Error(maskText(report.message));
      error.name = name;
      // The window's script addresses (http://127.0.0.1:<port>/assets/…) as app paths.
      error.stack = `${name}: ${error.message}\n${String(report.stack || "").split("\n").filter(line => /^\s*at /.test(line)).slice(0, 50)
        .map(line => line.replace(/\bhttps?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//g, "app:///public/")).join("\n")}`;
      Sentry.captureException(error, { tags: { process: "renderer" } });
    },
    /** The technical log's events become breadcrumbs: codes and counts only. */
    attachLog(log) {
      log.onRecord(entry => Sentry.addBreadcrumb({ category: DIAGNOSTIC_BREADCRUMB, message: entry.event, data: entry.fields, level: "info", timestamp: Date.parse(entry.at) / 1000 }));
    },
    /** A bug report the user reviewed and sent. */
    async sendFeedback({ message, tags, contexts, attachments }) {
      const associatedEventId = lastError && Date.now() - lastError.at < 30 * 60_000 ? lastError.id : undefined;
      const id = Sentry.captureFeedback({ message, tags, ...(associatedEventId ? { associatedEventId } : {}) }, { attachments, captureContext: { contexts } });
      await Sentry.flush(10_000);
      return id;
    }
  };
}

module.exports = { startSentry };
