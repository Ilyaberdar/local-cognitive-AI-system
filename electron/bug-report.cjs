const fs = require("fs");
const { randomUUID } = require("crypto");
const { bugReportFormSchema, clientDiagnostics, composeBugReport } = require("../dist/src/diagnostics/BugReport.js");
const { collectRuntimeDiagnostics } = require("../dist/src/diagnostics/snapshot.js");

// Report a bug (spec §11): the user writes what happened, ticks what to attach after seeing it,
// and sends it through Sentry (or saves it to a file). The screenshot and the server's
// diagnostics stay in this process; the window gets previews. What is sent is what was shown.
function registerBugReport({ app, ipcMain, dialog, assertSender, getWindow, sentry, backend, remote, accountService }) {
  const handle = (name, action) => ipcMain.handle(`bugReport:${name}`, async (event, ...args) => {
    assertSender(event);
    try { return { ok: true, value: await action(...args) }; }
    catch (error) { return { ok: false, error: { code: error.code || "error", message: error.message || "The report failed." } }; }
  });
  let screenshot, prepared, serverPreview;
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
    prepared = {
      reportId, createdAt: new Date().toISOString(), appVersion: app.getVersion(),
      diagnostics: {
        client: clientDiagnostics({ versions: process.versions, osVersion: process.getSystemVersion(), signedIn: account.state === "signed-in", modeHint: request && request.mode, remote: status }),
        runtime: await collectRuntimeDiagnostics({ runtimeManager: backend.runtimeManager, diagnosticLog: backend.diagnosticLog, runtimeKind: "desktop" })
      },
      log: backend.diagnosticLog.tail({ days: 14, maxBytes: 64 * 1024 }),
      ...(screenshot && Date.now() - screenshot.at < 10 * 60_000 ? { screenshot: screenshot.jpeg } : {})
    };
    serverPreview = undefined;
    const server = status?.state === "connected" && (status.capabilities || []).includes("diagnostics.collect") ? { name: status.hostName || "the server" } : null;
    return { reportId, diagnostics: prepared.diagnostics, log: prepared.log, screenshot: prepared.screenshot ? `data:image/jpeg;base64,${Buffer.from(prepared.screenshot).toString("base64")}` : null,
      server, sendAvailable: sentry.enabled };
  });

  // The server's diagnostics, fetched only when the user ticks them, and shown before sending.
  handle("server-diagnostics", async () => {
    const status = remoteStatus();
    if (!prepared) fail("Open the report again.");
    if (status?.state !== "connected") fail("No server is connected.", "unavailable");
    serverPreview = await remote.client.request("diagnostics.collect", { includeLog: true }, 30_000);
    prepared.server = serverPreview;
    return serverPreview;
  });

  const compose = input => {
    const form = bugReportFormSchema.safeParse(input);
    if (!form.success) fail("Write a short summary of the problem (and a valid email, if you give one).");
    if (!prepared || prepared.reportId !== form.data.reportId) fail("Open the report again.");
    if (form.data.include.server && !prepared.server) fail("Load the server's diagnostics first.");
    return composeBugReport(form.data, prepared);
  };

  handle("submit", async input => {
    if (!sentry.enabled) fail("Sending reports is not available in this build. Save the report to a file instead.", "unavailable");
    const report = compose(input);
    const eventId = await sentry.sendFeedback({ message: report.message, email: report.email, tags: report.tags, contexts: report.contexts, attachments: report.attachments });
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
