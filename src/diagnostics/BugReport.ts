import { z } from "zod";
import { diagnosticCode } from "./events";

/** What the user writes, and what they chose to attach. */
export const bugReportFormSchema = z.object({
  reportId: z.uuid(),
  message: z.string().trim().min(1).max(4000),
  include: z.object({ diagnostics: z.boolean().default(false), screenshot: z.boolean().default(false) }).strict().default({ diagnostics: false, screenshot: false })
}).strict();
export type BugReportForm = z.infer<typeof bugReportFormSchema>;

/** The desktop's own part of the diagnostics: versions and the connection's state, no names. */
export const clientDiagnosticsSchema = z.object({
  electron: z.string().max(40), chrome: z.string().max(40), osVersion: z.string().max(40),
  mode: z.enum(["local", "remote"]), signedIn: z.boolean(),
  remote: z.object({ state: diagnosticCode, code: diagnosticCode.optional(), serverVersion: z.string().max(40).optional(), capabilities: z.number().int().min(0) }).strict().optional()
}).strict();
export type ClientDiagnostics = z.infer<typeof clientDiagnosticsSchema>;

const code = (value: unknown) => { const text = String(value ?? "").toLowerCase(); return diagnosticCode.safeParse(text).success ? text : "unknown"; };
const version = (value: unknown) => /^[\w.+-]{1,40}$/.test(String(value ?? "")) ? String(value) : "unknown";

/** The desktop's part, from what the main process knows; the window's hint of the mode is
 * believed only when a server is in fact connected. */
export const clientDiagnostics = (input: { versions: Record<string, string | undefined>; osVersion: string; signedIn: boolean; modeHint?: unknown;
  remote?: { state?: unknown; error?: { code?: unknown }; serverVersion?: unknown; capabilities?: unknown[] } }): ClientDiagnostics => {
  const connected = input.remote?.state === "connected";
  return clientDiagnosticsSchema.parse({
    electron: version(input.versions.electron), chrome: version(input.versions.chrome), osVersion: version(input.osVersion),
    mode: connected && input.modeHint === "remote" ? "remote" : "local", signedIn: input.signedIn,
    ...(input.remote?.state ? { remote: { state: code(input.remote.state), ...(input.remote.error?.code ? { code: code(input.remote.error.code) } : {}),
      ...(input.remote.serverVersion ? { serverVersion: version(input.remote.serverVersion) } : {}), capabilities: input.remote.capabilities?.length ?? 0 } } : {})
  });
};

export interface PreparedReport {
  reportId: string;
  createdAt: string;
  appVersion: string;
  diagnostics: { client: ClientDiagnostics; runtime: unknown };
  log: unknown[];
  screenshot?: Uint8Array;
  server?: unknown;
}

export interface ComposedReport {
  message: string;
  tags: Record<string, string>;
  contexts: { lc: Record<string, string> };
  attachments: Array<{ filename: string; data: string | Uint8Array; contentType: string }>;
  /** The same report as one file, for saving when it cannot be sent. */
  file: Record<string, unknown>;
}

/** The diagnostics as the preview shows them and the report attaches them: this computer's, the
 * technical log (what the app did before the problem, as codes), and the connected server's. */
export const reportDiagnostics = (prepared: PreparedReport) => ({ ...prepared.diagnostics, log: prepared.log, ...(prepared.server ? { server: prepared.server } : {}) });

/** A report as it is sent and saved: the user's words, and only the parts they chose, exactly as
 * the preview showed them. */
export const composeBugReport = (form: BugReportForm, prepared: PreparedReport): ComposedReport => {
  const diagnostics = form.include.diagnostics ? reportDiagnostics(prepared) : undefined;
  const screenshot = form.include.screenshot ? prepared.screenshot : undefined;
  const mode = prepared.diagnostics.client.mode;
  const attachments: ComposedReport["attachments"] = [
    ...(diagnostics ? [{ filename: "diagnostics.json", data: JSON.stringify(diagnostics, null, 2), contentType: "application/json" }] : []),
    ...(screenshot ? [{ filename: "screenshot.jpg", data: screenshot, contentType: "image/jpeg" }] : [])
  ];
  return {
    message: form.message,
    tags: { report_id: form.reportId, mode, app_version: prepared.appVersion },
    contexts: { lc: { report_id: form.reportId, mode, attached: attachments.map(item => item.filename).join(",") || "none" } },
    attachments,
    file: { format: "local-cognitive-bug-report", version: 2, reportId: form.reportId, createdAt: prepared.createdAt, appVersion: prepared.appVersion, message: form.message,
      ...(diagnostics ? { diagnostics } : {}),
      ...(screenshot ? { screenshot: { contentType: "image/jpeg", base64: Buffer.from(screenshot).toString("base64") } } : {}) }
  };
};
