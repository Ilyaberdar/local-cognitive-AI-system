const fs = require("fs");
const { randomUUID } = require("crypto");
const { bugReportFormSchema, clientDiagnostics, composeBugReport, reportDiagnostics } = require("../dist/src/diagnostics/BugReport.js");
const { collectRuntimeDiagnostics } = require("../dist/src/diagnostics/snapshot.js");

// Report a bug (spec §11): the user writes what went wrong and presses Send. Diagnostics (with the
// technical log of what the app did before, and the connected server's) and a screenshot are
// attached as they chose, after a preview; it goes through Sentry, tied to a recent error if one
// was reported. The screenshot stays in this process until sent; the window gets previews.
function registerBugReport({ app, ipcMain, dialog, assertSender, getWindow, sentry, backend, remote, accountService }) {
  const handle = (name, action) => ipcMain.handle(`bugReport:${name}`, async (event, ...args) => {
    assertSender(event);
    try { return { ok: true, value: await action(...args) }; }
    catch (error) { return { ok: false, error: { code: error.code || "error", message: error.message || "The report failed." } }; }
  });
  // Reports being written, by id: the small form and the full page each keep their own.
  const reports = new Map();
  const REPORT_TTL_MS = 60 * 60_000;
  let screenshot;
  const fail = (message, code = "invalid_request") => { throw Object.assign(new Error(message), { code }); };
  const remoteStatus = () => { try { return remote?.client?.status(); } catch { return undefined; } };

  // The window as it was when the user chose Report a bug (before the report page opened).
  handle("capture", async () => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return { preview: null };
    let image = await window.webContents.capturePage();
    if (image.isEmpty()) return { preview: null };
    if (image.getSize().width > 1600) image = image.resize({ width: 1600, quality: "good" });
    screenshot = { jpeg: image.toJPEG(80), at: Date.now() };
    return { preview: image.resize({ width: 480 }).toDataURL() };
  });

  handle("prepare", async request => {
    const status = remoteStatus();
    const account = accountService.status();
    const reportId = randomUUID();
    const prepared = {
      reportId, createdAt: new Date().toISOString(), appVersion: app.getVersion(),
      diagnostics: {
        client: clientDiagnostics({ versions: process.versions, osVersion: process.getSystemVersion(), signedIn: account.state === "signed-in", modeHint: request && request.mode, remote: status }),
        runtime: await collectRuntimeDiagnostics({ runtimeManager: backend.runtimeManager, diagnosticLog: backend.diagnosticLog, runtimeKind: "desktop" })
      },
      log: backend.diagnosticLog.tail({ days: 14, maxBytes: 64 * 1024 }),
      ...(screenshot && Date.now() - screenshot.at < 10 * 60_000 ? { screenshot: screenshot.jpeg } : {})
    };
    // The connected server's diagnostics are part of the diagnostics (shown in the same preview).
    if (status?.state === "connected" && (status.capabilities || []).includes("diagnostics.collect")) {
      try { prepared.server = await remote.client.request("diagnostics.collect", { includeLog: true }, 10_000); }
      catch { /* An unreachable server is left out. */ }
    }
    for (const [id, report] of reports) if (Date.now() - Date.parse(report.createdAt) > REPORT_TTL_MS) reports.delete(id);
    reports.set(reportId, prepared);
    while (reports.size > 8) reports.delete(reports.keys().next().value);
    return { reportId, diagnostics: reportDiagnostics(prepared), screenshot: prepared.screenshot ? `data:image/jpeg;base64,${Buffer.from(prepared.screenshot).toString("base64")}` : null,
      diagnosticsByDefault: sentry.consent().automatic === true, sendAvailable: sentry.enabled };
  });

  const compose = input => {
    const form = bugReportFormSchema.safeParse(input);
    if (!form.success) fail("Write what went wrong.");
    const prepared = reports.get(form.data.reportId);
    // Gone (an hour passed, or the app restarted): the window prepares it again.
    if (!prepared) fail("The report's diagnostics expired.", "report_expired");
    return composeBugReport(form.data, prepared);
  };

  handle("submit", async input => {
    if (!sentry.enabled) fail("Sending reports is not available in this build. Save the report to a file instead.", "unavailable");
    const report = compose(input);
    const eventId = await sentry.sendFeedback({ message: report.message, tags: report.tags, contexts: report.contexts, attachments: report.attachments });
    reports.delete(input.reportId);
    return { reportId: input.reportId, eventId };
  });

  handle("export", async input => {
    const report = compose(input);
    const window = getWindow();
    const result = await dialog.showSaveDialog(window && !window.isDestroyed() ? window : undefined, {
      title: "Save bug report", defaultPath: `local-cognitive-report-${String(input.reportId).slice(0, 8)}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (result.canceled || !result.filePath) return { saved: false };
    fs.writeFileSync(result.filePath, JSON.stringify(report.file, null, 2), { mode: 0o600 });
    return { saved: true };
  });
}

module.exports = { registerBugReport };
