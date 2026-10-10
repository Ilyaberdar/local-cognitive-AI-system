// Settings → Report a bug (spec §11): the user writes what went wrong and presses Send. The app
// adds diagnostics (versions, states, error codes, what it did before the problem, and the
// connected server's) and, if the user turns it on, a screenshot; each can be seen before sending.
// Diagnostics are on when the user allowed error reports, and off otherwise until switched on.

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function reportBugHtml(view) {
  if (!view.bridge) return '<p class="settings-description">Reports are sent from the desktop app.</p>';
  if (view.loading) return '<div class="usage-loading" role="status"><span class="button-spinner" aria-hidden="true"></span>Preparing…</div>';
  if (view.error && !view.prepared) return `<p class="settings-description is-error" role="alert">${escape(view.error)}</p>`;
  if (view.sent) return `<div class="settings-rows"><div class="settings-row"><div><span class="settings-row-label">Thank you, the report was sent</span><p>Report ID <code class="report-id">${escape(view.sent.reportId)}</code></p></div><div class="settings-control"><button type="button" class="ghost-button" data-report-new>New report</button></div></div></div>`;
  const { prepared, form, busy, shown } = view;
  const toggle = (name, label, text, disabled = false) => `<div class="settings-row"><div><label for="report-${name}">${label}</label><p>${text}</p></div><div class="settings-control"><input id="report-${name}" type="checkbox" role="switch" data-report-include="${name}" ${form.include[name] ? 'checked' : ''} ${disabled ? 'disabled' : ''} /></div></div>`;
  const show = name => `<button type="button" class="settings-text-button" data-report-show="${name}" aria-expanded="${shown[name]}">${shown[name] ? 'Hide' : 'Show what is sent'}</button>`;
  const status = busy ? 'Sending…' : view.error || (form.message.trim() ? 'Goes to the developer (Sentry, EU region).' : 'Describe the problem to send it.');
  return `<p class="settings-description">Something broke? Describe it in detail and press Send. For a quick note, use the bug button at the top of the app.</p>
  <div class="settings-rows report-card">
    <div class="settings-row report-message-row"><div><label for="report-message">Describe the problem</label><p>What you did, what happened, and what you expected: as much as helps. The app adds what it knows.</p></div>
      <div class="settings-control"><textarea id="report-message" data-report-message rows="8" maxlength="4000" placeholder="For example: I attached a PDF to a chat with the local model, and it stopped answering after a minute.">${escape(form.message)}</textarea></div></div>
    ${toggle('diagnostics', 'Attach diagnostics', `Versions, states and error codes, and what the app did before the problem. No chats, prompts, keys or files${prepared.diagnostics?.server ? ', and the same from the connected server' : ''}. ${show('diagnostics')}`)}
    ${shown.diagnostics ? `<div class="report-preview-row"><pre class="report-preview" aria-label="Diagnostics">${escape(JSON.stringify(prepared.diagnostics, null, 2))}</pre></div>` : ''}
    ${toggle('screenshot', 'Attach a screenshot', prepared.screenshot ? `The window as it was when you opened Report a bug. ${show('screenshot')}` : 'Open Report a bug from the profile menu to capture the window you were in.', !prepared.screenshot)}
    ${shown.screenshot && prepared.screenshot ? `<div class="report-preview-row"><img class="report-screenshot" src="${escape(prepared.screenshot)}" alt="Screenshot" /></div>` : ''}
  </div>
  <div class="settings-form-footer"><span role="status" aria-live="polite" class="settings-save-status ${view.error ? 'is-error' : ''}">${escape(status)}</span>
    <span class="settings-form-actions">${view.failed ? `<button type="button" class="ghost-button" data-report-export ${busy ? 'disabled' : ''}>${view.saved ? 'Saved to a file' : 'Save to file'}</button>` : ''}<button type="button" class="primary-button" data-report-send ${busy || !form.message.trim() || !prepared.sendAvailable ? 'disabled' : ''}>Send</button></span></div>`;
}

const emptyForm = (diagnostics = false) => ({ message: '', include: { diagnostics, screenshot: false } });

/** Mounts the page; returns its disposer. `mode`: the screen the user came from (local or a server). */
export function mountReportBugPage(container, { bridge = window.desktopBugReport, mode = 'local' } = {}) {
  if (!container) return () => {};
  const view = { bridge, loading: Boolean(bridge), prepared: null, form: emptyForm(), busy: false, error: '', failed: false, saved: false, sent: null, shown: { diagnostics: false, screenshot: false } };
  let disposed = false;
  const paint = () => {
    if (disposed) return;
    const typing = document.activeElement?.matches?.('[data-report-message]') ? document.activeElement.selectionStart : undefined;
    container.innerHTML = reportBugHtml(view);
    if (typing !== undefined) { const area = container.querySelector('[data-report-message]'); area?.focus(); area?.setSelectionRange(typing, typing); }
  };
  const prepare = async () => {
    view.loading = true; view.error = ''; paint();
    const result = await bridge.prepare({ mode }).catch(error => ({ ok: false, error }));
    view.loading = false;
    if (result?.ok) { view.prepared = result.value; view.form = emptyForm(Boolean(result.value.diagnosticsByDefault)); }
    else view.error = result?.error?.message || 'The report could not be prepared.';
    paint();
  };
  const payload = () => ({ reportId: view.prepared.reportId, message: view.form.message, include: { ...view.form.include, screenshot: view.form.include.screenshot && Boolean(view.prepared.screenshot) } });
  const send = async () => {
    view.busy = true; view.error = ''; paint();
    const result = await bridge.submit(payload()).catch(error => ({ ok: false, error }));
    view.busy = false;
    if (result?.ok) view.sent = result.value;
    else { view.failed = true; view.error = `Not sent. ${result?.error?.message || 'The report failed.'} You can save it to a file and send it later.`; }
    paint();
  };
  const save = async () => {
    const result = await bridge.export(payload()).catch(error => ({ ok: false, error }));
    if (result?.ok) view.saved = Boolean(result.value?.saved); else view.error = result?.error?.message || 'The file was not saved.';
    paint();
  };
  const onInput = event => {
    if (!event.target.matches?.('[data-report-message]')) return;
    const had = Boolean(view.form.message.trim());
    view.form.message = event.target.value;
    // Only the Send button depends on the text; repainting on every key would fight the cursor.
    if (had !== Boolean(view.form.message.trim())) paint();
  };
  const onChange = event => {
    const name = event.target.dataset?.reportInclude;
    if (!name) return;
    view.form.include[name] = event.target.checked;
    if (name === 'screenshot' && event.target.checked) view.shown.screenshot = true;
    paint();
  };
  const onClick = event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.reportSend !== undefined) void send();
    else if (button.dataset.reportExport !== undefined) void save();
    else if (button.dataset.reportShow) { view.shown[button.dataset.reportShow] = !view.shown[button.dataset.reportShow]; paint(); }
    else if (button.dataset.reportNew !== undefined) { Object.assign(view, { sent: null, failed: false, saved: false, shown: { diagnostics: false, screenshot: false } }); void prepare(); }
  };
  container.addEventListener('input', onInput);
  container.addEventListener('change', onChange);
  container.addEventListener('click', onClick);
  if (bridge) void prepare(); else paint();
  return () => { disposed = true; container.removeEventListener('input', onInput); container.removeEventListener('change', onChange); container.removeEventListener('click', onClick); };
}
