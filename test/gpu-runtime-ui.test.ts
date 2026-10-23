import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { buildSync } from "esbuild";
import { bootApp, defaultBootstrap, flush } from "./fixtures/appHarness";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require("jsdom");

const MB = 1024 ** 2, GB = 1024 ** 3;
const license = { name: "NVIDIA CUDA Toolkit End User License Agreement", url: "https://docs.nvidia.com/cuda/eula/" };
const acceleration = (cuda: Record<string, unknown>, gpu: Record<string, unknown> | null = { name: "NVIDIA GeForce RTX 3070 Ti", driver: "610.88", memoryBytes: 8 * GB, count: 1 }) =>
  ({ ...(gpu ? { gpu } : {}), cuda: { state: "available", variant: "win32-x64-cuda13", downloadBytes: 516 * MB, installedBytes: 0.7 * GB, offer: true, license, ...cuda } });

const load = () => {
  const bundle = buildSync({ entryPoints: ["public/assets/gpu-runtime-ui.js"], bundle: true, write: false, format: "iife", globalName: "GpuUi" }).outputFiles[0]!.text;
  const dom = new JSDOM('<div id="panel"></div>', { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  // JSDOM has <dialog> without showModal.
  dom.window.HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  dom.window.HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  dom.window.eval(`${bundle}\nwindow.GpuUi = GpuUi;`);
  return { dom, ui: dom.window.GpuUi };
};

test("GPU acceleration: each CUDA state says what happens, with NVIDIA's license before any download", t => {
  const { dom, ui } = load();
  t.after(() => dom.window.close());
  const card = ui.accelerationHtml(acceleration({}), { backend: "Vulkan" });
  assert.match(card, /NVIDIA GeForce RTX 3070 Ti · 8\.0 GB · driver 610\.88/);
  assert.match(card, /Models run on<\/span><span>Vulkan/);
  assert.match(card, /faster than with Vulkan.*Download: 516 MB, 0\.7 GB on disk\./s);
  assert.match(card, /data-gpu-action="install"/);
  const confirming = ui.cudaHtml(acceleration({}), { confirming: true });
  assert.match(confirming, /<a href="https:\/\/docs\.nvidia\.com\/cuda\/eula\/" target="_blank" rel="noopener noreferrer">NVIDIA CUDA Toolkit End User License Agreement<\/a>/);
  assert.match(confirming, /data-gpu-action="confirm"[^>]*>Agree and install/);
  assert.doesNotMatch(ui.cudaHtml(acceleration({ license: { name: "x", url: "javascript:alert(1)" } }), { confirming: true }), /javascript:/, "only an https license link");
  assert.match(ui.cudaHtml(acceleration({ state: "downloading", progress: { receivedBytes: 258 * MB, totalBytes: 516 * MB, bytesPerSecond: 8 * MB } })),
    /258 MB of 516 MB · 8\.0 MB\/s.*value="50".*data-gpu-action="cancel"/s);
  // In the offer dialog, Close joins the state's buttons in one row (Cancel left, Close right), not a row of its own.
  const close = '<button type="button" class="ghost-button" data-offer="close">Close</button>';
  assert.match(ui.cudaHtml(acceleration({ state: "downloading", progress: { receivedBytes: 1, totalBytes: 2 } }), { actions: close }),
    /<div class="gpu-runtime-actions"><button[^>]*data-gpu-action="cancel"[^>]*>Cancel<\/button><button[^>]*data-offer="close">Close<\/button><\/div>/);
  assert.match(ui.cudaHtml(acceleration({ state: "installing" }), { actions: close }), /<div class="gpu-runtime-actions"><button[^>]*data-offer="close">Close<\/button><\/div>/);
  assert.doesNotMatch(ui.cudaHtml(acceleration({ state: "installing" })), /gpu-runtime-actions/, "no empty row in Settings");
  assert.match(ui.cudaHtml(acceleration({ state: "installed" })), /is installed.*Remove CUDA runtime \(frees 0\.7 GB\)/s);
  assert.match(ui.cudaHtml(acceleration({ state: "failed", reason: "The CUDA runtime does not see the GPU." })), /does not see the GPU\. Models run on Vulkan\..*Try again/s);
  assert.match(ui.cudaHtml(acceleration({ state: "unavailable", reason: "Update the NVIDIA driver to 551.78 or newer to use CUDA (this computer has 537.58)." })), /Update the NVIDIA driver.*Check again/s);
  assert.match(ui.accelerationHtml(acceleration({ state: "unavailable", reason: "No NVIDIA GPU was found." }, null)), /No NVIDIA GPU found/);
  const hostile = ui.accelerationHtml(acceleration({ reason: "<img src=x onerror=alert(1)>" }, { name: "<script>alert(1)</script>", driver: "1", count: 1 }));
  assert.doesNotMatch(hostile, /<script|<img/);
});

// Each JSDOM window is closed at the end: its timers (the panel's refresh) would keep the test running.

test("the Settings panel installs with the license token, cancels and removes", async () => {
  const { dom, ui } = load();
  const calls: Array<[string, string | undefined, string | undefined]> = [];
  let current = acceleration({});
  const request = async (url: string, init: { method?: string; body?: string } = {}) => {
    calls.push([init.method ?? "GET", url, init.body]);
    if (url === "/local/runtime") return { runtime: { backend: "Vulkan", acceleration: current } };
    if (url.endsWith("/install")) current = acceleration({ state: "downloading", progress: { receivedBytes: 0, totalBytes: 516 * MB } });
    return current;
  };
  const panel = dom.window.document.getElementById("panel");
  const dispose = ui.mountGpuRuntimePanel(panel, { request, getRuntime: () => ({ backend: "Vulkan", acceleration: current }) });
  await delay(5);
  (panel.querySelector('[data-gpu-action="install"]') as HTMLButtonElement).click();
  assert.match(panel.textContent, /NVIDIA CUDA Toolkit End User License Agreement/, "the license first");
  assert.equal(calls.filter(([method]) => method === "POST").length, 0, "nothing downloads before agreeing");
  (panel.querySelector('[data-gpu-action="confirm"]') as HTMLButtonElement).click();
  await delay(5);
  assert.deepEqual(calls.find(([, url]) => url === "/local/runtime/cuda/install"), ["POST", "/local/runtime/cuda/install", JSON.stringify({ license: "nvidia-cuda-eula" })]);
  assert.match(panel.textContent, /Downloading the CUDA runtime/);
  (panel.querySelector('[data-gpu-action="cancel"]') as HTMLButtonElement).click();
  await delay(5);
  assert.ok(calls.some(([method, url]) => method === "POST" && url === "/local/runtime/cuda/cancel"));
  current = acceleration({ state: "installed" });
  panel.innerHTML = ui.accelerationHtml(current);
  (panel.querySelector('[data-gpu-action="remove"]') as HTMLButtonElement).click();
  await delay(5);
  assert.ok(calls.some(([method, url]) => method === "DELETE" && url === "/local/runtime/cuda"));
  dispose();
  dom.window.close();
});

test("the first-launch offer: once, with the license; Not now is remembered by the app", async () => {
  const { dom, ui } = load();
  const calls: string[] = [];
  const request = async (url: string, init: { method?: string; body?: string } = {}) => {
    calls.push(`${init.method ?? "GET"} ${url}${init.body && init.body !== "{}" ? ` ${init.body}` : ""}`);
    return url === "/local/runtime" ? { runtime: { acceleration: acceleration({}) } } : acceleration({ state: "downloading" });
  };
  ui.createCudaOffer({ request, doc: dom.window.document, delays: [0, 1] });
  await delay(20);
  const dialog = dom.window.document.querySelector("dialog.cuda-offer");
  assert.ok(dialog?.hasAttribute("open"), "shown");
  assert.equal(dom.window.document.querySelectorAll("dialog.cuda-offer").length, 1, "once");
  assert.match(dialog.textContent, /found NVIDIA GeForce RTX 3070 Ti.*516 MB \(0\.7 GB on disk\).*NVIDIA CUDA Toolkit End User License Agreement/s);
  (dialog.querySelector('[data-offer="later"]') as HTMLButtonElement).click();
  await flush(5);
  assert.ok(calls.includes("POST /local/runtime/cuda/dismiss"));
  assert.equal(dom.window.document.querySelector("dialog.cuda-offer"), null);
  dom.window.close();

  const second = load();
  const installs: string[] = [];
  let state = acceleration({});
  second.ui.createCudaOffer({ doc: second.dom.window.document, delays: [0], request: async (url: string, init: { method?: string; body?: string } = {}) => {
    if (init.method === "POST") { installs.push(`${url} ${init.body}`); state = acceleration({ state: "downloading", progress: { receivedBytes: 1, totalBytes: 516 * MB } }); }
    return url === "/local/runtime" ? { runtime: { acceleration: state } } : state;
  } });
  await delay(20);
  (second.dom.window.document.querySelector('[data-offer="install"]') as HTMLButtonElement).click();
  await delay(20);
  assert.deepEqual(installs, [`/local/runtime/cuda/install ${JSON.stringify({ license: "nvidia-cuda-eula" })}`]);
  assert.match(second.dom.window.document.querySelector("[data-offer-progress]")!.textContent!, /Downloading the CUDA runtime/);
  second.dom.window.close();
});

test("Settings → Local Runtime shows GPU acceleration on this computer", async () => {
  const runtime = { status: "stopped", backend: "Vulkan", acceleration: acceleration({ state: "installed", offer: false }) };
  const app = await bootApp({ bootstrap: () => ({ ...defaultBootstrap(), localModels: { runtime } }),
    route: (_method, url) => url === "/local/runtime" ? { runtime } : undefined });
  try {
    app.window.location.hash = "#/settings/runtime";
    await flush(40);
    const panel = app.document.querySelector("[data-gpu-runtime-panel]");
    assert.match(panel?.textContent ?? "", /GPU acceleration.*NVIDIA GeForce RTX 3070 Ti.*The CUDA runtime is installed/s);
  } finally { app.close(); }
});
