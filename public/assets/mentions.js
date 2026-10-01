import { icon } from './ui-primitives.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const tokens = value => [...String(value).matchAll(/(^|[\s(])@((?:agent:)?[\p{L}\p{N}_-]+)(?![\p{L}\p{N}_:-])/gu)];
export const pluginIconPath = id => `/assets/plugin-icons/${String(id).startsWith('outlook-') ? 'outlook' : /^[a-z0-9-]+$/.test(id) ? id : 'notion'}.svg`;
export function pluginMentionIds(value, catalog = []) {
  const ids = new Set(catalog.map(plugin => plugin.id));
  return [...new Set(tokens(value).map(match => match[2].toLowerCase()).filter(id => ids.has(id)))].sort();
}
function entries(plugins, agents, catalog) {
  return [
    ...plugins.map(plugin => ({ ...plugin, kind: 'plugin', token: plugin.id })),
    ...agents.map(agent => ({ ...agent, kind: 'agent', token: catalog.some(plugin => plugin.id === agent.name.toLowerCase()) ? `agent:${agent.name}` : agent.name,
      description: [agent.model, 'Subagent'].filter(Boolean).join(' · ') }))
  ];
}
export function mentionedAgentNames(value, catalog = [], agents = []) {
  const present = new Set(tokens(value).map(match => match[2].toLowerCase()));
  return entries([], agents, catalog).filter(agent => present.has(agent.token.toLowerCase())).map(agent => agent.name);
}
const badge = item => item.kind === 'plugin'
  ? `<img src="${pluginIconPath(item.id)}" width="24" height="24" alt="" />`
  : `<span class="mention-agent-icon" aria-hidden="true">${icon('profile')}</span>`;
export function renderMentionText(value, catalog = [], agents = []) {
  const known = entries(catalog, agents, catalog), source = String(value ?? '');
  let previous = 0, html = '';
  for (const match of tokens(source)) {
    const start = match.index + match[1].length, end = match.index + match[0].length;
    const item = known.find(item => item.token.toLowerCase() === match[2].toLowerCase());
    html += escape(source.slice(previous, start));
    html += item ? `<span class="entity-mention entity-mention--${item.kind}" title="@${escape(item.token)}">${badge(item)}<span>@${escape(item.name)}</span></span>` : escape(source.slice(start, end));
    previous = end;
  }
  return html + escape(source.slice(previous));
}

/** One composer owns one accessible picker. Draft text is the source of truth. */
export function bindMentionPicker({ textarea, menu, selected, getPlugins, getCatalog, getAgents, refresh, getError = () => '', onChange }) {
  if (!textarea || !menu) return { dispose() {}, update() {} };
  const controller = new AbortController(), options = { signal: controller.signal };
  let candidates = [], active = 0, match, disposed = false, loading = false, dismissed = false;
  menu.id = 'composer-mentions'; menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', 'Plugins and subagents');
  textarea.setAttribute('aria-autocomplete', 'list'); textarea.setAttribute('aria-controls', menu.id);
  function close() { menu.hidden = true; textarea.setAttribute('aria-expanded', 'false'); textarea.removeAttribute('aria-activedescendant'); }
  function chips() {
    if (!selected) return;
    const known = entries(getCatalog(), getAgents(), getCatalog());
    const present = new Set(tokens(textarea.value).map(token => token[2].toLowerCase()));
    const items = known.filter(item => present.has(item.token.toLowerCase()));
    selected.hidden = !items.length;
    selected.innerHTML = items.map(item => {
      const unavailable = item.kind === 'plugin' && !getPlugins().some(plugin => plugin.id === item.id);
      return `<button type="button" class="composer-mention-chip ${unavailable ? 'is-unavailable' : ''}" data-remove-mention="${escape(item.token)}" aria-label="Remove ${escape(item.name)}">${badge(item)}<span>${escape(item.name)}</span>${unavailable ? '<small>Unavailable</small>' : ''}<span aria-hidden="true">×</span></button>`;
    }).join('');
  }
  function update() {
    chips();
    const before = textarea.value.slice(0, textarea.selectionStart ?? textarea.value.length);
    match = before.match(/(^|[\s(])@((?:agent:)?[\p{L}\p{N}_-]*)$/u);
    if (!match || dismissed) { close(); return; }
    const query = match[2].toLowerCase();
    candidates = entries(getPlugins(), getAgents(), getCatalog()).filter(item => `${item.name} ${item.token} ${item.description ?? ''}`.toLowerCase().includes(query));
    active = Math.max(0, Math.min(active, candidates.length - 1));
    menu.hidden = false; textarea.setAttribute('aria-expanded', 'true');
    menu.innerHTML = '<div class="mention-menu-heading">Add</div>' + ['plugin', 'agent'].map(kind => {
      const rows = candidates.flatMap((item, index) => item.kind !== kind ? [] : [`<button type="button" role="option" aria-selected="${index === active}" tabindex="-1" id="mention-option-${index}" class="mention-item" data-mention-index="${index}">${badge(item)}<span class="mention-item-name">${escape(item.name)}</span><span class="mention-item-description">${escape(item.description)}</span></button>`]).join('');
      return rows ? `<div role="group" aria-label="${kind === 'plugin' ? 'Plugins' : 'Subagents'}"><div class="mention-menu-label">${kind === 'plugin' ? 'Plugins' : 'Subagents'}</div>${rows}</div>` : '';
    }).join('') + (getError() || !candidates.length ? `<div class="mention-empty" role="status">${escape(loading ? 'Loading connected plugins…' : getError() || (query ? 'No matching plugins or subagents.' : 'No connected plugins or configured subagents.'))}</div>` : '') +
      '<a class="mention-manage" href="#/settings/plugins">Manage plugins</a>';
    if (candidates.length) textarea.setAttribute('aria-activedescendant', `mention-option-${active}`);
    else textarea.removeAttribute('aria-activedescendant');
  }
  function choose(index) {
    const item = candidates[index];
    if (!item || !match) return;
    const cursor = textarea.selectionStart ?? textarea.value.length;
    const start = cursor - match[0].length + match[1].length;
    const insert = `@${item.token} `;
    textarea.setRangeText(insert, start, cursor, 'end');
    onChange(textarea.value); textarea.focus(); dismissed = true; chips(); close();
  }
  async function reload() {
    loading = true;
    try { await refresh(); } finally { loading = false; if (!disposed) update(); }
  }
  textarea.addEventListener('input', () => {
    const wasClosed = menu.hidden;
    dismissed = false; active = 0; onChange(textarea.value); update();
    if (wasClosed && !menu.hidden && !loading) void reload();
  }, options);
  textarea.addEventListener('focus', () => { dismissed = false; update(); void reload(); }, options);
  textarea.addEventListener('click', () => { dismissed = false; update(); }, options);
  textarea.addEventListener('keyup', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { dismissed = false; update(); } }, options);
  textarea.addEventListener('keydown', event => {
    if (menu.hidden || event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismissed = true; close(); return; }
    if (!candidates.length) return;
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); active = (active + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length; update();
      menu.querySelector(`[data-mention-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
    } else if (['Enter', 'Tab'].includes(event.key) && !event.shiftKey && !event.ctrlKey && !event.metaKey) { event.preventDefault(); choose(active); }
  }, options);
  menu.addEventListener('mousedown', event => { if (event.target.closest('[data-mention-index]')) event.preventDefault(); }, options);
  menu.addEventListener('click', event => { const button = event.target.closest('[data-mention-index]'); if (button) choose(Number(button.dataset.mentionIndex)); }, options);
  selected?.addEventListener('click', event => {
    const token = event.target.closest('[data-remove-mention]')?.dataset.removeMention;
    if (!token) return;
    textarea.value = textarea.value.replace(/(^|[\s(])@((?:agent:)?[\p{L}\p{N}_-]+)(?![\p{L}\p{N}_:-])/gu,
      (full, prefix, candidate) => candidate.toLowerCase() === token.toLowerCase() ? prefix : full);
    onChange(textarea.value); textarea.focus(); dismissed = true; chips(); close();
  }, options);
  textarea.ownerDocument.addEventListener('pointerdown', event => { if (event.target !== textarea && !menu.contains(event.target)) { dismissed = true; close(); } }, options);
  chips(); close();
  return { update, dispose() { disposed = true; controller.abort(); } };
}
