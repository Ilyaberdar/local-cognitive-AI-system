// Choosing a profile picture's area: the image under a round frame with a grid, moved by dragging
// (or the arrow keys) and zoomed with the slider, the wheel or a pinch; Apply saves exactly the
// square inside the frame, so every round avatar shows what was chosen.

const VIEW = 300;
const OUTPUT = 512;
export const MAX_ZOOM = 5;

/** The scale at which the image just covers the square view. */
export const coverScale = (view, width, height) => view / Math.min(width, height);

/** Keeps the image covering the whole view: no empty edge at any side. */
export const clampOffset = (view, width, height, scale, x, y) => ({
  x: Math.min(0, Math.max(view - width * scale, x)),
  y: Math.min(0, Math.max(view - height * scale, y))
});

/** A new scale with the point (px, py) of the view staying over the same spot of the image. */
export const zoomAt = (view, width, height, from, to, x, y, px = view / 2, py = view / 2) => {
  const imageX = (px - x) / from, imageY = (py - y) / from;
  return clampOffset(view, width, height, to, px - imageX * to, py - imageY * to);
};

/** The square of the image (in its own pixels) that the view shows. */
export const cropRect = (view, scale, x, y) => ({ sx: -x / scale, sy: -y / scale, size: view / scale });

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

/** Opens the cropper for an image (a data URL); resolves with the chosen square as a data URL,
 * or null when cancelled. */
export function openAvatarCropper(src, { document: doc = document } = {}) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error('This image could not be opened.'));
    image.onload = () => {
      const width = image.naturalWidth, height = image.naturalHeight;
      if (!width || !height) { reject(new Error('This image could not be opened.')); return; }
      const base = coverScale(VIEW, width, height);
      let zoom = 1, scale = base, { x, y } = clampOffset(VIEW, width, height, base, (VIEW - width * base) / 2, (VIEW - height * base) / 2);
      const dialog = doc.createElement('dialog');
      dialog.className = 'avatar-crop';
      dialog.setAttribute('aria-labelledby', 'avatar-crop-title');
      dialog.innerHTML = `<form method="dialog" class="avatar-crop__form">
        <h2 id="avatar-crop-title">Choose the picture's area</h2>
        <p class="settings-description">Drag to move, zoom with the slider or the wheel. The circle is what your avatar shows.</p>
        <div class="avatar-crop__view" tabindex="0" role="application" aria-label="Picture area: arrow keys move it, plus and minus zoom" style="width:${VIEW}px;height:${VIEW}px">
          <img class="avatar-crop__image" src="${escape(src)}" alt="" draggable="false" />
          <div class="avatar-crop__frame" aria-hidden="true"></div>
        </div>
        <label class="avatar-crop__zoom"><span>Zoom</span><input type="range" min="1" max="${MAX_ZOOM}" step="0.01" value="1" data-avatar-zoom aria-label="Zoom" /></label>
        <div class="avatar-crop__actions"><button type="button" class="ghost-button" data-avatar-cancel>Cancel</button><button type="button" class="primary-button" data-avatar-apply>Apply</button></div>
      </form>`;
      const view = dialog.querySelector('.avatar-crop__view'), picture = dialog.querySelector('.avatar-crop__image'), slider = dialog.querySelector('[data-avatar-zoom]');
      const paint = () => {
        picture.style.width = `${width * scale}px`; picture.style.height = `${height * scale}px`;
        picture.style.transform = `translate(${x}px, ${y}px)`;
        slider.value = String(zoom);
      };
      const setZoom = (next, px, py) => {
        const target = Math.min(MAX_ZOOM, Math.max(1, next));
        ({ x, y } = zoomAt(VIEW, width, height, scale, base * target, x, y, px, py));
        zoom = target; scale = base * target; paint();
      };
      const move = (dx, dy) => { ({ x, y } = clampOffset(VIEW, width, height, scale, x + dx, y + dy)); paint(); };
      let finished = false;
      const finish = value => { if (finished) return; finished = true; dialog.close(); dialog.remove(); resolve(value); };

      let drag;
      view.addEventListener('pointerdown', event => { drag = { id: event.pointerId, x: event.clientX, y: event.clientY }; view.setPointerCapture?.(event.pointerId); view.classList.add('is-dragging'); });
      view.addEventListener('pointermove', event => {
        if (!drag || drag.id !== event.pointerId) return;
        move(event.clientX - drag.x, event.clientY - drag.y);
        drag.x = event.clientX; drag.y = event.clientY;
      });
      const stop = () => { drag = undefined; view.classList.remove('is-dragging'); };
      view.addEventListener('pointerup', stop); view.addEventListener('pointercancel', stop);
      // The wheel, and a trackpad pinch (a wheel event with ctrlKey), zoom around the pointer.
      view.addEventListener('wheel', event => {
        event.preventDefault();
        const rect = view.getBoundingClientRect();
        setZoom(zoom * Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)), event.clientX - rect.left, event.clientY - rect.top);
      }, { passive: false });
      view.addEventListener('keydown', event => {
        const step = event.shiftKey ? 40 : 10;
        const keys = { ArrowLeft: () => move(step, 0), ArrowRight: () => move(-step, 0), ArrowUp: () => move(0, step), ArrowDown: () => move(0, -step),
          '+': () => setZoom(zoom * 1.1), '=': () => setZoom(zoom * 1.1), '-': () => setZoom(zoom / 1.1) };
        if (keys[event.key]) { event.preventDefault(); keys[event.key](); }
      });
      slider.addEventListener('input', () => setZoom(Number(slider.value)));
      dialog.querySelector('[data-avatar-cancel]').addEventListener('click', () => finish(null));
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
      dialog.querySelector('[data-avatar-apply]').addEventListener('click', () => {
        const { sx, sy, size } = cropRect(VIEW, scale, x, y);
        const canvas = doc.createElement('canvas');
        canvas.width = OUTPUT; canvas.height = OUTPUT;
        const context = canvas.getContext('2d');
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, sx, sy, size, size, 0, 0, OUTPUT, OUTPUT);
        // WebP keeps a transparent background and stays small; PNG where it is not available.
        const webp = canvas.toDataURL('image/webp', 0.9);
        finish(webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png'));
      });
      doc.body.append(dialog);
      paint();
      dialog.showModal();
      view.focus();
    };
    image.src = src;
  });
}
