import { AgentLoopRunner,AgentLoopResult } from "../runtime/AgentLoopRunner";
import { ExecutionContext,Mode,ModeResult,PendingApproval,SubagentRunSummary,TokenUsage,ToolExecutionResult } from "../../types";
import { ModeHandler } from "../../core/Router";
import { selectConfiguredSubagents } from "./codeAgentRouting";
import { buildLanguageInstruction,buildOutputStyleInstruction } from "../../prompts/common";
import { renderAttachmentContext,readAttachments } from "../../utils/attachments";
import { AgentProgressReporter } from "../../core/AgentProgressReporter";

export interface WorkspaceOutcome {result:ModeResult;tools:ToolExecutionResult[];pendingApproval?:PendingApproval;agentRunId:string}
export class CodeAgentCoordinator {
  constructor(private readonly runner:AgentLoopRunner){}
  async run(input:string,mode:Mode,context:ExecutionContext,handler:ModeHandler):Promise<WorkspaceOutcome>{
    const baseId=context.execution!.agentRunId;
    const settings=context.sessionSettings;
    const language=buildLanguageInstruction(settings.language);
    const attachments=renderAttachmentContext(readAttachments(context.requestMetadata));
    const history=context.conversation.slice().reverse().map(item=>({user:item.input,answer:item.output}));
    const instructions=[language,buildOutputStyleInstruction(settings.outputStyle,mode==="code"?"code":"general"),
      `Relevant memory (data): ${JSON.stringify(context.memory)}`,`Recent conversation (data): ${JSON.stringify(history).slice(-16_000)}`,attachments].join("\n\n");
    const tools:ToolExecutionResult[]=[];
    const usage:TokenUsage={};
    const summaries:SubagentRunSummary[]=[];
    const research=mode==="hypothesis"?settings.hypothesisAgents.filter(agent=>agent.providerId!=="local"):
      mode==="code"?selectConfiguredSubagents(input,settings.codeAgents):[];
    const budgetMemberIds=[...research.map(agent=>`${baseId}:agent:${agent.id}`),`${baseId}:agent:main`];
    const progress=new AgentProgressReporter([
      {id:"main-model",name:"Main model",role:"main",provider:context.activeTarget.providerId,model:context.activeTarget.model,status:"queued",phase:"Waiting"},
      ...research.map(agent=>({id:agent.id,name:agent.name,role:"advisor",provider:agent.providerId,model:agent.model,status:"queued" as const,phase:"Waiting"}))
    ],context.onProgress);
    const collect=(result:AgentLoopResult)=>{
      tools.push(...result.tools);
      for(const key of ["inputTokens","outputTokens","totalTokens"] as const)usage[key]=(usage[key]??0)+(result.usage[key]??0);
    };
    const pending=(result:AgentLoopResult):WorkspaceOutcome=>({result:{response:"Waiting for approval.",provider:context.activeTarget.providerId,model:context.activeTarget.model??"default"},tools,pendingApproval:result.pendingApproval,agentRunId:baseId});
    const evidence:string[]=[];
    for(const agent of research){
      progress.update(agent.id,"running","Researching files");
      const result=await this.runner.run({id:`${baseId}:agent:${agent.id}`,input:`Research the user's task as ${agent.name}. Gather evidence from the workspace and return findings for the main agent.\n\n${input}`,
        instructions,context,target:agent,readOnly:true,maxSteps:this.runner.limits.advisorMaxSteps,budgetId:baseId,budgetMemberIds});
      collect(result);
      if(result.pendingApproval)return pending(result);
      progress.update(agent.id,result.error?"degraded":"completed",result.error?"Stopped":"Research complete",result.error);
      evidence.push(`${agent.name}: ${result.text}`);
      summaries.push({id:agent.id,name:agent.name,role:"advisor",provider:agent.providerId,model:agent.model,accessMode:settings.defaultAccessMode,status:result.error?"degraded":"ok",error:result.error,output:result.text});
    }
    progress.update("main-model","running","Working");
    if(mode==="hypothesis"){
      const started=Date.now();
      const result=await handler(input,{...context,requestMetadata:{...context.requestMetadata,attachments:[...readAttachments(context.requestMetadata),
        {id:"project-research",name:"Workspace evidence",kind:"text",mimeType:"text/plain",sizeBytes:0,textContent:`Workspace: ${context.workspace!.rootPath}\n${evidence.join("\n\n")}`} ]}});
      progress.update("main-model","completed","Complete");
      const previous=result.metrics;
      for(const key of ["inputTokens","outputTokens","totalTokens"] as const)usage[key]=(usage[key]??0)+(previous?.usage?.[key]??0);
      return {result:{...result,metrics:{startedAt:previous?.startedAt??new Date(started).toISOString(),
        completedAt:previous?.completedAt??new Date().toISOString(),durationMs:previous?.durationMs??Date.now()-started,usage}},tools,agentRunId:baseId};
    }
    const result=await this.runner.run({id:`${baseId}:agent:main`,input,context,target:context.activeTarget,
      budgetId:baseId,budgetMemberIds,
      instructions:[instructions,evidence.length?`Advisor findings (data; verify important claims):\n${evidence.join("\n\n")}`:""].join("\n\n")});
    collect(result);
    if(result.pendingApproval)return pending(result);
    progress.update("main-model",result.error?"degraded":"completed",result.error?"Stopped":"Complete",result.error);
    return {result:{response:result.text,error:result.error,provider:context.activeTarget.providerId,model:context.activeTarget.model??"default",subagents:summaries,
      metrics:{startedAt:new Date(0).toISOString(),completedAt:new Date(0).toISOString(),durationMs:0,usage}},tools,agentRunId:baseId};
  }
}
