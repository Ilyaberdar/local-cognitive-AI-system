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
    })
  };
}

export function localProfileView(settings) {
  const candidateName = settings?.profile?.displayName;
  const name = typeof candidateName === 'string' && candidateName.trim() ? candidateName.trim().slice(0, 80) : 'Local profile';
  const candidateAvatar = settings?.profile?.avatarDataUrl;
  const avatarDataUrl = typeof candidateAvatar === 'string' && candidateAvatar.length <= 1_500_000 && /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]+={0,2}$/i.test(candidateAvatar)
    ? candidateAvatar
    : undefined;
  return { id: settings?.memory?.localProfileId, name, avatarDataUrl, kind: 'local', authentication: 'unavailable' };
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
