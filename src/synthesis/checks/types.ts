// Contract checks: the trusted evaluators a contract names directly (Tests, Exports, Imports,
// Forbid), beside the registered calculator adapters.

export type CheckStatus = "Pass" | "Fail" | "Unknown";
export type CheckLanguage = "javascript" | "typescript" | "python" | "cpp";

/** One test case as the runner reported it. Paths are relative to the work folder. */
export interface CheckCase {
  name: string;
  status: "pass" | "fail";
  file?: string;
  line?: number;
  message?: string;
  expected?: string;
  actual?: string;
}

/** What a check found. `feedback` is what the model reads next: at most 8 short, exact items. */
export interface CheckResult {
  status: CheckStatus;
  /** One line for the run's activity and the gates panel. */
  message: string;
  feedback: string[];
  cases?: CheckCase[];
}

/** The files a check sees. `candidate` (written by the model) and `frozen` (written by the engineer,
 * read-only for the model) are keyed by path relative to the module's checkout folder; `suite` (the
 * contract's test files) by path relative to the .lcspec folder. All share one root when run. */
export interface CheckFiles {
  candidate: Record<string, string>;
  frozen: Record<string, string>;
  suite: Record<string, string>;
}

/** Runs a command in a sandbox: no network, writes only inside the work folder, nothing from the
 * user's home or the app's data. `unavailable` says why it cannot run here (the check is then Unknown). */
export interface SandboxProvider {
  name: string;
  unavailable(): Promise<string | undefined>;
  wrap(executable: string, args: string[], workDir: string, readable: string[]): { executable: string; args: string[]; env: NodeJS.ProcessEnv };
}
