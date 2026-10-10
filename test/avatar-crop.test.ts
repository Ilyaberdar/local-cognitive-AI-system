import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require("jsdom");
const bundle = buildSync({ entryPoints: ["public/assets/avatar-crop.js"], bundle: true, write: false, format: "iife", globalName: "AvatarCrop" }).outputFiles[0].text;

const load = () => {
  const dom = new JSDOM("<main></main>", { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.eval(`${bundle}\nwindow.AvatarCrop = AvatarCrop;`);
  return dom;
};

test("the image always covers the frame; zoom keeps the point under the pointer; the crop is what the frame shows", () => {
  const dom = load();
  const { coverScale, clampOffset, zoomAt, cropRect } = dom.window.AvatarCrop;
  // A portrait photo 1000x2000 in a 300 px view: scaled to 300x600.
  const scale = coverScale(300, 1000, 2000);
  assert.equal(scale, 0.3);
  assert.deepEqual({ ...clampOffset(300, 1000, 2000, scale, 50, 10) }, { x: 0, y: 0 }, "no empty edge on the left or top");
  assert.deepEqual({ ...clampOffset(300, 1000, 2000, scale, -10, -400) }, { x: 0, y: -300 }, "nor on the right or bottom");
  // Zooming x2 around the view's centre from the top of the photo (y = 0).
  const zoomed = zoomAt(300, 1000, 2000, 0.3, 0.6, 0, 0);
  assert.deepEqual({ ...zoomed }, { x: -150, y: -150 });
  // At the top-left corner, the point under it stays.
  assert.deepEqual({ ...zoomAt(300, 1000, 2000, 0.3, 0.6, 0, 0, 0, 0) }, { x: 0, y: 0 });
  assert.deepEqual({ ...cropRect(300, 0.6, -150, -150) }, { sx: 250, sy: 250, size: 500 }, "a 500 px square of the photo, from (250, 250)");
  dom.window.close();
});

test("the cropper: move, zoom, Apply gives the chosen square; Cancel gives nothing", async () => {
  const dom = load();
  const window = dom.window;
  // jsdom loads no images and draws nothing: a 1000x2000 image and a canvas that records the draw.
  class FakeImage { naturalWidth = 1000; naturalHeight = 2000; onload?: () => void; onerror?: () => void; set src(_value: string) { setTimeout(() => this.onload?.(), 0); } }
  window.Image = FakeImage;
  const draws: number[][] = [];
  window.HTMLCanvasElement.prototype.getContext = function () { return { imageSmoothingQuality: "", drawImage: (_image: unknown, ...args: number[]) => draws.push(args) }; };
  window.HTMLCanvasElement.prototype.toDataURL = function (type: string) { return `data:${type};base64,AAAA`; };
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };

  const chosen = window.AvatarCrop.openAvatarCropper("data:image/png;base64,AAAA");
  await new Promise(resolve => setTimeout(resolve, 5));
  const dialog = window.document.querySelector("dialog.avatar-crop");
  assert.ok(dialog?.hasAttribute("open"));
  assert.equal(dialog.querySelector(".avatar-crop__image").style.transform, "translate(0px, -150px)", "starts centred");
  const view = dialog.querySelector(".avatar-crop__view");
  // Drag down by 100 px (towards the top of the photo), then zoom x2 with the slider.
  // jsdom has no PointerEvent: mouse events under the pointer names carry the same coordinates.
  view.dispatchEvent(new window.MouseEvent("pointerdown", { clientX: 100, clientY: 100 }));
  view.dispatchEvent(new window.MouseEvent("pointermove", { clientX: 100, clientY: 200 }));
  view.dispatchEvent(new window.MouseEvent("pointerup", {}));
  assert.equal(dialog.querySelector(".avatar-crop__image").style.transform, "translate(0px, -50px)");
  const slider = dialog.querySelector("[data-avatar-zoom]");
  slider.value = "2"; slider.dispatchEvent(new window.Event("input"));
  dialog.querySelector("[data-avatar-apply]").click();
  assert.equal(await chosen, "data:image/webp;base64,AAAA");
  // Zoom x2 around the centre: offset (-150, -250), the square 500 px from (250, 416.67) of the photo, drawn at 512 px.
  assert.equal(draws.length, 1);
  const [sx, sy, sw, sh, dx, dy, dw, dh] = draws[0]!;
  assert.deepEqual([sx, Math.round(sy!), sw, sh, dx, dy, dw, dh], [250, 417, 500, 500, 0, 0, 512, 512]);
  assert.equal(window.document.querySelector("dialog.avatar-crop"), null, "closed and removed");

  const cancelled = window.AvatarCrop.openAvatarCropper("data:image/png;base64,AAAA");
  await new Promise(resolve => setTimeout(resolve, 5));
  window.document.querySelector("[data-avatar-cancel]").click();
  assert.equal(await cancelled, null);
  dom.window.close();
});
