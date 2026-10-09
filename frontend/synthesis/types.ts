export interface SynthesisProject { id: string; name: string; rootPath: string; archivedAt?: string }
/** How the screen reaches Synthesis: this computer's API by default, or a paired server (R5-5). */
export interface SynthesisTransport {
  request<T>(path: string, options?: RequestInit): Promise<T>;
  /** A server: its candidates are not previewed here and its files are not opened in an editor here. */
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
  models?: { id: string; providerId: string; displayName?: string; sizeBytes?: number }[];
  events: SynthesisEvent[];
  evidence?: {
    candidateHash: string; specHash: string; status: "Pass" | "Fail" | "Unknown";
    gates: { id: string; evaluator: string; status: "Pass" | "Fail" | "Unknown"; message: string }[];
  };
}
export interface CandidateDiff { files: { path: string; before: string | null; after: string }[]; canApply: boolean }
export interface RunSources { specSource: string; flowSource: string; specHash: string }
export interface SynthesisWorkspaceProps {
  projects: SynthesisProject[]; colorMode?: "dark" | "light"; active?: boolean;
  selectedProjectId?: string;
  onCreateProject?: () => void;
  transport?: SynthesisTransport;
  /** Keeps this machine's view preferences apart from another's. */
  storageKey?: string;
}
