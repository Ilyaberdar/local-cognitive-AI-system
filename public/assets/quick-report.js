// A bug report from anywhere (the bug button in the top bar): what went wrong, and Send.
// Diagnostics go along when the user allowed error reports (Data & Privacy), as on the full page;
// More options opens Settings → Report a bug with a screenshot of the window to choose from.

export function createQuickReport({ bridge = window.desktopBugReport, mode = () => 'local', onMore = () => {} } = {}) {
  let panel, prepared, preparing, busy = false, failed = false, closeTimer, opened = false;
  const element = selector => panel?.querySelector(selector);
  const note = (text, kind = '') => { const slot = element('[data-quick-status]'); if (slot) { slot.textContent = text; slot.className = `quick-report__status settings-save-status ${kind}`; } };
  const canSend = () => Boolean(element('[data-quick-message]')?.value.trim()) && !busy;
  const refresh = () => {
    const send = element('[data-quick-send]'); if (send) send.disabled = !canSend();
    const save = element('[data-quick-export]'); if (save) save.hidden = !failed;
  };
  const defaultNote = () => prepared?.diagnosticsByDefault
    ? 'Diagnostics go along (error reports are on). No chats, prompts, keys or files.'
    : 'Only your text is sent. More options lets you attach diagnostics.';
  const payload = () => ({ reportId: prepared.reportId, message: element('[data-quick-message]').value, include: { diagnostics: Boolean(prepared.diagnosticsByDefault), screenshot: false } });

  const prepare = () => preparing ??= bridge.prepare({ mode: mode() }).then(result => {
    if (!result?.ok) throw new Error(result?.error?.message || 'The report could not be prepared.');
    prepared = result.value;
    if (!busy) note(defaultNote());
    return prepared;
  }).catch(error => { preparing = undefined; note(error.message, 'is-error'); throw error; });

  async function send() {
    if (!canSend()) return;
    busy = true; refresh(); note('Sending…');
    try {
      await prepare();
      const result = await bridge.submit(payload());
      if (!result?.ok) throw new Error(result?.error?.message || 'The report failed.');
      failed = false;
      note('Sent. Thank you!', 'is-success');
      const area = element('[data-quick-message]'); if (area) area.value = '';
      prepared = undefined; preparing = undefined;
      closeTimer = setTimeout(close, 1800);
    } catch (error) {
      failed = true;
      note(`Not sent. ${error instanceof Error ? error.message : String(error)} You can save it to a file.`, 'is-error');
    }
    busy = false; refresh();
  }

  async function save() {
    try {
      await prepare();
      const result = await bridge.export(payload());
      if (!result?.ok) throw new Error(result?.error?.message || 'The file was not saved.');
      if (result.value?.saved) note('Saved to a file.', 'is-success');
    } catch (error) { note(error instanceof Error ? error.message : String(error), 'is-error'); }
  }

  function build() {
    panel = document.createElement('div');
    panel.className = 'quick-report';
    panel.setAttribute('popover', 'auto');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Report a bug');
    panel.innerHTML = `<form class="quick-report__form"><strong class="quick-report__title">Report a bug</strong>
      <textarea data-quick-message rows="4" maxlength="4000" placeholder="What went wrong?" aria-label="What went wrong?"></textarea>
      <p class="quick-report__status settings-save-status" role="status" aria-live="polite" data-quick-status></p>
      <div class="quick-report__actions"><button type="button" class="settings-text-button" data-quick-more>More options</button>
        <span><button type="button" class="ghost-button" data-quick-export hidden>Save to file</button><button type="submit" class="primary-button" data-quick-send disabled>Send</button></span></div></form>`;
    panel.querySelector('form').addEventListener('submit', event => { event.preventDefault(); void send(); });
    panel.addEventListener('input', refresh);
    panel.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } });
    panel.querySelector('[data-quick-export]').addEventListener('click', () => void save());
    panel.querySelector('[data-quick-more]').addEventListener('click', () => { close(); onMore(); });
    panel.addEventListener('toggle', event => { opened = event.newState === 'open'; if (!opened) clearTimeout(closeTimer); });
    document.body.append(panel);
  }

  function open(anchor) {
    if (!bridge) return;
    if (!panel) build();
    clearTimeout(closeTimer);
    failed = false; refresh();
    note(prepared ? defaultNote() : '');
    panel.showPopover(); opened = true;
    const rect = anchor?.getBoundingClientRect?.();
    if (rect) {
      panel.style.left = `${Math.max(8, Math.min(rect.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 8))}px`;
      panel.style.top = `${Math.min(rect.bottom + 8, innerHeight - panel.offsetHeight - 8)}px`;
    }
    element('[data-quick-message]')?.focus();
    void prepare().catch(() => {});
  }

  function close() { clearTimeout(closeTimer); if (opened) { opened = false; try { panel.hidePopover(); } catch { /* Already closed. */ } } }

  return { open, close, isOpen: () => opened };
}
