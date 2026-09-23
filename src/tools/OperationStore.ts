import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { PendingApproval, ToolExecutionResult } from "../types";
import { WorkspaceSnapshot } from "../workspace/types";
import { writeJsonAtomically, isMissingFile } from "../utils/fileStore";
import { AgentAction } from "./AgentTool";

export interface SavedOperation {
  id: string;
  agentRunId: string;
  workspace: WorkspaceSnapshot;
  action: AgentAction;
  originalAction: AgentAction;
  status: "prepared" | "waiting" | "approved" | "executing" | "completed" | "unknown";
  approval: PendingApproval;
  result?: ToolExecutionResult;
}
export class OperationStore {
  constructor(private readonly baseDir: string) {}
  key(id: string) { return path.join(this.baseDir, "operations", `${createHash("sha256").update(id).digest("hex")}.json`); }
  async get(id: string): Promise<SavedOperation | undefined> {
    try { return JSON.parse(await fs.readFile(this.key(id), "utf8")) as SavedOperation; }
    catch (error) { if (isMissingFile(error)) return; throw error; }
  }
  async save(operation: SavedOperation): Promise<void> { await writeJsonAtomically(this.key(operation.id), operation); }
}
