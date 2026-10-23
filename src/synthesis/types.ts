import { ManagedModel } from "../types";
import type { AgentSummary } from "./agents/AgentPool";
import { Diagnostic, FlowProgram, SpecProgram } from "./language";

export type RunStatus = "queued" | "running" | "accepted" | "needs_review" | "blocked" | "unresolved" | "interrupted" | "cancelled";
export interface SynthesisDiagnostic { severity: Diagnostic["severity"]; code: string; message: string; file?: string; line: number; column: number }
export interface SynthesisModule {
  id: string; name: string; specPath: string; flowPath: string; valid: boolean;
  diagnostics: SynthesisDiagnostic[]; specSource?: string; flowSource?: string;
}
export interface ActivityEvent {
  sequence: number; at: string; step: string; message: string; iteration: number;
  /** warning: the step went on, but the run is likely to suffer (a low-bit model was chosen). */
  status: "running" | "ok" | "failed" | "warning"; detail?: string; model?: string; file?: string; line?: number;
  /** The step waits for a local model another request holds. */
  waiting?: true;
  /** Tokens a running generation has streamed so far. */
  tokens?: number;
  /** A finished model request of revise: how it was asked, so a run can be repeated and studied. */
  generation?: GenerationRecord;
}
/** One model request: its seed and sampling, its thinking budget, a hash of its prompt, and what came
 * back. `mode`: a file (write), a retry after an empty answer, or an escalation after a file came back
 * unchanged (focus: one failure, thinking first; edit: SEARCH/REPLACE blocks; whole: an edit's fallback). */
export interface GenerationRecord {
  mode: "write" | "retry" | "focus" | "edit" | "whole";
  seed: number; temperature?: number; topP?: number; topK?: number; minP?: number; repeatPenalty?: number;
  thinking: number; budgetMessage?: string; maxTokens: number; promptHash: string; promptChars: number;
  inputTokens?: number; outputTokens?: number; finish?: string; ms: number;
  /** The answer, when it was a file: the same file as before. */
  unchanged?: boolean;
}
export type VerdictStatus = "Pass" | "Fail" | "Unknown";
export interface EvidenceCase { name: string; status: "pass" | "fail"; file?: string; line?: number; message?: string; expected?: string; actual?: string }
export interface Evidence {
  candidateHash: string; specHash: string; evaluatorVersion: string; status: VerdictStatus;
  /** The contract's test files as frozen at launch (contracts with Tests gates). */
  suiteHash?: string;
  gates: Array<{id: string; evaluator: string; status: VerdictStatus; message: string; severity: "hard" | "soft";
    /** What the model reads next for this gate; the test cases a Tests gate ran. */
    feedback?: string[]; cases?: EvidenceCase[];
    /** Not run: the model wrote none of the declared files, so there was nothing to judge. */
    skipped?: "no_candidate";
    /** Grounded: the file it read (relative to the checkout folder) and each place it cites, with what was found. */
    grounded?: {file: string; references: Array<{path: string; start?: number; end?: number; status: "ok" | "missing" | "range"; lines?: number}>}}>;
}
export interface SynthesisRun {
  id: string; projectId: string; moduleId: string; moduleName: string; status: RunStatus;
  phase: string; iteration: number; createdAt: string; updatedAt: string;
  error?: string; appliedAt?: string; restartedFrom?: string; models: ManagedModel[];
  /** A paired device started it (R5-5): it stops once the device may no longer use the project. */
  startedBy?: "device";
  events: ActivityEvent[]; evidence?: Evidence;
  usage: {inputTokens: number; outputTokens: number; calls: number};
  /** How the run's agents stand (agents-v1); each agent is read with the run's agents. */
  agents?: AgentCounts;
  /** Every model request's seed derives from it; a restart keeps it only after an interruption. */
  seed?: number;
}
export interface AgentCounts { total: number; queued: number; running: number; done: number; failed: number; cancelled: number }
export interface RunRecord extends SynthesisRun {
  version: 1; rootPath: string; specSource: string; flowSource: string; specHash: string;
  spec: SpecProgram; flow: FlowProgram; outputPath?: string;
  files: Record<string, string>; baseline: Record<string, string | null>;
  /** Project files the run deleted (relative to the checkout folder): Apply removes them. */
  removed?: string[];
  /** Every task's agent of the run, in the order parallel_map made them. */
  agentRuns?: AgentSummary[];
  /** The engineer's frozen files, read at checkout; the contract's test files, read at launch. */
  frozen?: Record<string, string>; suite?: Record<string, string>; suiteHash?: string;
}
export class SynthesisError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); }
}
