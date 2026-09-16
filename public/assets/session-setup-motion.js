// Keep the scrollable setup body stable while the surrounding app is rendered.
// Agent lists are keyed by identity so deleting a card does not move focus to
// an unrelated input that happens to reuse its old array index.
export function createSessionSetupMotion() {
  let stopAnimation;
  let pendingAddedId;
  const body = () => document.querySelector("#session-setup-body");
  const key = (element) => {
    const form = element?.closest("#session-settings-form");
    return form ? `${form.dataset.sessionId}:${form.dataset.setupMode}` : null;
  };

  function capture() {
    const panel = body();
    const active = document.activeElement;
    const card = active?.closest?.("[data-setup-agent-id]");
    const snapshot = panel && panel.clientHeight ? {
      key: key(panel), top: panel.scrollTop, addedId: pendingAddedId,
      focus: panel.contains(active) ? { agentId: card?.dataset.setupAgentId, name: active.name,
        action: active.dataset.action, start: active.selectionStart, end: active.selectionEnd } : null
    } : null;
    stopAnimation?.();
    return snapshot;
  }

  function restore(snapshot, addedId) {
    const panel = body();
    if (!panel || !snapshot || key(panel) !== snapshot.key || !panel.clientHeight) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const originalPadding = panel.style.paddingBottom;
    const padding = parseFloat(getComputedStyle(panel).paddingBottom) || 0;
    const maxTop = Math.max(0, panel.scrollHeight - panel.clientHeight);
    const extra = Math.max(0, snapshot.top - maxTop);
    // Keep the old scroll range temporarily when the last card is removed.
    // Shrink it together with the scroll, instead of letting the browser clamp
    // the viewport to the new bottom in a single frame.
    if (extra && !reduced) panel.style.paddingBottom = `${padding + extra}px`;
    panel.scrollTop = reduced ? Math.min(snapshot.top, maxTop) : snapshot.top;

    const cards = [...panel.querySelectorAll("[data-setup-agent-id]")];
    const targetId = addedId || snapshot.addedId;
    const added = targetId && cards.find((card) => card.dataset.setupAgentId === targetId);
    let target = Math.min(snapshot.top, maxTop);
    if (added) {
      const viewport = panel.getBoundingClientRect(), rect = added.getBoundingClientRect();
      if (rect.height > panel.clientHeight - 24 || rect.top < viewport.top + 12) {
        target = panel.scrollTop + rect.top - viewport.top - 12;
      } else if (rect.bottom > viewport.bottom - 12) {
        target = panel.scrollTop + rect.bottom - viewport.bottom + 12;
      }
      target = Math.max(0, Math.min(target, maxTop));
      if (!reduced && addedId) added.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }],
        { duration: 220, easing: "ease-out" });
    }

    const focus = snapshot.focus;
    if (focus) {
      const scope = focus.agentId ? cards.find((card) => card.dataset.setupAgentId === focus.agentId) : panel;
      const control = scope && [...scope.querySelectorAll("input, select, textarea, button")].find((element) =>
        focus.name ? element.name === focus.name || (focus.agentId && element.name?.split(":")[0] === focus.name.split(":")[0])
          : focus.action && element.dataset.action === focus.action);
      control?.focus({ preventScroll: true });
      if (control && typeof focus.start === "number" && typeof control.setSelectionRange === "function") {
        try { control.setSelectionRange(focus.start, focus.end); } catch { /* Selects and non-text inputs. */ }
      }
    }

    const from = panel.scrollTop;
    if (reduced || Math.abs(target - from) < 1) {
      panel.style.paddingBottom = originalPadding;
      panel.scrollTop = target;
      return;
    }
    let frame, started, interrupted = false;
    const events = ["wheel", "touchstart", "pointerdown", "keydown"];
    const stop = () => {
      cancelAnimationFrame(frame);
      panel.style.paddingBottom = originalPadding;
      events.forEach((name) => panel.removeEventListener(name, interrupt));
      if (stopAnimation === stop) { stopAnimation = undefined; pendingAddedId = undefined; }
    };
    const interrupt = () => {
      if (!extra) { stop(); return; }
      // Keep shrinking the temporary deletion space smoothly, but let the user
      // control scrollTop. Removing it here would instantly clamp the viewport.
      interrupted = true;
      pendingAddedId = undefined;
    };
    const step = (now) => {
      if (!panel.isConnected) { stop(); return; }
      started ??= now;
      const progress = Math.min(1, (now - started) / 280);
      const eased = 1 - (1 - progress) ** 3;
      if (extra) panel.style.paddingBottom = `${padding + extra * (1 - eased)}px`;
      if (!interrupted) panel.scrollTop = from + (target - from) * eased;
      if (progress < 1) frame = requestAnimationFrame(step);
      else { stop(); if (!interrupted) panel.scrollTop = target; }
    };
    stopAnimation = stop;
    pendingAddedId = added?.dataset.setupAgentId;
    events.forEach((name) => panel.addEventListener(name, interrupt, { passive: true }));
    frame = requestAnimationFrame(step);
  }

  return { capture, restore };
}
