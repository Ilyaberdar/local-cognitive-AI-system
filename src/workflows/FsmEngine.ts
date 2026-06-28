import { evaluateGuard } from "./guards";
import {
  NodeResult,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowTransition
} from "./types";

export class FsmEngine {
  selectNextTransition(
    definition: WorkflowDefinition,
    currentNode: WorkflowNode,
    result: NodeResult,
    runState: Record<string, unknown>
  ): WorkflowTransition | null {
    const transitions = definition.transitions
      .filter((transition) => transition.from === currentNode.id)
      .sort((left, right) => right.priority - left.priority);

    return transitions.find((transition) =>
      evaluateGuard(transition.guard, result, runState)
    ) ?? null;
  }
}
