/** The nearest box around `element` that scrolls vertically now. */
function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let box = element.parentElement; box; box = box.parentElement) {
    const { overflowY } = getComputedStyle(box);
    if ((overflowY === "auto" || overflowY === "scroll") && box.scrollHeight > box.clientHeight) return box;
  }
  return null;
}

/** Brings `element` into view by scrolling only the box it scrolls in. Element.scrollIntoView also
 * scrolls every box around that one, the window among them, and so moved the whole Synthesis screen
 * when a list chose a row below its fold (the first agent that failed, a report at the list's end). */
export function revealIn(element: HTMLElement | null | undefined, block: "nearest" | "center" = "nearest"): void {
  const box = element ? scrollerOf(element) : null;
  if (!element || !box) return;
  const outer = box.getBoundingClientRect(), inner = element.getBoundingClientRect();
  if (block === "center") box.scrollTop += inner.top - outer.top - (box.clientHeight - inner.height) / 2;
  else if (inner.top < outer.top) box.scrollTop -= outer.top - inner.top;
  // A row taller than the box keeps its start in view.
  else if (inner.bottom > outer.bottom) box.scrollTop += Math.min(inner.bottom - outer.bottom, inner.top - outer.top);
}
