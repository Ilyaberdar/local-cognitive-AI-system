// Settings → Report a bug (spec §11). The user writes what happened and ticks what to attach,
// after seeing exactly what it is: diagnostics (versions, system, states, error codes), a
// screenshot of the window, the connected server's diagnostics. Nothing is attached by default.
// Sent through the developer's error tracker, or saved to a file.

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const json = value => escape(JSON.stringify(value, null, 2));

export function reportBugHtml(view) {
  if (!view.bridge) return '<div class="settings-empty"><h2>Reports are sent from the desktop app</h2><p>Open Local Cognitive on your computer to report a problem.</p></div>';
  if (view.loading) return '<div class="usage-loading" role="status"><span class="button-spinner" aria-hidden="true"></span>Preparing the report…</div>';
  if (view.error && !view.prepared) return `<div class="settings-empty" role="alert"><h2>The report could not be prepared</h2><p>${escape(view.error)}</p></div>`;
  if (view.sent) return `<div class="settings-empty report-sent" role="status"><h2>Thank you, the report was sent</h2><p>Report ID <code>${escape(view.sent.reportId)}</code></p><div class="settings-empty-actions"><button type="button" class="ghost-button" data-report-copy>Copy ID</button><button type="button" class="ghost-button" data-report-new>Write another</button></div></div>`;
  const { prepared, form, busy } = view;
  const field = (name, label, rows, hint = '') => `<label class="report-field"><span>${label}</span>${rows ? `<textarea data-report-field="${name}" rows="${rows}" maxlength="${name === 'expected' || name === 'actual' ? 1000 : 4000}" placeholder="${escape(hint)}">${escape(form[name])}</textarea>` : `<input data-report-field="${name}" ${name === 'contact' ? 'type="email" maxlength="320"' : 'maxlength="200" required'} value="${escape(form[name])}" placeholder="${escape(hint)}" />`}</label>`;
  const check = (name, label, note, disabled = false) => `<label class="report-check"><input type="checkbox" data-report-include="${name}" ${form.include[name] ? 'checked' : ''} ${disabled ? 'disabled' : ''} /><span><strong>${label}</strong><small>${note}</small></span></label>`;
  const server = prepared.server;
  return `<div class="report-page">
    <p class="settings-description">Tell the developer what went wrong. Nothing else is attached unless you tick it below, and you can see each part first.</p>
    <div class="report-fields">
      ${field('summary', 'Summary', 0, 'What went wrong, in a sentence')}
      ${field('description', 'What happened', 4)}
      ${field('steps', 'Steps to reproduce', 3, '1. …')}
      <div class="report-pair">${field('expected', 'Expected', 2)}${field('actual', 'Actual', 2)}</div>
      ${field('contact', 'Email for questions (optional)', 0, 'you@example.com')}
    </div>
    <div class="report-attachments">
      ${check('diagnostics', 'Technical diagnostics', 'App and system versions, connection and runtime states, provider and MCP counts, error codes of the last 14 days. No chats, prompts, keys, paths or file contents.')}
      ${form.include.diagnostics ? `<pre class="report-preview" aria-label="Diagnostics to be sent">${json({ ...prepared.diagnostics, log: prepared.log })}</pre>` : ''}
      ${check('screenshot', 'Screenshot of the window', prepared.screenshot ? 'As it was when you chose Report a bug. Check that it shows nothing private.' : 'Open Report a bug from the profile menu to capture the window you were in.', !prepared.screenshot)}
      ${form.include.screenshot && prepared.screenshot ? `<img class="report-screenshot" src="${escape(prepared.screenshot)}" alt="Screenshot to be sent" />` : ''}
      ${server ? check('server', `Diagnostics of ${escape(server.name)}`, 'A separate disclosure: the server’s versions, states and error codes, fetched now.') : ''}
      ${server && form.include.server ? view.serverLoading ? '<p class="usage-sub" role="status">Loading the server’s diagnostics…</p>' : view.serverDiagnostics ? `<pre class="report-preview" aria-label="Server diagnostics to be sent">${json(view.serverDiagnostics)}</pre>` : '' : ''}
    </div>
    ${view.error ? `<p class="report-error" role="alert">${escape(view.error)}</p>` : ''}
    ${view.saved ? '<p class="usage-sub" role="status">The report was saved to a file.</p>' : ''}
    <div class="settings-form-footer"><span class="settings-save-status">${prepared.sendAvailable ? 'Sent to the developer’s error tracker (Sentry, EU).' : 'Sending is not available in this build: save the report to a file.'}</span>
      <span class="settings-form-actions"><button type="button" class="primary-button" data-report-send ${busy || !form.summary.trim() || !prepared.sendAvailable ? 'disabled' : ''}>${busy === 'send' ? '<span class="button-spinner" aria-hidden="true"></span>Sending…' : 'Send report'}</button><button type="button" class="ghost-button" data-report-export ${busy || !form.summary.trim() ? 'disabled' : ''}>Save to file</button></span></div>
  </div>`;
}

const emptyForm = () => ({ summary: '', description: '', steps: '', expected: '', actual: '', contact: '', include: { diagnostics: false, screenshot: false, server: false } });

/** Mounts the page; returns its disposer. `mode`: the screen the user came from (local or a server). */
export function mountReportBugPage(container, { bridge = window.desktopBugReport, mode = 'local' } = {}) {
  if (!container) return () => {};
  const view = { bridge, loading: Boolean(bridge), prepared: null, form: emptyForm(), busy: null, error: '', sent: null, saved: false, serverDiagnostics: null, serverLoading: false };
  let disposed = false;
  const paint = () => {
    if (disposed) return;
    const focused = document.activeElement?.dataset?.reportField, start = document.activeElement?.selectionStart;
    container.innerHTML = reportBugHtml(view);
    if (focused) { const input = container.querySelector(`[data-report-field="${focused}"]`); input?.focus(); if (start !== undefined && input?.setSelectionRange) input.setSelectionRange(start, start); }
  };
  const prepare = async () => {
    view.loading = true; view.error = ''; paint();
    const result = await bridge.prepare({ mode }).catch(error => ({ ok: false, error }));
    view.loading = false;
    if (result?.ok) view.prepared = result.value; else view.error = result?.error?.message || 'The report could not be prepared.';
    paint();
  };
  const payload = () => ({ reportId: view.prepared.reportId, ...view.form, include: { ...view.form.include, screenshot: view.form.include.screenshot && Boolean(view.prepared.screenshot) } });
  const run = async (kind) => {
    view.busy = kind; view.error = ''; view.saved = false; paint();
    const result = await (kind === 'send' ? bridge.submit(payload()) : bridge.export(payload())).catch(error => ({ ok: false, error }));
    view.busy = null;
    if (!result?.ok) view.error = `${result?.error?.message || 'The report failed.'}${kind === 'send' ? ' You can save it to a file instead.' : ''}`;
    else if (kind === 'send') view.sent = result.value;
    else view.saved = Boolean(result.value?.saved);
    paint();
  };
  const onInput = event => {
    const name = event.target.dataset?.reportField;
    if (!name) return;
    const hadSummary = Boolean(view.form.summary.trim());
    view.form[name] = event.target.value;
    // Only the buttons depend on the summary; repainting on every key would fight the cursor.
    if (name === 'summary' && hadSummary !== Boolean(view.form.summary.trim())) paint();
  };
  const onChange = async event => {
    const include = event.target.dataset?.reportInclude;
    if (!include) return;
    view.form.include[include] = event.target.checked;
    if (include === 'server' && event.target.checked && !view.serverDiagnostics) {
      view.serverLoading = true; paint();
      const result = await bridge.serverDiagnostics().catch(error => ({ ok: false, error }));
      view.serverLoading = false;
      if (result?.ok) view.serverDiagnostics = result.value;
      else { view.form.include.server = false; view.error = result?.error?.message || 'The server’s diagnostics could not be loaded.'; }
    }
    paint();
  };
  const onClick = event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.reportSend !== undefined) void run('send');
    else if (button.dataset.reportExport !== undefined) void run('export');
    else if (button.dataset.reportCopy !== undefined) void navigator.clipboard?.writeText(view.sent.reportId).catch(() => {});
    else if (button.dataset.reportNew !== undefined) { Object.assign(view, { sent: null, form: emptyForm(), serverDiagnostics: null }); void prepare(); }
  };
  container.addEventListener('input', onInput);
  container.addEventListener('change', onChange);
  container.addEventListener('click', onClick);
  if (bridge) void prepare(); else paint();
  return () => { disposed = true; container.removeEventListener('input', onInput); container.removeEventListener('change', onChange); container.removeEventListener('click', onClick); };
}
