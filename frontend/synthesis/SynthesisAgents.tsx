import { useEffect, useState } from "react";
import { encode, errorMessage } from "./api";
import type { AgentDetail, AgentItem, SynthesisRun } from "./types";

const statusText: Record<AgentItem["status"], string> = { queued: "Queued", running: "Running", done: "Done", failed: "Failed", cancelled: "Cancelled" };
const seconds = (ms: number) => ms ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : "";
const tokens = (value: number) => value >= 10_000 ? `${Math.round(value / 1000)}k` : value.toLocaleString();

/** The run's agents: how many stand where, one row per task, and one agent's steps when chosen. */
export function SynthesisAgents({ run, request }: { run: SynthesisRun; request: <T>(path: string, options?: RequestInit) => Promise<T> }) {
  const [items, setItems] = useState<AgentItem[]>([]);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const live = run.status === "running" || run.status === "queued";
  useEffect(() => {
    let current = true;
    const load = () => request<{ items?: AgentItem[] }>(`/runs/${encode(run.id)}/agents`)
      .then(result => { if (current) { setItems(result?.items ?? []); setError(""); } }, reason => { if (current) setError(errorMessage(reason)); });
    void load();
    const timer = live ? setInterval(load, 1500) : undefined;
    return () => { current = false; if (timer) clearInterval(timer); };
  }, [run.id, live, run.agents?.done, run.agents?.failed]);
  useEffect(() => { setSelected(null); setDetail(null); }, [run.id]);
  const chosen = selected === null ? undefined : items[selected];
  useEffect(() => {
    if (selected === null) return;
    let current = true;
    request<AgentDetail>(`/runs/${encode(run.id)}/agents/${selected}`).then(result => { if (current) setDetail(result); }, () => undefined);
    return () => { current = false; };
  }, [run.id, selected, chosen?.status, chosen?.steps]);
  const counts = run.agents;
  return <div className="synthesis-agents">
    {counts ? <div className="synthesis-agents__counts" aria-label="Agents">
      <span><strong>{counts.total}</strong> agents</span>
      {counts.running ? <span className="status-running"><strong>{counts.running}</strong> running</span> : null}
      {counts.queued ? <span><strong>{counts.queued}</strong> queued</span> : null}
      <span className="status-pass"><strong>{counts.done}</strong> done</span>
      {counts.failed ? <span className="status-fail"><strong>{counts.failed}</strong> failed</span> : null}
      {counts.cancelled ? <span><strong>{counts.cancelled}</strong> cancelled</span> : null}
    </div> : null}
    {error && !items.length ? <div className="synthesis-empty" role="alert">{error}</div> : null}
    {items.length ? <div className="synthesis-agents__table" role="table" aria-label="Agents of this run">
      <div role="row" className="synthesis-agents__head"><span role="columnheader">#</span><span role="columnheader">Model</span><span role="columnheader">Status</span><span role="columnheader">Steps</span><span role="columnheader">Tokens in / out</span><span role="columnheader">Time</span><span role="columnheader">Task</span></div>
      {items.map(item => <button type="button" role="row" key={`${item.call}:${item.index}`} aria-pressed={selected === item.index} className={`synthesis-agents__row status-${item.status}`} onClick={() => setSelected(selected === item.index ? null : item.index)}>
        <span role="cell">{item.index + 1}</span><span role="cell" title={`${item.providerId}/${item.model}`}>{item.model}<small>{item.providerId}</small></span>
        <span role="cell">{statusText[item.status]}</span><span role="cell">{item.steps || ""}</span><span role="cell">{item.inputTokens ? `${tokens(item.inputTokens)} / ${tokens(item.outputTokens)}` : ""}</span>
        <span role="cell">{seconds(item.durationMs)}</span><span role="cell" title={item.task}>{item.task}{item.files.length ? <small>{item.files.join(", ")}</small> : null}{item.error ? <small className="status-fail">{item.error}</small> : null}</span>
      </button>)}
    </div> : !error ? <div className="synthesis-empty">{live ? "Agents appear here as the flow starts them." : "This run started no agents."}</div> : null}
    {detail && selected !== null ? <section className="synthesis-agent-detail" aria-label={`Agent ${selected + 1}`}>
      <header><strong>Agent {selected + 1}</strong><span>{detail.providerId}/{detail.model} · {statusText[detail.status]}{detail.protocol ? ` · ${detail.protocol} actions` : ""}</span></header>
      <p className="synthesis-agent-detail__task">{detail.task}</p>
      <ol>{detail.turns.map((turn, index) => <li key={index} className={`synthesis-agent-turn is-${turn.type}`}><span>{turn.type === "tool" ? "Action" : turn.type === "result" ? "Result" : "Correction"}</span><pre>{turn.content}</pre></li>)}</ol>
      {detail.final ? <div className="synthesis-agent-detail__final"><span>Answer</span><pre>{detail.final}</pre></div> : null}
    </section> : null}
  </div>;
}
