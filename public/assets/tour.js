// The first-run tour: a few places of the window, one at a time, each highlighted with a sentence or
// two about it (Next, Back, Skip tour; Esc closes it). It never navigates: every place is on the first
// screen, so nothing the user had open changes, and a place that is not on screen when its turn comes
// (a narrow window hides the chat list, no chat is open) is left out. A profile that has not seen this
// version of the tour is offered it once, in a small card beside the profile menu, where it can be
// started again at any time.
import { icon } from './ui-primitives.js';

/** Raised when the tour changes enough to be offered again to those who saw an earlier one. */
export const TOUR_VERSION = 1;

/** The places, in order. `target` is a selector, `area` the parts of it the highlight covers. */
export const TOUR_STEPS = [
  { id: 'welcome', icon: 'tour', title: 'Welcome to Local Cognitive',
    text: 'Chats, agents and workflows that run on your computer. This short tour shows where everything is.',
    next: 'Show me around', skip: 'Not now' },
  { id: 'models', target: '.nav-button[data-route="models"]', placement: 'right', icon: 'models', title: 'Start with a model',
    text: 'Download a model in Models to run it on this computer, privately and for free. To use a cloud service instead, add its API key in Settings → Models & Providers.' },
  { id: 'chat', target: '#chat-form', placement: 'top', icon: 'chat', title: 'Chat',
    text: 'Ask anything here. + attaches files and the microphone dictates. The chat’s mode, model and subagents are in Session Setup.' },
  { id: 'projects', target: '.sidebar-conversations', area: '.sidebar-section', placement: 'right', icon: 'folder', title: 'Projects and chats',
    text: 'Add a project folder so a chat’s agents can read and change its files. Every chat is kept here, in its project or under Chats.' },
  { id: 'workflow', target: '.nav-button[data-route="orchestration"]', placement: 'right', icon: 'orchestration', title: 'Tasks and workflows',
    text: 'Queue tasks, run them on a schedule, and build workflows in which several agents hand work to each other.' },
  { id: 'synthesis', target: '.nav-button[data-route="synthesis"]', placement: 'right', icon: 'synthesis', title: 'Synthesis',
    text: 'Write a contract for a module, and agents write and test the code until it meets it. You follow each step and apply the result.' },
  { id: 'remote', target: '.nav-button[data-route="remote"]', placement: 'right', icon: 'remote', title: 'Remote',
    text: 'Use another computer you own, such as a server with a GPU, or let your other devices use this one in This computer. Both need a signed-in account.' },
  { id: 'settings', target: '#local-profile-button', placement: 'right', icon: 'settings', title: 'Settings and account',
    text: 'This menu opens Settings: appearance, providers and keys, plugins, MCP servers, privacy, and your account. The tour is here too, if you want it again.' }
];

export const TOUR_OFFER = {
  target: '#local-profile-button', placement: 'top', title: 'New: a tour of the app',
  text: 'A minute’s look at where models, chats, workflows and settings are. You can also start it from this menu later.'
};

/** What the window does at launch: the tour for a new profile (its settings have no appearance
 * preferences yet: the window saves them at its first start), the offer for one that has not seen
 * this version, nothing once it has. */
export function tourAtLaunch({ ui, seen = 0 }) {
  if (seen >= TOUR_VERSION) return null;
  return ui ? 'offer' : 'tour';
}

/** Whether the tour was seen, kept in this profile's settings (`ui.tourSeen`, the version) and in
 * localStorage, so a save that failed never brings it back. */
export function createTourStore({ storage, save, key = 'lcai.tourSeen' }) {
  const local = () => { try { return Number.parseInt(storage?.getItem(key) ?? '', 10) || 0; } catch { return 0; } };
  return {
    seen: ui => Math.max(Number.isInteger(ui?.tourSeen) ? ui.tourSeen : 0, local()),
    mark() {
      try { storage?.setItem(key, String(TOUR_VERSION)); } catch { /* Storage can be unavailable; the settings keep it. */ }
      return Promise.resolve().then(() => save({ ui: { tourSeen: TOUR_VERSION } })).catch(() => undefined);
    }
  };
}

const SIDES = ['right', 'bottom', 'top', 'left'];
const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

/** Where a bubble of `size` goes beside `target` (a rect) in `view`: on the preferred side when it
 * fits, else on the first side that does, else where there is most room, kept `margin` inside the
 * window. `arrow` is the offset along the facing edge of the point it aims at; `side` is "none" when
 * there is no target or the bubble had to cover it. */
export function placeBubble(target, size, view, preferred = 'right', { gap = 14, margin = 12 } = {}) {
  const maxLeft = Math.max(margin, view.width - size.width - margin), maxTop = Math.max(margin, view.height - size.height - margin);
  if (!target) return { side: 'none', left: clamp((view.width - size.width) / 2, margin, maxLeft), top: clamp((view.height - size.height) / 2, margin, maxTop), arrow: 0 };
  const right = target.left + target.width, bottom = target.top + target.height;
  const centerX = target.left + target.width / 2, centerY = target.top + target.height / 2;
  const sides = {
    right: { left: right + gap, top: centerY - size.height / 2, room: view.width - margin - right - gap - size.width },
    left: { left: target.left - gap - size.width, top: centerY - size.height / 2, room: target.left - gap - size.width - margin },
    bottom: { left: centerX - size.width / 2, top: bottom + gap, room: view.height - margin - bottom - gap - size.height },
    top: { left: centerX - size.width / 2, top: target.top - gap - size.height, room: target.top - gap - size.height - margin }
  };
  const order = [preferred, ...SIDES.filter(side => side !== preferred)];
  let side = order.find(candidate => sides[candidate].room >= 0);
  const fits = Boolean(side);
  side ??= order.reduce((best, candidate) => sides[candidate].room > sides[best].room ? candidate : best, order[0]);
  const left = clamp(sides[side].left, margin, maxLeft), top = clamp(sides[side].top, margin, maxTop);
  const vertical = side === 'left' || side === 'right';
  const arrow = vertical ? clamp(centerY - top, 18, Math.max(18, size.height - 18)) : clamp(centerX - left, 18, Math.max(18, size.width - 18));
  return { side: fits ? side : 'none', left, top, arrow };
}

function onScreen(element) {
  if (!element?.isConnected || element.closest('[inert]')) return false;
  if (typeof element.checkVisibility === 'function' && !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * The tour and its offer. `blocked` says something else holds the window (another dialog, Settings),
 * so a launch waits; `fallbackFocus` is where focus goes when the element it came from is gone;
 * `onClose(reason)` follows each end ("done", "skipped", "unavailable") and `onOffer` each offer shown.
 * `isVisible` and `rectOf` replace the layout checks (tests).
 */
export function createTour({ doc = document, steps = TOUR_STEPS, offerStep = TOUR_OFFER, blocked = () => Boolean(doc.querySelector('dialog[open]')),
  fallbackFocus = () => null, onClose = () => {}, onOffer = () => {}, isVisible = onScreen, rectOf = element => element.getBoundingClientRect(), poll = 400 } = {}) {
  const win = doc.defaultView;
  const frame = typeof win.requestAnimationFrame === 'function' ? callback => win.requestAnimationFrame(callback) : callback => win.setTimeout(callback, 16);
  let dialog, index = -1, returnFocus, stopFollowing, offerCard, stopOffer, waitTimer = 0;
  const element = (step) => step?.target ? doc.querySelector(step.target) : null;
  const available = step => !step.target || isVisible(element(step));

  /** The rect the highlight covers: the target, or the visible parts of it named by `area`. */
  function areaOf(step) {
    const target = element(step);
    if (!target || !isVisible(target)) return null;
    const parts = step.area ? [...target.querySelectorAll(step.area)].filter(isVisible).map(rectOf) : [];
    if (!parts.length) return rectOf(target);
    const left = Math.min(...parts.map(rect => rect.left)), top = Math.min(...parts.map(rect => rect.top));
    return { left, top, width: Math.max(...parts.map(rect => rect.left + rect.width)) - left, height: Math.max(...parts.map(rect => rect.top + rect.height)) - top };
  }

  /** Calls `layout` once per frame while the window, any scroller or the page under the tour changes. */
  function follow(layout, own) {
    let pending = 0;
    const schedule = () => { if (!pending) pending = frame(() => { pending = 0; layout(); }); };
    win.addEventListener('resize', schedule);
    doc.addEventListener('scroll', schedule, true);
    const mutations = new win.MutationObserver(records => { if (records.some(record => !own()?.contains(record.target))) schedule(); });
    mutations.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    const sizes = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(schedule) : null;
    sizes?.observe(doc.documentElement);
    return () => { win.removeEventListener('resize', schedule); doc.removeEventListener('scroll', schedule, true); mutations.disconnect(); sizes?.disconnect(); };
  }

  function place(card, rect, placement) {
    const size = { width: card.offsetWidth, height: card.offsetHeight };
    const spot = placeBubble(rect, size, { width: win.innerWidth, height: win.innerHeight }, placement);
    card.style.left = `${Math.round(spot.left)}px`;
    card.style.top = `${Math.round(spot.top)}px`;
    card.style.setProperty('--tour-arrow', `${Math.round(spot.arrow)}px`);
    card.dataset.side = spot.side;
  }

  // The tour.
  const part = name => dialog.querySelector(`[data-tour-${name}]`);
  function build() {
    dialog = doc.createElement('dialog');
    dialog.className = 'app-tour';
    dialog.setAttribute('aria-labelledby', 'app-tour-title');
    dialog.setAttribute('aria-describedby', 'app-tour-text');
    dialog.innerHTML = `<div class="app-tour__spot is-empty" data-tour-spot aria-hidden="true"></div>
      <section class="app-tour__bubble liquid-glass" data-tour-bubble>
        <span class="app-tour__arrow" aria-hidden="true"></span>
        <div class="app-tour__head"><span class="app-tour__mark" data-tour-mark aria-hidden="true"></span><span class="app-tour__count" data-tour-count></span></div>
        <h2 class="app-tour__title" id="app-tour-title"></h2>
        <p class="app-tour__text" id="app-tour-text"></p>
        <div class="app-tour__actions">
          <button type="button" class="ghost-button app-tour__skip" data-tour="skip"></button>
          <span class="app-tour__nav"><button type="button" class="ghost-button" data-tour="back">Back</button><button type="button" class="primary-button" data-tour="next"></button></span>
        </div>
        <p class="sr-only" aria-live="polite" data-tour-live></p>
      </section>`;
    dialog.addEventListener('click', event => {
      const action = event.target.closest?.('[data-tour]')?.dataset.tour;
      if (action === 'next') go(1);
      else if (action === 'back') go(-1);
      else if (action === 'skip') finish('skipped');
    });
    // Esc is a skip. A modal dialog cancels on Esc by itself; the keydown covers the rest.
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish('skipped'); });
    dialog.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish('skipped'); }
      else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); go(event.key === 'ArrowRight' ? 1 : -1); }
      else if (event.key === 'Tab') {
        // Focus stays in the bubble, from its last button to its first and back.
        const items = [...dialog.querySelectorAll('button')].filter(button => !button.hidden && !button.disabled);
        const at = items.indexOf(doc.activeElement);
        event.preventDefault(); event.stopPropagation();
        items[event.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at < 0 || at === items.length - 1 ? 0 : at + 1)]?.focus();
      }
    });
    doc.body.append(dialog);
  }

  const nextIndex = (from, direction) => {
    for (let at = from + direction; at >= 0 && at < steps.length; at += direction) if (available(steps[at])) return at;
    return -1;
  };

  function show(at, announce) {
    index = at;
    const step = steps[at], last = nextIndex(at, 1) === -1;
    const counted = steps.filter(item => item.target && available(item)), position = counted.indexOf(step);
    dialog.dataset.step = step.id;
    part('mark').innerHTML = icon(step.icon);
    part('count').textContent = step.target && position >= 0 ? `${position + 1} of ${counted.length}` : '';
    dialog.querySelector('#app-tour-title').textContent = step.title;
    dialog.querySelector('#app-tour-text').textContent = step.text;
    const skip = dialog.querySelector('[data-tour="skip"]'), back = dialog.querySelector('[data-tour="back"]'), next = dialog.querySelector('[data-tour="next"]');
    skip.textContent = step.skip || 'Skip tour';
    skip.hidden = last && at > 0;
    back.hidden = nextIndex(at, -1) === -1;
    next.textContent = step.next || (last ? 'Done' : 'Next');
    // The new step is read out; focus stays on the button it was on, or goes to the main one.
    if (announce) part('live').textContent = `${part('count').textContent ? `${part('count').textContent}. ` : ''}${step.title}. ${step.text}`;
    if (!dialog.contains(doc.activeElement) || doc.activeElement.hidden) next.focus();
    layout();
  }

  function layout() {
    if (!dialog) return;
    const step = steps[index], spot = part('spot'), bubble = part('bubble');
    let rect = areaOf(step);
    if (rect && (rect.top + rect.height < 0 || rect.top > win.innerHeight || rect.left + rect.width < 0 || rect.left > win.innerWidth)) {
      element(step)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      rect = areaOf(step);
    }
    if (rect) {
      const pad = step.pad ?? 4, radius = Number.parseFloat(win.getComputedStyle(element(step)).borderTopLeftRadius) || 8;
      rect = { left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
      Object.assign(spot.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, borderRadius: `${Math.min(radius + pad, 28)}px` });
    } else Object.assign(spot.style, { left: '50%', top: '50%', width: '0px', height: '0px' });
    // Without its element (gone since the step began), the bubble waits in the middle of the window.
    spot.classList.toggle('is-empty', !rect);
    place(bubble, rect, step.placement);
    // The bubble glides between places, but appears at its first one without sliding there.
    if (!bubble.classList.contains('is-placed')) { void bubble.offsetWidth; bubble.classList.add('is-placed'); }
  }

  function go(direction) {
    if (!dialog) return;
    const at = nextIndex(index, direction);
    if (at !== -1) show(at, true);
    else if (direction > 0) finish('done');
  }

  function start() {
    if (dialog) return false;
    removeOffer();
    const first = nextIndex(-1, 1);
    if (first === -1) { onClose('unavailable'); return false; }
    returnFocus = doc.activeElement;
    build();
    dialog.showModal();
    stopFollowing = follow(layout, () => dialog);
    show(first, false);
    dialog.querySelector('[data-tour="next"]').focus();
    return true;
  }

  function finish(reason) {
    if (!dialog) return;
    stopFollowing?.(); stopFollowing = undefined;
    dialog.close();
    dialog.remove();
    dialog = undefined; index = -1;
    const back = returnFocus && returnFocus !== doc.body && isVisible(returnFocus) ? returnFocus : fallbackFocus();
    returnFocus = undefined;
    back?.focus?.({ preventScroll: true });
    onClose(reason);
  }

  // The offer: a card beside the profile menu, not modal, shown once.
  function offer() {
    if (dialog || offerCard) return false;
    offerCard = doc.createElement('section');
    offerCard.className = 'app-tour-offer liquid-glass';
    offerCard.setAttribute('aria-labelledby', 'app-tour-offer-title');
    offerCard.setAttribute('aria-describedby', 'app-tour-offer-text');
    offerCard.innerHTML = `<span class="app-tour__arrow" aria-hidden="true"></span>
      <div class="app-tour__head"><span class="app-tour__mark" aria-hidden="true">${icon('tour')}</span><h2 class="app-tour__title" id="app-tour-offer-title"></h2></div>
      <p class="app-tour__text" id="app-tour-offer-text"></p>
      <div class="app-tour__actions"><span class="app-tour__nav"><button type="button" class="ghost-button" data-tour-offer="decline">No thanks</button><button type="button" class="primary-button" data-tour-offer="take">Take the tour</button></span></div>
      <p class="sr-only" aria-live="polite" data-tour-offer-live></p>`;
    offerCard.querySelector('#app-tour-offer-title').textContent = offerStep.title;
    offerCard.querySelector('#app-tour-offer-text').textContent = offerStep.text;
    offerCard.addEventListener('click', event => {
      const action = event.target.closest?.('[data-tour-offer]')?.dataset.tourOffer;
      if (action === 'take') start();
      else if (action === 'decline') removeOffer(true);
    });
    offerCard.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); removeOffer(true); } });
    doc.body.append(offerCard);
    const layoutOffer = () => {
      if (!offerCard) return;
      const anchor = element(offerStep), shown = isVisible(anchor);
      // Hidden while its menu is not on screen (Settings open, say), back when it is.
      offerCard.hidden = !shown;
      if (shown) place(offerCard, rectOf(anchor), offerStep.placement);
    };
    stopOffer = follow(layoutOffer, () => offerCard);
    layoutOffer();
    // A card that appears is not announced by itself.
    win.setTimeout(() => { const live = offerCard?.querySelector('[data-tour-offer-live]'); if (live) live.textContent = `${offerStep.title}. ${offerStep.text}`; }, 50);
    onOffer();
    return true;
  }

  function removeOffer(returnFocusToApp = false) {
    if (!offerCard) return;
    const hadFocus = offerCard.contains(doc.activeElement);
    stopOffer?.(); stopOffer = undefined;
    offerCard.remove(); offerCard = undefined;
    if (returnFocusToApp && hadFocus) fallbackFocus()?.focus?.({ preventScroll: true });
  }

  /** Starts the tour or the offer once nothing else holds the window, after `delay` ms. */
  function launch(mode, { delay = 0 } = {}) {
    win.clearTimeout(waitTimer);
    const attempt = () => {
      if (blocked() || doc.visibilityState === 'hidden') { waitTimer = win.setTimeout(attempt, poll); return; }
      waitTimer = 0;
      if (mode === 'offer') offer(); else start();
    };
    waitTimer = win.setTimeout(attempt, delay);
  }

  return {
    start, launch, offer,
    next: () => go(1), back: () => go(-1), close: () => finish('skipped'),
    isOpen: () => Boolean(dialog),
    offered: () => Boolean(offerCard),
    step: () => (dialog ? steps[index]?.id : undefined),
    dispose() { win.clearTimeout(waitTimer); removeOffer(); if (dialog) { stopFollowing?.(); dialog.remove(); dialog = undefined; } }
  };
}
