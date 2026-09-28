import { useEffect, useRef, useState } from "react";
import type { HTMLAttributes, RefObject } from "react";

const clamp = (value: number) => Math.max(8, Math.min(92, value));

/** A persisted proportional split, shared by pointer and keyboard resizing. */
export function usePaneSplit(key: string, initial: number, axis: "x" | "y", container: RefObject<HTMLDivElement | null>) {
  const [value, setValue] = useState(() => {
    try { const saved = localStorage.getItem(key); return saved !== null && Number.isFinite(Number(saved)) ? clamp(Number(saved)) : initial; }
    catch { return initial; }
  });
  const drag = useRef<{ pointer: number; origin: number; value: number; size: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  useEffect(() => { if (!resizing) { try { localStorage.setItem(key, String(value)); } catch { /* Optional preference. */ } } }, [key, value, resizing]);
  const handle: HTMLAttributes<HTMLDivElement> = {
    role: "separator", tabIndex: 0, "aria-orientation": axis === "x" ? "vertical" : "horizontal",
    "aria-valuemin": 8, "aria-valuemax": 92, "aria-valuenow": Math.round(value),
    onPointerDown(event) {
      if (event.button !== 0) return;
      const bounds = container.current?.getBoundingClientRect();
      const size = bounds && (axis === "x" ? bounds.width : bounds.height);
      if (!size) return;
      event.preventDefault(); event.currentTarget.focus();
      drag.current = { pointer: event.pointerId, origin: axis === "x" ? event.clientX : event.clientY, value, size };
      event.currentTarget.setPointerCapture(event.pointerId); setResizing(true);
    },
    onPointerMove(event) {
      const start = drag.current;
      if (!start || start.pointer !== event.pointerId) return;
      setValue(clamp(start.value + ((axis === "x" ? event.clientX : event.clientY) - start.origin) / start.size * 100));
    },
    onPointerUp(event) {
      drag.current = null; setResizing(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel() { drag.current = null; setResizing(false); },
    onLostPointerCapture() { drag.current = null; setResizing(false); },
    onDoubleClick() { setValue(initial); },
    onKeyDown(event) {
      const decrease = axis === "x" ? "ArrowLeft" : "ArrowUp";
      const increase = axis === "x" ? "ArrowRight" : "ArrowDown";
      if (![decrease, increase, "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      setValue(current => event.key === "Home" ? 8 : event.key === "End" ? 92 : clamp(current + (event.key === increase ? 5 : -5)));
    }
  };
  return { value, resizing, handle };
}
