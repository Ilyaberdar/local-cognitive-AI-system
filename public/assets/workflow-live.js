// One subscription owns one run. Closing it fences all in-flight responses.
export function watchWorkflowRun({ runId, detail, cached, request, onChange, EventSourceClass = EventSource }) {
  let closed = false;
  let timer = null;
  let fetching = false;
  let dirty = false;
  let snapshot = { ...detail, events: cached?.events ?? [], cursor: cached?.cursor ?? 0,
    truncated: cached?.truncated ?? false, connection: "connecting" };
  const publish = () => { if (!closed) onChange(snapshot); };
  const acceptDetail = next => {
    if (closed || next?.run?.id !== runId) return false;
    const previousAt = snapshot.run.updatedAt ?? "";
    const nextAt = next.run.updatedAt ?? "";
    if (nextAt < previousAt) return false;
    if (["done", "failed", "cancelled"].includes(snapshot.run.status) && next.run.status !== snapshot.run.status) return false;
    if (nextAt === previousAt) {
      if (next.nodeRuns.length < snapshot.nodeRuns.length) return false;
      const incoming = new Map(next.nodeRuns.map(node => [node.id, node]));
      for (const current of snapshot.nodeRuns) {
        const node = incoming.get(current.id);
        if (!node) return false;
        if ((node.completedAt ?? node.progress?.at ?? node.startedAt ?? "") < (current.completedAt ?? current.progress?.at ?? current.startedAt ?? "")) return false;
        if (current.status !== "running" && node.status === "running") return false;
      }
    }
    snapshot = { ...snapshot, ...next }; return true;
  };
  const merge = (incoming, firstSequence = 0) => {
    const bySequence = new Map(snapshot.events.filter(event => event.sequence >= firstSequence).map(event => [event.sequence, event]));
    incoming.forEach(event => bySequence.set(event.sequence, event));
    const events = [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
    snapshot = { ...snapshot, events: events.slice(-1000), cursor: Math.max(snapshot.cursor, incoming.at(-1)?.sequence ?? 0),
      truncated: snapshot.truncated || firstSequence > 1 || events.length > 1000 };
  };
  const refresh = async () => {
    timer = null;
    if (closed) return;
    if (fetching) { dirty = true; return; }
    fetching = true; dirty = false;
    const cursorAtRequest = snapshot.cursor;
    try {
      const next = await request(`/workflow-runs/${encodeURIComponent(runId)}`);
      if (snapshot.cursor !== cursorAtRequest) dirty = true;
      else if (acceptDetail(next)) publish();
    } catch { /* SSE reconnect and the dashboard poll retry state retrieval. */ }
    finally { fetching = false; if (dirty && !closed) schedule(); }
  };
  const schedule = () => { if (!closed && timer === null) timer = setTimeout(() => void refresh(), 120); };
  const source = new EventSourceClass(`/workflow-runs/${encodeURIComponent(runId)}/events?after=${snapshot.cursor}`);
  source.addEventListener("history", event => {
    if (closed) return;
    try {
      const history = JSON.parse(event.data);
      if (history.lastSequence < snapshot.cursor) snapshot = { ...snapshot, events: [], cursor: 0, truncated: false };
      merge(history.events, history.firstSequence);
      acceptDetail(history.detail);
      snapshot = { ...snapshot,
        cursor: history.lastSequence, truncated: snapshot.truncated || history.truncated, connection: "live" };
      publish(); schedule();
    } catch { snapshot = { ...snapshot, connection: "reconnecting" }; publish(); }
  });
  source.addEventListener("update", event => {
    if (closed) return;
    try {
      const item = JSON.parse(event.data);
      if (item.runId !== runId || item.sequence <= snapshot.cursor) return;
      merge([item]); snapshot = { ...snapshot, connection: "live" }; publish(); schedule();
    } catch { /* A malformed event never replaces the known run. */ }
  });
  source.onerror = () => { snapshot = { ...snapshot, connection: "reconnecting" }; publish(); };
  publish();
  return { close() { closed = true; clearTimeout(timer); source.close(); },
    setDetail(next) { if (acceptDetail(next)) publish(); } };
}
