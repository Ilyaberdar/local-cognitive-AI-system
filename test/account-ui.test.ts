import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require("jsdom");
const shellBundle = buildSync({ entryPoints: ["public/assets/settings-shell.js"], bundle: true, write: false, format: "iife", globalName: "SettingsShell" }).outputFiles[0].text;

async function until(check: () => boolean, label = "condition") {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 2000) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const signedIn = (profile: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  state: "signed-in", cloudReachable: true, accessToken: "SECRET", refreshToken: "SECRET",
  profile: { accountId: "acc-123", email: "mira@example.test", emailVerified: true, name: "Mira", idToken: "SECRET", ...profile }, ...extra
});

function fakeBridge(initial: unknown) {
  const calls: unknown[][] = [];
  let listener: ((status: unknown) => void) | undefined;
  const bridge = {
    status: async () => { calls.push(["status"]); return initial; },
    signIn: async (method: string) => { calls.push(["signIn", method]); const status = { state: "signing-in" }; listener?.(status); return status; },
    cancelSignIn: async () => { calls.push(["cancelSignIn"]); const status = { state: "signed-out" }; listener?.(status); return status; },
    signOut: async () => { calls.push(["signOut"]); const status = { state: "signed-out" }; listener?.(status); return status; },
    onChange: (next: (status: unknown) => void) => { listener = next; return () => { listener = undefined; }; }
  };
  return { bridge, calls, emit: (status: unknown) => listener?.(status) };
}

function mount(bridge?: unknown) {
  const dom = new JSDOM('<main><div id="root"></div></main>', { url: "http://localhost/#/chat", runScripts: "outside-only", pretendToBeVisual: true });
  if (bridge) dom.window.desktopAccount = bridge;
  dom.window.eval(`${shellBundle}\nwindow.SettingsShell = SettingsShell;`);
  const appSettings = { memory: { localProfileId: "local-1" }, profile: { displayName: "Local Mira" } };
  const shell = dom.window.SettingsShell.createSettingsShell({ app: dom.window.document.getElementById("root"), getContext: () => ({ appSettings }),
    data: { integrations: [] }, captureScroll: () => ({}), restoreScroll() {}, onReturn() {} });
  const page = () => dom.window.document.querySelector("[data-account-page]");
  const click = (action: string) => page().querySelector(`[data-account-action="${action}"]`).click();
  return { dom, shell, page, click, settings: () => dom.window.document.querySelector("#settings-root"), close: () => dom.window.close() };
}

test("account page outside the desktop app explains where sign-in is available", t => {
  const ui = mount(); t.after(ui.close);
  ui.shell.route("#/settings/account");
  assert.match(ui.page().textContent, /available in the desktop app/);
  assert.equal(ui.page().querySelectorAll("[data-account-action]").length, 0);
  assert.equal(ui.settings().querySelector(".settings-parent").getAttribute("href"), "#/settings/profile");
});

test("signed-out account offers Google, email and sign-up; cancel returns to signed-out", async t => {
  const fake = fakeBridge({ state: "signed-out" });
  const ui = mount(fake.bridge); t.after(ui.close);
  ui.shell.route("#/settings/account");
  await until(() => Boolean(ui.page()?.querySelector('[data-account-action="google"]')), "sign-in buttons");
  assert.match(ui.page().textContent, /only for Remote/);
  assert.equal(ui.page().querySelectorAll('[data-account-action="google"], [data-account-action="email"], [data-account-action="signup"]').length, 3);
  ui.click("google");
  await until(() => /Waiting for your browser/.test(ui.page().textContent), "waiting view");
  assert.deepEqual(fake.calls.at(-1), ["signIn", "google"]);
  ui.click("cancel");
  await until(() => Boolean(ui.page().querySelector('[data-account-action="google"]')), "signed-out again");
  assert.deepEqual(fake.calls.at(-1), ["cancelSignIn"]);
});

test("signed-in account escapes profile fields, never renders token fields, and signs out", async t => {
  const fake = fakeBridge(signedIn({ name: '<img src=x onerror="alert(1)">', email: 'a"<b>@x.test', emailVerified: false }));
  const ui = mount(fake.bridge); t.after(ui.close);
  ui.shell.route("#/settings/account");
  await until(() => Boolean(ui.page()?.querySelector('[data-account-action="sign-out"]')), "signed-in view");
  assert.equal(ui.page().querySelector("img"), null);
  assert.match(ui.page().textContent, /<img src=x/);
  assert.match(ui.page().textContent, /a"<b>@x\.test/);
  assert.match(ui.page().textContent, /Not verified/);
  assert.ok(ui.page().querySelector('[data-account-action="refresh"]'), "unverified email offers Check again");
  assert.doesNotMatch(ui.dom.window.document.body.innerHTML, /SECRET/);
  ui.click("sign-out");
  await until(() => Boolean(ui.page().querySelector('[data-account-action="google"]')), "signed out");
  assert.deepEqual(fake.calls.at(-1), ["signOut"]);
});

test("offline and error states are explained without losing the session or retry", async t => {
  const fake = fakeBridge(signedIn({}, { cloudReachable: false }));
  const ui = mount(fake.bridge); t.after(ui.close);
  ui.shell.route("#/settings/account");
  await until(() => /Can't reach Local Cognitive Cloud/.test(ui.page()?.textContent || ""), "offline notice");
  assert.ok(ui.page().querySelector('[data-account-action="sign-out"]'));
  fake.emit({ state: "error", error: { code: "callback_failed", message: "<b>Denied</b> by provider" } });
  await until(() => /Sign-in didn't complete/.test(ui.page().textContent), "error view");
  assert.equal(ui.page().querySelector("b"), null);
  assert.match(ui.page().textContent, /<b>Denied<\/b> by provider/);
  assert.ok(ui.page().querySelector('[data-account-action="google"]'), "error offers retry");
});

test("account changes update the profile link and menu without discarding profile drafts", async t => {
  const fake = fakeBridge({ state: "signed-out" });
  const ui = mount(fake.bridge); t.after(ui.close);
  ui.shell.route("#/settings/profile");
  await until(() => /Sign in to use Remote/.test(ui.settings().textContent), "signed-out link");
  const name = ui.dom.window.document.getElementById("local-profile-name");
  name.value = "Draft name";
  fake.emit(signedIn());
  await until(() => /mira@example\.test/.test(ui.settings().querySelector('a.settings-list-row[href="#/settings/account"]').textContent), "link updated");
  assert.equal(ui.dom.window.document.getElementById("local-profile-name").value, "Draft name");

  ui.shell.route("#/chat");
  ui.dom.window.document.body.insertAdjacentHTML("beforeend", ui.shell.profileButton());
  ui.shell.bindProfile();
  const menu = ui.dom.window.document.getElementById("profile-menu");
  menu.showPopover = () => {};
  ui.dom.window.document.getElementById("local-profile-button").click();
  assert.equal(menu.querySelector(".profile-menu-header small").textContent, "mira@example.test");
  fake.emit({ state: "signed-out" });
  assert.equal(menu.querySelector(".profile-menu-header small").textContent, "On this device");
});
