import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require("jsdom");

const HOST = "6f1c2c3e-58a4-4c55-9a0e-3c7f5b1d2e90", DEVICE = "0b6a3f0e-7f1d-4b9e-8a52-1f2c3d4e5f60";
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function load(bridge: unknown, accountView: Record<string, unknown>) {
  const dom = new JSDOM('<!doctype html><section class="route--remote"></section>');
  const source = fs.readFileSync("public/assets/remote-ui.js", "utf8").replace(/^import .*\n/m, "").replace("export function", "function");
  const listeners: Array<(view: unknown) => void> = [];
  const account = { get: () => accountView, subscribe: (listener: (view: unknown) => void) => { listeners.push(listener); return () => undefined; } };
  const context: any = { window: dom.window, document: dom.window.document, icon: (name: string) => `<svg data-icon="${name}"></svg>`, setTimeout, console };
  vm.runInNewContext(`${source}\nthis.ui = createRemoteUi({ bridge: this.bridge, account: this.account });`, Object.assign(context, { bridge, account }));
  const root = dom.window.document.querySelector(".route--remote");
  const paint = () => { root.innerHTML = context.ui.render(); context.ui.bind(root); };
  return { dom, ui: context.ui, root, paint, signIn: (view: Record<string, unknown>) => { Object.assign(accountView, view); listeners.forEach(listener => listener(accountView)); } };
}

const bridgeWith = (overrides: Record<string, unknown> = {}) => {
  const calls: Array<[string, ...unknown[]]> = [];
  let change: (status: unknown) => void = () => undefined;
  const ok = (value: unknown) => ({ ok: true, value });
  const bridge: Record<string, unknown> = {
    status: async () => ok({ state: "idle" }),
    hosts: async () => ok([{ hostId: HOST, name: "Fedora <img src=x onerror=alert(1)>", online: true, appVersion: "0.1.0", paired: true,
      devices: [{ deviceId: DEVICE, name: "Mac", platform: "macos", status: "active", current: true }] }]),
    hostStatus: async () => ok({ phase: "running", activeWork: { total: 0 }, inference: { backend: "cuda", active: "CUDA" }, loadedModels: ["qwen"] }),
    disconnect: async () => ok({ state: "idle" }),
    revokeDevice: async () => ok(undefined),
    onChange: (callback: (status: unknown) => void) => { change = callback; },
    ...overrides
  };
  for (const [name, fn] of Object.entries(bridge)) if (typeof fn === "function" && name !== "onChange") bridge[name] = (...args: unknown[]) => { calls.push([name, ...args]); return (fn as (...a: unknown[]) => unknown)(...args); };
  return { bridge, calls, emit: (status: unknown) => change(status) };
};

test("Remote explains what is needed before it can connect", async () => {
  const browser = load(undefined, { state: "signed-out" });
  browser.paint();
  assert.match(browser.root.textContent, /Remote is available in the desktop app/);
  const signedOut = load(bridgeWith().bridge, { state: "signed-out" });
  signedOut.paint();
  await flush();
  assert.match(signedOut.root.textContent, /Sign in to use Remote/);
  assert.ok(signedOut.root.querySelector('a[href="#/settings/account"]'));
});

test("a key pairs this computer, the server state shows, and names are escaped", async () => {
  const { bridge, calls, emit } = bridgeWith({ pair: async () => ({ ok: true, value: { state: "online", hostId: HOST, hostName: "Fedora", serverVersion: "0.1.0" } }) });
  const page = load(bridge, { state: "signed-in", profile: { accountId: "a", emailVerified: true } });
  page.paint();
  page.signIn({});
  await flush(); await flush();
  assert.match(page.root.textContent, /This computer/);
  assert.equal(page.root.querySelectorAll("img").length, 0, "a server name cannot inject markup");
  assert.match(page.root.innerHTML, /Fedora &lt;img/);

  const field = page.root.querySelector("[data-remote-key]");
  field.value = "  LCR1-ABC  ";
  field.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
  page.root.querySelector("[data-remote-form]").dispatchEvent(new page.dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await flush(); await flush();
  assert.deepEqual(calls.find(call => call[0] === "pair"), ["pair", "LCR1-ABC"]);
  emit({ state: "online", hostId: HOST, hostName: "Fedora", serverVersion: "0.1.0" });
  await flush(); await flush();
  assert.match(page.root.textContent, /Connected to Fedora/);
  assert.match(page.root.textContent, /CUDA/);
  assert.match(page.root.textContent, /qwen/);
  assert.equal(page.root.querySelector("[data-remote-key]").value, "", "a used key is cleared");

  page.root.querySelector('[data-remote-action="revoke"]').click();
  await flush();
  assert.deepEqual(calls.find(call => call[0] === "revokeDevice"), ["revokeDevice", HOST, DEVICE]);
});

test("a mistyped key stays editable and the reason is shown", async () => {
  const { bridge } = bridgeWith({ pair: async () => ({ ok: true, value: { state: "error", error: { code: "key_checksum", message: "The connection key has a typo. Copy it again." } } }) });
  const page = load(bridge, { state: "signed-in", profile: { accountId: "a", emailVerified: true } });
  page.paint();
  const field = page.root.querySelector("[data-remote-key]");
  field.value = "LCR1-TYPO";
  field.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
  page.root.querySelector("[data-remote-form]").dispatchEvent(new page.dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await flush(); await flush();
  assert.match(page.root.textContent, /has a typo/);
  assert.equal(page.root.querySelector("[data-remote-key]").value, "LCR1-TYPO");
});
