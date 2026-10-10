import { z } from "zod";
import { diagnosticCode } from "./events";

/** What the user writes, and what they chose to attach. */
export const bugReportFormSchema = z.object({
  reportId: z.uuid(),
  summary: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(""),
  steps: z.string().max(4000).default(""),
  expected: z.string().max(1000).default(""),
  actual: z.string().max(1000).default(""),
  contact: z.union([z.literal(""), z.email().max(320)]).default(""),
  include: z.object({ diagnostics: z.boolean().default(false), screenshot: z.boolean().default(false), server: z.boolean().default(false) }).strict().default({ diagnostics: false, screenshot: false, server: false })
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
  email?: string;
  tags: Record<string, string>;
  contexts: { lc: Record<string, string> };
  attachments: Array<{ filename: string; data: string | Uint8Array; contentType: string }>;
  /** The same report as one file, for saving when it cannot be sent. */
  file: Record<string, unknown>;
}

/** A report as it is sent and saved: the user's words, and only the parts they ticked, exactly as
 * the preview showed them. */
export const composeBugReport = (form: BugReportForm, prepared: PreparedReport): ComposedReport => {
  const sections: Array<[string, string]> = [["What happened", form.description], ["Steps to reproduce", form.steps], ["Expected", form.expected], ["Actual", form.actual]];
  const message = [form.summary, ...sections.filter(([, text]) => text.trim()).map(([title, text]) => `${title}:\n${text.trim()}`)].join("\n\n");
  const diagnostics = form.include.diagnostics ? { ...prepared.diagnostics, log: prepared.log } : undefined;
  const screenshot = form.include.screenshot ? prepared.screenshot : undefined;
  const server = form.include.server ? prepared.server : undefined;
  const mode = prepared.diagnostics.client.mode;
  const attachments: ComposedReport["attachments"] = [
    ...(diagnostics ? [{ filename: "diagnostics.json", data: JSON.stringify(diagnostics, null, 2), contentType: "application/json" }] : []),
    ...(server ? [{ filename: "server-diagnostics.json", data: JSON.stringify(server, null, 2), contentType: "application/json" }] : []),
    ...(screenshot ? [{ filename: "screenshot.jpg", data: screenshot, contentType: "image/jpeg" }] : [])
  ];
  return {
    message, ...(form.contact ? { email: form.contact } : {}),
    tags: { report_id: form.reportId, mode, app_version: prepared.appVersion },
    contexts: { lc: { report_id: form.reportId, mode, attached: attachments.map(item => item.filename).join(",") || "none" } },
    attachments,
    file: { format: "local-cognitive-bug-report", version: 1, reportId: form.reportId, createdAt: prepared.createdAt, appVersion: prepared.appVersion,
      report: { summary: form.summary, description: form.description, steps: form.steps, expected: form.expected, actual: form.actual, contact: form.contact },
      ...(diagnostics ? { diagnostics } : {}), ...(server ? { serverDiagnostics: server } : {}),
      ...(screenshot ? { screenshot: { contentType: "image/jpeg", base64: Buffer.from(screenshot).toString("base64") } } : {}) }
  };
};
