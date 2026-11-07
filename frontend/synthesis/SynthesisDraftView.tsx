import { useEffect, useRef, useState } from "react";
import { encode, errorMessage, isAbort } from "./api";
import { SynthesisIcon } from "./SynthesisIcon";
import { normalizeLines, SourceEditor, SourcePreview, type SourceProblem } from "./SourceEditor";
import type { SynthesisDraft, SynthesisModule } from "./types";

type Tab = "contract" | "flow" | "tests";
interface Edits { spec?: string; flow?: string; tests?: Record<string, string> }
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** What the draft is doing, or what it left, in a line. */
export function draftStatus(draft: SynthesisDraft): string {
  const model = draft.model.displayName;
  if (draft.status === "drafting") {
    if (draft.phase === "loading") return `Loading ${model}…`;
    if (draft.phase === "checking") return `Checking answer ${draft.attempt}…`;
    const progress = ` · answer ${Math.max(1, draft.attempt)} of ${draft.maxAttempts}${draft.tokens ? ` · ${draft.tokens.toLocaleString()} tokens` : ""}`;
    if (draft.phase === "thinking") return `${model} is thinking before it writes${progress}`;
    return `${model} is writing the contract and tests${progress}`;
  }
  if (draft.status === "failed") return draft.error ?? `${model} wrote no contract.`;
  const errors = draft.diagnostics.filter(item => item.severity !== "warning").length;
  if (errors) return `${model} left ${plural(errors, "problem")} after ${plural(draft.attempt, "answer")}. Fix them here, or save and fix them later.`;
  return `Written by ${model} in ${plural(draft.attempt, "answer")}. Read the contract and tests: once saved they are yours, and a run accepts exactly what they check.`;
}

/** A module a model drafted, before it is in the project: its contract, flow and tests to read and edit,
 * checked again on request, then saved as a new module or discarded. */
export function SynthesisDraftView({ draft, request, onChanged, onSaved, onDiscarded }: {
  draft: SynthesisDraft;
  request: <T>(path: string, options?: RequestInit) => Promise<T>;
  onChanged: (draft: SynthesisDraft) => void; onSaved: (module: SynthesisModule) => void; onDiscarded: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("contract");
  const [testFile, setTestFile] = useState("");
  const [edits, setEdits] = useState<Edits>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => { setEdits({}); setError(""); setConfirming(false); setTab("contract"); }, [draft.id]);
  const drafting = draft.status === "drafting";

  // While the model writes, the draft is read again each second.
  useEffect(() => {
    if (!drafting) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await request<SynthesisDraft>(`/drafts/${encode(draft.id)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        onChanged(next);
        if (next.status === "drafting") timer = setTimeout(poll, 1000);
      } catch (reason) { if (!controller.signal.aborted && !isAbort(reason)) { setError(errorMessage(reason)); timer = setTimeout(poll, 3000); } }
    };
    timer = setTimeout(poll, 1000);
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [draft.id, drafting]);

  const tests = { ...draft.tests, ...edits.tests };
  const files = Object.keys(tests).sort();
  const shownTest = files.includes(testFile) ? testFile : files[0] ?? "";
  const editable = !drafting && Boolean(draft.spec);
  const edited = edits.spec !== undefined || edits.flow !== undefined || edits.tests !== undefined;
  const value = tab === "contract" ? edits.spec ?? draft.spec ?? "" : tab === "flow" ? edits.flow ?? draft.flow ?? "" : tests[shownTest] ?? "";
  const change = (text: string) => setEdits(current => tab === "contract" ? { ...current, spec: text } : tab === "flow" ? { ...current, flow: text }
    : { ...current, tests: { ...draft.tests, ...current.tests, [shownTest]: text } });
  const problems: SourceProblem[] = tab === "tests" ? [] : draft.diagnostics
    .filter(item => item.line && item.file === (tab === "contract" ? draft.specPath : draft.flowPath))
    .map(item => ({ line: item.line!, column: item.column, message: item.message, severity: item.severity === "warning" ? "warning" : "error" }));
  const listed = tab === "flow" ? draft.diagnostics.filter(item => item.file === draft.flowPath) : draft.diagnostics.filter(item => item.file !== draft.flowPath);
  const untested = draft.diagnostics.filter(item => item.code === "SPEC_CLAUSE_UNTESTED").length;

  const act = async (label: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(label); setError("");
    try { await action(); } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { if (alive.current) setBusy(""); }
  };
  const check = async () => {
    if (!edited) return draft;
    const next = await request<SynthesisDraft>(`/drafts/${encode(draft.id)}`, { method: "PUT", body: JSON.stringify(edits) });
    if (alive.current) { setEdits({}); onChanged(next); }
    return next;
  };
  const save = () => void act("save", async () => {
    await check();
    onSaved(await request<SynthesisModule>(`/drafts/${encode(draft.id)}/save`, { method: "POST" }));
  });
  const discard = () => void act("discard", async () => {
    await request(`/drafts/${encode(draft.id)}`, { method: "DELETE" });
    onDiscarded(draft.id);
  });

  const label = tab === "contract" ? "Draft contract" : tab === "flow" ? "Draft flow" : `Draft test ${shownTest}`;
  return <main className="synthesis-main-pane synthesis-draft">
    <div className={`synthesis-draft__status${draft.status === "failed" || (!drafting && !draft.valid) ? " is-problem" : ""}`} role="status" aria-live="polite">
      {drafting ? <span className="synthesis-draft__spinner" aria-hidden="true" /> : <SynthesisIcon name={draft.valid ? "check" : "warning"} />}<span>{draftStatus(draft)}</span>
    </div>
    {error ? <div className="synthesis-message synthesis-message--error" role="alert">{error}<button type="button" aria-label="Dismiss error" onClick={() => setError("")}>×</button></div> : null}
    <div className="synthesis-tabs" role="tablist" aria-label="Draft views">{([["contract", "Contract"], ["flow", "Flow"], ["tests", `Tests · ${files.length}`]] as Array<[Tab, string]>).map(([id, text]) =>
      <button role="tab" type="button" key={id} id={`synthesis-draft-tab-${id}`} aria-selected={tab === id} aria-controls="synthesis-draft-panel" disabled={!draft.spec} onClick={() => setTab(id)}>{text}
        {(id === "contract" && edits.spec !== undefined) || (id === "flow" && edits.flow !== undefined) || (id === "tests" && edits.tests !== undefined) ? <span className="synthesis-dirty" title="Not checked yet">•</span> : null}</button>)}
    </div>
    <div className="synthesis-source-origin">
      {tab === "tests" && files.length > 1 ? <div role="group" aria-label="Test file">{files.map(file => <button type="button" key={file} aria-pressed={file === shownTest} onClick={() => setTestFile(file)}>{file}</button>)}</div> : null}
      <span>{drafting ? "The model is writing; the files show here when it has an answer." : tab === "flow" ? draft.flowEdited ? "Your flow" : "Derived from the contract's files, on the model that wrote the draft" : tab === "tests" ? "Your tests once saved: only these decide what a run accepts" : draft.clauses.length ? `${plural(draft.clauses.length, "numbered clause")}${untested ? ` · ${untested} not checked by a test` : " · each checked"}` : "The contract"}</span>
      <div className="synthesis-source-actions">
        {drafting ? <button type="button" disabled={Boolean(busy)} onClick={discard}>{busy === "discard" ? "Stopping…" : "Stop and discard"}</button>
          : confirming ? <div className="synthesis-confirm synthesis-confirm--inline" role="group" aria-label="Discard the draft"><span>Discard this draft?</span><button type="button" className="synthesis-danger" disabled={Boolean(busy)} onClick={discard}>Discard</button><button type="button" disabled={Boolean(busy)} onClick={() => setConfirming(false)}>Keep</button></div>
          : <button type="button" disabled={Boolean(busy)} onClick={() => setConfirming(true)}>Discard draft</button>}
        {!drafting ? <button type="button" disabled={!edited || Boolean(busy)} onClick={() => void act("check", async () => { await check(); })}>{busy === "check" ? "Checking…" : "Check"}</button> : null}
        {!drafting ? <button type="button" className="synthesis-primary" disabled={!draft.spec || Boolean(busy)} onClick={save}>{busy === "save" ? "Saving…" : "Save module"}</button> : null}
      </div>
    </div>
    <section className={`synthesis-source-panel${editable ? " is-editing" : ""}`} id="synthesis-draft-panel" role="tabpanel" aria-labelledby={`synthesis-draft-tab-${tab}`}>
      {!draft.spec ? <div className="synthesis-empty">{drafting ? "No answer yet." : "The model wrote no contract. Discard the draft and try a larger model or a clearer description."}</div>
        : editable ? <SourceEditor key={`${draft.id}:${tab}:${shownTest}`} value={normalizeLines(value)} label={label} problems={problems} onChange={change} onSave={() => void act("check", async () => { await check(); })} />
        : <SourcePreview source={value} name={label} />}
    </section>
    {listed.length ? <div className="synthesis-problems" aria-label="Problems in the draft">
      {listed.slice(0, 6).map((item, index) => <span key={index} className={`synthesis-draft__problem is-${item.severity === "warning" ? "warning" : "error"}`}><SynthesisIcon name="warning" />{item.line && item.line > 1 ? <span>Line {item.line}</span> : null}{item.message}</span>)}
      {listed.length > 6 ? <span className="synthesis-problems__note">{listed.length - 6} more</span> : null}
    </div> : null}
  </main>;
}
