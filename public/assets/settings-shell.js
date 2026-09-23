import { icon, bindGlassLighting } from './ui-primitives.js';
import { entityPatch, localProfileView } from './settings-data.js';

const groups = [
  ['Personal', [['general', 'General', 'settings'], ['notifications', 'Notifications', 'info'], ['profile', 'Profile', 'profile'], ['appearance', 'Appearance', 'sun'], ['voice', 'Voice', 'microphone'], ['shortcuts', 'Keyboard Shortcuts', 'keyboard'], ['usage', 'Usage', 'clock'], ['account', 'Account', 'profile']]],
  ['AI System', [['providers', 'Models & Providers', 'models'], ['runtime', 'Local Runtime', 'models'], ['agents', 'Agents', 'workflow'], ['memory', 'Memory', 'folder']]],
  ['Integrations', [['plugins', 'Plugins', 'plugins'], ['mcp', 'MCP Servers', 'code'], ['connections', 'Connections', 'externalLink']]],
  ['System', [['data', 'Data & Privacy', 'shield'], ['about', 'About', 'info']]]
];
const providerNames = { llamacpp: 'Local models · llama.cpp', ollama: 'Ollama', lmstudio: 'LM Studio', openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const get = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);
const field = (name, label, type = 'text', extra = {}) => ({ name, label, type, ...extra });
const bool = (name, label, description = '') => field(name, label, 'boolean', { description });
const select = (name, label, choices, description = '') => field(name, label, 'select', { choices, description });
const number = (name, label, min, max, description = '') => field(name, label, 'number', { min, max, description });
const link = (path, title, description = '', symbol = 'chevronRight') => `<a class="settings-list-row" href="#/settings/${escape(path)}"><span><strong>${escape(title)}</strong>${description ? `<small>${escape(description)}</small>` : ''}</span>${icon(symbol)}</a>`;
const note = (title, description) => `<div class="settings-empty"><span class="settings-empty-icon">${icon('info')}</span><h2>${escape(title)}</h2><p>${escape(description)}</p></div>`;

export function createSettingsShell({ app, getContext, data, applyPreferences, renderModelControl, onReturn, captureScroll, restoreScroll, voiceInput }) {
  const root = document.createElement('section');
  root.id = 'settings-root'; root.hidden = true;
  document.body.append(root);
  const menu = document.createElement('div');
  menu.id = 'profile-menu'; menu.className = 'profile-menu liquid-glass'; menu.setAttribute('popover', 'auto'); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Local profile');
  document.body.append(menu);
  let active = false, page = 'general', previousRoute = '#/chat', appScroll, appFocus, search = '', appInfo;
  const drafts = new Map(), statuses = new Map(), results = new Map();
  let suppressMenuFocus = false, disposeVoice;
  const context = () => getContext() || {};
  const settings = () => context().appSettings || {};
  const fieldsFor = route => {
    const [name, id] = route.split('/');
    if (name === 'general') return [
      select('ui.language', 'Response language', [['auto', 'Auto detect'], ['en', 'English'], ['ru', 'Russian']], 'Default for new chats.'),
      select('ui.outputStyle', 'Response style', ['compact', 'balanced', 'detailed', 'exhaustive'], 'Default for new chats.'),
      select('ui.mode', 'Default chat mode', ['auto', 'general', 'code', 'hypothesis'], 'Existing chats keep their own settings.')
    ];
    if (name === 'voice') return [field('voice.microphone', 'Microphone', 'text', { description: 'Input device, headset, input level and permissions' }), field('voice.language', 'Language'), field('voice.recognition', 'Recognition model')];
    if (name === 'appearance') return [
      select('ui.theme', 'Theme', [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']], 'Uses the same theme as the main sidebar.'),
      field('ui.fontScale', 'Text size', 'font-scale', { description: 'Scale text across the app, including chats and workflow. Default: 100%.' }),
      bool('ui.animations', 'Animations', 'Motion is reduced automatically when your system requests it.')
    ];
    if (name === 'providers' && id && settings().providers?.[id]) {
      return [bool(`providers.${id}.enabled`, 'Enabled'), ...(id === 'llamacpp' ? [] : [
        field(`providers.${id}.baseUrl`, 'Base URL', 'url'), ...(id === 'ollama' ? [] : [field(`providers.${id}.apiKey`, 'API key', 'secret')])
      ]), field(`providers.${id}.model`, 'Default model', 'model', { provider: id }),
      ...(id === 'llamacpp' ? [] : [number(`providers.${id}.timeoutMs`, 'Timeout (ms)', 1000, 3600000)]),
      ...(id === 'anthropic' ? [field(`providers.${id}.version`, 'Anthropic version'), number(`providers.${id}.maxTokens`, 'Max tokens', 1, 1000000)] : [])];
    }
    if (name === 'providers') return [select('llm.defaultProvider', 'Default provider', Object.keys(settings().providers || {}).map(id => [id, providerNames[id] || id]), 'Used when a chat or workflow has no explicit provider override.')];
    if (name === 'runtime') return [
      field('localModels.modelsDir', 'Model storage folder', 'directory', { description: 'Changing storage copies and verifies models before switching. Previous files remain as a backup. Pause downloads first.' }),
      number('localModels.contextSize', 'Context size (tokens)', 512, 131072), number('localModels.gpuLayers', 'GPU layers', 0, 999),
      number('localModels.memoryLimitPercent', 'Memory warning threshold (%)', 10, 90),
      number('localModels.loadTimeoutMs', 'Load timeout (ms)', 10000, 1800000), number('localModels.generationTimeoutMs', 'Generation timeout (ms)', 10000, 3600000)
    ];
    if (name === 'memory' && id === 'advanced') return [
      select('memory.worldPartition.strategy', 'Partition strategy', ['auto', 'global', 'partitioned']),
      number('memory.worldPartition.activationThreshold', 'Activation threshold / user', 1, 1000000000),
      number('memory.worldPartition.chunkCapacity', 'Chunk capacity', 32, 10000000),
      number('memory.worldPartition.initialRadius', 'Initial radius', 0, 1000000), number('memory.worldPartition.maxRadius', 'Max radius', 0, 1000000),
      bool('memory.worldPartition.fallbackToGlobalSearch', 'Global fallback'), bool('memory.worldPartition.migrateLegacyOnStart', 'Migrate legacy JSON'),
      bool('memory.openMemory.enabled', 'OpenMemory enabled', 'Existing adapter configuration; availability depends on the installed backend.'), field('memory.openMemory.dbPath', 'OpenMemory DB path')
    ];
    if (name === 'memory') return [select('memory.adapter', 'Adapter', ['local-json', 'world-partition', 'openmemory']), number('memory.topK', 'Retrieval Top K', 1, 1000), field('memory.baseDir', 'Memory directory'), bool('memory.worldPartition.crossSessionRecall', 'Cross-session recall')];
    if (name === 'mcp' && id === 'local-cognitive') return [bool('mcp.server.enabled', 'Enabled'), field('mcp.server.defaultSessionId', 'Default session')];
    if (name === 'plugins' && id) {
      const integration = data.integrations.find(item => item.id === id);
      return !integration || integration.unavailable ? [] : [bool(`plugins.${id}.enabled`, 'Enabled'), ...integration.fields.map(([key, label, type]) => type === 'access'
        ? select(`plugins.${id}.values.${key}`, label, ['restricted', 'full']) : field(`plugins.${id}.values.${key}`, label, type || 'text'))];
    }
    return [];
  };
  function titleFor(route) {
    const [name, id] = route.split('/');
    if (id) return name === 'providers' ? providerNames[id] || id : name === 'plugins' ? data.integrations.find(item => item.id === id)?.name || id : name === 'memory' ? 'Advanced memory' : name === 'mcp' ? 'Local Cognitive MCP server' : id;
    return groups.flatMap(([, items]) => items).find(([key]) => key === name)?.[1] || 'Page not found';
  }
  const dirty = route => { if (!drafts.has(route)) drafts.set(route, {}); return drafts.get(route); };
  function valueOf(spec) { return Object.hasOwn(dirty(page), spec.name) ? dirty(page)[spec.name] : get(settings(), spec.name); }
  function renderField(spec) {
    const value = valueOf(spec), id = `setting-${spec.name.replaceAll('.', '-')}`;
    let control;
    const common = `id="${id}" name="${escape(spec.name)}"`;
    if (spec.type === 'boolean') control = `<input ${common} type="checkbox" role="switch" ${value ? 'checked' : ''} />`;
    else if (spec.type === 'font-scale') control = `<div class="settings-font-scale"><input ${common} type="range" min="85" max="150" step="5" value="${value ?? 100}" aria-valuetext="${value ?? 100}%" /><output for="${id}">${value ?? 100}%</output></div>`;
    else if (spec.type === 'select') control = `<select ${common}>${spec.choices.map(choice => { const [key, label] = Array.isArray(choice) ? choice : [choice, choice]; return `<option value="${escape(key)}" ${String(value) === key ? 'selected' : ''}>${escape(label)}</option>`; }).join('')}</select>`;
    else if (spec.type === 'secret') control = `<div class="settings-secret"><input ${common} type="password" autocomplete="new-password" value="" placeholder="${get(settings(), spec.name) ? 'Saved key · leave blank to keep' : 'Enter API key'}" /><button type="button" class="ghost-button" data-clear="${escape(spec.name)}">Remove key</button><small data-secret-state="${escape(spec.name)}">${Object.hasOwn(dirty(page), spec.name) ? dirty(page)[spec.name] === '' ? 'Key will be removed on Apply.' : 'Replacement key entered.' : 'Blank input keeps the existing key.'}</small></div>`;
    else if (spec.type === 'model') {
      control = renderModelControl(spec.provider, value || '').replaceAll(`provider.${spec.provider}.model`, spec.name);
      // The existing model picker is reused with a unique accessible label.
      control = control.replace(/<(select|input) /, `<$1 id="${id}" `);
    } else if (spec.type === 'textarea') control = `<textarea ${common} rows="3">${escape(value)}</textarea>`;
    else control = `<input ${common} type="${['number', 'url'].includes(spec.type) ? spec.type : 'text'}" value="${escape(value)}" ${spec.type === 'number' ? `min="${spec.min}" max="${spec.max}" step="1" required` : ''} />${spec.type === 'directory' && window.desktopModels?.selectDirectory ? '<button type="button" class="ghost-button" data-directory>Choose folder</button>' : ''}`;
    return `<div class="settings-row" data-setting="${escape(spec.name)}"><div><label for="${id}">${escape(spec.label)}</label>${spec.description ? `<p>${escape(spec.description)}</p>` : ''}</div><div class="settings-control">${control}</div></div>`;
  }
  function form(specs, leadingRows = '') {
    if (!specs.length) return '';
    const preference = specs.every(item => item.name.startsWith('ui.'));
    const status = statuses.get(page);
    return `<form id="settings-entity-form" data-entity="${escape(page)}" class="settings-form"><div class="settings-rows">${leadingRows}${specs.map(renderField).join('')}</div><div class="settings-form-footer"><span role="status" aria-live="polite" class="settings-save-status ${status?.error ? 'is-error' : status?.success ? 'is-success' : ''}">${escape(status?.text || (preference ? 'Changes save automatically.' : 'Apply changes to this page only.'))}</span>${preference ? '<button type="submit" class="ghost-button" data-retry hidden>Retry save</button>' : `<button type="submit" class="primary-button" ${status?.busy ? 'disabled' : ''}>Save / Apply</button>`}</div></form>`;
  }
  function profile() {
    const user = localProfileView(settings());
    return `<div class="local-profile-view"><div class="local-avatar">${icon('profile')}</div><h2>${escape(user.name)}</h2><p>Stored on this device</p></div>`;
  }
  function content() {
    const [name, id] = page.split('/');
    const specs = fieldsFor(page);
    const result = results.get(page);
    const testResult = result ? `<div class="settings-test-result ${result.ok ? 'is-success' : 'is-error'}" role="status"><div class="settings-test-heading">${icon(result.ok ? 'check' : 'shieldAlert')}<strong>${result.ok ? 'Test succeeded' : 'Test failed'}</strong></div>${result.ok && name === 'providers' ? '<div class="settings-connection-status">Provider connected <small>Verified by the last test</small></div>' : ''}<p>${escape(result.message)}</p>${result.model ? `<small>Model: ${escape(result.model)}</small>` : ''}</div>` : '';
    if (name === 'voice') return '<div data-voice-settings-page></div>';
    if (name === 'profile') return profile() + `<p class="settings-description">Your chats and settings belong to this local profile. Cloud sign-in and profile editing are unavailable.</p>` + link('account', 'Account', 'Authentication availability') + link('usage', 'Usage', 'Activity reporting availability');
    if (name === 'account') return profile() + note('Cloud account unavailable', 'Sign-in, cloud synchronization and billing are not available in this release. Local features work without an account.');
    if (name === 'usage') return note('Usage statistics are not available yet', 'This version does not maintain a complete usage ledger across chats, agents, workflows and providers. Token totals, subscription limits and lifetime activity cannot be reported reliably.');
    if (name === 'notifications') return note('Status stays in the app', 'Task progress, errors and approval requests appear in the existing chat and workflow views. Configurable desktop notifications are not available in this release.');
    if (name === 'connections') return note('Account connections unavailable', 'External account authorization and OAuth connection management will arrive in a later stage. Configure the current integrations in Plugins.') + link('plugins', 'Plugins');
    if (name === 'agents') return note('Agent settings belong to each task', 'Choose agents, models and tool permissions in the chat setup or workflow editor. Existing participant limits and overrides are preserved.') + `<a class="settings-list-row" href="#/chat"><span>Open chat setup</span>${icon('chevronRight')}</a><a class="settings-list-row" href="#/orchestration"><span>Open Workflow</span>${icon('chevronRight')}</a>`;
    if (name === 'shortcuts') return `<div class="settings-rows">${[['Open Settings', navigator.platform.includes('Mac') ? '⌘ ,' : 'Ctrl ,'], ['Close profile menu', 'Escape'], ['Move through profile menu', '↑ / ↓ · Home / End'], ['Send chat message', 'Enter'], ['New line', 'Shift Enter'], ['Stop active chat generation (in app)', 'Escape']].map(([label, value]) => `<div class="settings-row"><span>${label}</span><kbd>${value}</kbd></div>`).join('')}</div><p class="settings-footnote">Shortcut customization is not available in this release.</p>`;
    if (name === 'about') return `<div class="settings-rows">${[['Application', appInfo?.name || 'Local Cognitive AI System'], ['Version', appInfo?.version || 'Loading…'], ['Platform', appInfo?.platform || 'Browser'], ['Electron', appInfo?.electron], ['Application license', appInfo?.license || 'Not declared in application metadata']].filter(([, value]) => value).map(([label, value]) => `<div class="settings-row"><span>${escape(label)}</span><span>${escape(value)}</span></div>`).join('')}</div><p class="settings-footnote">Third-party runtime notices are included with the desktop application.</p>`;
    if (name === 'data') return `<p class="settings-description">Chats, configuration, memory and downloaded models are stored locally. External providers and integrations receive the requests you send to them.</p><button type="button" class="ghost-button" data-open-data ${window.desktopApp ? '' : 'disabled'}>Open data folder</button><p class="settings-footnote">${window.desktopApp ? 'Opens the actual application data folder in Finder.' : 'Opening the data folder is available in the desktop app.'}</p><div role="status" data-folder-status></div>`;
    if (name === 'plugins' && !id) return `<p class="settings-description">Existing integrations use the local backend. Saved configuration does not confirm a connection.</p><div class="settings-list">${data.integrations.map(integration => link(`plugins/${integration.id}`, integration.name, integration.unavailable ? 'Unavailable · saved configuration preserved' : `${settings().plugins?.[integration.id]?.enabled ? 'Enabled' : 'Disabled'} · ${integration.description}`)).join('')}</div>`;
    if (name === 'plugins' && id) {
      const integration = data.integrations.find(item => item.id === id);
      if (!integration) return note('Integration not found', 'Return to Plugins to choose an existing integration.');
      if (integration.unavailable) return note('Editor bridge unavailable', integration.description);
      return `<p class="settings-description">${escape(integration.description)} ${id === 'file' ? 'Test writes a small check file in the configured output directory.' : 'Test checks the saved credentials; it does not run an OAuth flow.'}</p>` + form(specs) + `<div class="settings-test-actions"><button type="button" class="ghost-button" data-test="plugin" ${statuses.get(page)?.busy ? 'disabled' : ''}>Save & test integration</button></div>` + testResult;
    }
    if (name === 'providers' && !id) return form(specs) + `<div class="settings-list">${Object.entries(settings().providers || {}).map(([key, provider]) => link(`providers/${key}`, providerNames[key] || key, provider.enabled ? 'Enabled · connection not checked' : 'Disabled')).join('')}</div>`;
    if (name === 'providers' && id) return specs.length ? `<p class="settings-description">${id === 'llamacpp' ? 'Built-in inference on this device. No API key or server address is required.' : 'Configure this provider and explicitly test its selected model.'}</p>` + form(specs) + `<div class="settings-test-actions"><button type="button" class="ghost-button" data-test="provider" ${statuses.get(page)?.busy ? 'disabled' : ''}>Save & test provider</button></div>` + testResult + (id === 'llamacpp' ? link('runtime', 'Local Runtime', 'Storage, context and timeouts') : '') : note('Provider not found', 'Return to Models & Providers.');
    if (name === 'runtime') return `<div class="settings-runtime-overview"><div class="settings-row"><span>Runtime status</span><span>${escape(context().localModels?.runtime?.status || 'Unavailable')}</span></div><a class="settings-list-row" href="#/models"><span>Manage model library</span>${icon('chevronRight')}</a></div>` + form(specs);
    if (name === 'memory') return form(specs) + (!id ? link('memory/advanced', 'Advanced memory', 'Partition, chunk and adapter parameters') : '');
    if (name === 'mcp' && !id) return `<p class="settings-description">The Local Cognitive server exposes this application to other MCP clients. Outgoing clients are managed separately by the existing MCP Client Manager.</p>` + link('mcp/local-cognitive', 'Local Cognitive MCP server', 'Incoming · stdio') + note('Outgoing MCP clients', 'The existing MCP Client Manager and its stored configuration are preserved. Connection-management controls are not part of this UI stage.');
    if (name === 'mcp' && id === 'local-cognitive') return `<p class="settings-description">Incoming MCP server for Local Cognitive. Other applications connect to this runtime over stdio; these controls do not manage outgoing connections.</p>` + form(specs, '<div class="settings-row"><span>Transport</span><span>stdio</span></div>') + `<p class="settings-footnote">Changes apply when the stdio server is next started.</p><pre class="config-snippet">npm run --silent mcp:stdio</pre>`;
    if (specs.length) return form(specs);
    return note('Page not found', 'Choose a page from the Settings navigation.');
  }
  function searchEntries() {
    const routes = groups.flatMap(([, items]) => items.map(([route]) => route));
    routes.push(...Object.keys(settings().providers || {}).map(id => `providers/${id}`), ...data.integrations.map(item => `plugins/${item.id}`), 'memory/advanced', 'mcp/local-cognitive');
    return routes.flatMap(route => [{ route, label: titleFor(route) }, ...fieldsFor(route).map(spec => ({ route, label: spec.label, description: spec.description, field: spec.name }))]);
  }
  function renderSearch() {
    const container = root.querySelector('.settings-search-results');
    if (!container) return;
    const query = search.toLocaleLowerCase().trim();
    root.querySelector('.settings-groups').hidden = Boolean(query);
    container.hidden = !query;
    if (!query) return;
    const matches = searchEntries().filter(entry => `${entry.label} ${entry.description || ''} ${titleFor(entry.route)}`.toLocaleLowerCase().includes(query));
    container.innerHTML = `<p role="status">${matches.length} results</p>` + (matches.length ? matches.map(entry => `<button class="settings-search-result" data-search-route="${entry.route}" data-search-field="${entry.field || ''}"><strong>${escape(entry.label)}</strong><small>${escape(titleFor(entry.route))}</small></button>`).join('') : '<p>No matching settings.</p>');
    container.querySelectorAll('[data-search-route]').forEach(button => button.addEventListener('click', () => {
      const fieldName = button.dataset.searchField;
      const route = button.dataset.searchRoute;
      search = '';
      if (page === route) { render(); focusField(fieldName); }
      else { pendingFocus = fieldName; location.hash = `#/settings/${route}`; }
    }));
  }
  let pendingFocus;
  function focusField(name) {
    const row = name && [...root.querySelectorAll('[data-setting]')].find(row => row.dataset.setting === name);
    if (row) { row.classList.add('settings-highlight'); row.scrollIntoView({ block: 'center', behavior: 'auto' }); row.querySelector('input,select,textarea')?.focus({ preventScroll: true }); }
    else root.querySelector('h1')?.focus({ preventScroll: true });
  }
  function render() {
    disposeVoice?.(); disposeVoice = undefined;
    const [name, id] = page.split('/');
    const parent = ['account', 'usage'].includes(name) ? 'profile' : id ? name : null;
    root.innerHTML = `<div class="settings-shell"><aside class="settings-sidebar liquid-glass"><a class="settings-back" href="${escape(previousRoute)}">${icon('chevronLeft')}<span>Back to app</span></a><div class="settings-search">${icon('search')}<input id="settings-search" type="search" placeholder="Search settings" aria-label="Search settings" value="${escape(search)}" /></div><div class="settings-search-results" hidden></div><nav class="settings-groups" aria-label="Settings navigation">${groups.map(([group, items]) => `<div class="settings-group"><h2>${group}</h2>${items.map(([route, label, symbol]) => `<a href="#/settings/${route}" class="settings-nav-row ${route === name ? 'active' : ''}" ${route === name ? 'aria-current="page"' : ''}>${icon(symbol)}<span>${label}</span></a>`).join('')}</div>`).join('')}</nav></aside><main class="settings-content"><div class="settings-content-inner">${parent ? `<a class="settings-parent" href="#/settings/${parent}" aria-label="Back to ${escape(titleFor(parent))}">${icon('chevronLeft')}<span>${escape(titleFor(parent))}</span></a>` : ''}<h1 tabindex="-1">${escape(titleFor(page))}</h1>${content()}</div></main></div>`;
    root.querySelector('#settings-search').addEventListener('input', event => { search = event.target.value; renderSearch(); });
    renderSearch(); bindForm(); bindGlassLighting(root);
    if (page === 'voice') disposeVoice = voiceInput?.mountSettings(root.querySelector('[data-voice-settings-page]'));
    root.querySelector('[data-open-data]')?.addEventListener('click', openDataFolder);
    if (page === 'about' && !appInfo) void (window.desktopApp?.getInfo?.() || fetch('/app/info').then(response => response.json())).then(info => { appInfo = info; if (active && page === 'about') render(); }).catch(() => { appInfo = { version: 'Unavailable' }; if (active && page === 'about') render(); });
  }
  function setStatus(route, value) {
    statuses.set(route, value);
    if (!active || page !== route) return;
    const slot = root.querySelector('.settings-save-status');
    if (slot) { slot.textContent = value.text; slot.classList.toggle('is-error', Boolean(value.error)); slot.classList.toggle('is-success', Boolean(value.success)); }
    root.querySelectorAll('button[type="submit"], [data-test]').forEach(button => { button.disabled = Boolean(value.busy); });
    const retry = root.querySelector('[data-retry]'); if (retry) retry.hidden = !value.error;
  }
  async function save(route) {
    const snapshot = { ...dirty(route) };
    if (!Object.keys(snapshot).length) return true;
    setStatus(route, { text: 'Saving…', busy: true });
    try {
      await data.save(entityPatch(snapshot));
      for (const [key, value] of Object.entries(snapshot)) if (dirty(route)[key] === value) delete dirty(route)[key];
      setStatus(route, { text: Object.keys(dirty(route)).length ? 'Unsaved changes' : 'Saved' });
      return true;
    } catch (error) {
      setStatus(route, { text: `Not saved. ${error.message}`, error: true });
      return false;
    }
  }
  function bindForm() {
    const current = page, specs = fieldsFor(page), element = root.querySelector('#settings-entity-form');
    const preference = specs.length && specs.every(spec => spec.name.startsWith('ui.'));
    element?.addEventListener('input', event => {
      const spec = specs.find(spec => spec.name === event.target.name); if (!spec) return;
      const value = spec.type === 'boolean' ? event.target.checked : ['number', 'font-scale'].includes(spec.type) ? Number(event.target.value) : event.target.value;
      if (spec.type === 'secret' && value === '') delete dirty(current)[spec.name]; else dirty(current)[spec.name] = value;
      results.delete(current);
      root.querySelector('.settings-test-result')?.remove();
      if (!statuses.get(current)?.busy) setStatus(current, { text: 'Unsaved changes' });
      if (spec.type === 'secret') root.querySelector(`[data-secret-state="${spec.name}"]`).textContent = value ? 'Replacement key entered.' : 'Blank input keeps the existing key.';
      if (spec.type === 'font-scale') {
        event.target.setAttribute('aria-valuetext', `${value}%`);
        event.target.nextElementSibling.value = `${value}%`;
        applyPreferences({ fontScale: value });
      }
    });
    element?.addEventListener('change', event => {
      if (!preference) return;
      const spec = specs.find(spec => spec.name === event.target.name); if (!spec) return;
      dirty(current)[spec.name] = spec.type === 'boolean' ? event.target.checked : spec.type === 'font-scale' ? Number(event.target.value) : event.target.value;
      applyPreferences(entityPatch(dirty(current)).ui || {});
      void save(current);
    });
    element?.addEventListener('submit', event => { event.preventDefault(); if (element.reportValidity()) void save(current); });
    root.querySelectorAll('[data-clear]').forEach(button => button.addEventListener('click', () => {
      dirty(current)[button.dataset.clear] = '';
      const input = element.elements.namedItem(button.dataset.clear); input.value = '';
      root.querySelector(`[data-secret-state="${button.dataset.clear}"]`).textContent = 'Key will be removed on Apply.';
      setStatus(current, { text: 'Unsaved changes · key removal pending' });
      results.delete(current); root.querySelector('.settings-test-result')?.remove();
    }));
    root.querySelector('[data-directory]')?.addEventListener('click', async () => {
      try { const directory = await window.desktopModels.selectDirectory(); if (directory) { const input = element.elements.namedItem('localModels.modelsDir'); input.value = directory; input.dispatchEvent(new Event('input', { bubbles: true })); } }
      catch (error) { setStatus(current, { text: error.message, error: true }); }
    });
    root.querySelector('[data-test]')?.addEventListener('click', async event => {
      if (statuses.get(current)?.busy || !element.reportValidity()) return;
      const kind = event.currentTarget.dataset.test, id = current.split('/')[1];
      if (!await save(current)) return;
      // New edits during a save must be applied before testing their values.
      if (Object.keys(dirty(current)).length) { setStatus(current, { text: 'Apply the newer changes before testing.' }); return; }
      setStatus(current, { text: 'Testing…', busy: true });
      let result;
      try { result = kind === 'provider' ? await data.testProvider(id, settings().providers[id].model, settings().providers[id].timeoutMs) : await data.testPlugin(id); }
      catch (error) { result = { ok: false, message: error.message }; }
      if (!Object.keys(dirty(current)).length) results.set(current, result);
      const hasNewerEdits = Object.keys(dirty(current)).length > 0;
      setStatus(current, { text: hasNewerEdits ? 'Unsaved changes · test used the previous configuration' : result.ok ? 'Test succeeded' : 'Test failed', error: !result.ok, success: result.ok && !hasNewerEdits });
      if (active && page === current) { const scroll = root.querySelector('.settings-content').scrollTop; render(); root.querySelector('.settings-content').scrollTop = scroll; }
    });
  }
  async function openDataFolder() {
    try { await window.desktopApp.openDataFolder(); }
    catch (error) { if (!active) { location.hash = '#/settings/data'; } setTimeout(() => { const slot = root.querySelector('[data-folder-status]'); if (slot) slot.textContent = error.message; }, 0); }
  }
  function closeMenu(restore = true) {
    if (!menu.matches(':popover-open')) return false;
    suppressMenuFocus = !restore; menu.hidePopover();
    if (restore) document.getElementById('local-profile-button')?.focus({ preventScroll: true });
    return true;
  }
  menu.addEventListener('toggle', event => {
    document.getElementById('local-profile-button')?.setAttribute('aria-expanded', String(event.newState === 'open'));
    if (event.newState === 'closed' && !suppressMenuFocus && !active) document.getElementById('local-profile-button')?.focus({ preventScroll: true });
    if (event.newState === 'closed') suppressMenuFocus = false;
  });
  function openMenu() {
    if (menu.matches(':popover-open')) { closeMenu(); return; }
    menu.innerHTML = `<div class="profile-menu-header"><span class="local-avatar">${icon('profile')}</span><span>Local profile<small>On this device</small></span></div>${[['profile', 'Profile', 'profile'], ['usage', 'Usage', 'clock'], ['general', 'Settings', 'settings'], ['data-folder', 'Open data folder', 'folder'], ['about', 'About', 'info']].map(([route, label, symbol]) => `<button type="button" role="menuitem" data-profile-route="${route}" ${route === 'data-folder' && !window.desktopApp ? 'disabled title="Available in the desktop app"' : ''}>${icon(symbol)}<span>${label}</span></button>`).join('')}`;
    menu.querySelectorAll('[data-profile-route]').forEach(button => button.addEventListener('click', () => {
      closeMenu(false);
      if (button.dataset.profileRoute === 'data-folder') { void openDataFolder(); document.getElementById('local-profile-button')?.focus(); }
      else location.hash = `#/settings/${button.dataset.profileRoute}`;
    }));
    menu.showPopover();
    const rect = document.getElementById('local-profile-button').getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.top - menu.offsetHeight - 8, innerHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector('button:not(:disabled)')?.focus();
  }
  menu.addEventListener('keydown', event => {
    const items = [...menu.querySelectorAll('button:not(:disabled)')], index = items.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = items.length - 1;
    if (next !== undefined) { event.preventDefault(); items[next].focus(); }
    if (event.key === 'Tab') closeMenu(false);
  });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && closeMenu()) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (event.key === ',' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); location.hash = '#/settings/general'; return; }
    if (active && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); const input = root.querySelector('#settings-search'); if (search) { search = ''; input.value = ''; renderSearch(); } }
  }, true);
  window.addEventListener('resize', () => closeMenu(false));
  return {
    isOpen: () => active,
    profileButton: () => `<button id="local-profile-button" class="local-profile-button" type="button" aria-label="Local profile" aria-haspopup="menu" aria-controls="profile-menu" aria-expanded="false"><span class="local-avatar">${icon('profile')}</span><span class="local-profile-label">Local profile</span>${icon('chevronDown')}</button>`,
    bindProfile: () => document.getElementById('local-profile-button')?.addEventListener('click', openMenu),
    route(hash) {
      let route = hash.replace(/^#\/?/, '');
      if (route === 'plugins') { route = 'settings/plugins'; history.replaceState(null, '', '#/settings/plugins'); }
      if (route === 'settings' || route.startsWith('settings/')) {
        if (!active) {
          voiceInput?.leaveChat();
          previousRoute = context().route ? `#/${context().route}` : '#/chat';
          appScroll = captureScroll(); appFocus = document.activeElement?.id;
          app.inert = true; app.style.visibility = 'hidden';
        }
        active = true; root.hidden = false; page = route.slice(9) || 'general';
        render(); focusField(pendingFocus); pendingFocus = undefined;
        return true;
      }
      if (active) {
        disposeVoice?.(); disposeVoice = undefined;
        active = false; root.hidden = true; app.inert = false; app.style.visibility = '';
        onReturn();
        if (hash === previousRoute) restoreScroll(appScroll);
        document.getElementById(appFocus || 'local-profile-button')?.focus({ preventScroll: true });
      }
      return false;
    },
    refreshPreferences() { if (active && page === 'appearance') render(); }
  };
}
