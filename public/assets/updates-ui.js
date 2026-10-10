// Settings → About → Updates: the user checks for a new version, reads what's new, downloads it and
// chooses when to restart into it. The main process does the work (electron/updates.cjs); this
// shows its state. Release notes are GitHub's HTML: shown only through renderReleaseNotes.
import { renderReleaseNotes } from './markdown-renderer.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const megabytes = bytes => `${(Math.max(0, Number(bytes) || 0) / 1024 ** 2).toFixed(1)} MB`;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** What failed, in words: the main process sends codes only. */
export const updateErrorText = ({ stage, code } = {}) => {
  if (code === 'mac_signature' || code === 'err_updater_invalid_signature') return 'This update is not signed by the developer, so it was not installed. Download the newest version from the website instead.';
  if (code === 'mac_read_only_volume') return 'Local Cognitive is running from the disk image or a temporary location. Move it to Applications, open it from there and update again.';
  if (code === 'err_updater_channel_file_not_found') return 'The new version for your computer is not ready yet. Try again later.';
  if (code === 'err_checksum_mismatch') return 'The download did not match the release. Try again.';
  if (code === 'http_error_403' || code === 'http_error_429') return 'GitHub declined the request for now. Try again in a few minutes.';
  if (String(code).startsWith('net_')) return 'No connection to GitHub. Check the internet connection and try again.';
  return `The update could not be ${stage === 'download' ? 'downloaded' : stage === 'install' ? 'installed' : 'checked'} (${code || 'unknown'}). Try again later.`;
};

/** Local work a restart stops, in words. */
export const workText = (work = {}) => {
  const parts = [work.chatRuns ? plural(work.chatRuns, 'chat') : '', work.workflowRuns ? plural(work.workflowRuns, 'workflow') : '',
    work.synthesisRuns ? `${work.synthesisRuns} Synthesis run${work.synthesisRuns === 1 ? '' : 's'}` : '', work.processRuns ? plural(work.processRuns, 'task') : '',
    work.inferenceBusy ? 'a local model answering' : ''].filter(Boolean);
  return parts.length ? parts.join(', ') : plural(work.total || 0, 'task');
};

const notesHtml = (available, renderNotes) => available?.notes?.length ? `<details class="updates-notes" open><summary>What's new</summary>${available.notes.map(note =>
  `<section><h4>Version ${escape(note.version)}</h4><div class="updates-notes-body">${renderNotes(note.html)}</div></section>`).join('')}</details>` : '';

/** The panel for a state from the main process (and the confirmation the window is showing, if any). */
export function updatesHtml(state, { confirm, renderNotes = renderReleaseNotes } = {}) {
  if (!state) return '<p class="settings-description">Updates are installed by the desktop app.</p>';
  const row = (title, text, actions = '') => `<div class="settings-rows"><div class="settings-row"><div><span class="settings-row-label">${title}</span>${text ? `<p>${text}</p>` : ''}</div>${actions ? `<div class="settings-control updates-actions">${actions}</div>` : ''}</div></div>`;
  const error = state.error ? `<p class="settings-description is-error" role="alert">${escape(updateErrorText(state.error))}</p>` : '';
  if (state.blocker === 'development') return row('Updates', `This is a development run (${escape(state.current)}): installed builds update themselves.`);
  const available = state.available;
  const button = (action, label, primary = false) => `<button type="button" class="${primary ? 'primary-button' : 'ghost-button'}" data-update-action="${action}">${label}</button>`;
  switch (state.phase) {
    case 'checking':
      return row('Checking for updates…', '', '<span class="button-spinner" aria-hidden="true"></span>');
    case 'up-to-date':
      return `${row(`Local Cognitive ${escape(state.current)} is up to date`, state.checkedAt ? `Checked at ${escape(new Date(state.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}.` : '', button('check', 'Check again'))}${error}`;
    case 'available':
      return `${row(`Version ${escape(available?.version)} is available`, `You have ${escape(state.current)}.${available?.size ? ` Download: ${megabytes(available.size)}.` : ''}${state.blocker === 'move-to-applications' ? ' Move Local Cognitive to Applications to install it.' : state.blocker === 'windows-unsigned' ? ' Download it from the website: updates install by themselves once Windows builds are signed.' : ''}`,
        state.blocker ? '' : button('download', 'Download', true))}${error}${notesHtml(available, renderNotes)}`;
    case 'downloading': {
      const progress = state.progress ?? {};
      return `${row(`Downloading ${escape(available?.version)}…`, `<span data-update-progress-text>${progressText(progress)}</span>`, button('cancel', 'Cancel'))}
        <progress class="updates-progress" data-update-progress max="100" value="${Math.round(progress.percent || 0)}" aria-label="Download progress"></progress>${notesHtml(available, renderNotes)}`;
    }
    case 'ready':
      if (confirm) return `${row(`Version ${escape(available?.version)} is ready`, `Running on this computer: ${escape(workText(confirm))}. Restarting stops it; model downloads pause and resume after. Work on your server goes on.`,
        `${button('install-anyway', 'Restart anyway', true)}${button('not-now', 'Not now')}`)}${notesHtml(available, renderNotes)}`;
      return `${row(`Version ${escape(available?.version)} is ready to install`, 'Local Cognitive restarts to finish. Your chats and settings stay.', button('install', 'Restart and update', true))}${error}${notesHtml(available, renderNotes)}`;
    case 'installing':
      return row('Preparing the update…', 'Local Cognitive restarts by itself in a moment.', '<span class="button-spinner" aria-hidden="true"></span>');
    default:
      return `${row('Updates', `You have Local Cognitive ${escape(state.current)}.`, button('check', 'Check for updates'))}${error}`;
  }
}

const progressText = (progress = {}) => {
  const parts = [`${Math.round(progress.percent || 0)}%`];
  if (progress.total) parts.push(`${megabytes(progress.transferred)} of ${megabytes(progress.total)}`);
  if (progress.bytesPerSecond) parts.push(`${megabytes(progress.bytesPerSecond)}/s`);
  return parts.join(' · ');
};

/** Mounts the panel; returns its disposer. */
export function mountUpdatesPanel(container, { bridge = window.desktopUpdates, renderNotes = renderReleaseNotes } = {}) {
  if (!container) return () => {};
  if (!bridge) { container.innerHTML = updatesHtml(undefined); return () => {}; }
  let state, confirm, disposed = false, shown = '';
  const paint = () => {
    if (disposed) return;
    // Progress moves in place: what's new and its scroll position stay as they are.
    const key = `${state?.phase}|${state?.available?.version}|${state?.error?.code ?? ''}|${state?.blocker ?? ''}|${Boolean(confirm)}|${state?.checkedAt ?? ''}`;
    if (key === shown && state?.phase === 'downloading') {
      const bar = container.querySelector('[data-update-progress]'), text = container.querySelector('[data-update-progress-text]');
      if (bar) bar.value = Math.round(state.progress?.percent || 0);
      if (text) text.textContent = progressText(state.progress);
      return;
    }
    shown = key;
    container.innerHTML = updatesHtml(state, { confirm, renderNotes });
  };
  const apply = next => { state = next; if (state?.phase !== 'ready') confirm = undefined; paint(); };
  const off = bridge.onChange?.(apply);
  container.addEventListener('click', async event => {
    const action = event.target.closest?.('[data-update-action]')?.dataset.updateAction;
    if (!action) return;
    if (action === 'check') apply(await bridge.check());
    else if (action === 'download') apply(await bridge.download());
    else if (action === 'cancel') apply(await bridge.cancel());
    else if (action === 'not-now') { confirm = undefined; paint(); }
    else if (action === 'install' || action === 'install-anyway') {
      const result = await bridge.install(action === 'install-anyway');
      if (!result.started && result.work) { confirm = result.work; paint(); } else apply(result.state);
    }
  });
  void bridge.state().then(apply);
  return () => { disposed = true; off?.(); };
}
