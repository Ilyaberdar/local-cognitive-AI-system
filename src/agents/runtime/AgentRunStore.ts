import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { PendingApproval, TokenUsage, ToolExecutionResult } from "../../types";
import { AgentAction } from "../../tools/AgentTool";
import { isMissingFile, writeJsonAtomically } from "../../utils/fileStore";
import { AgentLimits } from "./AgentLimits";

export interface AgentRun {
  id:string; fingerprint:string; input:string; instructions:string;
  status:"running"|"waiting"|"completed"|"failed";
  turns:Array<{type:"tool"|"result"|"format_error";content:string}>;
  tools:ToolExecutionResult[];
  pending?:{action:AgentAction;id:string;approval?:PendingApproval};
  steps:number; repairs:number; activeMs:number; final?:string;error?:string;usage:TokenUsage;
  budgetId?: string;
  limits?: AgentLimits;
  maxSteps?: number;
}
export interface AgentBudget { id: string; memberIds: string[]; limits: AgentLimits; }
export class AgentRunStore {
  constructor(private readonly baseDir:string){}
  key(id:string){return path.join(this.baseDir,"agent-runs",`${createHash("sha256").update(id).digest("hex")}.json`);}
  budgetKey(id:string){return path.join(this.baseDir,"agent-budgets",`${createHash("sha256").update(id).digest("hex")}.json`);}
  async get(id:string):Promise<AgentRun|undefined>{try{return JSON.parse(await fs.readFile(this.key(id),"utf8")) as AgentRun;}catch(error){if(isMissingFile(error))return;throw error;}}
  async save(run:AgentRun){await writeJsonAtomically(this.key(run.id),run);}
  async getBudget(id: string): Promise<AgentBudget | undefined> {
    try {
      const budget = JSON.parse(await fs.readFile(this.budgetKey(id), "utf8")) as AgentBudget;
      if (budget.id !== id || !Array.isArray(budget.memberIds) || budget.memberIds.some(member => typeof member !== "string") || !budget.limits) {
        throw new Error("The saved agent budget is invalid.");
      }
      return budget;
    } catch (error) { if (isMissingFile(error)) return undefined; throw error; }
  }
  async saveBudget(budget: AgentBudget): Promise<void> { await writeJsonAtomically(this.budgetKey(budget.id), budget); }
}
