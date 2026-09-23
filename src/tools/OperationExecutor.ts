import path from "path";
import fs from "fs/promises";
import { createHash } from "crypto";
import { ApprovalHandler, PendingApproval, SubagentAccessMode, ToolExecutionResult } from "../types";
import { WorkspaceSnapshot } from "../workspace/types";
import { withFileLock } from "../utils/fileStore";
import { runCommand } from "../utils/runCommand";
import { canonicalPath, isWorkspacePath } from "./AccessPolicy";
import { parseAgentAction, readTool } from "./AgentTool";
import { OperationStore, SavedOperation } from "./OperationStore";
import { WorkspaceFileService } from "./WorkspaceFileService";

export interface OperationInput {
  id:string; agentRunId:string; workspace:WorkspaceSnapshot; accessMode:SubagentAccessMode;
  tool:string; arguments:Record<string,unknown>;
  approval?:{id:string;approved:boolean}; pauseForApproval?:boolean;
  requestApproval?:ApprovalHandler; requireApproval?:boolean; readOnly?:boolean; signal?:AbortSignal;
  captureVersion?: boolean;
  resumePrepared?: boolean;
}
export class OperationExecutor {
  readonly store: OperationStore;
  private readonly files = new WorkspaceFileService();
  constructor(baseDir:string) { this.store=new OperationStore(baseDir); }
  async execute(input:OperationInput):Promise<{result?:ToolExecutionResult;pendingApproval?:PendingApproval}> {
    return withFileLock(this.store.key(input.id),async()=>{
      input.signal?.throwIfAborted();
      const existing = await this.store.get(input.id);
      let args = input.arguments;
      if(input.captureVersion && ["file.write","file.append","file.replace"].includes(input.tool) && args.expectedVersion===undefined) {
        const target=path.resolve(input.workspace.rootPath,String(args.path));
        const mayRead=await isWorkspacePath(target,input.workspace.allowedDirectories)||input.accessMode==="full";
        const expectedVersion = existing?.originalAction.arguments.expectedVersion ?? (mayRead?await this.fileVersion(target):"capture-after-approval");
        args={...args,expectedVersion};
      }
      const original = input.resumePrepared&&existing ? existing.originalAction : parseAgentAction({tool:input.tool,arguments:args});
      const tool=original.tool.startsWith("file.")?"file":"command";
      if(input.readOnly&&!readTool(original.tool)) return {result:{tool,ok:false,output:"This agent has read-only tools. Ask the main agent to apply changes."}};
      const root=await fs.realpath(input.workspace.rootPath);
      if(root!==input.workspace.rootPath || !(await fs.stat(root)).isDirectory()) throw new Error("Working directory moved or changed. Choose the project folder again.");
      let saved=existing;
      if(saved&&(saved.agentRunId!==input.agentRunId||JSON.stringify(saved.originalAction)!==JSON.stringify(original)||JSON.stringify(saved.workspace)!==JSON.stringify(input.workspace))) throw new Error("Operation identity or workspace does not match its saved proposal.");
      if(saved?.status==="completed") return {result:saved.result};
      if(saved?.status==="executing"||saved?.status==="unknown") {
        saved.status="unknown";
        // The existing executing/unknown record already fences this effect.
        // A continuing disk failure must not downgrade it to a retryable error.
        await this.store.save(saved).catch(() => undefined);
        return {result:{tool,ok:false,output:"Operation outcome is unknown after interruption. Inspect the files or command effects before starting a new run; it was not repeated.",metadata:{unknown:true,operationId:input.id}}};
      }
      if(!saved) {
        const action=await this.files.prepare(original,input.workspace);
        const target=String(action.arguments[action.tool==="command.run"?"cwd":"path"]);
        const details=action.tool==="command.run"?`${JSON.stringify(action.arguments)}\nWorking directory: ${target}`:
          `${target}\n${action.arguments.content??action.arguments.newText??""}`;
        saved={id:input.id,agentRunId:input.agentRunId,workspace:structuredClone(input.workspace),originalAction:original,action,status:"prepared",
          approval:{id:input.id,tool,operation:action.tool,summary:`${action.tool} · ${target}`,details,requestedAt:new Date().toISOString()}};
        await this.store.save(saved);
      }
      const target=String(saved.action.arguments[saved.action.tool==="command.run"?"cwd":"path"]);
      const internal=await isWorkspacePath(target,input.workspace.allowedDirectories);
      const readonly=readTool(saved.action.tool);
      const needsApproval=input.requireApproval || (input.accessMode!=="full" && (!internal || saved.action.tool==="file.delete"||saved.action.tool==="command.run"||(input.accessMode==="ask"&&!readonly)));
      if(needsApproval&&saved.status!=="approved") {
        let decision:boolean|undefined;
        if(input.approval?.id===input.id) decision=input.approval.approved;
        else if(input.pauseForApproval) { saved.status="waiting";await this.store.save(saved);return {pendingApproval:saved.approval}; }
        else if(input.requestApproval) {
          saved.status="waiting";await this.store.save(saved);
          decision=await withFileLock(`approval:${input.agentRunId.split(":agent:")[0]}`,()=>input.requestApproval!(saved!.approval));
        } else return {result:{tool,ok:false,output:`Permission required: ${saved.approval.summary}`,metadata:{permissionRequired:true,operationId:input.id}}};
        input.signal?.throwIfAborted();
        if(!decision) {
          saved.status="completed";saved.result={tool,ok:false,output:`Cancelled: ${saved.approval.summary}`,metadata:{cancelled:true,operationId:input.id}};
          await this.store.save(saved);return {result:saved.result};
        }
        saved.status="approved";await this.store.save(saved);
      }
      input.signal?.throwIfAborted();
      const rechecked=await this.files.prepare(saved.action,input.workspace);
      if(JSON.stringify(rechecked)!==JSON.stringify(saved.action)) throw new Error("Operation path changed while awaiting approval.");
      if(input.captureVersion&&saved.action.arguments.expectedVersion==="capture-after-approval"){
        saved.action.arguments.expectedVersion=await this.fileVersion(String(saved.action.arguments.path));
        await this.store.save(saved);
      }
      saved.status="executing";await this.store.save(saved);
      try {
        let result:ToolExecutionResult;
        if(saved.action.tool==="command.run") {
          const args=saved.action.arguments;
          if([args.executable,...args.args as string[]].some(item=>String(item).includes("\0"))) throw new Error("Command contains a null byte.");
          const cwd=await canonicalPath(String(args.cwd));
          const execution=await runCommand(String(args.executable),args.args as string[],cwd,Number(args.timeoutMs),input.signal);
          result={tool:"command",ok:execution.exitCode===0,output:JSON.stringify(execution),metadata:{operation:"command",executable:args.executable,args:args.args,cwd,...execution}};
        } else result=await this.files.execute(saved.action,input.workspace,input.signal);
        saved.result={...result,metadata:{...result.metadata,operationId:input.id}};
      } catch(error) {
        if(input.signal?.aborted) { saved.status="unknown";await this.store.save(saved);throw error; }
        saved.result={tool,ok:false,output:error instanceof Error?error.message:String(error),metadata:{operationId:input.id}};
      }
      saved.status="completed";
      try {
        await this.store.save(saved);
      } catch (error) {
        // The effect may already have happened. A journal failure is not a
        // retryable tool failure: returning one lets the agent/graph generate
        // a fresh operation ID and repeat a command that already ran.
        const message = error instanceof Error ? error.message : String(error);
        const result: ToolExecutionResult = {
          tool,
          ok: false,
          output: `The operation may have completed, but its result could not be recorded (${message}). Its outcome is unknown. Inspect its effects before starting another run; it must not be repeated automatically.`,
          metadata: { ...saved.result?.metadata, unknown: true, operationId: input.id }
        };
        saved.status = "unknown";
        saved.result = result;
        // If the disk is still unavailable, the previously persisted executing
        // record remains the durable tombstone and also prevents replay.
        await this.store.save(saved).catch(() => undefined);
        return { result };
      }
      return {result:saved.result};
    });
  }
  private async fileVersion(target:string):Promise<string>{
    const stat=await fs.stat(target).catch((error:NodeJS.ErrnoException)=>{if(error.code!=="ENOENT")throw error;return undefined;});
    if(!stat)return "missing";
    if(!stat.isFile()||stat.size>5*1024*1024)throw new Error("Only text files up to 5 MB can be edited.");
    return createHash("sha256").update(await fs.readFile(target)).digest("hex");
  }
}
