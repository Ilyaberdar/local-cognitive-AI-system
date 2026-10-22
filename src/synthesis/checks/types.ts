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

/** A place a Grounded file cites, once however often it does: whether it holds, and how many lines
 * the file it names has. */
export interface GroundedReference { path: string; start?: number; end?: number; status: "ok" | "missing" | "range"; lines?: number }

/** What a check found. `feedback` is what the model reads next: at most 8 short, exact items. */
export interface CheckResult {
  status: CheckStatus;
  /** One line for the run's activity and the gates panel. */
  message: string;
  feedback: string[];
  cases?: CheckCase[];
  /** Grounded: the file it read (relative to the checkout folder) and every place it cites. */
  grounded?: { file: string; references: GroundedReference[] };
}

/** The files a check sees. `candidate` (written by the model) and `frozen` (written by the engineer,
 * read-only for the model) are keyed by path relative to the module's checkout folder; `suite` (the
 * contract's test files) by path relative to the .lcspec folder. All share one root when run. */
export interface CheckFiles {
  candidate: Record<string, string>;
  frozen: Record<string, string>;
  suite: Record<string, string>;
}

/** A single endpoint a sandboxed command may be let out to (an egress proxy): the sandbox's only way to
 * the network, so the proxy, not the tool, enforces where it may go. On macOS it is a loopback port; on
 * Linux the proxy listens on a UNIX socket (`socketPath`, named proxy.sock in a folder of its own), which
 * the sandbox sees read-only and reaches from a network of its own that has nothing else. */
export interface EgressEndpoint { host: string; port: number; socketPath?: string }

/** Runs a command in a sandbox: no network, writes only inside the work folder, nothing from the
 * user's home or the app's data. `unavailable` says why it cannot run here (the check is then Unknown).
 * `egress`, when given, is the proxy the command may reach, and nothing else on the network. */
export interface SandboxProvider {
  name: string;
  unavailable(): Promise<string | undefined>;
  /** `proxyUrl`: where the command sends its web requests, set only when `egress` was wired in. */
  wrap(executable: string, args: string[], workDir: string, readable: string[], egress?: EgressEndpoint): { executable: string; args: string[]; env: NodeJS.ProcessEnv; proxyUrl?: string };
  /** Whether a sandboxed command can be let out to one proxy (and nothing else) on this platform. When
   * absent or false, a terminal runs with no network, as before, even with the http right. */
  egressSupported?: boolean;
  /** How the proxy is reached: a loopback port (macOS) or a UNIX socket (Linux). */
  egressTransport?: "tcp" | "unix";
  /** Checks, where the platform needs it, that a sandbox reaches the proxy and nothing else (Linux):
   * undefined when it does (then egressSupported is true), else why not (a terminal then runs without
   * network). Asked when an agent first needs it, never for contract tests. */
  checkEgress?(): Promise<string | undefined>;
}
