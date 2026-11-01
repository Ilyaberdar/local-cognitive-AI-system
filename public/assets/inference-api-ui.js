// Settings → API: the OpenAI-compatible API to this computer's models (src/api/inference). It is set
// here, on this computer only: on or off, its port, whether other devices on the network may reach it,
// and the keys programs send. A key is shown once, when it is made.

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const day = (iso) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); };
const moment = (iso) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };

export function inferenceApiHtml(view) {
  const status = view.status;
  if (!status) return `<p class="settings-description">${view.error ? escape(view.error) : 'Loading…'}</p>`;
  const state = !status.enabled ? 'Off.' : status.listening ? `On at <code>${escape(status.url)}</code>${status.lan ? `, and at this computer's network addresses on port ${status.port}` : ''}.` : `On, but not listening: ${escape(status.error || 'it could not start')}`;
  const keys = status.keys.length ? status.keys.map((key) => `<li data-api-key="${escape(key.id)}"><span><strong>${escape(key.name)}</strong><small>…${escape(key.hint)} · made ${escape(day(key.createdAt))} · ${key.lastUsedAt ? `last used ${escape(moment(key.lastUsedAt))}` : 'never used'}</small></span>${view.confirm === key.id
    ? `<span class="inference-api-confirm"><button type="button" class="ghost-button" data-api-revoke-cancel>Keep</button><button type="button" class="ghost-button task-delete-button" data-api-revoke-confirm="${escape(key.id)}">Revoke</button></span>`
    : `<button type="button" class="ghost-button" data-api-revoke="${escape(key.id)}" ${view.busy ? 'disabled' : ''}>Revoke</button>`}</li>`).join('') : '';
  const model = view.example || 'MODEL';
  return `<div class="inference-api">
    <p class="settings-description">Programs on this computer, such as scripts, bots and editors, can use your models through an API that speaks OpenAI's: point them at the address below with a key made here. Each request is a model call on its own: nothing is remembered, no chat is kept and no tools are used.</p>
    <div class="settings-rows">
      <div class="settings-row"><div><label for="inference-api-enabled">OpenAI-compatible API</label><p data-api-state>${state}</p></div><div class="settings-control"><input id="inference-api-enabled" type="checkbox" role="switch" data-api-enabled ${status.enabled ? 'checked' : ''} ${view.busy ? 'disabled' : ''} /></div></div>
      <div class="settings-row"><div><label for="inference-api-port">Port</label><p>The address stays the same from launch to launch. 4141 unless you choose another.</p></div><div class="settings-control inference-api-port"><input id="inference-api-port" type="number" min="1024" max="65535" step="1" value="${escape(status.port)}" data-api-port ${view.busy ? 'disabled' : ''} /><button type="button" class="ghost-button" data-api-port-save ${view.busy ? 'disabled' : ''}>Save</button></div></div>
      <div class="settings-row"><div><label for="inference-api-lan">Other devices on this network</label><p>They reach it at this computer's address on the port. Requests and keys travel unencrypted (plain HTTP): turn this on only on a network you trust.</p></div><div class="settings-control"><input id="inference-api-lan" type="checkbox" role="switch" data-api-lan ${status.lan ? 'checked' : ''} ${view.busy ? 'disabled' : ''} /></div></div>
    </div>
    <h3>Keys</h3>
    <p class="settings-description">A program sends its key as <code>Authorization: Bearer &lt;key&gt;</code>. Make one for each program, so that you can revoke it alone. A key calls the models and nothing else of the app.</p>
    <form class="inference-api-new" data-api-key-form><input name="name" type="text" maxlength="80" placeholder="Name, such as News bot" aria-label="Key name" required ${view.busy ? 'disabled' : ''} /><button type="submit" class="primary-button" ${view.busy ? 'disabled' : ''}>Make key</button></form>
    ${view.made ? `<div class="inference-api-made" role="status"><p><strong>${escape(view.made.name)}</strong>: copy the key now. It is not shown again.</p><div class="inference-api-key"><code data-api-made-key>${escape(view.made.key)}</code><button type="button" class="ghost-button" data-api-copy>${view.copied ? 'Copied' : 'Copy'}</button></div></div>` : ''}
    ${keys ? `<ul class="inference-api-keys">${keys}</ul>` : '<p class="settings-footnote">No keys yet.</p>'}
    ${view.error ? `<p class="settings-footnote inference-api-error" role="alert">${escape(view.error)}</p>` : ''}
    <h3>Use it</h3>
    <pre class="settings-code-preview"><code>curl ${escape(status.url)}/chat/completions \\
  -H "Authorization: Bearer $LOCAL_COGNITIVE_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${escape(model)}", "messages": [{"role": "user", "content": "Hello"}]}'</code></pre>
    <p class="settings-footnote">The model is a loaded local model by its id (<code>GET /v1/models</code> lists them), or a cloud provider's as provider/model, such as <code>deepseek/deepseek-chat</code>. A local model is not loaded for a request: load it in Models first. A server has its own API, turned on there: <code>sudo local-cognitive-server api on</code>.</p>
  </div>`;
}

/** Mounts the page; returns its disposer. */
export function mountInferenceApiPage(container, { request, clipboard = navigator.clipboard } = {}) {
  if (!container) return () => {};
  const view = { status: null, error: '', busy: false, made: null, copied: false, confirm: null, example: '' };
  let disposed = false;
  const paint = () => { if (!disposed) { container.innerHTML = inferenceApiHtml(view); bind(); } };
  const act = async (action) => {
    view.busy = true; view.error = ''; paint();
    try { await action(); } catch (error) { view.error = error instanceof Error ? error.message : String(error); }
    view.busy = false; paint();
  };
  const load = async () => {
    try {
      view.status = await request('/inference-api');
      const loaded = await request('/local/models/loaded').catch(() => null);
      const first = (Array.isArray(loaded) ? loaded : loaded?.models ?? [])[0];
      if (first?.id) view.example = first.id;
    } catch (error) { view.error = error instanceof Error ? error.message : String(error); }
    paint();
  };
  const configure = (patch) => act(async () => { view.status = await request('/inference-api', { method: 'PUT', body: JSON.stringify(patch) }); });
  function bind() {
    container.querySelector('[data-api-enabled]')?.addEventListener('change', (event) => { void configure({ enabled: event.currentTarget.checked }); });
    container.querySelector('[data-api-lan]')?.addEventListener('change', (event) => { void configure({ lan: event.currentTarget.checked }); });
    container.querySelector('[data-api-port-save]')?.addEventListener('click', () => {
      const port = Number(container.querySelector('[data-api-port]')?.value);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) { view.error = 'The port must be a whole number from 1024 to 65535.'; paint(); return; }
      void configure({ port });
    });
    container.querySelector('[data-api-key-form]')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = String(new FormData(event.currentTarget).get('name') || '').trim();
      if (!name) return;
      void act(async () => {
        view.made = await request('/inference-api/keys', { method: 'POST', body: JSON.stringify({ name }) });
        view.copied = false;
        view.status = await request('/inference-api');
      });
    });
    container.querySelector('[data-api-copy]')?.addEventListener('click', async () => {
      try { await clipboard?.writeText(view.made?.key ?? ''); view.copied = true; } catch { view.error = 'The key could not be copied: select it and copy it.'; }
      paint();
    });
    container.querySelectorAll('[data-api-revoke]').forEach((button) => button.addEventListener('click', () => { view.confirm = button.dataset.apiRevoke; paint(); }));
    container.querySelector('[data-api-revoke-cancel]')?.addEventListener('click', () => { view.confirm = null; paint(); });
    container.querySelector('[data-api-revoke-confirm]')?.addEventListener('click', (event) => {
      const id = event.currentTarget.dataset.apiRevokeConfirm;
      view.confirm = null;
      void act(async () => {
        await request(`/inference-api/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (view.made?.id === id) view.made = null;
        view.status = await request('/inference-api');
      });
    });
  }
  paint();
  void load();
  return () => { disposed = true; view.made = null; };
}
