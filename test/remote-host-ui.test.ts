import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require("jsdom");

const PHONE = "0b6a3f0e-7f1d-4b9e-8a52-1f2c3d4e5f60", INVITATION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const status = (overrides: Record<string, unknown> = {}) => ({ available: true, enabled: false, keepAwake: true, openAtLogin: false,
  hostName: "MacBook", state: "off", devices: [], ...overrides });

/** The tab in a page of its own, with its timers in the test's hands and confirmations answered by `answer`. */
function load(bridge: Record<string, any> | undefined, accountView: Record<string, unknown> = { state: "signed-in" }) {
  const dom = new JSDOM('<!doctype html><section class="route--remote"><div data-remote-host-root></div></section>');
  const source = fs.readFileSync("public/assets/remote-host-ui.js", "utf8").replace("export function", "function");
  const timers: Array<() => void> = [], confirmations: string[] = [], copied: string[] = [];
  const answer = { value: true };
  dom.window.confirm = (text: string) => { confirmations.push(text); return answer.value; };
  const context: any = { window: dom.window, document: dom.window.document, setTimeout, console, Date,
    setInterval: (callback: () => void) => { timers.push(callback); return timers.length; }, clearInterval: (id: number) => { if (id) timers[id - 1] = () => undefined; },
    navigator: { clipboard: { writeText: async (text: string) => { copied.push(text); } } } };
  vm.runInNewContext(`${source}\nthis.ui = createRemoteHostUi({ bridge: this.bridge, account: this.account });`, Object.assign(context, { bridge, account: { get: () => accountView } }));
  const root = dom.window.document.querySelector(".route--remote");
  context.ui.bind(root);
  const view = () => root.querySelector("[data-remote-host-root]");
  return { dom, ui: context.ui, root, view, text: () => view().textContent.replace(/\s+/g, " "), tick: () => timers.forEach(timer => timer()), confirmations, copied, answer };
}
const bridgeWith = (start: Record<string, unknown>, overrides: Record<string, unknown> = {}) => {
  const calls: Array<[string, ...unknown[]]> = [];
  let change: (value: unknown) => void = () => undefined;
  const ok = (value: unknown) => ({ ok: true, value });
  const bridge: Record<string, any> = {
    status: async () => ok(start),
    set: async (patch: Record<string, unknown>) => ok({ ...start, ...patch, state: patch.enabled ? "online" : "off" }),
    connectKey: async () => ok({ key: "LCR1-KEY", invitationId: INVITATION, expiresAt: Date.now() + 600_000 }),
    invitation: async () => ok({ consumed: false }),
    revokeDevice: async () => ok({ revoked: true }),
    trustDevice: async (_id: string, trusted: boolean) => ok({ trusted }),
    unlink: async () => ok({ ...start, state: "online", reason: undefined }),
    onChange: (callback: (value: unknown) => void) => { change = callback; },
    ...overrides
  };
  for (const [name, fn] of Object.entries(bridge)) if (name !== "onChange") bridge[name] = (...args: unknown[]) => { calls.push([name, ...args]); return fn(...args); };
  return { bridge, calls, emit: (value: unknown) => change(value) };
};

test("hosting is turned on with its switch, and the page says when the computer accepts connections", async () => {
  const { bridge, calls } = bridgeWith(status());
  const page = load(bridge);
  page.view().innerHTML = page.ui.inner();
  await flush();
  assert.match(page.text(), /Remote connections are off\s*Devices cannot connect to MacBook/);
  assert.equal(page.view().querySelector('[data-host-setting="keepAwake"]').disabled, true, "nothing to keep awake for while off");
  assert.equal(page.view().querySelector('[data-host-setting="allowDeviceCommands"]'), null, "no switch for every device at once: trust is per device");
  const enabled = page.view().querySelector('[data-host-setting="enabled"]');
  enabled.checked = true;
  enabled.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
  await flush();
  // Made in the page's realm: compared as JSON.
  assert.equal(JSON.stringify(calls.find(call => call[0] === "set")), JSON.stringify(["set", { enabled: true }]));
  assert.match(page.text(), /MacBook accepts connections\s*No devices paired yet/);
  assert.match(page.text(), /closed sleeps anyway/, "the lid is not promised");
});

test("a one-time key is shown with its time left, copied, and gives way to the device that used it", async () => {
  let used = false;
  const { bridge, calls } = bridgeWith(status({ enabled: true, state: "online" }), { invitation: async () => ({ ok: true, value: used ? { consumed: true, deviceName: "iPhone <b>" } : { consumed: false } }) });
  const page = load(bridge);
  page.view().innerHTML = page.ui.inner();
  await flush();
  page.view().querySelector('[data-host-action="show-key"]').click();
  await flush();
  assert.equal(page.view().querySelector("textarea.remote-key").value, "LCR1-KEY");
  assert.equal(page.view().querySelector("textarea.remote-key").readOnly, true);
  assert.match(page.text(), /Valid for (10:00|9:5\d)/);
  assert.equal(page.view().querySelector(".remote-key-qr"), null, "a host without a code shows the key alone");
  page.view().querySelector('[data-host-action="copy-key"]').click();
  await flush();
  assert.deepEqual(page.copied, ["LCR1-KEY"]);
  page.tick(); await flush();
  assert.match(page.text(), /Waiting for a device/);
  used = true;
  page.tick(); await flush();
  assert.deepEqual(calls.filter(call => call[0] === "invitation").at(-1), ["invitation", INVITATION]);
  assert.match(page.text(), /iPhone <b> is connected/);
  assert.equal(page.view().querySelectorAll("b").length, 0, "a device's name is text");
});

test("a key with a code shows the code; a key that expires is withdrawn", async () => {
  const { bridge } = bridgeWith(status({ enabled: true, state: "online" }), { connectKey: async () => ({ ok: true,
    value: { key: "LCR1-KEY", invitationId: INVITATION, expiresAt: Date.now() + 1000, qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 53 53"></svg>' } }) });
  const page = load(bridge);
  page.view().innerHTML = page.ui.inner();
  await flush();
  page.view().querySelector('[data-host-action="show-key"]').click();
  await flush();
  assert.ok(page.view().querySelector(".remote-key-qr svg"));
  assert.match(page.text(), /Scan to connect[\s\S]*Computers → \+, then point the camera at the code/);
  assert.equal(page.view().querySelector("textarea.remote-key").value, "LCR1-KEY", "the key is still there for another computer");
  await new Promise(resolve => setTimeout(resolve, 1100));
  page.tick(); await flush();
  assert.equal(page.view().querySelector("textarea.remote-key"), null);
  assert.match(page.text(), /The key expired before a device used it/);
});

test("a device loses access only after a yes, and its name is shown as text", async () => {
  const devices = [{ deviceId: PHONE, name: "iPhone <img src=x>", grantedAt: "2026-10-31T10:00:00Z", connected: true }];
  const { bridge, calls } = bridgeWith(status({ enabled: true, state: "online", devices }));
  const page = load(bridge);
  page.view().innerHTML = page.ui.inner();
  await flush();
  assert.match(page.text(), /1 device paired, 1 connected now/);
  assert.equal(page.view().querySelectorAll("img").length, 0);
  page.answer.value = false;
  page.view().querySelector('[data-host-action="revoke"]').click();
  await flush();
  assert.equal(calls.some(call => call[0] === "revokeDevice"), false);
  page.answer.value = true;
  page.view().querySelector('[data-host-action="revoke"]').click();
  await flush();
  assert.deepEqual(calls.find(call => call[0] === "revokeDevice"), ["revokeDevice", PHONE]);
  assert.match(page.confirmations[0]!, /Remove iPhone <img src=x>'s access to this computer\?/);
});

test("a device is trusted with its own switch; the app asks before it is, the page only passes it on", async () => {
  const devices = [{ deviceId: PHONE, name: "iPhone", grantedAt: "2026-10-31T10:00:00Z", connected: true, trusted: false }];
  const { bridge, calls } = bridgeWith(status({ enabled: true, state: "online", devices }));
  const page = load(bridge);
  page.view().innerHTML = page.ui.inner();
  await flush();
  assert.match(page.text(), /A trusted one also uses the chats of your projects here, asking before every change, and approves commands, files anywhere and its applications' tools, one action at a time/);
  const trust = page.view().querySelector(`[data-device-trust="${PHONE}"]`);
  assert.equal(trust.checked, false);
  trust.checked = true;
  trust.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
  await flush();
  assert.equal(JSON.stringify(calls.find(call => call[0] === "trustDevice")), JSON.stringify(["trustDevice", PHONE, true]));
  assert.equal(page.confirmations.length, 0, "the question is the app's own dialog, not the page's");
});

test("paused hosting says why: signed out, or set up for another account, which unlinking ends", async () => {
  const signedOut = load(bridgeWith(status({ enabled: true, state: "paused", reason: "signed_out" })).bridge);
  signedOut.view().innerHTML = signedOut.ui.inner();
  await flush();
  assert.match(signedOut.text(), /Paused: you are signed out/);
  assert.ok(signedOut.view().querySelector('a[href="#/settings/account"]'));

  const { bridge, calls } = bridgeWith(status({ enabled: true, state: "paused", reason: "other_account" }));
  const other = load(bridge);
  other.view().innerHTML = other.ui.inner();
  await flush();
  assert.match(other.text(), /This computer belongs to another account/);
  other.view().querySelector('[data-host-action="unlink"]').click();
  await flush();
  assert.ok(calls.some(call => call[0] === "unlink"));
  assert.match(other.confirmations[0]!, /Every device of that account loses access/);
  assert.match(other.text(), /MacBook accepts connections/);
});

test("Remote has a tab for this computer, remembered; without the desktop app it says where to find it", async () => {
  const dom = new JSDOM('<!doctype html><section class="route--remote"></section>', { url: "http://127.0.0.1/" });
  const source = fs.readFileSync("public/assets/remote-ui.js", "utf8").replace(/^import .*\n/m, "").replace("export function", "function");
  const hostUi = { inner: () => '<p data-host-page>Hosting</p>', bind: () => undefined };
  const context: any = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, icon: () => "", setTimeout, console };
  vm.runInNewContext(`${source}\nthis.ui = createRemoteUi({ bridge: undefined, account: { get: () => ({ state: "signed-in" }) }, hostUi: this.hostUi });`, Object.assign(context, { hostUi }));
  const root = dom.window.document.querySelector(".route--remote");
  root.innerHTML = context.ui.render();
  context.ui.bind(root);
  assert.deepEqual([...root.querySelectorAll("[data-remote-tab]")].map((tab: any) => [tab.textContent, tab.getAttribute("aria-selected")]), [["Other computers", "true"], ["This computer", "false"]]);
  root.querySelector('[data-remote-tab="host"]').click();
  assert.ok(root.querySelector("[data-host-page]"));
  assert.equal(dom.window.localStorage.getItem("lcai.remoteTab"), "host");
  context.ui.showTab("connect");
  assert.equal(root.querySelector("[data-host-page]"), null, "the tray's link and the router choose a tab too");
  context.ui.showTab("host");
  assert.ok(root.querySelector("[data-host-page]"));
  const none = load(undefined);
  none.view().innerHTML = none.ui.inner();
  assert.match(none.text(), /Available in the desktop app/);
});

test("shared folders: the app's own Projects folder, folders shared here with their switch, and stop sharing after a yes", async () => {
  const FOLDER = "11111111-2222-4333-8444-555555555555";
  const list = [{ id: "projects", label: "Projects", managed: true, allowCreate: true, location: "~/Library/Application Support/Local Cognitive/projects" },
    { id: FOLDER, label: "Work <i>", managed: false, allowCreate: false, location: "~/Documents/Work" }];
  const ok = (value: unknown) => ({ ok: true, value });
  const { bridge, calls } = bridgeWith(status({ enabled: true, state: "online" }), { folders: async () => ok(list), addFolder: async () => ok(list), openFolder: async () => ok(undefined),
    setFolder: async () => ok(list), removeFolder: async () => ok(list.slice(0, 1)) });
  const page = load(bridge);
  page.view().innerHTML = page.ui.inner();
  await flush();
  const rows = [...page.view().querySelectorAll(".remote-host-folders .settings-row")];
  assert.match(rows[0].textContent, /Projects.*this app's own folder/s);
  assert.equal(rows[0].querySelector('[data-host-action="remove-folder"]'), null, "the app's own folder stays shared");
  assert.equal(page.view().querySelectorAll("i").length, 0);
  page.view().querySelector('[data-host-action="add-folder"]').click();
  await flush();
  assert.ok(calls.some(call => call[0] === "addFolder" && call.length === 1), "the window asks; it names no path");
  const create = page.view().querySelector(`[data-folder-create="${FOLDER}"]`);
  create.checked = true;
  create.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
  await flush();
  assert.equal(JSON.stringify(calls.find(call => call[0] === "setFolder")), JSON.stringify(["setFolder", FOLDER, { allowCreate: true }]));
  page.view().querySelectorAll('[data-host-action="open-folder"]')[1].click();
  await flush();
  assert.deepEqual(calls.find(call => call[0] === "openFolder"), ["openFolder", FOLDER]);
  page.view().querySelector('[data-host-action="remove-folder"]').click();
  await flush();
  assert.deepEqual(calls.find(call => call[0] === "removeFolder"), ["removeFolder", FOLDER]);
  assert.match(page.confirmations.at(-1)!, /Stop sharing Work <i>\? .*nothing in it is deleted/);
  assert.equal(page.view().querySelectorAll(".remote-host-folders .settings-row").length, 1);
});

test("open at login is offered in the installed app while hosting is on, and says when macOS wants an approval", async () => {
  const page = load(bridgeWith(status({ enabled: true, state: "online", openAtLoginAvailable: true, openAtLogin: true, openAtLoginNeedsApproval: true })).bridge);
  page.view().innerHTML = page.ui.inner();
  await flush();
  assert.equal(page.view().querySelector('[data-host-setting="openAtLogin"]').disabled, false);
  assert.match(page.text(), /macOS needs your approval: System Settings → General → Login Items/);
  const dev = load(bridgeWith(status({ enabled: true, state: "online", openAtLoginAvailable: false })).bridge);
  dev.view().innerHTML = dev.ui.inner();
  await flush();
  assert.equal(dev.view().querySelector('[data-host-setting="openAtLogin"]').disabled, true);
  assert.match(dev.text(), /Available in the installed app/);
});
