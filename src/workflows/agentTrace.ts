import type { AgentRun, AgentRunStore } from "../agents/runtime/AgentRunStore";
import type { NodeRun } from "./types";

export class AgentTraceNotFoundError extends Error { readonly statusCode = 404; }
export type AgentTrace = AgentRun | { id: string; agents: AgentRun[]; turns: AgentRun["turns"] };

/** The agent steps behind an agent step of a workflow run: its own agent, or the agents a
 * coordinator ran for it. Only agent runs recorded by that workflow run are read. */
export async function readAgentTrace(store: Pick<AgentRunStore, "get" | "getBudget">, nodeRuns: NodeRun[] | undefined, agentRunId: string): Promise<AgentTrace> {
  const ids = nodeRuns?.map(node => node.agentRunId).filter((id): id is string => typeof id === "string") ?? [];
  if (!ids.some(id => agentRunId === id || agentRunId.startsWith(`${id}:agent:`))) throw new AgentTraceNotFoundError("Agent run was not found in this workflow.");
  const exact = await store.get(agentRunId);
  if (!exact && ids.includes(agentRunId)) {
    const budget = await store.getBudget(agentRunId);
    const participants = await Promise.all((budget?.memberIds ?? []).filter(id => id.startsWith(`${agentRunId}:agent:`)).map(id => store.get(id)));
    const agents = participants.filter((agent): agent is AgentRun => Boolean(agent));
    if (agents.length) {
      return { id: agentRunId, agents, turns: agents.flatMap(agent => agent.turns.map(turn => ({ ...turn, content: `[${agent.id.slice(agentRunId.length + 7)}] ${turn.content}` }))) };
    }
  }
  const run = exact ?? await store.get(`${agentRunId}:agent:main`);
  if (!run) throw new AgentTraceNotFoundError("No agent steps have been recorded yet.");
  return run;
}
