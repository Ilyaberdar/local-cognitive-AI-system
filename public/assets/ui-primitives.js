// Shared presentation primitives. No runtime, provider, or task behavior lives here.
const paths = {
  chat: '<path d="M4 10.5 12 4l8 6.5M6.5 9v10h4v-5h3v5h4V9"/>',
  orchestration: '<rect x="4" y="5" width="16" height="14" rx="3"/><path d="M9.3 5v14m5.4-14v14M6.7 9h0m5.3 3h0m5.3-3h0"/>',
  models: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9 8-4.5M12 12 4 7.5M12 12v9"/>',
  plugins: '<path d="M9 4h6v4h2a3 3 0 1 1 0 6h-2v6H9v-4H7a3 3 0 1 1 0-6h2V4Z"/>',
  settings: '<path d="m9.5 4 .7-2h3.6l.7 2 1.6 1 2.2-.4 1.8 3.1-1.4 1.7v2l1.4 1.7-1.8 3.1-2.2-.4-1.6 1-.7 2h-3.6l-.7-2-1.6-1-2.2.4-1.8-3.1L5 11.4v-2L3.6 7.7l1.8-3.1 2.2.4 1.9-1Z" transform="translate(0 1.5)"/><circle cx="12" cy="12" r="3"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="4"/><path d="M9 4v16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  arrowUp: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14m-6-6 6 6 6-6"/>',
  chevronLeft: '<path d="m14 7-5 5 5 5"/>',
  chevronRight: '<path d="m10 7 5 5-5 5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M20 14a8.5 8.5 0 0 1-10-10A8.5 8.5 0 1 0 20 14Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  refresh: '<path d="M20 4v6h-6M4 20v-6h6"/><path d="M5.6 8a7 7 0 0 1 11.6-3L20 8M4 16l2.8 3a7 7 0 0 0 11.6-3"/>',
  play: '<path d="m9 5 10 7-10 7V5Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="3" fill="currentColor" stroke="none"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="3"/><path d="M15 8V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v7a3 3 0 0 0 3 3h2"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5"/>',
  workflow: '<rect x="3" y="9" width="6" height="6" rx="2"/><rect x="15" y="3" width="6" height="6" rx="2"/><rect x="15" y="15" width="6" height="6" rx="2"/><path d="M9 12h3m3-6h-1a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h1"/>'
};

export function icon(name, className = "") {
  return `<svg class="ui-icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.chat}</svg>`;
}

export function glassFilters() {
  // Neutral interior with displacement confined to the rim. Text is never filtered.
  const map = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><defs><linearGradient id="x"><stop stop-color="#008080"/><stop offset=".08" stop-color="#808080"/><stop offset=".92" stop-color="#808080"/><stop offset="1" stop-color="#ff8080"/></linearGradient><linearGradient id="y" x2="0" y2="1"><stop stop-color="#800080"/><stop offset=".08" stop-color="#808080" stop-opacity="0"/><stop offset=".92" stop-color="#808080" stop-opacity="0"/><stop offset="1" stop-color="#80ff80"/></linearGradient></defs><rect width="256" height="256" fill="url(#x)"/><rect width="256" height="256" fill="url(#y)"/></svg>`;
  return `<svg class="glass-filter-defs" aria-hidden="true"><defs><filter id="liquid-lens" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feImage href="data:image/svg+xml,${encodeURIComponent(map)}" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="rim"/><feDisplacementMap in="SourceGraphic" in2="rim" scale="8" xChannelSelector="R" yChannelSelector="G"/></filter></defs></svg>`;
}

export function bindGlassLighting(root) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  root.querySelectorAll(".liquid-glass").forEach((surface) => {
    surface.addEventListener("pointermove", (event) => {
      const rect = surface.getBoundingClientRect();
      surface.style.setProperty("--light-x", `${((event.clientX - rect.left) / rect.width) * 100}%`);
      surface.style.setProperty("--light-y", `${((event.clientY - rect.top) / rect.height) * 100}%`);
    }, { passive: true });
  });
}
