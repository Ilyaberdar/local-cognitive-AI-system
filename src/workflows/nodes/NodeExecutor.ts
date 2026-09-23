import { CognitiveEngine } from "../../core/CognitiveEngine";
import { ProcessProgressEvent, ProviderTarget, SessionSettings, SubagentAccessMode } from "../../types";
import { WorkspaceSnapshot } from "../../workspace/types";
import { Task } from "../../tasks/types";
import {
  NodeResult,
  NodeRun,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowRun
} from "../types";

export interface NodeExecutionContext {
  task: Task;
  workflow: WorkflowDefinition;
  run: WorkflowRun;
  node: WorkflowNode;
  previousNodeRuns: NodeRun[];
  signal?: AbortSignal;
  onProgress?: (event: ProcessProgressEvent) => void;
  approval?: Record<string, unknown>;
  workspace?: WorkspaceSnapshot;
  accessMode?: SubagentAccessMode;
  settings?: SessionSettings;
  agentRunId?: string;
  agentInput?: string;
  operationId?: string;
}

export interface NodeExecutor {
  type: WorkflowNodeType;
  snapshotTarget?(node: WorkflowNode, settings?: SessionSettings): ProviderTarget | undefined;
  execute(context: NodeExecutionContext): Promise<NodeResult>;
}

export class NodeExecutorRegistry {
  private readonly executors = new Map<WorkflowNodeType, NodeExecutor>();

  constructor(executors: NodeExecutor[]) {
    for (const executor of executors) {
      this.executors.set(executor.type, executor);
    }
  }

  get(type: WorkflowNodeType): NodeExecutor {
    const executor = this.executors.get(type);

    if (!executor) {
      throw new Error(`No node executor registered for "${type}".`);
    }

    return executor;
  }
}

export interface AgentNodeExecutorOptions {
  engine: CognitiveEngine;
}
