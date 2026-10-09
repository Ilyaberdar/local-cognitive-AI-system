// Catalog metadata is fetched from the backend's release-owned integration catalog.
export function createSettingsData({ request, onSaved }) {
  let queue = Promise.resolve();
  return {
    integrations: [],
    save(patch) {
      const next = queue.then(async () => {
        const response = await request('/app/settings', { method: 'PUT', body: JSON.stringify(patch), timeoutMs: patch.localModels?.modelsDir ? 900000 : 60000 });
        onSaved(response, patch);
        return response.settings;
      });
      queue = next.catch(() => {});
      return next;
    },
    testProvider: (id, model, timeoutMs) => request(`/providers/${encodeURIComponent(id)}/test`, {
      method: 'POST', body: JSON.stringify({ model }), timeoutMs: id === 'llamacpp' ? 0 : Math.max(60000, timeoutMs || 0) + 30000
    }),
    loadMcp: () => request('/mcp/clients'),
    connectMcp: id => request(`/mcp/clients/${encodeURIComponent(id)}/connect`, { method: 'POST', timeoutMs: 30000 }),
    disconnectMcp: id => request(`/mcp/clients/${encodeURIComponent(id)}/disconnect`, { method: 'POST', timeoutMs: 30000 }),
    // A server's secrets: only whether each is set comes back, never a value.
    mcpSecrets: id => request(`/mcp/clients/servers/${encodeURIComponent(id)}/secrets`),
    setMcpSecret: (id, secret) => request(`/mcp/clients/servers/${encodeURIComponent(id)}/secrets`, { method: 'PUT', body: JSON.stringify(secret), timeoutMs: 30000 }),
    mcpImportSources: () => request('/mcp/clients/import/sources'),
    previewMcpImport: body => request('/mcp/clients/import/preview', { method: 'POST', body: JSON.stringify(body), timeoutMs: 30000 }),
    applyMcpImport: body => request('/mcp/clients/import/apply', { method: 'POST', body: JSON.stringify(body), timeoutMs: 60000 }),
    removeMcpSecret: (id, kind, name) => request(`/mcp/clients/servers/${encodeURIComponent(id)}/secrets/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`, { method: 'DELETE', timeoutMs: 30000 })
  };
}

export function localProfileView(settings) {
  const candidateName = settings?.profile?.displayName;
  const name = typeof candidateName === 'string' && candidateName.trim() ? candidateName.trim().slice(0, 80) : 'Local profile';
  const candidateAvatar = settings?.profile?.avatarDataUrl;
  const avatarDataUrl = typeof candidateAvatar === 'string' && candidateAvatar.length <= 1_500_000 && /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]+={0,2}$/i.test(candidateAvatar)
    ? candidateAvatar
    : undefined;
  return { id: settings?.memory?.localProfileId, name, avatarDataUrl, kind: 'local' };
}

const accountStates = ['signed-out', 'signing-in', 'signed-in', 'error'];
const accountText = (value, max) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

// Allowlist only: tokens or any other bridge fields can never reach markup.
export function accountView(status) {
  const raw = status?.profile && typeof status.profile === 'object' ? status.profile : undefined;
  const accountId = accountText(raw?.accountId, 200);
  const profile = accountId ? { accountId, email: accountText(raw.email, 320), emailVerified: raw.emailVerified === true, name: accountText(raw.name, 120) } : undefined;
  let state = accountStates.includes(status?.state) ? status.state : 'error';
  if (state === 'signed-in' && !profile) state = 'error';
  const error = state === 'error'
    ? { code: accountText(status?.error?.code, 80) || 'unknown', message: accountText(status?.error?.message, 300) || 'Sign-in could not be completed. Try again.' }
    : undefined;
  return { state, profile: state === 'signed-in' ? profile : undefined, error, cloudReachable: status?.cloudReachable !== false };
}

// Account state for the renderer. Change events from the desktop bridge are the source
// of truth; a call result older than a later event is ignored.
export function createAccountState(bridge) {
  let view = { state: bridge ? 'loading' : 'unavailable', cloudReachable: true };
  let generation = 0;
  const listeners = new Set();
  const publish = status => { view = accountView(status); listeners.forEach(listener => listener(view)); return view; };
  const failed = () => ({ state: 'error', error: { code: 'bridge_error', message: 'Sign-in could not start. Try again.' } });
  if (bridge) {
    bridge.onChange?.(status => { generation++; publish(status); });
    const start = generation;
    bridge.status().then(status => { if (generation === start) publish(status); }, () => { if (generation === start) publish(failed()); });
  }
  async function call(method, ...args) {
    if (!bridge) return view;
    const start = ++generation;
    try { const status = await bridge[method](...args); return generation === start ? publish(status) : view; }
    catch { return generation === start || view.state === 'signing-in' ? publish(failed()) : view; }
  }
  return {
    get: () => view,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    signIn: method => ['google', 'email', 'signup'].includes(method) ? call('signIn', method) : Promise.resolve(view),
    cancelSignIn: () => call('cancelSignIn'),
    signOut: () => call('signOut'),
    refresh: () => call('status')
  };
}

// Counts the entries actually shown in MCP settings, not connected accounts.
// The built-in incoming server remains an entry even when disabled/on demand.
export function mcpServerCount(settings) {
  return 1 + Object.keys(settings?.mcp?.client?.servers || {}).length;
}

// Only fields explicitly edited in this entity are sent. A blank secret retains
// the saved value; an explicit Remove action sends an empty string.
export function entityPatch(fields) {
  const patch = {};
  for (const [name, value] of Object.entries(fields)) {
    const keys = name.split('.');
    if (keys.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('Invalid setting.');
    let target = patch;
    for (const key of keys.slice(0, -1)) target = target[key] ??= {};
    target[keys.at(-1)] = value;
  }
  return patch;
}
