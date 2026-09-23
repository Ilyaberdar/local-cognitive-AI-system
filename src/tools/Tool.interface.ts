import { ToolDescriptor, ToolExecutionRequest, ToolExecutionResult } from "../types";

export interface Tool {
  /** Non-secret identity of the configured destination used by a saved approval. */
  approvalFingerprint?(): string;
  name: string;
  description: string;
  matchesIntent(input: string): boolean;
  execute(input: ToolExecutionRequest): Promise<ToolExecutionResult>;
  toDescriptor(): ToolDescriptor;
}
