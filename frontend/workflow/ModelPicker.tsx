import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { ProviderOption } from "./types";

export function ModelPicker({ provider, value, disabled, describedBy, onChange }: {
  provider?: ProviderOption; value: string; disabled: boolean; describedBy?: string; onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({});
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const label = (model: string) => provider?.modelLabels?.[model] || model;
  const defaultLabel = provider?.defaultModel ? `Provider default · ${label(provider.defaultModel)}` : "Provider default";
  const options = useMemo(() => {
    const models = [...new Set(provider?.models ?? [])];
    if (value && !models.includes(value) && !provider?.installedOnly) models.unshift(value);
    const all = [{ value: "", label: defaultLabel }, ...models.map(model => ({ value: model, label: provider?.modelLabels?.[model] || model }))];
    const text = query.trim().toLowerCase();
    const filtered = text ? all.filter(item => `${item.label} ${item.value}`.toLowerCase().includes(text)) : all;
    if (query.trim() && !provider?.installedOnly && !models.includes(query.trim())) filtered.push({ value: query.trim(), label: `Use custom model · ${query.trim()}` });
    return filtered;
  }, [provider, value, query, defaultLabel]);
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));
  const close = (restoreFocus = false) => { setOpen(false); if (restoreFocus) trigger.current?.focus(); };
  const choose = (model: string) => { if (disabled) return; onChange(model); close(true); };
  const show = () => { setQuery(""); setActive(0); setOpen(true); };

  useLayoutEffect(() => {
    if (!open || disabled) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      if (rect.bottom < 0 || rect.top > window.innerHeight) { setOpen(false); return; }
      const below = window.innerHeight - rect.bottom - 14;
      const above = rect.top - 14;
      const upward = below < 250 && above > below;
      const width = Math.min(Math.max(rect.width, 300), window.innerWidth - 16);
      setPosition({ position: "fixed", width, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        maxHeight: Math.min(360, Math.max(100, upward ? above : below)),
        ...(upward ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }) });
    };
    const scroll = (event: Event) => { if (!popup.current?.contains(event.target as Node)) place(); };
    place(); search.current?.focus();
    window.addEventListener("resize", place); document.addEventListener("scroll", scroll, true);
    return () => { window.removeEventListener("resize", place); document.removeEventListener("scroll", scroll, true); };
  }, [open, disabled]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => { if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside); document.addEventListener("focusin", outside);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside); };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const item = list.current?.children[activeIndex] as HTMLElement | undefined;
    if (item && list.current) {
      const top = item.offsetTop - list.current.offsetTop;
      if (top < list.current.scrollTop) list.current.scrollTop = top;
      else if (top + item.offsetHeight > list.current.scrollTop + list.current.clientHeight) list.current.scrollTop = top + item.offsetHeight - list.current.clientHeight;
    }
  }, [activeIndex, open, query]);

  return <>
    <button type="button" className="fsm-model-picker__trigger" ref={trigger} disabled={disabled}
      aria-label="Model" aria-describedby={describedBy} aria-haspopup="dialog" aria-expanded={open && !disabled} aria-controls={open ? `${id}-popup` : undefined}
      title={value ? label(value) : defaultLabel} onClick={() => open ? close() : show()}
      onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); show(); } }}>
      <span>{value ? label(value) : defaultLabel}</span>
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m5 7 5 5 5-5" /></svg>
    </button>
    {open && !disabled ? createPortal(<div id={`${id}-popup`} ref={popup} style={position} className="fsm-model-picker__popup" role="dialog" aria-label="Choose model"
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
        else if (event.key === "Tab") { event.preventDefault(); close(true); }
      }}>
      <div className="fsm-model-picker__search"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>
        <input ref={search} aria-label="Search models" role="combobox" aria-expanded="true" aria-controls={`${id}-list`} aria-autocomplete="list"
          aria-activedescendant={options.length ? `${id}-option-${activeIndex}` : undefined} autoComplete="off" spellCheck={false}
          placeholder={provider?.installedOnly ? "Search installed models…" : "Search models or enter an ID…"} value={query}
          onChange={event => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={event => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActive(Math.max(0, Math.min(options.length - 1, activeIndex + (event.key === "ArrowDown" ? 1 : -1)))); }
            else if (event.key === "Enter") { event.preventDefault(); if (options[activeIndex]) choose(options[activeIndex].value); }
          }} />
      </div>
      <div className="fsm-model-picker__list" role="listbox" aria-label="Models" id={`${id}-list`} ref={list}>
        {options.map((option, index) => <button type="button" role="option" tabIndex={-1} id={`${id}-option-${index}`} key={option.value}
          aria-selected={value === option.value} className={activeIndex === index ? "is-active" : ""}
          onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(option.value)}>
          <span>{option.label}</span>{value === option.value ? <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m4 10 4 4 8-8" /></svg> : null}
        </button>)}
        {!options.length ? <p>No matching installed models.</p> : null}
      </div>
      <div className="fsm-model-picker__footer">{provider?.name ?? "Run default"} · {provider?.models.length ?? 0} models</div>
    </div>, document.body) : null}
  </>;
}
