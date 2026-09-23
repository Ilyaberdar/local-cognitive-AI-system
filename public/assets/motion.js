// One policy for CSS, Web Animations and functional JS consumers.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let preference = localStorage.getItem('lcai.animations') !== 'false';
export const motionEnabled = () => preference && !reducedMotion.matches;
function publish() {
  const enabled = motionEnabled();
  document.documentElement.dataset.motion = enabled ? 'on' : 'off';
  if (!enabled) {
    for (const animation of document.getAnimations?.() || []) {
      try { animation.finish(); } catch { animation.cancel(); }
    }
    document.querySelectorAll('.message-stream, .route.active, .chat-settings, .settings-content, .sidebar, #session-setup-body').forEach(element => {
      element.scrollTo({ top: element.scrollTop, left: element.scrollLeft, behavior: 'instant' });
    });
    document.querySelectorAll('.liquid-glass').forEach(surface => {
      surface.style.removeProperty('--light-x'); surface.style.removeProperty('--light-y');
    });
  }
  window.dispatchEvent(new CustomEvent('lcai:motion', { detail: enabled }));
}
export function setAnimations(enabled) {
  preference = enabled !== false;
  localStorage.setItem('lcai.animations', String(preference));
  publish();
}
reducedMotion.addEventListener('change', publish);
publish();
