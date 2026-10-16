export interface SynthesisProject { id: string; name: string; rootPath: string; archivedAt?: string }
/** How the screen reaches Synthesis: this computer's API by default, or a paired server (R5-5). */
export interface SynthesisTransport {
  request<T>(path: string, options?: RequestInit): Promise<T>;
  /** A server: its files are not opened in an editor here, and the project files a run cites are not read from here. */
  remote?: { hostName: string };
}
export interface Diagnostic { message: string; line?: number; column?: number; file?: string; severity?: string }
export interface SynthesisModule {
  id: string; name: string; specPath?: string; flowPath?: string; valid: boolean; diagnostics: Diagnostic[];
  specSource?: string; flowSource?: string;
}
export interface SynthesisEvent {
  sequence: number; at: string; step: string; message: string; detail?: string; iteration?: number;
  status?: "running" | "ok" | "failed"; model?: string; file?: string; line?: number;
}
export interface SynthesisRun {
  id: string; projectId: string; moduleId: string; moduleName: string;
  status: "queued" | "running" | "accepted" | "needs_review" | "blocked" | "unresolved" | "interrupted" | "cancelled";
  phase: string; iteration: number; createdAt: string; updatedAt: string; error?: string; appliedAt?: string;
  models?: { id: string; providerId: string; providerName?: string; displayName?: string; sizeBytes?: number }[];
  usage?: { inputTokens: number; outputTokens: number; calls: number };
  agents?: { total: number; queued: number; running: number; done: number; failed: number; cancelled: number };
  events: SynthesisEvent[];
  evidence?: {
    candidateHash: string; specHash: string; status: "Pass" | "Fail" | "Unknown";
    gates: { id: string; evaluator: string; status: "Pass" | "Fail" | "Unknown"; message: string;
      /** What the model read for this gate, and the test cases a Tests gate ran. */
      feedback?: string[];
      cases?: { name: string; status: "pass" | "fail"; file?: string; line?: number; message?: string; expected?: string; actual?: string }[];
      /** Grounded: the file it read (relative to the checkout folder) and each place it cites. */
      grounded?: { file: string; references: GroundedReference[] } }[];
  };
}
/** after null: the run deleted the file. `root`: the checkout folder the paths start with (older hosts send none). */
export interface CandidateDiff { files: { path: string; before: string | null; after: string | null }[]; canApply: boolean; root?: string }
/** A place a Grounded file cites, with what the check found. */
export interface GroundedReference { path: string; start?: number; end?: number; status: "ok" | "missing" | "range"; lines?: number }
export interface AgentItem {
  index: number; call: number; task: string; providerId: string; model: string; status: "queued" | "running" | "done" | "failed" | "cancelled";
  steps: number; inputTokens: number; outputTokens: number; durationMs: number; files: string[]; error?: string;
  /** Changes it left checked out when it failed or was stopped: dropped. */
  reverted?: string[];
  /** parallel_map's answer_file: the file its answer was saved as, since it wrote none itself, or why not. */
  answerFile?: string; answerRefused?: string;
}
export interface AgentDetail extends AgentItem { final?: string; protocol?: string; turns: { type: "tool" | "result" | "format_error"; content: string; ok?: boolean }[] }
export interface RunSources { specSource: string; flowSource: string; specHash: string }
export interface SynthesisWorkspaceProps {
  projects: SynthesisProject[]; colorMode?: "dark" | "light"; active?: boolean;
  selectedProjectId?: string;
  onCreateProject?: () => void;
  transport?: SynthesisTransport;
  /** Keeps this machine's view preferences apart from another's. */
  storageKey?: string;
}
