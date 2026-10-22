import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { encode, errorMessage } from "./api";
import { revealIn } from "./scroll";
import { usePaneSplit } from "./usePaneSplit";
import type { AgentDetail, AgentItem, SynthesisRun } from "./types";

const statusText: Record<AgentItem["status"], string> = { queued: "Queued", running: "Running", done: "Done", failed: "Failed", cancelled: "Cancelled" };
const seconds = (ms: number) => ms ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : "";
const tokens = (value: number) => value >= 10_000 ? `${Math.round(value / 1000)}k` : value.toLocaleString();

/** The run's agents: how many stand where, the agents on the left (one per task) and the chosen
 * one's steps on the right, each scrolling on its own. */
export function SynthesisAgents({ run, request }: { run: SynthesisRun; request: <T>(path: string, options?: RequestInit) => Promise<T> }) {
  const [items, setItems] = useState<AgentItem[]>([]);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const split = usePaneSplit("lcai.synthesis.agentsSplit.v1", 34, "x", container);
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
  // Until one is chosen: the first that failed, else the first.
  const shown = selected ?? (items.find(item => item.status === "failed") ?? items[0])?.index ?? null;
  const chosen = shown === null ? undefined : items.find(item => item.index === shown);
  useEffect(() => {
    if (shown === null) return;
    let current = true;
    request<AgentDetail>(`/runs/${encode(run.id)}/agents/${shown}`).then(result => { if (current) setDetail(result); }, () => undefined);
    return () => { current = false; };
  }, [run.id, shown, chosen?.status, chosen?.steps]);
  useEffect(() => {
    revealIn(list.current?.querySelector('[aria-selected="true"]') as HTMLElement | null);
  }, [shown, items.length]);
  const move = (event: KeyboardEvent<HTMLUListElement>) => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key) || !items.length) return;
    event.preventDefault();
    const at = Math.max(0, items.findIndex(item => item.index === shown)) + (event.key === "ArrowDown" ? 1 : -1);
    const next = items[Math.max(0, Math.min(items.length - 1, at))]!;
    setSelected(next.index);
    (event.currentTarget.querySelector(`[data-agent="${next.index}"]`) as HTMLElement | null)?.focus();
  };
  const counts = run.agents;
  // A local model's id (gguf-…) is not what Models calls it: its name and its provider's, as the run lists them.
  const named = (item: AgentItem) => {
    const model = run.models?.find(entry => entry.id === item.model && entry.providerId === item.providerId);
    return { model: model?.displayName || item.model, provider: model?.providerName ?? item.providerId };
  };
  const view = detail && detail.index === shown ? detail : null;
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
    {items.length ? <div className="synthesis-agents__split" ref={container} data-resizing={split.resizing || undefined}
      style={{ gridTemplateColumns: `minmax(180px, ${split.value}fr) 9px minmax(0, ${100 - split.value}fr)` }}>
      <ul className="synthesis-agents__list" role="listbox" aria-label="Agents of this run" ref={list} onKeyDown={move}>
        {items.map(item => <li key={`${item.call}:${item.index}`}><button type="button" role="option" data-agent={item.index} aria-selected={item.index === shown}
          tabIndex={item.index === shown ? 0 : -1} className={`synthesis-agents__row status-${item.status}`} onClick={() => setSelected(item.index)}>
          <span className="synthesis-agents__top"><span className="synthesis-agents__number">{item.index + 1}</span>
            <span className="synthesis-agents__model" title={`${item.providerId}/${item.model}`}>{named(item).model}<small>{named(item).provider}</small></span>
            <span className="synthesis-agents__status">{statusText[item.status]}</span></span>
          <span className="synthesis-agents__task" title={item.task}>{item.task}</span>
          <span className="synthesis-agents__meta">{[item.steps ? `${item.steps} steps` : "", item.inputTokens ? `${tokens(item.inputTokens)} / ${tokens(item.outputTokens)}` : "", seconds(item.durationMs)].filter(Boolean).join(" · ")}
            {item.files.length ? <small>{item.files.map(file => file === item.answerFile ? `${file} (its answer)` : file).join(", ")}</small> : null}</span>
          {item.error ? <span className="synthesis-agents__error status-fail">{item.error}</span> : null}
        </button></li>)}
      </ul>
      <div {...split.handle} className="synthesis-split" aria-label="Resize the list of agents" title="Drag to resize · Double-click to reset" />
      {view ? <section className="synthesis-agent-detail" aria-label={`Agent ${view.index + 1}`}>
        <header><strong>Agent {view.index + 1}</strong><span>{named(view).provider} · {named(view).model} · {statusText[view.status]}{view.protocol ? ` · ${view.protocol} actions` : ""}</span></header>
        <p className="synthesis-agent-detail__task">{view.task}</p>
        {view.error ? <p className="synthesis-agent-detail__error status-fail">{view.error}</p> : null}
        {view.answerFile ? <p className="synthesis-agent-detail__task">It wrote no file itself: its answer was saved as {view.answerFile}.</p>
          : view.answerRefused ? <p className="synthesis-agent-detail__task">Its answer was not saved: {view.answerRefused}</p> : null}
        <ol>{view.turns.map((turn, index) => <li key={index} className={`synthesis-agent-turn is-${turn.type}${turn.ok === false ? " is-refused" : ""}`}><span>{turn.type === "tool" ? "Action" : turn.type === "result" ? turn.ok === false ? "Refused" : "Result" : "Correction"}</span><pre>{turn.content}</pre></li>)}</ol>
        {view.final ? <div className="synthesis-agent-detail__final"><span>Answer</span><pre>{view.final}</pre></div> : null}
        {!view.turns.length && !view.final ? <p className="synthesis-agent-detail__task">{view.status === "queued" ? "Waiting for its turn." : view.status === "running" ? "No steps yet." : "No action ran."}</p> : null}
      </section> : <div className="synthesis-agent-detail synthesis-empty">Loading the agent's steps…</div>}
    </div> : !error ? <div className="synthesis-empty">{live ? "Agents appear here as the flow starts them." : "This run started no agents."}</div> : null}
  </div>;
}
