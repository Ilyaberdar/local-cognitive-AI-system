import { ToolDescriptor, ToolExecutionRequest, ToolExecutionResult } from "../types";

export interface Tool {
  name: string;
  description: string;
  matchesIntent(input: string): boolean;
  execute(input: ToolExecutionRequest): Promise<ToolExecutionResult>;
  toDescriptor(): ToolDescriptor;
}
