import { FollowOutputButton } from "./FollowOutputButton";
import { useMemo } from "react";
import type { RefObject } from "react";
import type { ProviderOption, WorkflowDefinition, WorkflowExecution, WorkflowLogEvent } from "./types";

const toolLabels: Record<string, string> = {
  "file.read": "Reading file", "file.write": "Writing file", "file.replace": "Editing file",
  "file.list": "Listing files", "file.search": "Searching files", "command.run": "Running command",
  "web.fetch": "Reading webpage", "web.search": "Searching the web"
};
function actionLabel(event: WorkflowLogEvent) {
  if (event.phase === "generating" || event.message === "Generating" || event.message === "Working in project") return "Generating response";
  const result = /^(\S+) (completed|failed)$/.exec(event.message);
  if (result && toolLabels[result[1]]) {
    const names: Record<string, string> = { "file.read": "File read", "file.write": "File saved", "file.replace": "File edited", "file.list": "Files listed", "file.search": "Search complete", "command.run": "Command completed" };
    return result[2] === "failed" ? `${toolLabels[result[1]]} failed` : names[result[1]] ?? event.message;
  }
  return toolLabels[event.message] ?? event.message;
}
function ActivityIcon({ event }: { event: WorkflowLogEvent }) {
  const text = event.message.toLowerCase();
  const path = event.level === "error" ? "M12 8v5m0 3h.01M12 3 2 21h20Z" :
    text.includes("command") ? "M8 9l3 3-3 3m5 0h3M4 4h16v16H4Z" :
    text.includes("file") ? "M6 3h8l4 4v14H6ZM14 3v5h4M9 12h6m-6 4h6" :
    text.includes("web") || text.includes("search") ? "M15 15l5 5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0" :
    text.includes("completed") || text.includes("done") ? "m5 12 4 4L19 6" :
    "M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6 2.1-2.1";
  return <svg className="workflow-activity__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}
function Detail({ text }: { text?: string }) {
  if (!text) return null;
  if (text.length <= 180 && !text.includes("\n")) return <p>{text}</p>;
  return <details><summary>{text.replace(/\s+/g, " ").slice(0, 160)}…</summary><pre>{text}</pre></details>;
}

export function WorkflowActivity({ execution, workflow, providers, events, recordedEvents, nodeFilter, now, scroller, follow, onFollow }: {
  execution?: WorkflowExecution; workflow: WorkflowDefinition; providers: ProviderOption[];
  events: WorkflowLogEvent[]; recordedEvents: WorkflowLogEvent[]; nodeFilter: string; now: number;
  scroller: RefObject<HTMLDivElement | null>; follow: boolean; onFollow: (follow: boolean) => void;
}) {
  const nodes = useMemo(() => new Map(workflow.nodes.map(node => [node.id, node])), [workflow]);
  const history = useMemo(() => events.filter(event => !event.stream && event.type !== "node.output" && event.type !== "transition" &&
    (event.type !== "run.status" || /failed|cancelled|interrupted/i.test(event.message)) &&
    (!nodeFilter || event.nodeId === nodeFilter)).filter((event, index, items) => {
      const next = items[index + 1];
      return !(actionLabel(event) === "Generating response" && next && actionLabel(next) === "Generating response" && event.nodeRunId === next.nodeRunId && event.nodeId === next.nodeId);
    }), [events, nodeFilter]);
  const currentNode = execution?.run.currentNodeId;
  const current = [...recordedEvents].reverse().find(event => event.nodeId === currentNode && !event.stream && event.type !== "transition");
  const running = execution?.run.status === "running";
  const currentLabel = running ? current ? actionLabel(current) : "Starting step" : execution ? `Workflow ${execution.run.status}` : "Ready to run";
  const elapsed = current ? Math.max(0, Math.floor((now - Date.parse(current.at)) / 1000)) : 0;
  const modelLabel = (id?: string) => {
    const node = id ? nodes.get(id) : undefined;
    if (node?.type !== "agent") return undefined;
    const provider = providers.find(item => item.id === node.config.providerId);
    const model = typeof node.config.model === "string" ? node.config.model : provider?.defaultModel;
    return model ? provider?.modelLabels?.[model] ?? model : provider?.name ?? "Agent";
  };
  return <section className="workflow-activity" aria-label="Agent activity">
    <header className="workflow-output__pane-header"><strong>Agent activity</strong>
      <FollowOutputButton following={follow} target="activity" onToggle={() => onFollow(!follow)} />
    </header>
    <div className={`workflow-activity__current status-${execution?.run.status ?? "idle"}`} aria-live="polite">
      <strong>{currentLabel}</strong>{running && current ? <time>{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}</time> : null}
      {currentNode ? <span>{nodes.get(currentNode)?.label ?? currentNode}{modelLabel(currentNode) ? ` · ${modelLabel(currentNode)}` : ""}</span> : null}
    </div>
    <div className="workflow-activity__history" ref={scroller} tabIndex={0} aria-label="Action history"
      onKeyDown={event => { if ((event.key === "Home" || event.key === "End") && event.target === event.currentTarget) {
        event.preventDefault(); event.currentTarget.scrollTop = event.key === "Home" ? 0 : event.currentTarget.scrollHeight; onFollow(event.key === "End");
      } }}
      onScroll={event => { const el = event.currentTarget; onFollow(el.scrollHeight - el.scrollTop - el.clientHeight <= 30); }}>
      {history.length ? history.map((event, index) => <article className={`workflow-activity__event level-${event.level}`} key={event.sequence} data-sequence={event.sequence}>
        {index === 0 || history[index - 1].nodeId !== event.nodeId || history[index - 1].nodeRunId !== event.nodeRunId ? <div className="workflow-activity__group">
          <span>{event.nodeId ? nodes.get(event.nodeId)?.label ?? event.nodeId : "Workflow"}</span>
          {modelLabel(event.nodeId) ? <small>{modelLabel(event.nodeId)}</small> : null}
        </div> : null}
        <div className="workflow-activity__action"><ActivityIcon event={event} /><div><strong>{actionLabel(event)}</strong><Detail text={event.detail} /></div>
          <time title={event.at}>{new Date(event.at).toLocaleTimeString([], { hour12: false })}</time></div>
      </article>) : <div className="workflow-console__empty">{!execution ? "Actions and results will appear here when you run the workflow." : "No activity in this view yet."}</div>}
    </div>
  </section>;
}
