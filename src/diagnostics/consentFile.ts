import fs from "fs";
import path from "path";

/** A server owner's consent to error reports: off until they turn it on (the CLI, or Settings on
 * their computer through Remote). A file in the data directory, read again when it changes: no
 * restart, and the CLI works whether the server runs or not. */
export interface ErrorReportConsent { automatic: boolean; decidedAt: string | null }

export const consentFilePath = (appDataDir: string) => path.join(appDataDir, "diagnostics", "consent.json");

export const readConsent = (file: string): ErrorReportConsent => {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ErrorReportConsent>;
    return { automatic: value.automatic === true, decidedAt: typeof value.decidedAt === "string" ? value.decidedAt : null };
  } catch { return { automatic: false, decidedAt: null }; }
};

export const writeConsent = (file: string, automatic: boolean, now = new Date()): ErrorReportConsent => {
  const consent = { automatic, decidedAt: now.toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(consent)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return consent;
};

/** The current consent, read again at most every few seconds and only when the file changed. */
export const liveConsent = (file: string, intervalMs = 5_000): (() => boolean) => {
  let checkedAt = 0, modified = -1, value = false;
  return () => {
    const now = Date.now();
    if (now - checkedAt < intervalMs) return value;
    checkedAt = now;
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { mtime = 0; }
    if (mtime !== modified) { modified = mtime; value = readConsent(file).automatic; }
    return value;
  };
};
