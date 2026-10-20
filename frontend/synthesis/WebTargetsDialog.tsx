import { useEffect, useMemo, useRef, useState } from "react";
import { encode, errorMessage, synthesisRequest } from "./api";
import { SynthesisIcon } from "./SynthesisIcon";
import { parseTarget, targetLabel } from "./targets";
import type { SynthesisProject } from "./types";

const MAX_TARGETS = 20;

/** The owner edits the web origins this project's agents may reach with the http right. A paired
 * device never opens this: it has no route to change the list (host-only boundary). */
export function WebTargetsDialog({ project, targets, onSaved, onClose, request = synthesisRequest }: {
  project: SynthesisProject; targets: string[];
  onSaved: (targets: string[]) => void; onClose: () => void;
  request?: <T>(path: string, options?: RequestInit) => Promise<T>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const pending = useRef(false);
  const alive = useRef(true);
  const [text, setText] = useState(() => targets.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Validate and normalize exactly as the engine does, so what is shown is what will be stored.
  const parsed = useMemo(() => {
    const labels: string[] = [];
    let invalid = "";
    for (const line of text.split("\n").map(item => item.trim()).filter(Boolean)) {
      try {
        const label = targetLabel(parseTarget(line));
        if (!labels.includes(label)) labels.push(label);
      } catch (reason) {
        invalid = reason instanceof Error && /\btarget\b/.test(reason.message) ? reason.message
          : `${line}: enter a full https:// (or http://) address with no path credentials.`;
        break;
      }
    }
    return { labels, invalid };
  }, [text]);
  const tooMany = parsed.labels.length > MAX_TARGETS;
  const blocked = Boolean(parsed.invalid) || tooMany;
  const changed = parsed.labels.join("\n") !== targets.join("\n");

  useEffect(() => {
    alive.current = true;
    const element = dialog.current;
    if (element?.showModal) element.showModal(); else element?.setAttribute("open", "");
    area.current?.focus();
    return () => { alive.current = false; if (element?.close) element.close(); };
  }, []);

  const save = async () => {
    if (pending.current || blocked) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const result = await request<{ targets?: unknown } | null>(`/projects/${encode(project.id)}/web-targets`, {
        method: "PUT", body: JSON.stringify({ targets: parsed.labels })
      });
      const saved = Array.isArray(result?.targets) ? result!.targets.filter((item): item is string => typeof item === "string") : parsed.labels;
      if (alive.current) onSaved(saved);
    } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };

  return <dialog ref={dialog} className="synthesis-create-dialog" aria-labelledby="synthesis-web-title" aria-describedby="synthesis-web-description"
    onCancel={event => { event.preventDefault(); if (!pending.current) onClose(); }}
    onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!pending.current) onClose(); }
      if (event.key === "Tab") {
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <header className="synthesis-create-header"><div><h2 id="synthesis-web-title">Web targets</h2><p id="synthesis-web-description">Origins {project.name}'s agents may reach with the http right. Add only your own or services you are authorized to test.</p></div>
      <button type="button" className="synthesis-icon-button" aria-label="Close web targets" disabled={busy} onClick={onClose}><SynthesisIcon name="close" /></button>
    </header>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="synthesis-create-body">
        <label className="synthesis-create-field" htmlFor="synthesis-web-targets">Allowed origins, one per line
          <textarea ref={area} id="synthesis-web-targets" className="synthesis-web-input" value={text} onChange={event => { setText(event.target.value); setError(""); }}
            placeholder={"https://staging.example.com\nhttps://api.example.com/v1"} autoComplete="off" spellCheck={false} rows={6} disabled={busy}
            aria-invalid={Boolean(parsed.invalid) || tooMany} aria-describedby="synthesis-web-hint" />
        </label>
        <p id="synthesis-web-hint" className={parsed.invalid || tooMany ? "synthesis-form-error" : "synthesis-form-hint"}>
          {parsed.invalid || (tooMany ? `Up to ${MAX_TARGETS} targets. Remove ${parsed.labels.length - MAX_TARGETS}.`
            : `A scheme, host and optional port and path — no credentials, query or fragment. A path (…/v1) allows that path and below. ${parsed.labels.length}/${MAX_TARGETS}.`)}
        </p>
        {parsed.labels.length && !blocked ? <div className="synthesis-web-preview" aria-label="Targets to save">{parsed.labels.map(label => <code key={label}>{label}</code>)}</div> : null}
        <p className="synthesis-form-hint">An agent's request carries none of the app's keys or cookies. A flow's http(allow = …) must stay within this list, or its run is refused. Empty clears it, and the http right is then refused.</p>
        {error ? <p className="synthesis-form-error" role="alert">{error}</p> : null}
      </div>
      <footer className="synthesis-create-footer"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="synthesis-primary" disabled={busy || blocked || !changed}>{busy ? "Saving…" : "Save targets"}</button></footer>
    </form>
  </dialog>;
}
