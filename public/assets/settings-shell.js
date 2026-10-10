import { icon, bindGlassLighting } from './ui-primitives.js';
import { createAccountState, entityPatch, localProfileView, mcpServerCount } from './settings-data.js';
import { mountIntegrationPage } from './plugins-ui.js';
import { mountUsagePage } from './usage-ui.js';
import { mountReportBugPage } from './report-bug.js';
import { openAvatarCropper } from './avatar-crop.js';

const groups = [
  ['Personal', [['general', 'General', 'settings'], ['notifications', 'Notifications', 'info'], ['profile', 'Profile', 'profile'], ['appearance', 'Appearance', 'sun'], ['voice', 'Voice', 'microphone'], ['shortcuts', 'Keyboard Shortcuts', 'keyboard'], ['usage', 'Usage', 'clock'], ['account', 'Account', 'profile']]],
  ['AI System', [['providers', 'Models & Providers', 'models'], ['runtime', 'Local Runtime', 'models'], ['agents', 'Agents', 'workflow'], ['memory', 'Memory', 'folder']]],
  ['Integrations', [['plugins', 'Plugins', 'plugins'], ['mcp', 'MCP Servers', 'code'], ['connections', 'Connected accounts', 'externalLink']]],
  ['System', [['data', 'Data & Privacy', 'shield'], ['about', 'About', 'info'], ['report-bug', 'Report a bug', 'bug']]]
];
// With a server selected, these pages show and change that server's settings (R5-3); plugins and
// MCP are each machine's own and are not offered for a server yet. Every other page is this device's.
const HOST_PAGES = new Set(['general', 'providers', 'runtime', 'agents', 'memory', 'data']);
const DEFER_PAGES = new Set(['plugins', 'connections', 'mcp']);
const providerNames = { llamacpp: 'Local models', ollama: 'Ollama', lmstudio: 'LM Studio', openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const get = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);
const field = (name, label, type = 'text', extra = {}) => ({ name, label, type, ...extra });
const bool = (name, label, description = '') => field(name, label, 'boolean', { description });
const select = (name, label, choices, description = '') => field(name, label, 'select', { choices, description });
const number = (name, label, min, max, description = '') => field(name, label, 'number', { min, max, description });
const link = (path, title, description = '', symbol = 'chevronRight') => `<a class="settings-list-row" href="#/settings/${escape(path)}"><span><strong>${escape(title)}</strong>${description ? `<small>${escape(description)}</small>` : ''}</span>${icon(symbol)}</a>`;
const note = (title, description) => `<div class="settings-empty"><span class="settings-empty-icon">${icon('info')}</span><h2>${escape(title)}</h2><p>${escape(description)}</p></div>`;
const isHexColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const appearancePresets = {
  dark: { label: 'Dark', description: 'Quiet graphite for focused work', accent: '#B4C9EB', background: '#111214', foreground: '#ECEDEF' },
  light: { label: 'Light', description: 'A softer, low-glare light surface', accent: '#466896', background: '#E9EDF2', foreground: '#273140' },
  midnight: { label: 'Midnight blue', description: 'Deep blue black, based on the Plugins view', accent: '#65A8FF', background: '#0C1117', foreground: '#E8EEF8' },
  system: { label: 'System', description: 'Follows your device appearance', accent: '#B4C9EB', background: '#111214', foreground: '#ECEDEF' }
};
const appearanceColorKey = { 'ui.accentColor': 'accent', 'ui.backgroundColor': 'background', 'ui.foregroundColor': 'foreground' };
const generationPresets = {
  precise: { temperature: 0.2, topP: 0.9, topK: 40, minP: 0.05, repeatPenalty: 1.05, maxTokens: 1024 },
  balanced: { temperature: 0.7, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1.05, maxTokens: 2048 },
  creative: { temperature: 1, topP: 0.98, topK: 80, minP: 0.02, repeatPenalty: 1.02, maxTokens: 3072 }
};
const generationFields = [
  ['temperature', 'Temperature', '0.0–2.0', '0', '2', '0.01'],
  ['topP', 'Top P', '0.0–1.0', '0', '1', '0.01'],
  ['topK', 'Top K', '0–200', '0', '200', '1'],
  ['minP', 'Min P', '0.0–1.0', '0', '1', '0.01'],
  ['repeatPenalty', 'Repeat penalty', '0.0–2.0', '0', '2', '0.01'],
  ['maxTokens', 'Max response tokens', '1–32,768', '1', '32768', '1']
];

export function createSettingsShell({ app, getContext, data, applyPreferences, renderModelControl, onReturn, captureScroll, restoreScroll, voiceInput, account = createAccountState(window.desktopAccount) }) {
  const root = document.createElement('section');
  root.id = 'settings-root'; root.hidden = true;
  document.body.append(root);
  const menu = document.createElement('div');
  menu.id = 'profile-menu'; menu.className = 'profile-menu liquid-glass'; menu.setAttribute('popover', 'auto'); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Local profile');
  document.body.append(menu);
  let active = false, page = 'general', previousRoute = '#/chat', appScroll, appFocus, search = '', appInfo, mcpSnapshot, mcpRequest, shownTarget = '';
  let mcpSecretsView, mcpSecretsRequest, mcpImport = {};
  const drafts = new Map(), statuses = new Map(), results = new Map();
  let suppressMenuFocus = false, disposeVoice, disposeIntegrations, disposeUsage, disposeReport, accountPending, accountNotice, diagnosticsConsent, diagnosticsSaved = false;
  const context = () => getContext() || {};
  const clientSettings = () => context().appSettings || {};
  /** The selected server, for the pages it owns; this device's pages never see it. */
  const serverFor = route => {
    const server = context().server, [name] = route.split('/');
    return server && (HOST_PAGES.has(name) || DEFER_PAGES.has(name)) ? server : undefined;
  };
  /** Where a page's values come from and are saved, fixed when an action starts: drafts and
   * statuses are kept per machine, and a save never lands on a server selected after it began. */
  const placeOf = route => {
    const server = serverFor(route);
    return server ? { key: `${server.key}\u0000${route}`, server, store: server.data, settings: () => server.settings() || {} }
      : { key: route, store: data, settings: clientSettings };
  };
  const settingsOf = route => placeOf(route).settings();
  const settings = () => settingsOf(page);
  const fieldsFor = route => {
    const specs = baseFieldsFor(route), server = serverFor(route);
    return server ? server.fields(route, specs) : specs;
  };
  const baseFieldsFor = route => {
    const [name, id] = route.split('/');
    if (name === 'general') return [
      select('ui.language', 'Response language', [['auto', 'Auto detect'], ['en', 'English'], ['ru', 'Russian']], 'Default for new chats.'),
      select('ui.outputStyle', 'Response style', ['compact', 'balanced', 'detailed', 'exhaustive'], 'Default for new chats.'),
      select('ui.mode', 'Default chat mode', ['auto', 'general', 'code', 'hypothesis'], 'Existing chats keep their own settings.')
    ];
    if (name === 'data') return [field('filesystem.outputDir', 'Chat output folder', 'text', { description: 'Built-in file tools use this folder for ordinary chats. Project and workflow folders keep their own boundaries.' }),
      select('filesystem.accessMode', 'Built-in filesystem access', ['restricted', 'full']),
      field('filesystem.allowedDirectories', 'Allowed folders', 'textarea', { description: 'One absolute folder path per line. Session approval rules still apply.' })];
    if (name === 'voice') return [field('voice.microphone', 'Microphone', 'text', { description: 'Input device, headset, input level and permissions' }), field('voice.language', 'Language'), field('voice.recognition', 'Recognition model')];
    if (name === 'appearance') return [
      field('ui.theme', 'Theme', 'theme-cards', { description: 'One visual style is applied to Chat, Workflow, Synthesis, Models and Plugins.' }),
      field('ui.accentColor', 'Accent', 'color', { colorKey: 'accent' }),
      field('ui.backgroundColor', 'Background', 'color', { colorKey: 'background' }),
      field('ui.foregroundColor', 'Foreground', 'color', { colorKey: 'foreground' }),
      field('ui.fontScale', 'Text size', 'font-scale', { description: 'Scale interface text and messages across the app. Code has its own size. Default: 100%.' }),
      field('ui.codeFontSize', 'Code text size', 'code-font-size', { description: 'Code blocks in chat, workflow responses and Review. Independent of text size. Default: 12 px.' }),
      bool('ui.animations', 'Animations', 'Shows the one-pass sweep when Chat, Workflow, Synthesis or Models is clicked. Motion is reduced automatically when your system requests it.')
    ];
    if (name === 'providers' && id && Object.hasOwn(settingsOf(route).providers || {}, id)) {
      return [bool(`providers.${id}.enabled`, 'Enabled'), ...(id === 'llamacpp' ? [] : [
        field(`providers.${id}.baseUrl`, 'Base URL', 'url'), ...(id === 'ollama' ? [] : [field(`providers.${id}.apiKey`, 'API key', 'secret')])
      ]), field(`providers.${id}.model`, 'Default model', 'model', { provider: id }),
      ...(id === 'llamacpp' ? [] : [number(`providers.${id}.timeoutMs`, 'Timeout (ms)', 1000, 3600000)]),
      ...(id === 'anthropic' ? [field(`providers.${id}.version`, 'Anthropic version'), number(`providers.${id}.maxTokens`, 'Max tokens', 1, 1000000)] : [])];
    }
    if (name === 'providers') return [select('llm.defaultProvider', 'Default provider', Object.keys(settingsOf(route).providers || {}).map(id => [id, providerNames[id] || id]), 'Used when a chat or workflow has no explicit provider override.')];
    if (name === 'runtime') return [
      field('localModels.modelsDir', 'Model storage folder', 'directory', { description: 'Changing storage copies and verifies models before switching. Previous files remain as a backup. Pause downloads first.' }),
      number('localModels.contextSize', 'Context size (tokens)', 512, 131072), field('localModels.gpuLayers', 'GPU layers', 'text', { description: 'auto places each model on the GPU first by free memory. A number fixes the offloaded layers; 0 runs on the CPU.' }),
      number('localModels.memoryLimitPercent', 'Memory warning threshold (%)', 10, 90),
      number('localModels.loadTimeoutMs', 'Load timeout (ms)', 10000, 1800000), number('localModels.generationTimeoutMs', 'Generation timeout (ms)', 10000, 3600000),
      field('localModels.generation', 'Generation profile', 'local-generation', { description: 'Sampling controls apply to the next local response without unloading the model. Structured tool actions use a precise profile for safety.' })
    ];
    if (name === 'agents') return [
      number('agentLimits.maxSteps', 'Main agent turns', 0, undefined, 'One turn is one model decision: request a tool or return the final answer.'),
      number('agentLimits.advisorMaxSteps', 'Advisor turns', 0, undefined, 'Applies to each configured subagent.'),
      number('agentLimits.maxTotalSteps', 'All agents, total turns', 0, undefined, 'Keeps a multi-agent run bounded only when you choose a value.'),
      number('agentLimits.maxActiveMs', 'Generation time limit (ms)', 0, undefined, '0 disables the automatic clock limit. You can still stop a chat yourself.')
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
    return [];
  };
  function titleFor(route) {
    const [name, id] = route.split('/');
    if (id) return name === 'providers' ? providerNames[id] || id : name === 'plugins' ? data.integrations.find(item => item.id === id)?.name || id : name === 'memory' ? 'Advanced memory' : name === 'mcp' ? id === 'local-cognitive' ? 'Local Cognitive MCP server' : id === 'new' ? 'Add MCP server' : id === 'import' ? 'Import MCP servers' : externalMcpServers()[id]?.name || id : id;
    return groups.flatMap(([, items]) => items).find(([key]) => key === name)?.[1] || 'Page not found';
  }
  const dirty = key => { if (!drafts.has(key)) drafts.set(key, {}); return drafts.get(key); };
  function valueOf(spec) { const draft = dirty(placeOf(page).key), value = Object.hasOwn(draft, spec.name) ? draft[spec.name] : get(settings(), spec.name); return Array.isArray(value) ? value.join('\n') : value; }
  function activeAppearanceTheme() {
    const candidate = valueOf({ name: 'ui.theme' });
    return Object.hasOwn(appearancePresets, candidate) ? candidate : 'dark';
  }
  function appearanceColor(spec) {
    const value = valueOf(spec);
    return isHexColor(value) ? value.toUpperCase() : appearancePresets[activeAppearanceTheme()][spec.colorKey];
  }
  function generationValue() {
    const stored = valueOf({ name: 'localModels.generation' }) || {};
    const preset = ['server', 'precise', 'balanced', 'creative', 'custom'].includes(stored.preset) ? stored.preset : 'server';
    return { ...stored, preset };
  }
  function generationInputValues(generation) {
    if (generation.preset === 'custom') return generation;
    return generationPresets[generation.preset] || {};
  }
  function renderGenerationControl() {
    const generation = generationValue();
    const values = generationInputValues(generation);
    const placeholder = generation.preset === 'server' ? 'Use default' : '';
    const profileNote = generation.preset === 'server'
      ? 'Uses the model’s built-in values until you choose a profile or enter a value.'
      : generation.preset === 'custom'
        ? 'Custom values apply to the next local response.'
        : 'This profile fills in the controls below. Editing a value creates a custom profile.';
    return `<section class="local-generation-card" aria-labelledby="local-generation-heading">
      <header class="local-generation-card-header"><div><h2 id="local-generation-heading">Generation profile</h2><p>Choose how a local model balances consistency and variety. Changes apply to the next response without unloading the model.</p></div>
        <label class="local-generation-profile" for="local-generation-preset"><span>Profile</span><select id="local-generation-preset" data-generation-preset aria-label="Generation profile">
          ${[['server', 'Default'], ['precise', 'Precise'], ['balanced', 'Balanced'], ['creative', 'Creative'], ['custom', 'Custom']].map(([value, label]) => `<option value="${value}" ${generation.preset === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select></label></header>
      <p class="local-generation-profile-note">${profileNote}</p>
      <div class="local-generation-grid">${generationFields.map(([key, label, hint, min, max, step]) => `<label><span>${label}</span><input type="number" inputmode="decimal" data-generation-field="${key}" min="${min}" max="${max}" step="${step}" value="${escape(values[key] ?? '')}" placeholder="${placeholder}" aria-label="${label}" /><small>${hint}</small></label>`).join('')}</div>
      <details class="local-generation-advanced"><summary>Advanced</summary><label><span>Seed</span><input type="number" inputmode="numeric" data-generation-field="seed" min="-1" max="2147483647" step="1" value="${generation.preset === 'custom' && generation.seed !== undefined ? escape(generation.seed) : ''}" placeholder="Random" aria-label="Seed" /><small>Leave blank for random sampling. Set a fixed integer to reproduce a run.</small></label></details>
    </section>`;
  }
  function avatar(user, extraClass = '') {
    const image = user.avatarDataUrl ? `<img src="${escape(user.avatarDataUrl)}" alt="" />` : icon('profile');
    return `<span class="local-avatar ${extraClass}">${image}</span>`;
  }
  function renderField(spec) {
    // Set on the server itself: what it is, never a path or a full address, and nothing to edit.
    if (spec.type === 'host-only') return `<div class="settings-row settings-host-only" data-setting="${escape(spec.name)}"><div><span class="settings-row-label">${escape(spec.label)}</span>${spec.description ? `<p>${escape(spec.description)}</p>` : ''}</div><div class="settings-control"><span>${escape(spec.display)}</span></div></div>`;
    const value = valueOf(spec), id = `setting-${spec.name.replaceAll('.', '-')}`, draft = dirty(placeOf(page).key);
    let control;
    const common = `id="${id}" name="${escape(spec.name)}"`;
    if (spec.type === 'boolean') control = `<input ${common} type="checkbox" role="switch" ${value ? 'checked' : ''} />`;
    else if (spec.type === 'local-generation') control = renderGenerationControl();
    else if (spec.type === 'theme-cards') {
      const selected = activeAppearanceTheme();
      control = `<div class="appearance-theme-picker" role="group" aria-label="Visual style">${Object.entries(appearancePresets).map(([theme, preset]) => `<button type="button" class="appearance-theme-card ${theme === selected ? 'is-selected' : ''}" data-appearance-theme="${theme}" aria-pressed="${theme === selected}"><span class="appearance-theme-preview appearance-theme-preview--${theme}" aria-hidden="true"><i></i><i></i><i></i></span><span><strong>${escape(preset.label)}</strong><small>${escape(preset.description)}</small></span></button>`).join('')}</div>`;
    } else if (spec.type === 'color') {
      const color = appearanceColor(spec);
      control = `<div class="appearance-color-control"><input id="${id}-picker" data-appearance-picker="${escape(spec.name)}" type="color" value="${escape(color)}" aria-label="Choose ${escape(spec.label).toLowerCase()} color" /><input ${common} data-appearance-color type="text" inputmode="text" autocomplete="off" spellcheck="false" maxlength="7" pattern="^#[0-9A-Fa-f]{6}$" value="${escape(color)}" aria-label="${escape(spec.label)} hex color" /></div>`;
    }
    else if (spec.type === 'font-scale') control = `<div class="settings-font-scale"><input ${common} type="range" min="85" max="150" step="5" value="${value ?? 100}" aria-valuetext="${value ?? 100}%" /><output for="${id}">${value ?? 100}%</output></div>`;
    else if (spec.type === 'code-font-size') control = `<div class="settings-font-scale"><input ${common} type="range" min="10" max="20" step="1" value="${value ?? 12}" aria-valuetext="${value ?? 12} px" /><output for="${id}">${value ?? 12} px</output></div><pre class="settings-code-preview" aria-label="Code size preview"><code><span class="hljs-keyword">const</span> message = <span class="hljs-string">"Hello, world"</span>;</code></pre>`;
    else if (spec.type === 'select') control = `<select ${common}>${spec.choices.map(choice => { const [key, label] = Array.isArray(choice) ? choice : [choice, choice]; return `<option value="${escape(key)}" ${String(value) === key ? 'selected' : ''}>${escape(label)}</option>`; }).join('')}</select>`;
    else if (spec.type === 'secret') control = `<div class="settings-secret"><input ${common} type="password" autocomplete="new-password" value="" placeholder="${get(settings(), spec.name) || get(settings(), `${spec.name}State`) === 'set' ? 'Saved key · leave blank to keep' : 'Enter API key'}" /><button type="button" class="ghost-button" data-clear="${escape(spec.name)}">Remove key</button><small data-secret-state="${escape(spec.name)}">${Object.hasOwn(draft, spec.name) ? draft[spec.name] === '' ? 'Key will be removed on Apply.' : 'Replacement key entered.' : 'Blank input keeps the existing key.'}</small></div>`;
    else if (spec.type === 'model') {
      control = (serverFor(page)?.renderModelControl ?? renderModelControl)(spec.provider, value || '').replaceAll(`provider.${spec.provider}.model`, spec.name);
      // The existing model picker is reused with a unique accessible label.
      control = control.replace(/<(select|input) /, `<$1 id="${id}" `);
    } else if (spec.type === 'textarea') control = `<textarea ${common} rows="3">${escape(value)}</textarea>`;
    else {
      const numberAttributes = spec.type === 'number' ? `${Number.isFinite(spec.min) ? `min="${spec.min}"` : ''} ${Number.isFinite(spec.max) ? `max="${spec.max}"` : ''} step="1" required` : '';
      const input = `<input ${common} type="${['number', 'url'].includes(spec.type) ? spec.type : 'text'}" value="${escape(value)}" ${numberAttributes} />`;
      control = spec.type === 'directory'
        ? `<div class="settings-directory-control">${input}${window.desktopModels?.selectDirectory ? '<button type="button" class="ghost-button" data-directory>Choose folder</button>' : ''}</div>`
        : input;
    }
    return `<div class="settings-row" data-setting="${escape(spec.name)}"><div><label for="${id}">${escape(spec.label)}</label>${spec.description ? `<p>${escape(spec.description)}</p>` : ''}</div><div class="settings-control">${control}</div></div>`;
  }
  function form(specs, leadingRows = '', beforeRows = '') {
    if (!specs.length) return '';
    const preference = specs.every(item => item.name.startsWith('ui.'));
    const status = statuses.get(placeOf(page).key);
    const rows = `<div class="settings-rows">${leadingRows}${specs.map(renderField).join('')}</div>`;
    if (!beforeRows && specs.every(item => item.type === 'host-only')) return `<div class="settings-form">${rows}</div>`;
    return `<form id="settings-entity-form" data-entity="${escape(page)}" class="settings-form">${beforeRows}${rows}<div class="settings-form-footer"><span role="status" aria-live="polite" class="settings-save-status ${status?.error ? 'is-error' : status?.success ? 'is-success' : ''}">${escape(status?.text || (preference ? 'Changes save automatically.' : 'Apply changes to this page only.'))}</span>${preference ? '<button type="submit" class="ghost-button" data-retry hidden>Retry save</button>' : `<button type="submit" class="primary-button" ${status?.busy ? 'disabled' : ''}>Save / Apply</button>`}</div></form>`;
  }
  function profile() {
    const user = localProfileView(clientSettings());
    return `<div class="local-profile-view">${avatar(user)}<h2>${escape(user.name)}</h2><p>Stored only on this device</p></div>`;
  }
  function accountSubtitle(view) {
    return view.state === 'signed-in' ? view.profile?.email || view.profile?.name || 'Signed in' : 'On this device';
  }
  function accountLinkDescription(view) {
    if (view.state === 'unavailable') return 'Available in the desktop app';
    return view.state === 'signed-in' ? view.profile?.email || 'Signed in' : 'Sign in to use Remote';
  }
  function accountButtons(disabled) {
    const attr = disabled ? ' disabled' : '';
    return `<div class="account-actions"><button type="button" class="primary-button" data-account-action="google"${attr}>Continue with Google</button><button type="button" class="ghost-button" data-account-action="email"${attr}>Continue with email</button><button type="button" class="ghost-button" data-account-action="signup"${attr}>Create account</button></div>`;
  }
  function accountPanel() {
    const view = account.get(), busy = Boolean(accountPending);
    if (view.state === 'unavailable') return note('Sign-in is available in the desktop app', 'Open the Local Cognitive desktop app to sign in. Local features work without an account.');
    if (view.state === 'loading') return '<p class="settings-description" role="status">Checking your account…</p>';
    if (view.state === 'signing-in') return `<div class="account-card" role="status"><div><h2>Waiting for your browser…</h2><p>Finish signing in in the browser window that opened, then return here. This page updates automatically.</p></div><div class="account-actions"><button type="button" class="ghost-button" data-account-action="cancel">Cancel</button></div></div>`;
    const signIn = `<div class="account-card"><div><h2>Sign in to Local Cognitive</h2><p>An account is needed only for Remote — controlling Local Cognitive on another computer you own. Chats, models, plugins and everything on this device work without signing in.</p></div>${accountButtons(busy)}<p class="settings-footnote">Sign-in opens in your web browser; your password is never entered in this app. Signing in doesn't change your local profile, chats or plugin connections.</p></div>`;
    if (view.state === 'error') return `<div class="settings-test-result is-error" role="alert"><div class="settings-test-heading">${icon('shieldAlert')}<strong>Sign-in didn't complete</strong></div><p>${escape(view.error?.message)}</p></div>${signIn}`;
    if (view.state !== 'signed-in') return signIn;
    const user = view.profile, title = user.name || user.email || 'Signed in', initial = (Array.from(title)[0] || '?').toUpperCase();
    const disabled = busy ? ' disabled' : '';
    const offline = view.cloudReachable ? '' : `<p class="account-offline" role="status">${icon('info')}<span>Can't reach Local Cognitive Cloud. You're still signed in on this device; Remote needs a connection. Local features are unaffected.</span></p>`;
    const verified = user.emailVerified ? '<span class="account-badge is-verified">Verified</span>' : '<span class="account-badge is-unverified">Not verified</span>';
    const emailRow = user.email ? `<div class="settings-row"><div><label>Email</label>${user.emailVerified ? '' : '<p>Confirm your email to use Remote, then choose Check again.</p>'}</div><div class="settings-control"><span>${escape(user.email)}</span>${verified}</div></div>` : '';
    const copy = navigator.clipboard?.writeText ? `<button type="button" class="ghost-button" data-account-action="copy-id"${disabled}>Copy</button>` : '';
    // R3/R5: the Remote hosts and devices link attaches after the identity rows.
    // The picture chosen in Profile, else the name's first letter.
    const picture = localProfileView(clientSettings()).avatarDataUrl;
    return `${offline}<div class="account-identity"><span class="local-avatar account-avatar">${picture ? `<img src="${escape(picture)}" alt="" />` : escape(initial)}</span><span><strong>${escape(title)}</strong>${user.email && user.name ? `<small>${escape(user.email)}</small>` : ''}</span></div><div class="settings-rows">${emailRow}<div class="settings-row"><div><label>Account ID</label><p>Identifies this account to Local Cognitive Cloud.</p></div><div class="settings-control account-id-control"><code class="account-id">${escape(user.accountId)}</code>${copy}</div></div></div><div class="settings-form-footer"><span role="status" aria-live="polite" class="settings-save-status" data-account-status>${escape(accountNotice || "Signing out doesn't remove local chats, models or plugin connections.")}</span><div class="settings-form-actions">${!user.emailVerified || !view.cloudReachable ? `<button type="button" class="ghost-button" data-account-action="refresh"${disabled}>Check again</button>` : ''}<button type="button" class="ghost-button" data-account-action="sign-out"${disabled}>Sign out</button></div></div>`;
  }
  function updateAccountPage() {
    const container = root.querySelector('[data-account-page]');
    if (!container) return;
    const hadFocus = container.contains(document.activeElement);
    container.innerHTML = accountPanel();
    if (hadFocus) (container.querySelector('[data-account-action]:not(:disabled)') || root.querySelector('h1'))?.focus({ preventScroll: true });
  }
  function bindAccountPage() {
    root.querySelector('[data-account-page]')?.addEventListener('click', event => {
      const action = event.target.closest('[data-account-action]')?.dataset.accountAction;
      if (action) void runAccountAction(action);
    });
  }
  async function runAccountAction(action) {
    if (accountPending && action !== 'cancel') return;
    accountPending = action; accountNotice = undefined;
    updateAccountPage();
    try {
      if (['google', 'email', 'signup'].includes(action)) await account.signIn(action);
      else if (action === 'cancel') await account.cancelSignIn();
      else if (action === 'sign-out') await account.signOut();
      else if (action === 'refresh') await account.refresh();
      else if (action === 'copy-id') { await navigator.clipboard.writeText(account.get().profile?.accountId || ''); accountNotice = 'Account ID copied.'; }
    } catch { if (action === 'copy-id') accountNotice = 'Copying is unavailable.'; }
    finally {
      if (accountPending === action) accountPending = undefined;
      if (active && page === 'account') updateAccountPage();
    }
  }
  function profileEditor() {
    const user = localProfileView(clientSettings());
    return profile() + `<p class="settings-description">Choose the name and avatar shown in the sidebar. They stay on this Mac and do not change your connected accounts or plugin credentials.</p><form id="settings-profile-form" class="settings-form"><div class="settings-rows"><div class="settings-row"><div><label for="local-profile-name">Profile name</label><p>Shown in the app navigation and local profile menu.</p></div><div class="settings-control"><input id="local-profile-name" name="displayName" type="text" maxlength="80" required value="${escape(user.name)}" /></div></div><div class="settings-row"><div><label for="local-profile-avatar">Avatar</label><p>PNG, JPEG or WebP. The image is kept locally with your settings.</p></div><div class="settings-control settings-avatar-control">${avatar(user, 'local-avatar--editor')}<label class="ghost-button" for="local-profile-avatar">Choose image</label><input id="local-profile-avatar" data-profile-avatar type="file" accept="image/png,image/jpeg,image/webp" hidden />${user.avatarDataUrl ? '<button type="button" class="ghost-button" data-remove-profile-avatar>Remove</button>' : ''}</div></div></div><div class="settings-form-footer"><span role="status" aria-live="polite" class="settings-save-status" data-profile-status>Changes stay on this device.</span><button type="submit" class="primary-button">Save profile</button></div></form>` + link('account', 'Account', accountLinkDescription(account.get())) + link('usage', 'Usage', 'Tokens over time, by period and by day');
  }
  function externalMcpServers() { return clientSettings().mcp?.client?.servers || {}; }
  function externalMcpBindings(serverId) {
    return Object.values(clientSettings().mcp?.client?.bindings || {}).filter(binding => binding.serverId === serverId);
  }
  function externalMcpStatus(serverId) {
    const bindingIds = new Set(externalMcpBindings(serverId).map(binding => binding.id));
    return (mcpSnapshot?.connections || []).filter(connection => bindingIds.has(connection.bindingId));
  }
  function externalMcpState(server) {
    if (!server.enabled) return 'Disabled';
    const statuses = externalMcpStatus(server.id);
    if (!statuses.length) return mcpSnapshot?.error ? 'Status unavailable' : 'Configured';
    const status = statuses.find(item => item.state === 'connected') || statuses[0];
    const count = (mcpSnapshot.tools || []).filter(tool => tool.bindingId === status.bindingId).length;
    const label = { connected: 'Connected', connecting: 'Connecting', disconnected: 'Disconnected', 'authentication-required': 'Authentication required', error: 'Connection failed' }[status.state] || 'Configured';
    return status.state === 'connected' ? `${label} · ${count} tool${count === 1 ? '' : 's'}` : label;
  }
  function externalMcpList() {
    const servers = Object.values(externalMcpServers());
    return `<section class="mcp-card" aria-labelledby="mcp-external-title"><div class="mcp-card-heading"><div><h2 id="mcp-external-title">External MCP servers <span class="mcp-count" aria-label="${servers.length} servers">${servers.length}</span></h2><p>Tools connected to this app</p></div><span class="mcp-card-actions"><a class="ghost-button" href="#/settings/mcp/import">Import…</a><a class="primary-button mcp-add-button" href="#/settings/mcp/new">${icon('plus')}<span>Add MCP server</span></a></span></div>`
      + (servers.length ? `<div class="mcp-server-list">${servers.map(server => link(`mcp/${server.id}`, server.name || server.id,
        `${server.transport === 'streamable-http' ? 'Streamable HTTP' : 'stdio'} · ${externalMcpState(server)}`)).join('')}</div>`
        : `<div class="mcp-empty-state"><span class="mcp-empty-icon">${icon('plugins')}</span><div><strong>No external servers yet</strong><p>Add your first server to discover its tools.</p></div></div>`) + '</section>';
  }
  function newMcpId(name) {
    const stem = String(name || 'external-mcp').toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').slice(0, 116) || 'external-mcp';
    const reserved = new Set(['local-cognitive', 'new', 'import']);
    const existing = new Set([...Object.keys(externalMcpServers()), ...Object.keys(clientSettings().mcp?.client?.bindings || {})]);
    let id = stem, suffix = 2;
    while (reserved.has(id) || existing.has(id)) id = `${stem.slice(0, 120)}-${suffix++}`;
    return id;
  }
  /** Import servers from Codex, Claude Desktop, Cursor or a pasted snippet: a preview to choose
   * from, then one save. Secret values found go to protected storage; none is shown. */
  function mcpImportPage() {
    if (!mcpImport.sources && !mcpImport.loading && data.mcpImportSources) {
      mcpImport.loading = true;
      void data.mcpImportSources().then(result => { mcpImport.sources = result.sources; })
        .catch(error => { mcpImport.sources = []; mcpImport.error = error.message; })
        .finally(() => { mcpImport.loading = false; if (active && page === 'mcp/import') render(); });
    }
    const sources = (mcpImport.sources || []).map(item => `<button type="button" class="ghost-button" data-mcp-import-source="${escape(item.source)}" ${item.available ? '' : 'disabled'}>${escape(item.label)}${item.available ? '' : ' (not found)'}</button>`).join('');
    const preview = mcpImport.preview;
    const summary = server => server.transport === 'stdio' ? [server.command, ...(server.args || [])].join(' ') : server.endpoint;
    const rows = preview ? preview.servers.map(item => {
      const blocked = item.unsupported || item.alreadyAdded;
      const secrets = item.secrets.map(secret => `<li>${escape(secret.kind === 'bearer' ? 'Bearer token' : secret.name)}: ${secret.found ? `${secret.from ? `value from this computer's ${escape(secret.from)} variable` : 'value found'}${preview.vault ? ', stored in protected storage' : ', but protected storage is unavailable: set it later'}` : 'no value found, set it later in the server\'s Settings'}</li>`).join('');
      return `<li class="mcp-import-item"><label><input type="checkbox" data-mcp-import-key="${escape(item.key)}" ${item.unsupported ? 'disabled' : blocked ? '' : 'checked'} /> <strong>${escape(item.server.name || item.key)}</strong> <code>${escape(item.id)}</code></label>
        <p><code>${escape(summary(item.server))}</code></p>
        ${item.unsupported ? `<p class="is-error">${escape(item.unsupported)}</p>` : ''}
        ${item.alreadyAdded ? `<p class="settings-description">Already added as <code>${escape(item.alreadyAdded)}</code>.</p>` : ''}
        ${secrets ? `<ul class="mcp-import-secrets">${secrets}</ul>` : ''}
        ${item.ignored.length ? `<p class="settings-description">Not imported: ${item.ignored.map(field => `<code>${escape(field)}</code>`).join(', ')}</p>` : ''}</li>`;
    }).join('') : '';
    return `<p class="settings-description">Add MCP servers you set up in another app. Nothing is saved until you import; secret values go to this computer's protected storage.</p>
      <section class="mcp-import"><h3>From an app on this computer</h3><div class="mcp-import-sources">${mcpImport.loading && !mcpImport.sources ? 'Looking…' : sources}</div>
      <h3>Or paste a snippet</h3><p class="settings-description">A Codex <code>[mcp_servers.name]</code> table, or JSON with <code>mcpServers</code> as in Claude Desktop, Cursor and most READMEs.</p>
      <textarea data-mcp-import-text rows="6" spellcheck="false" placeholder='{"mcpServers": {"blender": {"command": "uvx", "args": ["blender-mcp"]}}}'></textarea>
      <div class="settings-form-actions"><button type="button" class="ghost-button" data-mcp-import-paste>Preview</button></div>
      ${preview ? (preview.servers.length ? `<h3>Servers found</h3><ul class="mcp-import-list">${rows}</ul><div class="settings-form-actions"><button type="button" class="primary-button" data-mcp-import-apply>Import selected</button></div>` : '<p class="settings-description">No MCP servers were found there.</p>') : ''}
      <span role="status" aria-live="polite" class="settings-save-status ${mcpImport.error ? 'is-error' : ''}" data-mcp-import-status>${escape(mcpImport.error || mcpImport.status || '')}</span></section>`;
  }
  function bindMcpImport() {
    const section = root.querySelector('.mcp-import');
    if (!section) return;
    const show = (body) => {
      mcpImport.error = ''; mcpImport.status = 'Reading…'; render();
      void data.previewMcpImport(body).then(preview => { mcpImport.preview = preview; mcpImport.status = ''; })
        .catch(error => { mcpImport.preview = undefined; mcpImport.error = error.message || 'Could not read that configuration.'; })
        .finally(() => { if (active && page === 'mcp/import') render(); });
    };
    section.querySelectorAll('[data-mcp-import-source]').forEach(button => button.addEventListener('click', () => show({ source: button.dataset.mcpImportSource })));
    section.querySelector('[data-mcp-import-paste]')?.addEventListener('click', () => {
      const text = section.querySelector('[data-mcp-import-text]').value;
      if (!text.trim()) { mcpImport.error = 'Paste a configuration first.'; render(); return; }
      show({ source: 'text', text });
    });
    section.querySelector('[data-mcp-import-apply]')?.addEventListener('click', event => {
      const keys = [...section.querySelectorAll('[data-mcp-import-key]:checked')].map(box => box.dataset.mcpImportKey);
      if (!keys.length) { mcpImport.error = 'Choose at least one server.'; render(); return; }
      event.currentTarget.disabled = true; mcpImport.error = ''; mcpImport.status = 'Importing…';
      const slot = section.querySelector('[data-mcp-import-status]'); if (slot) slot.textContent = 'Importing…';
      void data.applyMcpImport({ token: mcpImport.preview.token, keys }).then(result => {
        const missing = result.missing.length ? ` Set ${result.missing.map(item => `${item.name} (${item.id})`).join(', ')} in each server's Settings.` : '';
        mcpImport = { status: `Imported ${result.added.length} server${result.added.length === 1 ? '' : 's'}.${missing}` };
        mcpSnapshot = undefined; mcpRequest = undefined;
        location.hash = '#/settings/mcp';
      }).catch(error => { mcpImport.error = error.message || 'Could not import.'; render(); });
    });
  }
  /** A server's secrets: names with set/not set, a value field to set one; values never come back. */
  function mcpSecretsSection(server) {
    const view = mcpSecretsView?.id === server.id ? mcpSecretsView.data : undefined;
    if (!view) { loadMcpSecrets(server.id); return '<section class="mcp-secrets"><h3>Secrets</h3><p class="settings-description">Loading…</p></section>'; }
    if (view.error) return `<section class="mcp-secrets"><h3>Secrets</h3><p class="settings-description is-error">${escape(view.error)}</p></section>`;
    const http = server.transport === 'streamable-http';
    const rows = view.secrets.map(item => `<li><code>${escape(item.kind === 'bearer' ? 'Bearer token' : item.name)}</code><span class="${item.set ? 'is-set' : 'is-unset'}">${item.set ? 'Set' : 'Not set'}</span><button type="button" class="ghost-button" data-mcp-secret-remove data-kind="${escape(item.kind)}" data-name="${escape(item.name)}">Remove</button></li>`).join('');
    const disabled = view.available ? '' : 'disabled';
    return `<section class="mcp-secrets" aria-labelledby="mcp-secrets-title"><h3 id="mcp-secrets-title">Secrets</h3>
      <p class="settings-description">${http ? 'Headers and a bearer token sent only to this address' : 'Environment variables such as API keys'}, kept in this computer's protected storage. Their values are never shown again.</p>
      ${view.available ? '' : `<p class="settings-description is-error">${escape(view.reason || 'Protected storage is unavailable.')}</p>`}
      ${rows ? `<ul class="mcp-secret-list">${rows}</ul>` : ''}
      <div class="mcp-secret-add">${http ? `<select data-mcp-secret-kind aria-label="Secret type" ${disabled}><option value="header">Header</option><option value="bearer">Bearer token</option></select>` : ''}
        <input data-mcp-secret-name aria-label="${http ? 'Header name' : 'Variable name'}" placeholder="${http ? 'X-Api-Key' : 'API_KEY'}" autocomplete="off" spellcheck="false" ${disabled} />
        <input data-mcp-secret-value type="password" aria-label="Value" placeholder="Value" autocomplete="new-password" ${disabled} />
        <button type="button" class="ghost-button" data-mcp-secret-save ${disabled}>Save secret</button></div>
      <span role="status" aria-live="polite" class="settings-save-status" data-mcp-secret-status></span></section>`;
  }
  function loadMcpSecrets(id) {
    if (!data.mcpSecrets || mcpSecretsRequest) return;
    mcpSecretsRequest = data.mcpSecrets(id).then(view => { mcpSecretsView = { id, data: view }; })
      .catch(error => { mcpSecretsView = { id, data: { error: error.message || 'Could not read the secrets.' } }; })
      .finally(() => { mcpSecretsRequest = undefined; if (active && page === `mcp/${id}`) render(); });
  }
  /** The server's discovered tools as "offered to agents" checkboxes (its disabledTools). */
  function mcpToolChoices(server, binding) {
    if (!server) return '';
    const tools = (mcpSnapshot?.tools || []).filter(tool => tool.bindingId === binding?.id);
    const disabled = new Set(server.disabledTools || []);
    const only = server.enabledTools ? `<p class="settings-description">Only these tools are offered (imported): ${server.enabledTools.map(name => `<code>${escape(name)}</code>`).join(', ')}. <button type="button" class="ghost-button" data-mcp-action="clear-enabled-tools">Offer all</button></p>` : '';
    const list = tools.length
      ? `<div class="mcp-tool-choices">${tools.map(tool => `<label title="${escape(tool.description || '')}"><input type="checkbox" data-mcp-tool="${escape(tool.name)}" ${disabled.has(tool.name) ? '' : 'checked'} /> <code>${escape(tool.name)}</code></label>`).join('')}</div>`
      : `<p class="settings-description">${disabled.size ? `Not offered: ${[...disabled].map(name => `<code>${escape(name)}</code>`).join(', ')}. ` : ''}Connect the server to choose its tools.</p>`;
    return `<div class="settings-row"><div><label>Tools offered to agents</label><p>Unchecked tools are hidden from agents; the server keeps running.</p></div><div class="settings-control">${only}${list}</div></div>`;
  }
  function mcpEditor(id) {
    const isNew = id === 'new';
    const server = isNew ? undefined : externalMcpServers()[id];
    if (!isNew && !server) return note('MCP server not found', 'It may have been removed in another settings window.');
    const binding = server && externalMcpBindings(server.id)[0];
    const transport = server?.transport || 'streamable-http';
    const http = transport === 'streamable-http';
    const endpoint = server?.transport === 'streamable-http' ? server.endpoint : '';
    const command = server?.transport === 'stdio' ? server.command : '';
    const args = server?.transport === 'stdio' && server.args?.length ? JSON.stringify(server.args) : '';
    const env = server?.transport === 'stdio' && server.env && Object.keys(server.env).length ? JSON.stringify(server.env) : '';
    const connection = externalMcpStatus(server?.id)[0];
    const state = server ? externalMcpState(server) : '';
    return `<p class="settings-description">${isNew ? 'Add a server configuration. Saving an enabled server connects it and discovers its tools.' : 'Edit this server or reconnect it. Tools become available to agents only after the connection is successful.'}</p>
      ${!isNew ? `<div class="settings-connection-status ${connection?.state === 'connected' ? 'is-connected' : ''}"><strong>${escape(state)}</strong><small>${connection?.error?.message ? escape(connection.error.message) : server?.approval === 'trust' ? 'Calls run without confirmation.' : server?.approval === 'read-only' ? 'Read-only tools run without confirmation.' : 'Every call asks for confirmation.'}</small></div>` : ''}
      ${connection?.diagnostic ? `<details class="mcp-diagnostic" open><summary>What the server reported</summary><pre>${escape(connection.diagnostic)}</pre></details>` : ''}
      ${connection?.skippedTools?.length ? `<p class="settings-description mcp-skipped">Left out because their input schema cannot be used: ${connection.skippedTools.map(name => `<code>${escape(name)}</code>`).join(', ')}. The server's other tools work.</p>` : ''}
      <form id="external-mcp-form" class="settings-form" data-mcp-server-id="${escape(id)}"><div class="settings-rows">
        <div class="settings-row"><div><label for="external-mcp-name">Name</label><p>Shown in Settings and in approval prompts.</p></div><div class="settings-control"><input id="external-mcp-name" data-mcp-field="name" maxlength="256" required value="${escape(server?.name || '')}" placeholder="e.g. My tools server" /></div></div>
        <div class="settings-row"><div><label for="external-mcp-transport">Transport</label><p>Match the server's MCP transport.</p></div><div class="settings-control"><select id="external-mcp-transport" data-mcp-field="transport"><option value="streamable-http" ${http ? 'selected' : ''}>Streamable HTTP</option><option value="stdio" ${http ? '' : 'selected'}>stdio command</option></select></div></div>
        <div class="settings-row" data-mcp-http ${http ? '' : 'hidden'}><div><label for="external-mcp-endpoint">MCP endpoint</label><p>Enter the MCP URL provided by your server or integration.</p></div><div class="settings-control"><input id="external-mcp-endpoint" data-mcp-field="endpoint" type="url" required ${http ? '' : 'disabled'} value="${escape(endpoint)}" placeholder="http://localhost:8000/mcp" /></div></div>
        <div class="settings-row" data-mcp-http ${http ? '' : 'hidden'}><div><label for="external-mcp-headers">Headers (JSON object)</label><p>Optional headers that are not secret. Put tokens and keys in Secrets below.</p></div><div class="settings-control"><textarea id="external-mcp-headers" data-mcp-field="headers" rows="2" ${http ? '' : 'disabled'} placeholder='{"X-Region":"us-east-1"}'>${escape(server?.transport === 'streamable-http' && server.headers && Object.keys(server.headers).length ? JSON.stringify(server.headers) : '')}</textarea></div></div>
        <div class="settings-row" data-mcp-stdio ${http ? 'hidden' : ''}><div><label for="external-mcp-command">Command</label><p>Executable used to start the local MCP server, such as uvx or npx. It is looked up as in your terminal; a full path also works.</p></div><div class="settings-control"><input id="external-mcp-command" data-mcp-field="command" required ${http ? 'disabled' : ''} value="${escape(command)}" placeholder="npx" /></div></div>
        <div class="settings-row" data-mcp-stdio ${http ? 'hidden' : ''}><div><label for="external-mcp-args">Arguments (JSON array)</label><p>For example: ["-y", "your-mcp-server"]. Do not put credentials here.</p></div><div class="settings-control"><textarea id="external-mcp-args" data-mcp-field="args" rows="3" ${http ? 'disabled' : ''} placeholder='["-y", "your-mcp-server"]'>${escape(args)}</textarea></div></div>
        <div class="settings-row" data-mcp-stdio ${http ? 'hidden' : ''}><div><label for="external-mcp-cwd">Working directory</label><p>Optional absolute path used only when starting the command.</p></div><div class="settings-control"><input id="external-mcp-cwd" data-mcp-field="cwd" ${http ? 'disabled' : ''} value="${escape(server?.transport === 'stdio' ? server.cwd || '' : '')}" /></div></div>
        <div class="settings-row" data-mcp-stdio ${http ? 'hidden' : ''}><div><label for="external-mcp-env">Environment (JSON object)</label><p>Optional variables that are not secret. Put API keys in Secrets below.</p></div><div class="settings-control"><textarea id="external-mcp-env" data-mcp-field="env" rows="3" ${http ? 'disabled' : ''} placeholder='{"LOG_LEVEL":"info"}'>${escape(env)}</textarea></div></div>
        <div class="settings-row"><div><label for="external-mcp-startup">Startup timeout (seconds)</label><p>How long the server may take to start. A first uvx or npx run downloads packages.</p></div><div class="settings-control"><input id="external-mcp-startup" data-mcp-field="startupSeconds" type="number" min="1" max="600" step="1" inputmode="numeric" value="${server?.connectTimeoutMs ? escape(String(Math.round(server.connectTimeoutMs / 1000))) : ''}" placeholder="${http ? 15 : 60}" /></div></div>
        <div class="settings-row"><div><label for="external-mcp-tool-timeout">Tool timeout (seconds)</label><p>How long a call may go without an answer or progress. A call that reports progress (a render, a build) may run up to 30 minutes.</p></div><div class="settings-control"><input id="external-mcp-tool-timeout" data-mcp-field="toolSeconds" type="number" min="1" max="3600" step="1" inputmode="numeric" value="${server?.requestTimeoutMs ? escape(String(Math.round(server.requestTimeoutMs / 1000))) : ''}" placeholder="60" /></div></div>
        ${mcpToolChoices(server, binding)}
        <div class="settings-row"><div><label for="external-mcp-approval">Approval</label><p>When a tool call waits for your confirmation. A chat set to ask first always asks.</p></div><div class="settings-control"><select id="external-mcp-approval" data-mcp-field="approval">${[['ask', 'Ask for every call'], ['read-only', 'Ask unless the tool is read-only'], ['trust', 'Trust this server (never ask)']].map(([value, label]) => `<option value="${value}" ${(server?.approval || 'ask') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div></div>
        <div class="settings-row"><div><label for="external-mcp-enabled">Enabled</label><p>When on, the app connects and discovers tools. Turning it off stops all bindings for this server.</p></div><div class="settings-control"><input id="external-mcp-enabled" data-mcp-field="enabled" type="checkbox" role="switch" ${server?.enabled !== false ? 'checked' : ''} /></div></div>
      </div><div class="settings-form-footer"><span role="status" aria-live="polite" class="settings-save-status" data-mcp-status>${isNew ? 'Add a server to begin.' : 'Changes apply to this server and its connections.'}</span><span class="settings-form-actions"><button type="submit" class="primary-button">${isNew ? 'Add & connect' : 'Save changes'}</button>${!isNew ? `<button type="button" class="ghost-button" data-mcp-action="${connection?.state === 'connected' ? 'disconnect' : 'connect'}" data-mcp-binding="${escape(binding?.id || '')}" ${binding ? '' : 'disabled'}>${connection?.state === 'connected' ? 'Disconnect' : 'Connect'}</button><button type="button" class="ghost-button danger-button" data-mcp-action="delete">Remove</button>` : ''}</span></div></form>
      ${!isNew ? mcpSecretsSection(server) : ''}`;
  }
  function blockedPage(blocked) {
    const actions = blocked.actions.map(action => action === 'use-local'
      ? '<button type="button" class="primary-button" data-server-action="use-local">Use This computer</button>'
      : '<button type="button" class="ghost-button" data-server-action="retry">Try again</button>').join('');
    return `<div class="settings-empty" role="status"><span class="settings-empty-icon">${icon('info')}</span><h2>${escape(blocked.title)}</h2>${blocked.text ? `<p>${escape(blocked.text)}</p>` : ''}${actions ? `<div class="settings-empty-actions">${actions}</div>` : ''}</div>`;
  }
  function content() {
    const [name, id] = page.split('/');
    const server = serverFor(page), blocked = server?.page(page).blocked;
    if (blocked) return blockedPage(blocked);
    const specs = fieldsFor(page);
    const result = results.get(placeOf(page).key);
    const testResult = result ? `<div class="settings-test-result ${result.ok ? 'is-success' : 'is-error'}" role="status"><div class="settings-test-heading">${icon(result.ok ? 'check' : 'shieldAlert')}<strong>${result.ok ? 'Test succeeded' : 'Test failed'}</strong></div>${result.ok && name === 'providers' ? '<div class="settings-connection-status">Provider connected <small>Verified by the last test</small></div>' : ''}<p>${escape(result.message)}</p>${result.model ? `<small>Model: ${escape(result.model)}</small>` : ''}</div>` : '';
    if (name === 'voice') return '<div data-voice-settings-page></div>';
    if (name === 'profile') return profileEditor();
    if (name === 'account') return `<div data-account-page>${accountPanel()}</div>`;
    if (name === 'usage') return '<div data-usage-page></div>';
    if (name === 'report-bug') return '<div data-report-bug-page></div>';
    if (name === 'notifications') return note('Status stays in the app', 'Task progress, errors and approval requests appear in the existing chat and workflow views. Configurable desktop notifications are not available in this release.');
    if (name === 'connections') return '<div data-integrations-page></div>';
    if (name === 'agents') return `<p class="settings-description">A turn is a model decision: it either requests one tool action or writes the final answer. The existing values stay unchanged. Enter 0 to remove a limit; there is no hidden upper ceiling.</p>` + form(specs) + `<a class="settings-list-row" href="#/chat"><span>Open chat setup</span>${icon('chevronRight')}</a><a class="settings-list-row" href="#/orchestration"><span>Open Workflow</span>${icon('chevronRight')}</a>`;
    if (name === 'shortcuts') return `<div class="settings-rows">${[['Open Settings', navigator.platform.includes('Mac') ? '⌘ ,' : 'Ctrl ,'], ['Close profile menu', 'Escape'], ['Move through profile menu', '↑ / ↓ · Home / End'], ['Send chat message', 'Enter'], ['New line', 'Shift Enter'], ['Stop active chat generation (in app)', 'Escape']].map(([label, value]) => `<div class="settings-row"><span>${label}</span><kbd>${value}</kbd></div>`).join('')}</div><p class="settings-footnote">Shortcut customization is not available in this release.</p>`;
    if (name === 'about') return `<div class="settings-rows">${[['Application', appInfo?.name || 'Local Cognitive AI System'], ['Version', appInfo?.version || 'Loading…'], ['Platform', appInfo?.platform || 'Browser'], ['Electron', appInfo?.electron], ['Application license', appInfo?.license || 'Not declared in application metadata'], ['Selected server', context().server && [context().server.hostName(), context().server.version()].filter(Boolean).join(' · ')]].filter(([, value]) => value).map(([label, value]) => `<div class="settings-row"><span>${escape(label)}</span><span>${escape(value)}</span></div>`).join('')}</div><p class="settings-footnote">Third-party runtime notices are included with the desktop application.</p>${link('report-bug', 'Report a bug', 'Tell the developer what went wrong')}`;
    if (name === 'data' && server) return serverErrorReportsRow(server) + form(specs);
    if (name === 'data') return `<p class="settings-description">Chats, configuration, memory and downloaded models are stored locally. External providers and integrations receive the requests you send to them. Account tokens use protected desktop storage.</p>${errorReportsRow()}<button type="button" class="ghost-button" data-open-data ${window.desktopApp ? '' : 'disabled'}>Open data folder</button><p class="settings-footnote">${window.desktopApp ? 'Opens the actual application data folder in Finder.' : 'Opening the data folder is available in the desktop app.'}</p><div role="status" data-folder-status></div>` + form(specs);
    if (name === 'plugins') return '<div data-integrations-page></div>';
    if (name === 'providers' && !id) return form(specs) + `<div class="settings-list">${Object.entries(settings().providers || {}).map(([key, provider]) => link(`providers/${key}`, providerNames[key] || key, provider.enabled ? 'Enabled · connection not checked' : 'Disabled')).join('')}</div>`;
    if (name === 'providers' && id) return specs.length ? `<p class="settings-description">${id === 'llamacpp' ? server ? `Built-in inference on ${escape(server.hostName())}. Load and use its models from Models.` : 'Built-in inference on this device. No API key or server address is required.' : 'Configure this provider and explicitly test its selected model.'}</p>` + form(specs) + (server && id === 'llamacpp' ? '' : `<div class="settings-test-actions"><button type="button" class="ghost-button" data-test="provider" ${statuses.get(placeOf(page).key)?.busy ? 'disabled' : ''}>Save & test provider</button></div>`) + testResult + (id === 'llamacpp' ? link('runtime', 'Local Runtime', 'Storage, context and timeouts') : '') : note('Provider not found', 'Return to Models & Providers.');
    if (name === 'runtime') {
      const generation = specs.find(spec => spec.type === 'local-generation');
      const runtimeSpecs = specs.filter(spec => spec !== generation);
      return `<div class="settings-runtime-overview"><div class="settings-row"><span>Runtime status</span><span>${escape((server ? server.runtimeStatus() : context().localModels?.runtime?.status) || 'Unavailable')}</span></div><a class="settings-list-row" href="#/models"><span>Manage model library</span>${icon('chevronRight')}</a></div>` + form(runtimeSpecs, '', generation ? renderGenerationControl() : '');
    }
    if (name === 'memory') return form(specs) + (!id ? link('memory/advanced', 'Advanced memory', 'Partition, chunk and adapter parameters') : '');
    if (name === 'mcp' && !id) {
      return `<div class="mcp-overview"><div class="mcp-overview-meta"><span>Model Context Protocol</span><span>${mcpServerCount(clientSettings())} configured server${mcpServerCount(clientSettings()) === 1 ? '' : 's'}</span></div>
        <aside class="mcp-info" aria-labelledby="mcp-info-title"><span class="mcp-info-icon">${icon('workflow')}</span><div><h2 id="mcp-info-title">Tools for your agents</h2><p>Connect local or remote MCP servers to make their tools available in chats and workflows.</p><small>You'll approve each tool call before it runs.</small></div></aside>`
        + externalMcpList()
        + `<section class="mcp-card" aria-labelledby="mcp-builtin-title"><div class="mcp-card-heading"><div><h2 id="mcp-builtin-title">Built-in server</h2><p>Share Local Cognitive tools with other AI apps.</p></div><span class="mcp-badge">Included</span></div><div class="mcp-server-list">`
        + link('mcp/local-cognitive', 'Local Cognitive MCP server', `stdio · ${clientSettings().mcp?.server?.enabled ? 'Enabled · Starts on demand' : 'Disabled'}`)
        + '</div></section></div>';
    }
    if (name === 'mcp' && id === 'local-cognitive') return `<p class="settings-description">Incoming MCP server for Local Cognitive. Other applications connect to this runtime over stdio; these controls do not manage outgoing connections.</p>` + form(specs, '<div class="settings-row"><span>Transport</span><span>stdio</span></div>') + `<p class="settings-footnote">Changes apply when the stdio server is next started.</p><pre class="config-snippet">npm run --silent mcp:stdio</pre>`;
    if (name === 'mcp' && id === 'import') return mcpImportPage();
    if (name === 'mcp' && id) return mcpEditor(id);
    if (name === 'appearance') return `<section class="appearance-section"><div class="appearance-section-heading"><div><h2>Visual style</h2><p>Set a consistent app theme, then refine its colors if you want a personal palette.</p></div><button type="button" class="ghost-button" data-reset-appearance>Reset colors</button></div>${form(specs)}</section>`;
    if (specs.length) return form(specs);
    return note('Page not found', 'Choose a page from the Settings navigation.');
  }
  function searchEntries() {
    const routes = groups.flatMap(([, items]) => items.map(([route]) => route));
    routes.push(...Object.keys(settingsOf('providers').providers || {}).map(id => `providers/${id}`), ...data.integrations.map(item => `plugins/${item.id}`), 'memory/advanced', 'mcp/local-cognitive');
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
  /** What the open page shows about machines: a new one means the page is rendered again. */
  function targetSignature() {
    const selected = context().server, server = serverFor(page);
    return [selected?.key ?? '', server ? [server.online(), server.loaded(), server.error(), server.unsupported()].join() : ''].join('|');
  }
  function targetNote(server) {
    const selected = context().server;
    if (!selected) return '';
    let text;
    if (server && server.loaded() && !server.online()) text = `${server.hostName()} is not connected. These are its last known settings; nothing can be saved until it reconnects.`;
    else if (server) text = server.page(page).note;
    else text = `These settings are kept on this device. ${selected.hostName()} has its own.`;
    return text ? `<p class="settings-target-note" role="note">${icon('info')}<span>${escape(text)}</span></p>` : '';
  }
  function render() {
    disposeVoice?.(); disposeVoice = undefined;
    disposeIntegrations?.(); disposeIntegrations = undefined;
    disposeUsage?.(); disposeUsage = undefined;
    disposeReport?.(); disposeReport = undefined;
    const [name, id] = page.split('/');
    const server = serverFor(page);
    server?.ensureLoaded();
    shownTarget = targetSignature();
    const selected = context().server;
    // Pages that show the selected server are marked with its name.
    const scope = route => selected && (HOST_PAGES.has(route) || DEFER_PAGES.has(route)) ? `<span class="settings-nav-scope" title="${escape(`Shows ${selected.hostName()}`)}">${escape(selected.hostName())}</span>` : '';
    const parent = ['account', 'usage'].includes(name) ? 'profile' : id ? name : ['connections', 'mcp'].includes(name) ? 'plugins' : null;
    root.innerHTML = `<div class="settings-shell"><aside class="settings-sidebar liquid-glass"><a class="settings-back" href="${escape(previousRoute)}">${icon('chevronLeft')}<span>Back to app</span></a><div class="settings-search">${icon('search')}<input id="settings-search" type="search" placeholder="Search settings" aria-label="Search settings" value="${escape(search)}" /></div><div class="settings-search-results" hidden></div><nav class="settings-groups" aria-label="Settings navigation">${groups.map(([group, items]) => `<div class="settings-group"><h2>${group}</h2>${items.map(([route, label, symbol]) => `<a href="#/settings/${route}" class="settings-nav-row ${route === name ? 'active' : ''}" ${route === name ? 'aria-current="page"' : ''}>${icon(symbol)}<span>${label}</span>${scope(route)}</a>`).join('')}</div>`).join('')}</nav></aside><main class="settings-content"><div class="settings-content-inner">${parent ? `<a class="settings-parent" href="#/settings/${parent}" aria-label="Back to ${escape(titleFor(parent))}">${icon('chevronLeft')}<span>${escape(titleFor(parent))}</span></a>` : ''}<h1 tabindex="-1">${escape(titleFor(page))}</h1>${targetNote(server)}${content()}</div></main></div>`;
    root.querySelector('#settings-search').addEventListener('input', event => { search = event.target.value; renderSearch(); });
    renderSearch(); bindForm(); bindGlassLighting(root);
    root.querySelectorAll('[data-server-action]').forEach(button => button.addEventListener('click', () => {
      if (button.dataset.serverAction === 'use-local') void context().useThisComputer?.();
      else if (server?.online()) void server.reload();
      else void server?.reconnect();
    }));
    if (server && server.loaded() && !server.online()) {
      // The last known values stay readable; nothing on the page can be sent.
      root.querySelector('.settings-content').classList.add('is-offline');
      root.querySelectorAll('.settings-content-inner :is(form, .settings-test-actions) :is(input, select, textarea, button)').forEach(control => { control.disabled = true; });
    }
    if (name === 'data' && server) bindServerErrorReports(server);
    if (server) return;
    if (name === 'profile') bindProfileForm();
    if (name === 'account') bindAccountPage();
    if (name === 'usage') disposeUsage = mountUsagePage(root.querySelector('[data-usage-page]'));
    if (name === 'report-bug') disposeReport = mountReportBugPage(root.querySelector('[data-report-bug-page]'), { mode: context().server ? 'remote' : 'local' });
    if (name === 'mcp' && id === 'import') bindMcpImport();
    else if (name === 'mcp' && id && id !== 'local-cognitive') bindMcpEditor();
    if (page === 'voice') disposeVoice = voiceInput?.mountSettings(root.querySelector('[data-voice-settings-page]'));
    if (name === 'plugins' || name === 'connections') disposeIntegrations = mountIntegrationPage(root.querySelector('[data-integrations-page]'), { pluginId: id, connectionsPage: name === 'connections', mcpCount: mcpServerCount(clientSettings()) });
    root.querySelector('[data-open-data]')?.addEventListener('click', openDataFolder);
    if (name === 'data') bindErrorReports();
    if (name === 'mcp') loadMcpSnapshot();
    if (page === 'about' && !appInfo) void (window.desktopApp?.getInfo?.() || fetch('/app/info').then(response => response.json())).then(info => { appInfo = info; if (active && page === 'about') render(); }).catch(() => { appInfo = { version: 'Unavailable' }; if (active && page === 'about') render(); });
  }
  function setStatus(key, value) {
    statuses.set(key, value);
    if (!active || placeOf(page).key !== key) return;
    const slot = root.querySelector('.settings-save-status');
    if (slot) { slot.textContent = value.text; slot.classList.toggle('is-error', Boolean(value.error)); slot.classList.toggle('is-success', Boolean(value.success)); }
    // A server page that went offline stays disabled whatever the save's outcome.
    const server = serverFor(page), offline = Boolean(server?.loaded() && !server.online());
    root.querySelectorAll('button[type="submit"], [data-test]').forEach(button => { button.disabled = Boolean(value.busy) || offline; });
    const retry = root.querySelector('[data-retry]'); if (retry) retry.hidden = !value.error;
  }
  async function save({ key, store }) {
    const draft = dirty(key), snapshot = { ...draft };
    // Pressing Save always answers, also when there was nothing to change.
    if (!Object.keys(snapshot).length) { setStatus(key, { text: 'All changes are saved.', success: true }); return true; }
    setStatus(key, { text: 'Saving…', busy: true });
    try {
      await store.save(entityPatch(snapshot));
      for (const [name, value] of Object.entries(snapshot)) if (draft[name] === value) delete draft[name];
      setStatus(key, Object.keys(draft).length ? { text: 'Unsaved changes' } : { text: 'Saved. The changes apply now.', success: true });
      return true;
    } catch (error) {
      // The server may have made a change whose answer was lost: say so rather than "Not saved".
      setStatus(key, { text: error.code === 'unknown_outcome' ? error.message : `Not saved. ${error.message}`, error: true });
      return false;
    }
  }
  function setMcpFormStatus(form, text, error = false) {
    const slot = form?.querySelector('[data-mcp-status]');
    if (!slot) return;
    slot.textContent = text;
    slot.classList.toggle('is-error', error);
    slot.classList.toggle('is-success', !error && /connected|saved|removed/i.test(text));
  }
  function toggleMcpTransport(form) {
    const http = form.querySelector('[data-mcp-field="transport"]').value === 'streamable-http';
    form.querySelectorAll('[data-mcp-http]').forEach(row => { row.hidden = !http; row.querySelectorAll('input,textarea').forEach(input => { input.disabled = !http; }); });
    form.querySelectorAll('[data-mcp-stdio]').forEach(row => { row.hidden = http; row.querySelectorAll('input,textarea').forEach(input => { input.disabled = http; }); });
  }
  function uniqueMcpBindingId(serverId) {
    const bindings = clientSettings().mcp?.client?.bindings || {};
    let id = serverId, suffix = 2;
    while (Object.hasOwn(bindings, id)) id = `${serverId.slice(0, 120)}-${suffix++}`;
    return id;
  }
  async function saveMcpServer(form) {
    const sourceId = form.dataset.mcpServerId, isNew = sourceId === 'new';
    const previous = isNew ? undefined : externalMcpServers()[sourceId];
    const name = form.querySelector('[data-mcp-field="name"]').value.trim();
    const transport = form.querySelector('[data-mcp-field="transport"]').value;
    const enabled = form.querySelector('[data-mcp-field="enabled"]').checked;
    if (!name) throw new Error('Enter a name for this MCP server.');
    const id = previous?.id || newMcpId(name);
    const approval = form.querySelector('[data-mcp-field="approval"]').value;
    const seconds = (field, max) => {
      const raw = form.querySelector(`[data-mcp-field="${field}"]`)?.value.trim();
      if (!raw) return undefined;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Enter a whole number of seconds from 1 to ${max}.`);
      return value * 1000;
    };
    const startup = seconds('startupSeconds', 600), toolTimeout = seconds('toolSeconds', 3600);
    const toolBoxes = [...form.querySelectorAll('[data-mcp-tool]')];
    const server = { ...(previous || {}), id, name, enabled, transport };
    // Saving merges into the stored server: a field it had and the form cleared is sent as null (removed).
    const clear = field => { if (previous?.[field] !== undefined) server[field] = null; else delete server[field]; };
    if (approval === 'ask') clear('approval'); else server.approval = approval;
    if (startup) server.connectTimeoutMs = startup; else clear('connectTimeoutMs');
    if (toolTimeout) server.requestTimeoutMs = toolTimeout; else clear('requestTimeoutMs');
    // Only when the list was shown (a connected server): otherwise the stored choice stays.
    if (toolBoxes.length) {
      const unchecked = toolBoxes.filter(box => !box.checked).map(box => box.dataset.mcpTool);
      if (unchecked.length) server.disabledTools = unchecked; else clear('disabledTools');
    }
    if (transport === 'streamable-http') {
      const endpoint = form.querySelector('[data-mcp-field="endpoint"]').value.trim();
      if (!endpoint) throw new Error('Enter an MCP endpoint.');
      Object.assign(server, { endpoint });
      const rawHeaders = form.querySelector('[data-mcp-field="headers"]')?.value.trim();
      let headers;
      if (rawHeaders) { try { headers = JSON.parse(rawHeaders); } catch { throw new Error('Headers must be valid JSON.'); } }
      if (headers !== undefined && (!headers || Array.isArray(headers) || Object.values(headers).some(value => typeof value !== 'string'))) throw new Error('Headers must be a JSON object with string values.');
      if (headers && Object.keys(headers).length) server.headers = headers; else clear('headers');
      // The stdio fields of a server switched to HTTP are dropped when it is saved.
      delete server.command; delete server.args; delete server.cwd; delete server.env;
    } else {
      const command = form.querySelector('[data-mcp-field="command"]').value.trim();
      if (!command) throw new Error('Enter the command used to start the MCP server.');
      const parseJson = (field, fallback, description) => {
        const raw = form.querySelector(`[data-mcp-field="${field}"]`).value.trim();
        if (!raw) return fallback;
        try { return JSON.parse(raw); } catch { throw new Error(`${description} must be valid JSON.`); }
      };
      const args = parseJson('args', undefined, 'Arguments');
      const env = parseJson('env', undefined, 'Environment');
      if (args !== undefined && (!Array.isArray(args) || args.some(value => typeof value !== 'string'))) throw new Error('Arguments must be a JSON array of strings.');
      if (env !== undefined && (!env || Array.isArray(env) || Object.values(env).some(value => typeof value !== 'string'))) throw new Error('Environment must be a JSON object with string values.');
      Object.assign(server, { command });
      if (args === undefined) clear('args'); else server.args = args;
      if (env === undefined) clear('env'); else server.env = env;
      const cwd = form.querySelector('[data-mcp-field="cwd"]').value.trim();
      if (cwd) server.cwd = cwd; else clear('cwd');
      delete server.endpoint;
    }
    const related = previous ? externalMcpBindings(previous.id) : [];
    const bindings = related.length
      ? Object.fromEntries(related.map(binding => [binding.id, { enabled }]))
      : { [uniqueMcpBindingId(id)]: { id: uniqueMcpBindingId(id), serverId: id, enabled } };
    setMcpFormStatus(form, 'Saving and connecting…');
    await data.save({ mcp: { client: { servers: { [id]: server }, bindings } } });
    mcpSnapshot = undefined; mcpRequest = undefined; mcpSecretsView = undefined;
    setMcpFormStatus(form, enabled ? 'Saved. Connecting…' : 'Saved. Server is disabled.');
    if (isNew) location.hash = `#/settings/mcp/${id}`;
    else render();
  }
  function bindMcpEditor() {
    const form = root.querySelector('#external-mcp-form');
    if (!form) return;
    form.querySelector('[data-mcp-field="transport"]')?.addEventListener('change', () => toggleMcpTransport(form));
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      void saveMcpServer(form).catch(error => setMcpFormStatus(form, error.message || 'Could not save MCP server.', true));
    });
    form.querySelector('[data-mcp-action="delete"]')?.addEventListener('click', () => {
      const id = form.dataset.mcpServerId;
      if (!id || !window.confirm(`Remove ${externalMcpServers()[id]?.name || id}? Its saved connections will also be removed.`)) return;
      setMcpFormStatus(form, 'Removing…');
      void data.save({ mcp: { client: { servers: { [id]: null } } } }).then(() => {
        mcpSnapshot = undefined; mcpRequest = undefined; location.hash = '#/settings/mcp';
      }).catch(error => setMcpFormStatus(form, error.message || 'Could not remove MCP server.', true));
    });
    const secrets = root.querySelector('.mcp-secrets');
    const secretStatus = (text, error = false) => { const slot = secrets?.querySelector('[data-mcp-secret-status]'); if (slot) { slot.textContent = text; slot.classList.toggle('is-error', error); } };
    const serverId = form.dataset.mcpServerId;
    const kindSelect = secrets?.querySelector('[data-mcp-secret-kind]');
    kindSelect?.addEventListener('change', () => { const name = secrets.querySelector('[data-mcp-secret-name]'); name.hidden = kindSelect.value === 'bearer'; });
    secrets?.querySelector('[data-mcp-secret-save]')?.addEventListener('click', event => {
      const kind = kindSelect?.value || 'env', nameInput = secrets.querySelector('[data-mcp-secret-name]'), valueInput = secrets.querySelector('[data-mcp-secret-value]');
      const name = nameInput.value.trim(), value = valueInput.value;
      if (kind !== 'bearer' && !name) { secretStatus('Enter a name.', true); return; }
      if (!value) { secretStatus('Enter the value.', true); return; }
      event.currentTarget.disabled = true; secretStatus('Saving…');
      void data.setMcpSecret(serverId, { kind, ...(kind === 'bearer' ? {} : { name }), value }).then(view => {
        valueInput.value = ''; mcpSecretsView = { id: serverId, data: view }; mcpSnapshot = undefined; mcpRequest = undefined; render();
      }).catch(error => { event.currentTarget.disabled = false; secretStatus(error.message || 'Could not save the secret.', true); });
    });
    secrets?.querySelectorAll('[data-mcp-secret-remove]').forEach(button => button.addEventListener('click', () => {
      button.disabled = true; secretStatus('Removing…');
      void data.removeMcpSecret(serverId, button.dataset.kind, button.dataset.name).then(view => {
        mcpSecretsView = { id: serverId, data: view }; mcpSnapshot = undefined; mcpRequest = undefined; render();
      }).catch(error => { button.disabled = false; secretStatus(error.message || 'Could not remove the secret.', true); });
    }));
    form.querySelector('[data-mcp-action="clear-enabled-tools"]')?.addEventListener('click', () => {
      const id = form.dataset.mcpServerId;
      setMcpFormStatus(form, 'Saving…');
      void data.save({ mcp: { client: { servers: { [id]: { enabledTools: null } } } } }).then(() => {
        mcpSnapshot = undefined; mcpRequest = undefined; render();
      }).catch(error => setMcpFormStatus(form, error.message || 'Could not save MCP server.', true));
    });
    form.querySelector('[data-mcp-action="connect"], [data-mcp-action="disconnect"]')?.addEventListener('click', event => {
      const button = event.currentTarget, bindingId = button.dataset.mcpBinding;
      if (!bindingId) return;
      button.disabled = true; setMcpFormStatus(form, button.dataset.mcpAction === 'connect' ? 'Connecting…' : 'Disconnecting…');
      const request = button.dataset.mcpAction === 'connect' ? data.connectMcp(bindingId) : data.disconnectMcp(bindingId);
      void request.then(() => {
        mcpSnapshot = undefined; mcpRequest = undefined; render();
      }).catch(error => { button.disabled = false; setMcpFormStatus(form, error.message || 'MCP connection failed.', true); });
    });
  }
  function loadMcpSnapshot() {
    if (!data.loadMcp || mcpSnapshot || mcpRequest) return;
    mcpRequest = data.loadMcp().then(snapshot => { mcpSnapshot = snapshot; }).catch(error => {
      mcpSnapshot = { connections: [], tools: [], error: error.message || 'Could not check MCP connections.' };
    }).finally(() => { mcpRequest = undefined; if (active && page.startsWith('mcp')) render(); });
  }
  function bindForm() {
    const current = page, place = placeOf(page), key = place.key, specs = fieldsFor(page), element = root.querySelector('#settings-entity-form');
    const preference = specs.length && specs.every(spec => spec.name.startsWith('ui.'));
    element?.addEventListener('input', event => {
      const generationField = event.target?.dataset?.generationField;
      if (generationField) {
        const previous = generationValue();
        const base = previous.preset === 'custom'
          ? previous
          : { ...(generationPresets[previous.preset] || generationPresets.balanced) };
        const raw = event.target.value;
        const next = { ...base, preset: 'custom' };
        if (raw === '') delete next[generationField];
        else next[generationField] = Number(raw);
        dirty(key)['localModels.generation'] = next;
        results.delete(key);
        if (!statuses.get(key)?.busy) setStatus(key, { text: 'Unsaved changes' });
        return;
      }
      const spec = specs.find(spec => spec.name === event.target.name); if (!spec) return;
      const value = spec.name === 'localModels.gpuLayers' ? (/^\s*(auto)?\s*$/i.test(event.target.value) ? 'auto' : Number(event.target.value)) : spec.name === 'filesystem.allowedDirectories' ? event.target.value.split('\n').map(value => value.trim()).filter(Boolean) : spec.type === 'boolean' ? event.target.checked : ['number', 'font-scale', 'code-font-size'].includes(spec.type) ? Number(event.target.value) : event.target.value;
      if (spec.type === 'secret' && value === '') delete dirty(key)[spec.name]; else dirty(key)[spec.name] = value;
      results.delete(key);
      root.querySelector('.settings-test-result')?.remove();
      if (!statuses.get(key)?.busy) setStatus(key, { text: 'Unsaved changes' });
      if (spec.type === 'secret') root.querySelector(`[data-secret-state="${spec.name}"]`).textContent = value ? 'Replacement key entered.' : 'Blank input keeps the existing key.';
      if (spec.type === 'color') {
        const picker = root.querySelector(`[data-appearance-picker="${spec.name}"]`);
        if (isHexColor(value)) {
          if (picker) picker.value = value;
          applyPreferences(entityPatch({ [spec.name]: value }).ui);
        }
      }
      if (['font-scale', 'code-font-size'].includes(spec.type)) {
        const label = spec.type === 'font-scale' ? `${value}%` : `${value} px`;
        event.target.setAttribute('aria-valuetext', label);
        event.target.nextElementSibling.value = label;
        applyPreferences(entityPatch({ [spec.name]: value }).ui);
      }
    });
    root.querySelector('[data-generation-preset]')?.addEventListener('change', event => {
      const preset = event.target.value;
      if (!['server', 'precise', 'balanced', 'creative', 'custom'].includes(preset)) return;
      const previous = generationValue();
      const next = preset === 'custom'
        ? { ...(previous.preset === 'custom' ? previous : generationPresets[previous.preset] || generationPresets.balanced), preset: 'custom' }
        : { preset };
      dirty(key)['localModels.generation'] = next;
      results.delete(key);
      setStatus(key, { text: 'Unsaved changes' });
      const scroll = root.querySelector('.settings-content')?.scrollTop || 0;
      render();
      root.querySelector('.settings-content').scrollTop = scroll;
    });
    element?.addEventListener('change', event => {
      if (!preference) return;
      const spec = specs.find(spec => spec.name === event.target.name); if (!spec) return;
      if (spec.type === 'color' && (!event.target.reportValidity() || !isHexColor(event.target.value))) return;
      dirty(key)[spec.name] = spec.type === 'boolean' ? event.target.checked : ['font-scale', 'code-font-size'].includes(spec.type) ? Number(event.target.value) : event.target.value;
      applyPreferences(entityPatch(dirty(key)).ui || {});
      void save(place);
    });
    root.querySelectorAll('[data-appearance-picker]').forEach(picker => picker.addEventListener('input', () => {
      const input = element?.elements.namedItem(picker.dataset.appearancePicker);
      if (!input) return;
      input.value = picker.value.toUpperCase();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }));
    root.querySelectorAll('[data-appearance-theme]').forEach(button => button.addEventListener('click', () => {
      const theme = button.dataset.appearanceTheme;
      if (!Object.hasOwn(appearancePresets, theme) || statuses.get(key)?.busy) return;
      dirty(key)['ui.theme'] = theme;
      root.querySelectorAll('[data-appearance-theme]').forEach(choice => {
        const selected = choice.dataset.appearanceTheme === theme;
        choice.classList.toggle('is-selected', selected);
        choice.setAttribute('aria-pressed', String(selected));
      });
      for (const [fieldName, presetKey] of Object.entries(appearanceColorKey)) {
        const currentColor = Object.hasOwn(dirty(key), fieldName) ? dirty(key)[fieldName] : get(place.settings(), fieldName);
        if (isHexColor(currentColor)) continue;
        const color = appearancePresets[theme][presetKey];
        const input = element?.elements.namedItem(fieldName);
        const picker = root.querySelector(`[data-appearance-picker="${fieldName}"]`);
        if (input) input.value = color;
        if (picker) picker.value = color;
      }
      applyPreferences({ theme });
      void save(place);
    }));
    root.querySelector('[data-reset-appearance]')?.addEventListener('click', () => {
      const reset = Object.fromEntries(Object.keys(appearanceColorKey).map(key => [key, '']));
      Object.assign(dirty(key), reset);
      applyPreferences(entityPatch(reset).ui);
      void save(place).then(saved => { if (saved && active && placeOf(page).key === key) render(); });
    });
    element?.addEventListener('submit', event => { event.preventDefault(); if (element.reportValidity()) void save(place); });
    root.querySelectorAll('[data-clear]').forEach(button => button.addEventListener('click', () => {
      dirty(key)[button.dataset.clear] = '';
      const input = element.elements.namedItem(button.dataset.clear); input.value = '';
      root.querySelector(`[data-secret-state="${button.dataset.clear}"]`).textContent = 'Key will be removed on Apply.';
      setStatus(key, { text: 'Unsaved changes · key removal pending' });
      results.delete(key); root.querySelector('.settings-test-result')?.remove();
    }));
    root.querySelector('[data-directory]')?.addEventListener('click', async () => {
      try { const directory = await window.desktopModels.selectDirectory(); if (directory) { const input = element.elements.namedItem('localModels.modelsDir'); input.value = directory; input.dispatchEvent(new Event('input', { bubbles: true })); } }
      catch (error) { setStatus(key, { text: error.message, error: true }); }
    });
    root.querySelector('[data-test]')?.addEventListener('click', async event => {
      if (statuses.get(key)?.busy || !element.reportValidity()) return;
      const kind = event.currentTarget.dataset.test, id = current.split('/')[1];
      if (!await save(place)) return;
      // New edits during a save must be applied before testing their values.
      if (Object.keys(dirty(key)).length) { setStatus(key, { text: 'Apply the newer changes before testing.' }); return; }
      setStatus(key, { text: 'Testing…', busy: true });
      let result;
      const provider = place.settings().providers?.[id];
      try { result = await place.store.testProvider(id, provider?.model, provider?.timeoutMs); }
      catch (error) { result = { ok: false, message: error.message }; }
      if (!Object.keys(dirty(key)).length) results.set(key, result);
      const hasNewerEdits = Object.keys(dirty(key)).length > 0;
      setStatus(key, { text: hasNewerEdits ? 'Unsaved changes · test used the previous configuration' : result.ok ? 'Test succeeded' : 'Test failed', error: !result.ok, success: result.ok && !hasNewerEdits });
      if (active && placeOf(page).key === key) { const scroll = root.querySelector('.settings-content').scrollTop; render(); root.querySelector('.settings-content').scrollTop = scroll; }
    });
  }
  /** A server's error reports: its owner's choice, kept on the server (asked through Remote).
   * Hidden for a server too old to offer it. */
  const serverConsents = new Map();
  function serverErrorReportsRow(server) {
    const state = serverConsents.get(server.key);
    if (!state || state.unsupported) return '';
    const name = escape(server.hostName());
    const status = state.error ? `<span class="settings-save-status is-error" role="status">${escape(state.error)}</span>` : state.saved ? `<span class="settings-save-status is-success" role="status">Saved · ${state.automatic ? 'on' : 'off'}</span>` : '';
    return `<div class="settings-rows settings-consent"><div class="settings-row"><div><label for="server-error-reports">Send ${name}'s error reports</label><p>When the server fails, a report goes to the developer (Sentry, EU region): error types, codes, versions and system. Chats, prompts, model answers, keys, file contents and paths are not included. Only the server's owner can change this.</p></div><div class="settings-control settings-consent-control">${status}<input id="server-error-reports" data-server-error-reports type="checkbox" role="switch" ${state.automatic ? 'checked' : ''} ${state.loading || !state.available ? 'disabled' : ''} /></div></div></div>`;
  }
  function bindServerErrorReports(server) {
    const runtime = window.desktopRemote?.runtime, hostId = server.key;
    if (!runtime || !hostId) return;
    const refresh = () => { if (active && page.split('/')[0] === 'data' && serverFor(page)?.key === hostId) render(); };
    if (!serverConsents.has(hostId)) {
      serverConsents.set(hostId, { loading: true });
      void runtime.request('diagnostics.consent.get', {}, hostId).then(result => {
        // A server that cannot answer (an older version) shows no row.
        serverConsents.set(hostId, result?.ok ? { ...result.value } : { unsupported: true });
        refresh();
      }).catch(() => { serverConsents.set(hostId, { unsupported: true }); refresh(); });
      return;
    }
    root.querySelector('[data-server-error-reports]')?.addEventListener('change', async event => {
      const toggle = event.currentTarget, previous = serverConsents.get(hostId);
      toggle.disabled = true;
      const result = await runtime.request('diagnostics.consent.set', { automatic: toggle.checked }, hostId).catch(error => ({ ok: false, error }));
      serverConsents.set(hostId, result?.ok ? { ...result.value, saved: true } : { ...previous, error: `Not saved. ${result?.error?.message || 'The server did not answer.'}` });
      refresh();
    });
  }

  /** Consent to error and crash reports (desktop): off until the user turns it on. */
  function errorReportsRow() {
    if (!window.desktopDiagnostics || !diagnosticsConsent?.available) return '';
    return `<div class="settings-rows settings-consent"><div class="settings-row"><div><label for="error-reports">Send error reports and crash dumps</label><p>When something fails or crashes, a report goes to the developer (Sentry, EU region): error types, codes, app version and system. Chats, prompts, model answers, keys, file contents and paths are not included. A crash dump is a snapshot of the crashed process's memory and may contain fragments of what it was doing.</p></div><div class="settings-control settings-consent-control"><span class="settings-save-status ${diagnosticsSaved ? 'is-success' : ''}" role="status" aria-live="polite" data-error-reports-status>${diagnosticsSaved ? `Saved · ${diagnosticsConsent.automatic ? 'on' : 'off'}` : ''}</span><input id="error-reports" data-error-reports type="checkbox" role="switch" ${diagnosticsConsent.automatic ? 'checked' : ''} /></div></div></div>`;
  }
  function bindErrorReports() {
    const toggle = root.querySelector('[data-error-reports]');
    if (!toggle) {
      if (window.desktopDiagnostics && !diagnosticsConsent) void window.desktopDiagnostics.consent().then(value => { diagnosticsConsent = value; if (active && page === 'data') render(); }).catch(() => {});
      return;
    }
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      const status = root.querySelector('[data-error-reports-status]');
      try {
        diagnosticsConsent = await window.desktopDiagnostics.setConsent(toggle.checked);
        diagnosticsSaved = true;
        if (status) { status.textContent = `Saved · ${diagnosticsConsent.automatic ? 'on' : 'off'}`; status.classList.add('is-success'); status.classList.remove('is-error'); }
      } catch {
        toggle.checked = Boolean(diagnosticsConsent?.automatic);
        if (status) { status.textContent = 'Not saved. Try again.'; status.classList.add('is-error'); status.classList.remove('is-success'); }
      }
      toggle.disabled = false;
    });
  }
  async function openDataFolder() {
    try { await window.desktopApp.openDataFolder(); }
    catch (error) { if (!active) { location.hash = '#/settings/data'; } setTimeout(() => { const slot = root.querySelector('[data-folder-status]'); if (slot) slot.textContent = error.message; }, 0); }
  }
  function bindProfileForm() {
    const form = root.querySelector('#settings-profile-form');
    const status = root.querySelector('[data-profile-status]');
    const setProfileStatus = (text, error = false) => {
      if (!status) return;
      status.textContent = text;
      status.classList.toggle('is-error', error);
    };
    const saveProfile = async (patch, success) => {
      setProfileStatus('Saving…');
      try {
        await data.save({ profile: patch });
        if (active && page === 'profile') render();
        return true;
      } catch (error) {
        setProfileStatus(`Not saved. ${error.message}`, true);
        return false;
      }
    };
    form?.addEventListener('submit', event => {
      event.preventDefault();
      const input = form.elements.namedItem('displayName');
      if (!form.reportValidity() || !input?.value?.trim()) return;
      void saveProfile({ displayName: input.value.trim() }, 'Profile saved.');
    });
    root.querySelector('[data-profile-avatar]')?.addEventListener('change', async event => {
      const input = event.currentTarget, file = input.files?.[0];
      input.value = '';
      if (!file) return;
      // Any size: what is saved is the chosen square, 512 px.
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) {
        setProfileStatus('Choose a PNG, JPEG or WebP image smaller than 20 MB.', true);
        return;
      }
      try {
        const reader = new FileReader();
        const image = await new Promise((resolve, reject) => { reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error || new Error('Could not read image.')); reader.readAsDataURL(file); });
        if (typeof image !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]+={0,2}$/i.test(image)) throw new Error('Choose a valid PNG, JPEG or WebP image.');
        const cropped = await openAvatarCropper(image);
        if (!cropped) { setProfileStatus('The avatar was not changed.'); return; }
        await saveProfile({ avatarDataUrl: cropped }, 'Avatar saved.');
      } catch (error) { setProfileStatus(error.message || 'Could not save image.', true); }
    });
    root.querySelector('[data-remove-profile-avatar]')?.addEventListener('click', () => { void saveProfile({ avatarDataUrl: '' }, 'Avatar removed.'); });
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
    const user = localProfileView(clientSettings());
    menu.innerHTML = `<div class="profile-menu-header">${avatar(user)}<span>${escape(user.name)}<small>${escape(accountSubtitle(account.get()))}</small></span></div>${[['profile', 'Profile', 'profile'], ['usage', 'Usage', 'clock'], ['general', 'Settings', 'settings'], ['data-folder', 'Open data folder', 'folder'], ['about', 'About', 'info'], ['report-bug', 'Report a bug', 'bug']].map(([route, label, symbol]) => `<button type="button" role="menuitem" data-profile-route="${route}" ${route === 'data-folder' && !window.desktopApp ? 'disabled title="Available in the desktop app"' : ''}>${icon(symbol)}<span>${label}</span></button>`).join('')}`;
    menu.querySelectorAll('[data-profile-route]').forEach(button => button.addEventListener('click', () => {
      closeMenu(false);
      if (button.dataset.profileRoute === 'data-folder') { void openDataFolder(); document.getElementById('local-profile-button')?.focus(); }
      // The window the user was in, before the report page covers it (sent only if they tick it).
      else if (button.dataset.profileRoute === 'report-bug' && window.desktopBugReport) {
        void window.desktopBugReport.capture().catch(() => {}).finally(() => { location.hash = '#/settings/report-bug'; });
      }
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
  account.subscribe(view => {
    if (active && page === 'account') updateAccountPage();
    // Update descriptions in place: a full render would drop profile form drafts.
    const link = root.querySelector('a.settings-list-row[href="#/settings/account"] small');
    if (link) link.textContent = accountLinkDescription(view);
    const header = menu.querySelector('.profile-menu-header small');
    if (header) header.textContent = accountSubtitle(view);
  });
  return {
    isOpen: () => active,
    profileButton: () => { const user = localProfileView(clientSettings()); return `<button id="local-profile-button" class="local-profile-button" type="button" aria-label="${escape(user.name)} profile" aria-haspopup="menu" aria-controls="profile-menu" aria-expanded="false">${avatar(user)}<span class="local-profile-label">${escape(user.name)}</span>${icon('chevronDown')}</button>`; },
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
        disposeIntegrations?.(); disposeIntegrations = undefined;
        active = false; root.hidden = true; app.inert = false; app.style.visibility = '';
        onReturn();
        if (hash === previousRoute) restoreScroll(appScroll);
        document.getElementById(appFocus || 'local-profile-button')?.focus({ preventScroll: true });
      }
      return false;
    },
    refreshPreferences() { if (active && page === 'appearance') render(); },
    /** The selected machine, its connection or the server's settings changed: the open page is
     * rendered again only when what it shows about them changed, so typing is not interrupted. */
    targetChanged() { if (active && targetSignature() !== shownTarget) render(); }
  };
}
