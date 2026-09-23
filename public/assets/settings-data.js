// Presentation consumes this adapter; a future PluginManager can replace it.
export const legacyIntegrations = [
  { id: 'file', name: 'Files', description: 'Read and write files using the existing access policy.', fields: [
    ['outputDir', 'Output directory'], ['accessMode', 'Access mode', 'access'], ['allowedDirectories', 'Allowed directories', 'textarea']
  ] },
  { id: 'notion', name: 'Notion', description: 'Use the existing Notion integration with your API key.', fields: [
    ['apiKey', 'API key', 'secret'], ['parentPageUrl', 'Parent page URL'], ['parentPageId', 'Parent page ID'],
    ['dataSourceUrl', 'Data source URL'], ['dataSourceId', 'Data source ID'], ['titleProperty', 'Title property'], ['version', 'Notion version']
  ] },
  { id: 'vscode', name: 'VS Code', description: 'The editor bridge is not available in this release. Saved configuration is preserved.', unavailable: true, fields: [] }
];
export function createSettingsData({ request, onSaved }) {
  let queue = Promise.resolve();
  return {
    integrations: legacyIntegrations,
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
    testPlugin: id => request(`/plugins/${encodeURIComponent(id)}/test`, { method: 'POST' })
  };
}

export function localProfileView(settings) {
  return { id: settings?.memory?.localProfileId, name: 'Local profile', kind: 'local', authentication: 'unavailable' };
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
