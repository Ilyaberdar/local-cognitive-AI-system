import { withFileLock, writeJsonAtomically, isMissingFile } from "../utils/fileStore";
import fs from "fs/promises";
import path from "path";
import { defaultTaskWorkflow } from "./defaultWorkflows";
import {
  WorkflowDefinition,
  WorkflowDefinitionRecord,
  WorkflowNode,
  WorkflowValidationResult
} from "./types";

export class WorkflowStore {
  private readonly filePath: string;

  constructor(private readonly baseDir: string) {
    this.filePath = path.join(baseDir, "definitions.json");
  }

  async list(): Promise<WorkflowDefinition[]> {
    return withFileLock(this.filePath, async () => {
      const record = await this.read();
      return [...record.workflows].sort((left, right) =>
        left.name.localeCompare(right.name) || right.version - left.version
      );
    });
  }

  async get(workflowId: string, version?: number): Promise<WorkflowDefinition | null> {
    return withFileLock(this.filePath, async () => {
      const record = await this.read();
      const candidates = record.workflows.filter((workflow) => workflow.id === workflowId);

      if (version !== undefined) {
        return candidates.find((workflow) => workflow.version === version) ?? null;
      }

      return candidates.sort((left, right) => right.version - left.version)[0] ?? null;
    });
  }

  async create(workflow: WorkflowDefinition): Promise<WorkflowDefinition> {
    return withFileLock(this.filePath, async () => {
      const validation = this.validate(workflow);

      if (!validation.ok) {
        throw new Error(`Invalid workflow: ${validation.errors.join("; ")}`);
      }

      const record = await this.read();
      if (record.workflows.some((item) => item.id === workflow.id && item.version === workflow.version)) {
        throw new Error("Workflow id and version already exist.");
      }
      const now = new Date().toISOString();
      const next = {
        ...workflow,
        createdAt: workflow.createdAt || now,
        updatedAt: now
      };

      record.workflows.push(next);
      await this.write(record);
      return next;
    });
  }

  async update(workflowId: string, workflow: WorkflowDefinition): Promise<WorkflowDefinition> {
    return withFileLock(this.filePath, async () => {
      const validation = this.validate(workflow);

      if (!validation.ok) {
        throw new Error(`Invalid workflow: ${validation.errors.join("; ")}`);
      }

      const record = await this.read();
      const next = {
        ...workflow,
        id: workflowId,
        updatedAt: new Date().toISOString()
      };
      const index = record.workflows.findIndex(
        (item) => item.id === workflowId && item.version === workflow.version
      );

      if (index >= 0) {
        record.workflows[index] = next;
      } else {
        record.workflows.push(next);
      }

      await this.write(record);
      return next;
    });
  }

  validate(input: unknown): WorkflowValidationResult {
    const errors: string[] = [];
    if (!isRecord(input) || typeof input.id !== "string" || typeof input.name !== "string" ||
      typeof input.entryNodeId !== "string" || !Array.isArray(input.nodes) || !Array.isArray(input.transitions)) {
      return { ok: false, errors: ["Workflow requires string id, name, entryNodeId and arrays nodes and transitions."] };
    }
    for (const node of input.nodes) {
      if (!isRecord(node) || typeof node.id !== "string" || typeof node.label !== "string" ||
        typeof node.type !== "string" || !isRecord(node.config) || !isRecord(node.position) ||
        !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) {
        errors.push("Each node requires string id, label, type, an object config and a finite position.");
      }
    }
    for (const transition of input.transitions) {
      if (!isRecord(transition) || typeof transition.id !== "string" || typeof transition.from !== "string" ||
        typeof transition.to !== "string" || !Number.isFinite(transition.priority) || !isRecord(transition.guard)) {
        errors.push("Each transition requires string id, from, to, a finite priority and an object guard.");
        continue;
      }
      const guard = transition.guard;
      const valid = guard.type === "always" ||
        (guard.type === "status" && ["ok", "failed", "blocked", "needs_input"].includes(String(guard.equals))) ||
        (guard.type === "event" && typeof guard.equals === "string" && Boolean(guard.equals.trim())) ||
        (guard.type === "json_path" && typeof guard.path === "string" && Boolean(guard.path.trim()) &&
          (guard.op === "exists" || (["eq", "contains"].includes(String(guard.op)) && guard.value !== undefined)));
      if (!valid) errors.push(`Transition ${transition.id} has an invalid guard or is missing a comparison value.`);
    }
    if (errors.length) return { ok: false, errors };
    const workflow = input as unknown as WorkflowDefinition;
    const nodeIds = new Set(workflow.nodes.map((node) => node.id));
    const transitionIds = new Set(workflow.transitions.map((transition) => transition.id));
    const supportedTypes = new Set([
      "entry",
      "agent",
      "file_search",
      "web_search",
      "file_write",
      "command",
      "decision",
      "human_review",
      "terminal"
    ]);

    if (!workflow.id.trim()) {
      errors.push("Workflow id is required.");
    }

    if (!workflow.name.trim()) {
      errors.push("Workflow name is required.");
    }

    if (!Number.isInteger(workflow.version) || workflow.version < 1) {
      errors.push("Workflow version must be a positive integer.");
    }

    if (workflow.nodes.length === 0) {
      errors.push("Workflow must contain at least one node.");
    }

    if (nodeIds.size !== workflow.nodes.length) {
      errors.push("Workflow node ids must be unique.");
    }

    if (transitionIds.size !== workflow.transitions.length) {
      errors.push("Workflow transition ids must be unique.");
    }

    if (!nodeIds.has(workflow.entryNodeId)) {
      errors.push("Entry node does not exist.");
    }

    const entryNode = workflow.nodes.find((node) => node.id === workflow.entryNodeId);
    if (entryNode && entryNode.type !== "entry") {
      errors.push("Entry node must use the entry type.");
    }

    if (!workflow.nodes.some((node) => node.type === "terminal")) {
      errors.push("Workflow must contain a terminal node.");
    }

    for (const node of workflow.nodes) {
      if (!node.id.trim()) {
        errors.push("Every workflow node requires an id.");
      }

      if (!node.label.trim()) {
        errors.push(`Workflow node ${node.id || "unknown"} requires a label.`);
      }

      if (!supportedTypes.has(node.type)) {
        errors.push(`Workflow node ${node.id} uses unsupported runtime type ${node.type}.`);
      }

      errors.push(...validateNodeConfig(node));
    }

    for (const transition of workflow.transitions) {
      if (!transition.id.trim()) {
        errors.push("Every workflow transition requires an id.");
      }

      if (!nodeIds.has(transition.from)) {
        errors.push(`Transition ${transition.id} references missing source node ${transition.from}.`);
      }

      if (!nodeIds.has(transition.to)) {
        errors.push(`Transition ${transition.id} references missing target node ${transition.to}.`);
      }

      const source = workflow.nodes.find((node) => node.id === transition.from);
      const target = workflow.nodes.find((node) => node.id === transition.to);
      if (source?.type === "terminal") {
        errors.push(`Terminal node ${source.id} cannot have outgoing transitions.`);
      }
      if (target?.type === "entry") {
        errors.push(`Entry node ${target.id} cannot have incoming transitions.`);
      }
    }

    if (entryNode && !hasReachableTerminal(workflow, entryNode.id)) {
      errors.push("No terminal node is reachable from the entry node.");
    }

    return {
      ok: errors.length === 0,
      errors
    };
  }

  private async read(): Promise<WorkflowDefinitionRecord> {
    await fs.mkdir(this.baseDir, { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<WorkflowDefinitionRecord>;
      if (!parsed || !Array.isArray(parsed.workflows)) throw new Error("Expected a workflows array.");
      const workflows = parsed.workflows;
      return {
        workflows: this.ensureDefaults(workflows)
      };
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      const initial = {
        workflows: [defaultTaskWorkflow()]
      };
      await this.write(initial);
      return initial;
    }
  }

  private ensureDefaults(workflows: WorkflowDefinition[]): WorkflowDefinition[] {
    if (workflows.some((workflow) => workflow.id === defaultTaskWorkflow().id)) {
      return workflows;
    }

    return [defaultTaskWorkflow(), ...workflows];
  }

  private async write(record: WorkflowDefinitionRecord): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    await writeJsonAtomically(this.filePath, record);
  }
}

const hasReachableTerminal = (workflow: WorkflowDefinition, entryNodeId: string): boolean => {
  const queue = [entryNodeId];
  const visited = new Set<string>();

  while (queue.length) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) {
      continue;
    }

    visited.add(nodeId);
    if (workflow.nodes.find((node) => node.id === nodeId)?.type === "terminal") {
      return true;
    }

    for (const transition of workflow.transitions) {
      if (transition.from === nodeId && !visited.has(transition.to)) {
        queue.push(transition.to);
      }
    }
  }

  return false;
};

const validateNodeConfig = (node: WorkflowNode): string[] => {
  const errors: string[] = [];
  const requireString = (key: string): void => {
    if (typeof node.config[key] !== "string" || !String(node.config[key]).trim()) {
      errors.push(`Workflow node ${node.id} requires config.${key}.`);
    }
  };
  const validateAccess = (): void => {
    const access = node.config.access ?? "default";
    if (access !== "default" && access !== "full") {
      errors.push(`Workflow node ${node.id} config.access must be default or full.`);
    }
  };

  switch (node.type) {
    case "file_search":
      requireString("root");
      break;
    case "web_search":
      requireString("queryTemplate");
      if (!["brave", "searxng"].includes(String(node.config.provider ?? "searxng"))) {
        errors.push(`Workflow node ${node.id} config.provider must be brave or searxng.`);
      }
      break;
    case "file_write":
      requireString("path");
      requireString("contentTemplate");
      validateAccess();
      break;
    case "command":
      requireString("executable");
      validateAccess();
      if (node.config.args !== undefined && !Array.isArray(node.config.args)) {
        errors.push(`Workflow node ${node.id} config.args must be an array.`);
      }
      break;
    case "decision":
      requireString("path");
      if (!["eq", "neq", "contains", "gt", "gte", "lt", "lte", "truthy", "exists"].includes(String(node.config.operator ?? "exists"))) {
        errors.push(`Workflow node ${node.id} has an unsupported decision operator.`);
      }
      break;
  }

  return errors;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
