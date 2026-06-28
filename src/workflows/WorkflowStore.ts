import fs from "fs/promises";
import path from "path";
import { defaultTaskWorkflow } from "./defaultWorkflows";
import {
  WorkflowDefinition,
  WorkflowDefinitionRecord,
  WorkflowValidationResult
} from "./types";

export class WorkflowStore {
  private readonly filePath: string;

  constructor(private readonly baseDir: string) {
    this.filePath = path.join(baseDir, "definitions.json");
  }

  async list(): Promise<WorkflowDefinition[]> {
    const record = await this.read();
    return [...record.workflows].sort((left, right) =>
      left.name.localeCompare(right.name) || right.version - left.version
    );
  }

  async get(workflowId: string, version?: number): Promise<WorkflowDefinition | null> {
    const record = await this.read();
    const candidates = record.workflows.filter((workflow) => workflow.id === workflowId);

    if (version !== undefined) {
      return candidates.find((workflow) => workflow.version === version) ?? null;
    }

    return candidates.sort((left, right) => right.version - left.version)[0] ?? null;
  }

  async create(workflow: WorkflowDefinition): Promise<WorkflowDefinition> {
    const validation = this.validate(workflow);

    if (!validation.ok) {
      throw new Error(`Invalid workflow: ${validation.errors.join("; ")}`);
    }

    const record = await this.read();
    const now = new Date().toISOString();
    const next = {
      ...workflow,
      createdAt: workflow.createdAt || now,
      updatedAt: now
    };

    record.workflows.push(next);
    await this.write(record);
    return next;
  }

  async update(workflowId: string, workflow: WorkflowDefinition): Promise<WorkflowDefinition> {
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
  }

  validate(workflow: WorkflowDefinition): WorkflowValidationResult {
    const errors: string[] = [];
    const nodeIds = new Set(workflow.nodes.map((node) => node.id));

    if (!workflow.id.trim()) {
      errors.push("Workflow id is required.");
    }

    if (!workflow.name.trim()) {
      errors.push("Workflow name is required.");
    }

    if (!nodeIds.has(workflow.entryNodeId)) {
      errors.push("Entry node does not exist.");
    }

    for (const transition of workflow.transitions) {
      if (!nodeIds.has(transition.from)) {
        errors.push(`Transition ${transition.id} references missing source node ${transition.from}.`);
      }

      if (!nodeIds.has(transition.to)) {
        errors.push(`Transition ${transition.id} references missing target node ${transition.to}.`);
      }
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
      const workflows = Array.isArray(parsed.workflows) ? parsed.workflows : [];
      return {
        workflows: this.ensureDefaults(workflows)
      };
    } catch {
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
    await fs.writeFile(this.filePath, JSON.stringify(record, null, 2), "utf8");
  }
}
