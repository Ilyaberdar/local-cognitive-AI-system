// Windows: GPU acceleration. The installer's llama.cpp uses any GPU through Vulkan; on an NVIDIA GPU
// the CUDA build is faster and is downloaded on request (src/local/GpuRuntimeService.ts). NVIDIA's
// license is shown before anything is downloaded. Offered once at first launch (a dialog) and kept in
// Settings → Local Runtime.

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const megabytes = bytes => `${Math.round((Number(bytes) || 0) / 1024 ** 2)} MB`;
const gigabytes = bytes => `${((Number(bytes) || 0) / 1024 ** 3).toFixed(1)} GB`;
const LICENSE_TOKEN = 'nvidia-cuda-eula';
const ACTIVE = new Set(['downloading', 'installing', 'removing']);

/** NVIDIA's license, before anything is downloaded. */
const licenseNotice = license => `<p class="gpu-runtime-license">The CUDA runtime includes NVIDIA CUDA Runtime and cuBLAS libraries, distributed under the
  <a href="${escape(/^https:\/\//.test(license?.url ?? '') ? license.url : 'https://docs.nvidia.com/cuda/eula/')}" target="_blank" rel="noopener noreferrer">${escape(license?.name || 'NVIDIA CUDA Toolkit End User License Agreement')}</a>.
  Installing it means you agree to it.</p>`;

const progressText = progress => progress?.totalBytes
  ? `${megabytes(progress.receivedBytes)} of ${megabytes(progress.totalBytes)}${progress.bytesPerSecond ? ` · ${(progress.bytesPerSecond / 1024 ** 2).toFixed(1)} MB/s` : ''}` : 'Starting…';

/** The CUDA part of the card (or of the offer dialog) for a state. */
export function cudaHtml(acceleration, { confirming = false, busy = false, error = '' } = {}) {
  const cuda = acceleration?.cuda;
  if (!cuda) return '';
  const button = (action, label, primary = false) => `<button type="button" class="${primary ? 'primary-button' : 'ghost-button'}" data-gpu-action="${action}" ${busy ? 'disabled' : ''}>${label}</button>`;
  const size = cuda.downloadBytes ? `Download: ${megabytes(cuda.downloadBytes)}${cuda.installedBytes ? `, ${gigabytes(cuda.installedBytes)} on disk` : ''}.` : '';
  const failure = error || cuda.reason;
  switch (cuda.state) {
    case 'downloading':
      return `<p class="gpu-runtime-status" data-gpu-progress-text>Downloading the CUDA runtime: ${escape(progressText(cuda.progress))}</p>
        <progress class="lc-progress" data-gpu-progress max="100" value="${cuda.progress?.totalBytes ? Math.round(cuda.progress.receivedBytes / cuda.progress.totalBytes * 100) : 0}" aria-label="CUDA runtime download"></progress>
        <p class="settings-description">Models keep running on Vulkan meanwhile. A cancelled download continues where it stopped.</p>${button('cancel', 'Cancel')}`;
    case 'installing':
      return `<p class="gpu-runtime-status"><span class="button-spinner" aria-hidden="true"></span>Checking and installing the CUDA runtime…</p>`;
    case 'removing':
      return `<p class="gpu-runtime-status"><span class="button-spinner" aria-hidden="true"></span>Removing the CUDA runtime…</p>`;
    case 'installed':
      return `<p class="gpu-runtime-status">The CUDA runtime is installed: models on this GPU use it.</p>${error ? `<p class="settings-description is-error" role="alert">${escape(error)}</p>` : ''}
        ${button('remove', `Remove CUDA runtime${cuda.installedBytes ? ` (frees ${gigabytes(cuda.installedBytes)})` : ''}`)}`;
    case 'failed':
      return `<p class="settings-description is-error" role="alert">${escape(failure || 'The CUDA runtime could not use this GPU.')} Models run on Vulkan.</p>${button('confirm', 'Try again')}${button('remove', 'Remove CUDA runtime')}`;
    case 'available':
      if (confirming) return `${licenseNotice(cuda.license)}<div class="gpu-runtime-actions">${button('confirm', 'Agree and install', true)}${button('not-now', 'Cancel')}</div>`;
      return `<p class="settings-description">With the CUDA runtime, models on this NVIDIA GPU run faster than with Vulkan (about 1.5× in our tests). ${escape(size)}</p>
        ${failure ? `<p class="settings-description is-error" role="alert">${escape(failure)}</p>` : ''}${button('install', failure ? 'Try again' : 'Install CUDA runtime', true)}`;
    default:
      return `<p class="settings-description">${escape(failure || 'CUDA needs an NVIDIA GPU.')}</p>${acceleration.gpu ? button('detect', 'Check again') : ''}`;
  }
}

/** Settings → Local Runtime: the GPU, what models run on, and the CUDA runtime. */
export function accelerationHtml(acceleration, options = {}) {
  if (!acceleration) return '';
  const gpu = acceleration.gpu;
  const runsOn = options.backend || (acceleration.cuda?.state === 'installed' ? 'CUDA' : 'Vulkan');
  return `<section class="gpu-runtime" aria-labelledby="gpu-runtime-title"><h3 id="gpu-runtime-title">GPU acceleration</h3>
    <div class="settings-rows"><div class="settings-row"><span>Graphics card</span><span>${gpu ? escape([gpu.name, gpu.memoryBytes ? gigabytes(gpu.memoryBytes) : '', `driver ${gpu.driver}`].filter(Boolean).join(' · ')) : 'No NVIDIA GPU found'}</span></div>
      <div class="settings-row"><span>Models run on</span><span>${escape(runsOn)}</span></div></div>
    <div class="gpu-runtime-cuda" data-gpu-cuda>${cudaHtml(acceleration, options)}</div></section>`;
}

/** Keeps a container showing the GPU state; the buttons install, cancel, remove and look again. */
function mountGpu(container, { request, getRuntime, render, onDone }) {
  let runtime = getRuntime?.(), confirming = false, busy = false, error = '', timer, disposed = false, shown = '';
  const paint = () => {
    if (disposed) return;
    const cuda = runtime?.acceleration?.cuda;
    // Progress moves in place: the rest of the page (and the focus) stays.
    const key = `${cuda?.state}|${confirming}|${busy}|${error}|${cuda?.reason}|${runtime?.backend}`;
    const bar = container.querySelector('[data-gpu-progress]'), text = container.querySelector('[data-gpu-progress-text]');
    if (key === shown && cuda?.state === 'downloading' && bar && text) {
      bar.value = cuda.progress?.totalBytes ? Math.round(cuda.progress.receivedBytes / cuda.progress.totalBytes * 100) : 0;
      text.textContent = `Downloading the CUDA runtime: ${progressText(cuda.progress)}`;
      return;
    }
    shown = key;
    container.innerHTML = render(runtime?.acceleration, { confirming, busy, error, backend: runtime?.backend });
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!disposed) timer = setTimeout(refresh, ACTIVE.has(runtime?.acceleration?.cuda?.state) ? 1000 : 5000);
  };
  async function refresh() {
    try { runtime = (await request('/local/runtime'))?.runtime ?? runtime; } catch { /* the next refresh tries again */ }
    paint(); schedule();
    if (runtime?.acceleration?.cuda?.state === 'installed') onDone?.(runtime);
  }
  const act = async (url, init) => {
    busy = true; error = ''; paint();
    try { const acceleration = await request(url, init); if (acceleration?.cuda) runtime = { ...runtime, acceleration }; }
    catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    finally { busy = false; confirming = false; }
    paint(); schedule();
  };
  container.addEventListener('click', event => {
    const action = event.target.closest?.('[data-gpu-action]')?.dataset.gpuAction;
    if (action === 'install') { confirming = true; paint(); }
    else if (action === 'not-now') { confirming = false; paint(); }
    else if (action === 'confirm') void act('/local/runtime/cuda/install', { method: 'POST', body: JSON.stringify({ license: LICENSE_TOKEN }) });
    else if (action === 'cancel') void act('/local/runtime/cuda/cancel', { method: 'POST', body: '{}' });
    else if (action === 'remove') void act('/local/runtime/cuda', { method: 'DELETE', timeoutMs: 180000 });
    else if (action === 'detect') void act('/local/runtime/gpu/detect', { method: 'POST', body: '{}' });
  });
  paint(); void refresh();
  return () => { disposed = true; clearTimeout(timer); };
}

/** Settings → Local Runtime. Returns its disposer. */
export function mountGpuRuntimePanel(container, { request, getRuntime }) {
  if (!container) return () => {};
  return mountGpu(container, { request, getRuntime, render: accelerationHtml });
}

/**
 * At first launch on an NVIDIA PC: a dialog offering the CUDA runtime, once. "Not now" is remembered
 * by the app (Settings keeps the button); "Install" shows the license, then the download in place.
 * Looks a few times after startup, while the app is still looking for the GPU.
 */
export function createCudaOffer({ request, doc = document, delays = [3000, 10000, 30000] }) {
  let shown = false;
  const timers = delays.map(delay => setTimeout(() => void check(), delay));
  async function check() {
    if (shown) return;
    let runtime;
    try { runtime = (await request('/local/runtime'))?.runtime; } catch { return; }
    const acceleration = runtime?.acceleration;
    if (!acceleration?.cuda?.offer || shown) return;
    shown = true;
    timers.forEach(clearTimeout);
    open(runtime);
  }
  function open(shownRuntime) {
    let runtime = shownRuntime;
    const gpu = runtime.acceleration.gpu;
    const dialog = doc.createElement('dialog');
    dialog.className = 'cuda-offer';
    dialog.setAttribute('aria-labelledby', 'cuda-offer-title');
    const cuda = runtime.acceleration.cuda;
    dialog.innerHTML = `<h2 id="cuda-offer-title">Speed up models on your NVIDIA GPU</h2>
      <p>Local Cognitive found ${escape(gpu?.name || 'an NVIDIA GPU')}. Models already use it through Vulkan; with the CUDA runtime they run faster (about 1.5× in our tests).
      It is a one-time download of ${megabytes(cuda.downloadBytes)}${cuda.installedBytes ? ` (${gigabytes(cuda.installedBytes)} on disk)` : ''}.</p>
      ${licenseNotice(cuda.license)}
      <div class="gpu-runtime-actions"><button type="button" class="primary-button" data-offer="install">Agree and install</button><button type="button" class="ghost-button" data-offer="later">Not now</button></div>
      <div class="cuda-offer-progress" data-offer-progress hidden></div>`;
    doc.body.append(dialog);
    let dispose;
    const close = () => { dispose?.(); dialog.close(); dialog.remove(); };
    dialog.addEventListener('cancel', () => { void request('/local/runtime/cuda/dismiss', { method: 'POST', body: '{}' }).catch(() => undefined); });
    dialog.addEventListener('click', async event => {
      const action = event.target.closest?.('[data-offer]')?.dataset.offer;
      if (action === 'later') {
        void request('/local/runtime/cuda/dismiss', { method: 'POST', body: '{}' }).catch(() => undefined);
        close();
      } else if (action === 'install') {
        const progress = dialog.querySelector('[data-offer-progress]');
        dialog.querySelector('.gpu-runtime-actions').hidden = true;
        dialog.querySelector('.gpu-runtime-license').hidden = true;
        progress.hidden = false;
        try {
          // The download has started: the progress shows from the answer, not the state before it.
          const started = await request('/local/runtime/cuda/install', { method: 'POST', body: JSON.stringify({ license: LICENSE_TOKEN }) });
          if (started?.cuda) runtime = { ...runtime, acceleration: started };
        } catch (failure) { progress.innerHTML = `<p class="settings-description is-error" role="alert">${escape(failure instanceof Error ? failure.message : String(failure))}</p>`; }
        dispose = mountGpu(progress, { request, getRuntime: () => runtime, render: (acceleration, options) => `${cudaHtml(acceleration, options)}<button type="button" class="ghost-button" data-offer="close">Close</button>`,
          onDone: () => undefined });
      } else if (action === 'close') close();
    });
    dialog.showModal();
  }
  return { dispose: () => timers.forEach(clearTimeout), check };
}
