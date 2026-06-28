import { WorkflowDefinition } from "./types";

export const DEFAULT_TASK_WORKFLOW_ID = "default-task-workflow";

export const defaultTaskWorkflow = (): WorkflowDefinition => {
  const timestamp = new Date(0).toISOString();

  return {
    id: DEFAULT_TASK_WORKFLOW_ID,
    name: "Default Task Workflow",
    version: 1,
    description: "Execute a queued task with one code agent node and terminal success/failure states.",
    entryNodeId: "entry",
    nodes: [
      {
        id: "entry",
        type: "entry",
        label: "Entry",
        position: { x: 0, y: 0 },
        config: {}
      },
      {
        id: "execute",
        type: "agent",
        label: "Execute Task",
        position: { x: 240, y: 0 },
        config: {
          mode: "code",
          promptTemplate: "{{task.title}}\n\n{{task.description}}"
        }
      },
      {
        id: "done",
        type: "terminal",
        label: "Done",
        position: { x: 520, y: 0 },
        config: {
          runStatus: "done"
        }
      },
      {
        id: "failed",
        type: "terminal",
        label: "Failed",
        position: { x: 520, y: 140 },
        config: {
          runStatus: "failed"
        }
      }
    ],
    transitions: [
      {
        id: "entry-execute",
        from: "entry",
        to: "execute",
        priority: 100,
        guard: { type: "always" }
      },
      {
        id: "execute-done",
        from: "execute",
        to: "done",
        priority: 100,
        guard: { type: "status", equals: "ok" }
      },
      {
        id: "execute-failed",
        from: "execute",
        to: "failed",
        priority: 90,
        guard: { type: "status", equals: "failed" }
      }
    ],
    createdAt: timestamp,
    updatedAt: timestamp
  };
};
