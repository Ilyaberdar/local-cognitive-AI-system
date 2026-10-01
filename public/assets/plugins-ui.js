const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const stateLabel = { connecting: 'Waiting for login', connected: 'Connected', disconnected: 'Disconnected', 'authentication-required': 'Login required', error: 'Connection error' };
const button = (action, label, extra = '') => `<button type="button" class="ghost-button" data-plugin-action="${action}" ${extra}>${label}</button>`;
// Only an in-memory handoff for the login link/device code across catalog → detail.
// No tokens or credentials are stored in the renderer.
const pendingLogins = new Map();

import { icon } from './ui-primitives.js';

/** One mounted page, one cancellable request owner. No tokens enter renderer state. */
export function mountIntegrationPage(root, { pluginId, connectionsPage = false, mcpCount = 1 }) {
  let snapshot, disposed = false, busy = false, message = '', error = false, filter = '', directory = false, login = pendingLogins.get(pluginId), timer;
  const main = root.closest('main'), isCatalog = !pluginId && !connectionsPage;
  if (isCatalog) main?.classList.add('settings-plugin-directory');
  const controller = new AbortController();
  async function request(path = '', method = 'GET', body = {}) {
    const response = await fetch(`/integrations${path}`, { method, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
      headers: { 'Content-Type': 'application/json', 'X-Local-Cognitive': '1' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not update integrations.');
    return result;
  }
  async function load(preserveDrafts = false) {
    snapshot = await request();
    for (const [id, attempt] of pendingLogins) if (!snapshot.connections.some(connection => connection.id === attempt.connectionId && connection.state === 'connecting')) pendingLogins.delete(id);
    if (login) {
      const connection = snapshot.connections.find(item => item.id === login.connectionId);
      if (connection?.state !== 'connecting') {
        login = undefined;
        if (!error && message.startsWith('Login started.')) message = connection?.state === 'connected'
          ? 'Account connected. Choose local permissions to enable it in chats and workflows.' : 'Check the account status below.';
      }
    }
    if (!disposed) { render(preserveDrafts); poll(); }
  }
  function poll() {
    clearTimeout(timer);
    const pending = snapshot?.connections.filter(connection => connection.state === 'connecting') ?? [];
    if (!pending.length || disposed) return;
    timer = setTimeout(async () => {
      try {
        for (const connection of pending) await request(`/connections/${connection.id}/refresh`, 'POST');
        if (!disposed) await load(true);
      } catch (failure) { if (!disposed) { message = failure.message; error = true; render(true); } }
    }, 2500);
  }
  async function action(work, success = '', afterSuccess) {
    if (busy || disposed) return;
    busy = true; message = ''; error = false; setBusy();
    try { await work(); message = success; await load(); if (!disposed) afterSuccess?.(); }
    catch (failure) { message = failure.message; error = true; }
    finally { busy = false; if (!disposed) render(); }
  }
  function setBusy() { root.querySelectorAll('button,select,input').forEach(control => { control.disabled = busy; }); }
  function canSignIn(plugin) { return snapshot.providers.some(provider => provider.ready) && snapshot.setup[plugin.id]?.configured === true; }
  function connectAccount(id) {
    const plugin = snapshot.catalog.find(item => item.id === id);
    if (!canSignIn(plugin)) { location.hash = `#/settings/plugins/${id}`; return; }
    void action(async () => {
      if (!plugin.installation) await request(`/${id}/install`, 'POST');
      login = await request(`/${id}/connect`, 'POST');
      pendingLogins.set(id, login);
    }, 'Login started. Complete authorization in your browser.', () => { if (!pluginId) location.hash = `#/settings/plugins/${id}`; });
  }
  function badge(plugin) {
    const asset = plugin.id.startsWith('outlook-') ? 'outlook' : plugin.id;
    return `<span class="plugin-app-icon plugin-app-icon--${escape(plugin.id)}" aria-hidden="true"><img src="/assets/plugin-icons/${escape(asset)}.svg" alt="" width="32" height="32" />${plugin.id === 'outlook-calendar' ? `<span class="plugin-icon-corner">${icon('calendar')}</span>` : ''}</span>`;
  }
  function accessState(plugin) {
    const installation = plugin.installation, connection = snapshot.connections.find(item => item.id === installation?.connectionId);
    const connected = connection?.state === 'connected';
    const active = connected && installation?.enabled && installation.permission !== 'none';
    const label = active ? 'Connected · enabled' : connected ? 'Connected · disabled' : connection?.state === 'connecting' ? 'Waiting for login' : 'Not connected';
    return { active: Boolean(active), connected, label };
  }
  function connectionMarkup(connection, plugin, selectable) {
    const state = stateLabel[connection.state] || 'Not checked';
    return `<div class="plugin-account"><div><strong>${escape(connection.label)}</strong><span class="plugin-status ${connection.state === 'connected' ? 'is-connected' : ''}">${escape(state)}</span>
      <small>${escape(connection.message || `${connection.tools.length} tools · ${plugin.name}`)}</small></div><div class="plugin-actions">
      ${selectable && connection.state === 'connected' && plugin.installation?.connectionId !== connection.id ? button(`select:${connection.id}`, 'Use this account') : ''}
      ${plugin.installation?.connectionId === connection.id ? '<span class="plugin-selected">Selected</span>' : ''}
      ${button(`refresh:${connection.id}`, 'Check connection')}${button(`disconnect:${connection.id}`, 'Disconnect')}</div></div>`;
  }
  function setupMarkup(plugin) {
    if (!snapshot.providers.some(provider => provider.ready)) return `<p class="settings-footnote">${escape(snapshot.providers[0]?.message || 'Open the desktop app to connect an account.')}</p>`;
    return snapshot.setup[plugin.id]?.configured ? '' : `<div class="plugin-unavailable" role="status"><strong>Not available in this build yet</strong><p>${escape(plugin.name)} sign-in has not been configured by the application developer. You do not need to create another account or enter technical settings.</p></div>`;
  }
  function detail(plugin) {
    const installation = plugin.installation, accounts = snapshot.connections.filter(item => item.pluginId === plugin.id);
    const selected = accounts.find(item => item.id === installation?.connectionId);
    const ready = canSignIn(plugin);
    return `<div class="plugin-detail-heading">${badge(plugin)}<div><p>${escape(plugin.description)}</p><span>${escape(plugin.category)} · v${escape(plugin.version)} · ${plugin.mcpEndpoint ? 'Official MCP service' : 'Direct service API'}</span></div></div>
      <div class="plugin-links"><a href="${escape(plugin.privacy)}" target="_blank" rel="noopener noreferrer">Privacy policy ↗</a></div>
      <ol class="plugin-steps" aria-label="Setup steps"><li class="${installation ? 'is-complete' : ''}">1. Install</li><li class="${selected?.state === 'connected' ? 'is-complete' : ''}">2. Connect account</li><li class="${installation?.enabled ? 'is-complete' : ''}">3. Choose access</li></ol>
      ${!installation ? `<p class="settings-description">Install opens ${escape(plugin.name)} in your browser so you can sign in and approve access. If you are already signed in, choose your account and continue.</p>${button(`install:${plugin.id}`, 'Install & connect', ready ? 'data-primary' : 'disabled')}${setupMarkup(plugin)}` : `
      <section class="plugin-section"><h2>Account</h2><p>Log in in your browser and review the service's consent screen. An account is connected only after its API or tools have been checked.</p>
      ${accounts.map(account => connectionMarkup(account, plugin, true)).join('')}
      ${button(`connect:${plugin.id}`, accounts.length ? 'Connect another account' : 'Connect account', ready ? 'data-primary' : 'disabled')}
      ${login ? `<div class="plugin-login" role="status">Complete login in your browser.${login.userCode ? `<p>Enter this code: <strong class="plugin-device-code">${escape(login.userCode)}</strong></p>` : ''}<p><a href="${escape(login.authorizationUrl)}" target="_blank" rel="noopener noreferrer">Open authorization page ↗</a></p>Return here after granting access. This page checks automatically.</div>` : ''}
      ${setupMarkup(plugin)}</section>
      <section class="plugin-section"><h2>Access in chats & workflows</h2><p>The active account is shared by chat agents and workflow agent steps in this profile. Provider consent and local tool permissions are separate. Every external write requires approval.</p>
      <label class="plugin-permission">Allowed tools <select data-plugin-permission aria-label="Plugin permissions"><option value="none" ${installation.permission === 'none' ? 'selected' : ''}>No access</option><option value="read" ${installation.permission === 'read' ? 'selected' : ''}>Read only</option><option value="read-write" ${installation.permission === 'read-write' ? 'selected' : ''}>Read & write (writes ask first)</option></select></label>
      ${button(`enable:${!installation.enabled}`, installation.enabled ? 'Disable plugin' : 'Enable plugin', !installation.enabled && (installation.permission === 'none' || selected?.state !== 'connected') ? 'disabled' : 'data-primary')}
      <span class="plugin-status ${installation.enabled ? 'is-connected' : ''}">${installation.enabled ? 'Enabled' : 'Disabled'}</span>
      ${selected?.state === 'connected' ? `<details class="plugin-tools"><summary>${selected.tools.length} available tools · ${escape(selected.label)}</summary>${selected.tools.map(tool => `<div><strong>${escape(tool.name)}</strong><span>${tool.readOnly ? 'Read' : 'Approval required'}</span><p>${escape(tool.description)}</p></div>`).join('')}</details>` : ''}</section>
      <section class="plugin-section"><h2>Uninstall</h2><p>Removes the plugin from this profile and stops its active operations. Account authorizations remain in Connected accounts until disconnected.</p>${button(`uninstall:${plugin.id}`, 'Uninstall plugin')}</section>`}`;
  }
  function render(preserveDrafts = false) {
    if (disposed) return;
    const focusedAction = document.activeElement?.dataset?.pluginAction;
    const expanded = preserveDrafts ? ['plugin-tools', 'plugin-add'].map(name => [name, root.querySelector(`details.${name}`)?.open]) : [];
    const activeInput = preserveDrafts && root.contains(document.activeElement) && document.activeElement.matches('input') ? document.activeElement : undefined;
    const focus = activeInput && { name: activeInput.name, search: activeInput.hasAttribute('data-plugin-search'), start: activeInput.selectionStart, end: activeInput.selectionEnd };
    let content;
    if (!snapshot) content = '<p>Loading plugins…</p>';
    else if (connectionsPage) {
      content = `<p class="settings-description">These are the accounts used by your plugins, not a second app store. Manage personal and work accounts here; choose the active account in each plugin. Tokens are encrypted on this device.</p>
        ${snapshot.connections.length ? snapshot.connections.map(connection => connectionMarkup(connection, snapshot.catalog.find(plugin => plugin.id === connection.pluginId), false)).join('') : '<p class="settings-footnote">No connected accounts yet. Return to Plugins and choose a service to sign in.</p>'}<p class="settings-footnote">Disconnect removes credentials from this device. To revoke access everywhere, remove Local Cognitive in the service\'s account settings.</p>`;
    } else if (pluginId) {
      const plugin = snapshot.catalog.find(item => item.id === pluginId);
      if (plugin) { root.closest('main')?.querySelector('h1')?.replaceChildren(document.createTextNode(plugin.name)); content = detail(plugin); }
      else content = '<p>Plugin not found. <a href="#/settings/plugins">Browse the catalog</a>.</p>';
    } else content = `<header class="plugin-directory-header"><div><h1 tabindex="-1">Plugins</h1><p>Manage plugins and connected apps</p></div>
      <div class="plugin-header-actions">${button('directory', directory ? 'Back to plugins' : 'Browse directory', `aria-pressed="${directory}"`)}
      <details class="plugin-add"><summary>Add ${icon('chevronDown')}</summary><div class="plugin-add-menu">${button('directory', 'Install from directory')}<a href="#/settings/connections">Manage connected accounts</a><a href="#/settings/mcp">Add MCP server</a></div></details></div></header>
      <div class="plugin-toolbar"><nav class="plugin-tabs" aria-label="Integration types"><button type="button" class="is-current" data-plugin-action="list" aria-current="page">Plugins <span>${snapshot.catalog.length}</span></button><a href="#/settings/connections" title="Connected accounts used by plugins">Accounts <span>${snapshot.connections.filter(item => item.state === 'connected').length}</span></a><a href="#/settings/mcp" title="Configured MCP servers, including the built-in Local Cognitive server">MCP servers <span>${Number(mcpCount)}</span></a></nav>
      <label class="plugin-search">${icon('search')}<input type="search" data-plugin-search placeholder="Search plugins" value="${escape(filter)}" aria-label="Search plugins" /></label></div>
      ${directory ? '<p class="plugin-directory-note">Install opens the service\'s sign-in page. Choose an account, approve access, then set its permissions here.</p>' : ''}
      <div class="plugin-catalog" data-plugin-list>${catalogRows()}</div>`;
    root.innerHTML = `<div class="plugin-page"><div class="plugin-message ${error ? 'is-error' : ''}" role="status" aria-live="polite">${escape(message)}</div>${content}${!snapshot && error ? button('retry', 'Try again') : ''}</div>`;
    for (const [name, open] of expanded) { const details = root.querySelector(`details.${name}`); if (details && typeof open === 'boolean') details.open = open; }
    bind(); if (busy) setBusy();
    if (focusedAction) [...root.querySelectorAll('[data-plugin-action]')].find(element => element.dataset.pluginAction === focusedAction)?.focus({ preventScroll: true });
    if (focus) {
      const input = focus.search ? root.querySelector('[data-plugin-search]') : undefined;
      input?.focus({ preventScroll: true });
      if (input && typeof focus.start === 'number' && typeof focus.end === 'number') input.setSelectionRange(focus.start, focus.end);
    }
  }
  function catalogRows() {
    const items = snapshot.catalog.filter(plugin => `${plugin.name} ${plugin.description} ${plugin.category}`.toLowerCase().includes(filter.toLowerCase()));
    return items.length ? items.map(plugin => {
      const access = accessState(plugin);
      return `<article class="plugin-catalog-row" data-plugin-id="${plugin.id}"><a href="#/settings/plugins/${plugin.id}" class="plugin-card-main">${badge(plugin)}<span><strong>${escape(plugin.name)}</strong><small>${escape(plugin.description)}</small></span></a>
      ${directory ? plugin.installation ? `<a class="ghost-button" href="#/settings/plugins/${plugin.id}">Manage</a>` : button(`install:${plugin.id}`, canSignIn(plugin) ? 'Install' : 'Unavailable', `aria-label="Install ${escape(plugin.name)}" ${canSignIn(plugin) ? '' : 'disabled'}`)
        : `<button type="button" role="switch" class="plugin-switch" data-plugin-action="toggle:${plugin.id}" aria-checked="${access.active}" aria-label="${escape(plugin.name)} access" title="${escape(access.label)}${access.active ? ' — disable access' : ' — connect or manage access'}"><span></span></button>`}</article>`;
    }).join('') : '<p class="settings-footnote">No matching plugins.</p>';
  }
  function bind() {
    root.querySelector('[data-plugin-search]')?.addEventListener('input', event => {
      filter = event.target.value; root.querySelector('[data-plugin-list]').innerHTML = catalogRows();
    });
    root.onclick = event => {
      const target = event.target.closest('[data-plugin-action]'); if (!target || target.disabled) return;
      const [kind, id] = target.dataset.pluginAction.split(':');
      if (kind === 'directory' || kind === 'list') { directory = kind === 'directory' ? !directory : false; render(); root.querySelector('[data-plugin-search]')?.focus(); return; }
      if (kind === 'toggle') {
        const plugin = snapshot.catalog.find(item => item.id === id), access = accessState(plugin);
        if (!access.active && !access.connected && canSignIn(plugin) && !snapshot.connections.some(connection => connection.pluginId === id && connection.state === 'connecting')) { connectAccount(id); return; }
        if (!access.active && (!access.connected || !plugin.installation || plugin.installation.permission === 'none')) { location.hash = `#/settings/plugins/${id}`; return; }
        void action(() => request(`/${id}`, 'PATCH', { enabled: !access.active }), access.active ? 'Plugin disabled. Account authorization is preserved.' : 'Enabled in chats and workflows.'); return;
      }
      if (kind === 'retry') { void action(load); return; }
      if (kind === 'install' || kind === 'connect') connectAccount(id);
      if (kind === 'refresh') void action(() => request(`/connections/${id}/refresh`, 'POST'), 'Connection checked.');
      if (kind === 'select') void action(() => request(`/${pluginId}`, 'PATCH', { connectionId: id }), 'Active account changed.');
      if (kind === 'enable') void action(() => request(`/${pluginId}`, 'PATCH', { enabled: id === 'true' }), id === 'true' ? 'Enabled in chats and workflow agent steps.' : 'Plugin disabled.');
      if (kind === 'disconnect' && confirm('Disconnect this account and remove its credentials from this device? Active operations will be stopped.')) void action(() => request(`/connections/${id}`, 'DELETE'), 'Account disconnected locally.');
      if (kind === 'uninstall' && confirm('Uninstall this plugin? Its account authorization will remain in Connections.')) void action(() => request(`/${id}`, 'DELETE'), 'Plugin uninstalled.');
    };
    root.querySelector('[data-plugin-permission]')?.addEventListener('change', event => {
      const permission = event.target.value;
      void action(() => request(`/${pluginId}`, 'PATCH', { permission, ...(permission === 'none' ? { enabled: false } : {}) }), 'Permissions updated.');
    });
  }
  render(); void load().catch(failure => { if (!disposed) { message = failure.message; error = true; render(); } });
  return () => { disposed = true; clearTimeout(timer); controller.abort(); root.onclick = null; if (isCatalog) main?.classList.remove('settings-plugin-directory'); };
}
