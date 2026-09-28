import { ManagedModel } from "../types";
import { Diagnostic, FlowProgram, SpecProgram } from "./language";

export type RunStatus = "queued" | "running" | "accepted" | "needs_review" | "blocked" | "unresolved" | "interrupted" | "cancelled";
export interface SynthesisDiagnostic { severity: Diagnostic["severity"]; code: string; message: string; file?: string; line: number; column: number }
export interface SynthesisModule {
  id: string; name: string; specPath: string; flowPath: string; valid: boolean;
  diagnostics: SynthesisDiagnostic[]; specSource?: string; flowSource?: string;
}
export interface ActivityEvent {
  sequence: number; at: string; step: string; message: string; iteration: number;
  status: "running" | "ok" | "failed"; detail?: string; model?: string; file?: string; line?: number;
}
export type VerdictStatus = "Pass" | "Fail" | "Unknown";
export interface Evidence {
  candidateHash: string; specHash: string; evaluatorVersion: string; status: VerdictStatus;
  gates: Array<{id: string; evaluator: string; status: VerdictStatus; message: string; severity: "hard" | "soft"}>;
}
export interface SynthesisRun {
  id: string; projectId: string; moduleId: string; moduleName: string; status: RunStatus;
  phase: string; iteration: number; createdAt: string; updatedAt: string;
  error?: string; appliedAt?: string; restartedFrom?: string; models: ManagedModel[];
  events: ActivityEvent[]; evidence?: Evidence;
  usage: {inputTokens: number; outputTokens: number; calls: number};
}
export interface RunRecord extends SynthesisRun {
  version: 1; rootPath: string; specSource: string; flowSource: string; specHash: string;
  spec: SpecProgram; flow: FlowProgram; outputPath?: string;
  files: Record<string, string>; baseline: Record<string, string | null>;
}
export class SynthesisError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); }
}
