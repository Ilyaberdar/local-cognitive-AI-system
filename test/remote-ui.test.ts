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

test("two computers with one name are told apart by the day each was paired; a date that is not one is left out", async () => {
  const devices = [
    { deviceId: DEVICE, name: "Gamzatels-MacBook-Pro", platform: "macos", status: "active", grantedAt: "2026-10-10T19:01:24.220Z", current: false },
    { deviceId: "stale", name: "Gamzatels-MacBook-Pro", platform: "macos", status: "active", grantedAt: "2026-10-16T17:34:08.629Z", current: false },
    { deviceId: "pc", name: "DESKTOP-QPD45QC", platform: "windows", status: "active", grantedAt: "not a date", current: true }];
  const hosts = async () => ({ ok: true, value: [{ hostId: HOST, name: "fedora", online: true, appVersion: "0.1.11", paired: true, devices }] });
  const page = load(bridgeWith({ hosts }).bridge, { state: "signed-in", profile: { accountId: "a", emailVerified: true } });
  page.paint();
  page.signIn({});
  await flush(); await flush();
  const rows = [...page.root.querySelectorAll(".remote-devices li")].map(row => row.textContent);
  const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  assert.ok(rows[0].includes(`macos · paired ${day("2026-10-10T19:01:24.220Z")}`), rows[0]);
  assert.ok(rows[1].includes(`macos · paired ${day("2026-10-16T17:34:08.629Z")}`), rows[1]);
  assert.notEqual(day("2026-10-10T19:01:24.220Z"), day("2026-10-16T17:34:08.629Z"));
  assert.match(rows[2], /This computer/);
  assert.doesNotMatch(rows[2], /paired/);
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

test("a newer release of the connected server is shown with how to install it; its notes are text", async () => {
  const { bridge, emit } = bridgeWith({
    status: async () => ({ ok: true, value: { state: "online", hostId: HOST, hostName: "Fedora", serverVersion: "0.1.0" } }),
    hostStatus: async () => ({ ok: true, value: { version: "0.1.0", phase: "running", activeWork: { total: 0 }, inference: { active: "CUDA" }, loadedModels: [],
      update: { current: "0.1.0", checkedAt: "2026-10-10T00:00:00.000Z", available: { version: "0.2.0", notes: "Faster <script>alert(1)</script> downloads", releasedAt: "2026-10-10T00:00:00.000Z" } } } })
  });
  const page = load(bridge, { state: "signed-in", profile: { accountId: "a", emailVerified: true } });
  page.paint();
  page.signIn({});
  emit({ state: "online", hostId: HOST, hostName: "Fedora", serverVersion: "0.1.0" });
  await flush(); await flush(); await flush();
  page.paint();
  assert.match(page.root.textContent, /Version\s*0\.1\.0 · 0\.2\.0 available/);
  assert.match(page.root.textContent, /Local Cognitive 0\.2\.0 is available for Fedora/);
  assert.match(page.root.textContent, /sudo local-cognitive-server update/);
  assert.equal(page.root.querySelectorAll("script").length, 0, "the notes are shown as text");
  assert.match(page.root.querySelector(".remote-update-notes").textContent, /Faster <script>/);
});

test("this computer, when it hosts, is listed as itself without Connect or Forget; a server that is gone can be removed from the account", async () => {
  const SELF = "11111111-2222-4333-8444-555555555555", GONE = "99999999-8888-4777-8666-555555555555";
  const hosts = async () => ({ ok: true, value: [
    { hostId: SELF, name: "MacBook", online: true, appVersion: "0.1.12", paired: false, self: true, devices: [{ deviceId: DEVICE, name: "iPhone", platform: "ios", status: "active", current: false }] },
    { hostId: GONE, name: "old-fedora", online: false, appVersion: "0.1.9", paired: false, self: false, devices: [] }] });
  const { bridge, calls } = bridgeWith({ hosts, removeHost: async () => ({ ok: true, value: undefined }) });
  const page = load(bridge, { state: "signed-in", profile: { accountId: "a", emailVerified: true } });
  page.paint();
  page.signIn({});
  await flush(); await flush();
  const [self, gone] = [...page.root.querySelectorAll(".remote-host")];
  assert.match(self.textContent, /MacBook\s*This computer/);
  assert.doesNotMatch(self.textContent, /not paired with this computer/);
  assert.equal(self.querySelectorAll('[data-remote-action="connect"], [data-remote-action="forget"], [data-remote-action="remove-host"]').length, 0);
  assert.ok(self.querySelector('[data-remote-action="revoke"]'), "its devices can lose access from here too");
  const confirmations: string[] = [];
  let answer = false;
  page.dom.window.confirm = (text: string) => { confirmations.push(text); return answer; };
  gone.querySelector('[data-remote-action="remove-host"]').click();
  await flush();
  assert.equal(calls.some(call => call[0] === "removeHost"), false, "nothing is removed without a yes");
  answer = true;
  page.root.querySelector('[data-remote-action="remove-host"]').click();
  await flush(); await flush();
  assert.deepEqual(calls.find(call => call[0] === "removeHost"), ["removeHost", GONE]);
  assert.match(confirmations[0]!, /Remove old-fedora from your account\? Every device loses access/);
});

test("a computer that hosts shows what its models run on, and the form says where a key comes from on a computer and on a server", async () => {
  const { bridge, emit } = bridgeWith({ hostStatus: async () => ({ ok: true, value: { kind: "desktop", version: "0.1.12", phase: "running", activeWork: { total: 0 }, loadedModels: [], inference: { backend: "Metal" } } }) });
  const page = load(bridge, { state: "signed-in", profile: { accountId: "a", emailVerified: true } });
  page.paint();
  page.signIn({});
  await flush();
  assert.match(page.root.textContent, /Remote → This computer → Show QR to connect and copy the key under the code; on a server, run sudo local-cognitive-server pair/);
  emit({ state: "online", hostId: HOST, hostName: "MacBook", serverVersion: "0.1.12" });
  await flush(); await flush();
  assert.match(page.root.textContent, /Connected to MacBook\s*Local Cognitive 0\.1\.12 there\./);
  assert.match(page.root.textContent, /Inference\s*Metal/);
  assert.doesNotMatch(page.root.textContent, /on the server|Your servers|Forget server/);
});

test("the server list says what kind of computer each host is, and since when one is offline", async () => {
  const today = new Date(); today.setHours(9, 5, 0, 0);
  const hosts = async () => ({ ok: true, value: [
    { hostId: HOST, name: "fedora", online: true, appVersion: "0.1.12", paired: true, self: false, kind: "server", platform: "linux", devices: [] },
    { hostId: "22222222-2222-4222-8222-222222222222", name: "MacBook", online: false, appVersion: "0.1.12", paired: true, self: false, kind: "desktop", platform: "macos", lastSeenAt: today.toISOString(), devices: [] },
    { hostId: "33333333-3333-4333-8333-333333333333", name: "old", online: false, appVersion: "0.1.9", paired: true, self: false, devices: [] }] });
  const page = load(bridgeWith({ hosts }).bridge, { state: "signed-in", profile: { accountId: "a", emailVerified: true } });
  page.paint();
  page.signIn({});
  await flush(); await flush();
  const rows = [...page.root.querySelectorAll(".remote-host-head .subtle")].map((row: any) => row.textContent);
  assert.match(rows[0], /^Server · Online · 0\.1\.12/);
  assert.match(rows[1], new RegExp(`^Mac · Offline since ${today.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} · 0\\.1\\.12`));
  assert.match(rows[2], /^Offline · 0\.1\.9/, "a host that never said what it is");
});

test("a computer that stays away is tried again without the page changing at every attempt, and Try now asks at once", async () => {
  // The owner saw Remote jerk with every attempt while the other computer was down (2026-10-31).
  const { bridge, calls, emit } = bridgeWith({ connect: async () => ({ ok: true, value: { state: "reconnecting", hostId: HOST, hostName: "Fedora" } }) });
  const page = load(bridge, { state: "signed-in", profile: { accountId: "a", emailVerified: true } });
  page.paint();
  page.signIn({});
  await flush(); await flush();
  const away = { code: "host_offline", message: "The other computer is offline or not connected to Local Cognitive." };
  emit({ state: "offline", hostId: HOST, hostName: "Fedora", error: away });
  const card = page.root.querySelector(".remote-status");
  assert.match(card.textContent, /Reconnecting to Fedora…/);
  for (const state of ["reconnecting", "offline", "reconnecting", "offline"]) emit({ state, hostId: HOST, hostName: "Fedora", error: away });
  assert.equal(page.root.querySelector(".remote-status"), card, "the same card stays: nothing was drawn again");
  (page.root.querySelector('[data-remote-action="connect"]') as any).click();
  await flush();
  assert.deepEqual(calls.filter(call => call[0] === "connect"), [["connect", HOST]], "Try now connects at once");
  emit({ state: "online", hostId: HOST, hostName: "Fedora", serverVersion: "0.1.12" });
  assert.match(page.root.querySelector(".remote-status").textContent, /Connected to Fedora/);
});
