import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { readShortcuts, validateSettingsPatch } from "../src/app/settingsValidation";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require("jsdom");
const bundle = (entry: string, name: string) => buildSync({ entryPoints: [entry], bundle: true, write: false, format: "iife", globalName: name }).outputFiles[0].text;
const shortcutsBundle = bundle("public/assets/shortcuts.js", "Shortcuts");
const shellBundle = bundle("public/assets/settings-shell.js", "SettingsShell");
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function load(platform = "darwin") {
  const dom = new JSDOM('<form id="chat-form"><textarea name="input"></textarea><button type="submit">Send</button></form>', { url: "http://localhost/", runScripts: "outside-only" });
  dom.window.desktopAppearance = { platform };
  dom.window.eval(`${shortcutsBundle}\nwindow.Shortcuts = Shortcuts;`);
  return { dom, api: dom.window.Shortcuts };
}

async function until(check: () => boolean, label = "condition") {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 10_000) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("a shortcut is physical keys: ⌘ on a Mac, Ctrl elsewhere, the same with any keyboard layout", t => {
  const { dom, api } = load(); t.after(() => dom.window.close());
  // With a Russian layout the comma key types "б"; the shortcut is still ⌘, (Ctrl+, on Windows).
  assert.equal(api.shortcutFromEvent({ code: "Comma", key: "б", metaKey: true }, true), "Mod+Comma");
  assert.equal(api.shortcutFromEvent({ code: "Comma", key: "б", ctrlKey: true }, false), "Mod+Comma");
  assert.equal(api.shortcutFromEvent({ code: "KeyK", key: "k", ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }, true), "Ctrl+Alt+Shift+Mod+KeyK");
  assert.equal(api.shortcutFromEvent({ code: "MetaLeft", key: "Meta", metaKey: true }, true), undefined, "a modifier alone is no shortcut yet");
  assert.match(api.shortcutFromEvent({ code: "KeyK", key: "k", metaKey: true }, false), /Meta/, "the Windows key is marked as the system's");

  assert.deepEqual(plain(api.shortcutCaps("Ctrl+Alt+Shift+Mod+KeyK", true)), ["⌃", "⌥", "⇧", "⌘", "K"]);
  assert.deepEqual(plain(api.shortcutCaps("Alt+Shift+Mod+KeyK", false)), ["Ctrl", "Alt", "Shift", "K"]);
  assert.equal(api.shortcutText("Mod+Comma", true), "⌘,");
  assert.equal(api.shortcutText("Mod+Comma", false), "Ctrl+,");
  assert.equal(api.shortcutText("Escape", true), "Esc");
  assert.equal(api.shortcutSpoken("Shift+Mod+KeyD", true), "Shift Command D");
  assert.equal(api.shortcutSpoken("Shift+Mod+KeyD", false), "Control Shift D");
  assert.equal(api.shortcutAria("Mod+KeyN", true), "Meta+N");
  assert.equal(api.shortcutAria("Mod+KeyN", false), "Control+N");
  assert.equal(api.shortcutAria("Escape", true), "Escape");
  for (const bad of ["Mod+Ctrl+KeyA", "Mod+Mod+KeyA", "Mod+Enter", "KeyA+Mod", "", "Mod+", "Hyper+KeyA"]) assert.equal(api.parseShortcut(bad), null, bad);
  assert.equal(api.isMacPlatform(), true);
});

test("keys the menus, text fields or the system use are refused with the reason; another action's keys ask first", t => {
  const { dom, api } = load(); t.after(() => dom.window.close());
  const defaults = api.effectiveShortcuts({});
  const check = (keys: string, mac = true, actionId = "newChat") => plain(api.checkShortcut(keys, { mac, actionId, shortcuts: defaults }));
  assert.match(check("Mod+KeyC").error, /⌘C is used for Copy/);
  assert.match(check("Mod+KeyY", false).error, /Ctrl\+Y is used for Redo/);
  assert.match(check("Mod+KeyQ").error, /Quit/);
  assert.match(check("Ctrl+KeyA").error, /text editing/);
  for (const typing of ["KeyK", "Shift+KeyK", "Alt+KeyK", "Space"]) assert.match(check(typing).error, /Add ⌘ or ⌃/, typing);
  assert.match(check("KeyK", false).error, /Add Ctrl/);
  assert.match(check("Tab").error, /Tab moves/);
  assert.match(check("Mod+Enter").error, /Enter sends/);
  assert.match(check("Mod+ArrowLeft").error, /move the cursor/);
  assert.match(check("Backspace").error, /edit text/);
  assert.match(check("Meta+KeyK", false).error, /Windows key/);
  assert.deepEqual(check("Mod+Digit1"), { conflict: "goChat" });
  assert.deepEqual(check("Escape", true, "dictate"), { conflict: "stopGeneration" });
  assert.deepEqual(check("Mod+KeyN"), { ok: true }, "an action's own keys are no conflict");
  assert.deepEqual(check("Alt+Mod+KeyN"), { ok: true });
  assert.deepEqual(check("F5"), { ok: true }, "function keys need no modifier");
});

test("only changed shortcuts are stored, and a default gives way to keys the person chose for another action", t => {
  const { dom, api } = load(); t.after(() => dom.window.close());
  const defaults = plain(api.effectiveShortcuts({}));
  assert.equal(defaults.newChat, "Mod+KeyN");
  assert.equal(defaults.stopGeneration, "Escape");
  assert.equal(defaults.dictate, null);
  assert.equal(new Set(Object.values(defaults).filter(Boolean)).size, Object.values(defaults).filter(Boolean).length, "defaults never collide");
  const taken = plain(api.effectiveShortcuts({ newChat: "Mod+Digit1" }));
  assert.equal(taken.newChat, "Mod+Digit1");
  assert.equal(taken.goChat, null);
  const mixed = plain(api.effectiveShortcuts({ newChat: "nonsense", dictate: "Shift+Mod+KeyD", goModels: null, openSettings: "Shift+Mod+KeyD" }));
  assert.equal(mixed.newChat, "Mod+KeyN", "an unreadable choice falls back to the default");
  assert.equal(mixed.dictate, "Shift+Mod+KeyD");
  assert.equal(mixed.goModels, null);
  assert.equal(mixed.openSettings, "Mod+Comma", "the same keys twice: the first action keeps them");
  assert.deepEqual(plain(api.ownShortcuts(api.effectiveShortcuts({ stopGeneration: "Mod+Period" }))), { stopGeneration: "Mod+Period" });
  assert.deepEqual(plain(api.ownShortcuts(defaults)), {});
});

test("the message box sends with its send key and never while a word is being composed", t => {
  const mount = (platform: string, mode: string) => {
    const { dom, api } = load(platform);
    const document = dom.window.document, form = document.getElementById("chat-form"), textarea = form.querySelector("textarea"), send = form.querySelector("button");
    const sent: string[] = [];
    form.addEventListener("submit", (event: Event) => { event.preventDefault(); sent.push(textarea.value); });
    api.bindComposerSend({ form, textarea, mode: () => mode, mac: platform === "darwin" });
    const press = (init: Record<string, unknown>) => {
      const event = new dom.window.KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, ...init });
      textarea.dispatchEvent(event);
      return event.defaultPrevented;
    };
    textarea.value = "hello";
    return { dom, textarea, send, sent, press };
  };
  const mac = mount("darwin", "enter"); t.after(() => mac.dom.window.close());
  assert.equal(mac.press({ shiftKey: true }), false); assert.equal(mac.sent.length, 0, "Shift+Enter is a new line");
  assert.equal(mac.press({ altKey: true }), false); assert.equal(mac.sent.length, 0);
  assert.equal(mac.press({ isComposing: true }), false); assert.equal(mac.press({ keyCode: 229 }), false); assert.equal(mac.sent.length, 0, "an input method is composing");
  assert.equal(mac.press({}), true); assert.deepEqual(mac.sent, ["hello"]);
  assert.equal(mac.press({ metaKey: true }), true); assert.equal(mac.sent.length, 2, "⌘Enter sends too");
  mac.send.disabled = true;
  assert.equal(mac.press({}), true); assert.equal(mac.sent.length, 2, "a disabled Send keeps the key from sending");
  mac.send.disabled = false; mac.textarea.value = "   ";
  assert.equal(mac.press({}), true); assert.equal(mac.sent.length, 2, "nothing to send, and no stray new line");
  mac.textarea.value = "hello";
  // A handler before it (the @mention list choosing with Enter) has the key.
  mac.textarea.addEventListener("keydown", (event: Event) => event.preventDefault(), { capture: true });
  mac.press({}); assert.equal(mac.sent.length, 2);

  const modEnter = mount("darwin", "mod-enter"); t.after(() => modEnter.dom.window.close());
  assert.equal(modEnter.press({}), false); assert.equal(modEnter.sent.length, 0, "Enter adds a line");
  assert.equal(modEnter.press({ metaKey: true }), true); assert.equal(modEnter.sent.length, 1);
  const windows = mount("win32", "mod-enter"); t.after(() => windows.dom.window.close());
  assert.equal(windows.press({ metaKey: true }), false);
  assert.equal(windows.press({ ctrlKey: true }), true); assert.equal(windows.sent.length, 1, "Ctrl+Enter on Windows");
});

function mountSettings(own?: Record<string, string | null>) {
  const dom = new JSDOM('<main><div id="root"></div></main>', { url: "http://localhost/#/chat", runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.desktopAppearance = { platform: "darwin" };
  dom.window.eval(`${shellBundle}\nwindow.SettingsShell = SettingsShell;`);
  const appSettings: { ui: Record<string, unknown>; memory: unknown; profile: unknown } = { ui: { theme: "dark", sendKey: "enter", ...(own ? { shortcuts: own } : {}) }, memory: { localProfileId: "local-1" }, profile: { displayName: "Mira" } };
  const saves: Array<{ ui?: Record<string, unknown> }> = [];
  const data = { integrations: [], save: async (patch: { ui?: Record<string, unknown> }) => { saves.push(plain(patch)); appSettings.ui = { ...appSettings.ui, ...patch.ui }; } };
  const shell = dom.window.SettingsShell.createSettingsShell({ app: dom.window.document.getElementById("root"), getContext: () => ({ appSettings }), data,
    voiceInput: { available: () => true, leaveChat() {}, mountSettings() {} }, applyPreferences() {}, captureScroll: () => ({}), restoreScroll() {}, onReturn() {} });
  shell.route("#/settings/shortcuts");
  const document = dom.window.document;
  const row = (id: string) => document.querySelector(`[data-shortcut="${id}"]`);
  // The keys on the right; a changed row also names its default keys in the hint.
  const keys = (id: string) => row(id).querySelector(".settings-shortcut-control .settings-keys").textContent;
  const click = (selector: string) => document.querySelector(selector).click();
  const press = (init: Record<string, unknown>) => dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "x", ...init }));
  return { dom, document, saves, appSettings, row, keys, click, press, close: () => dom.window.close() };
}

test("Keyboard Shortcuts records new keys, refuses reserved ones, asks before taking another action's, and resets", async t => {
  const ui = mountSettings(); t.after(ui.close);
  assert.equal(ui.document.querySelectorAll("[data-shortcut]").length, 10);
  assert.match(ui.document.querySelector("#settings-entity-form select[name='ui.sendKey']").textContent, /⌘Enter/);
  assert.equal(ui.keys("newChat").trim().startsWith("⌘N"), true);
  // The app's own key handlers get nothing while keys are recorded.
  let reachedApp = 0;
  ui.dom.window.addEventListener("keydown", () => { reachedApp++; });

  ui.click('[data-shortcut-change="newChat"]');
  assert.match(ui.row("newChat").querySelector(".settings-shortcut-control .settings-keys").className, /is-recording/);
  assert.match(ui.row("newChat").textContent, /Press the new keys/);
  ui.press({ code: "KeyC", key: "c", metaKey: true });
  assert.match(ui.row("newChat").textContent, /⌘C is used for Copy/);
  ui.press({ code: "KeyK", key: "k", metaKey: true, shiftKey: true });
  await until(() => ui.saves.length === 1, "first save");
  assert.deepEqual(ui.saves[0], { ui: { shortcuts: { newChat: "Shift+Mod+KeyK" } } });
  assert.equal(reachedApp, 0);
  assert.match(ui.keys("newChat"), /⇧⌘K/);
  assert.match(ui.row("newChat").textContent, /Default/);

  ui.click('[data-shortcut-change="dictate"]');
  ui.press({ code: "Digit1", key: "1", metaKey: true });
  assert.match(ui.row("dictate").textContent, /⌘1 is used by Go to Chat/);
  assert.equal(ui.saves.length, 1, "nothing is taken before the person agrees");
  ui.click('[data-shortcut-replace="dictate"]');
  await until(() => ui.saves.length === 2, "replace saved");
  assert.deepEqual(ui.saves[1], { ui: { shortcuts: { newChat: "Shift+Mod+KeyK", dictate: "Mod+Digit1", goChat: null } } });
  assert.match(ui.keys("goChat"), /None/);

  ui.click('[data-shortcut-change="stopGeneration"]');
  ui.press({ code: "Escape", key: "Escape" });
  assert.match(ui.keys("stopGeneration"), /Esc/);
  assert.doesNotMatch(ui.row("stopGeneration").querySelector(".settings-shortcut-control .settings-keys").className, /is-recording/, "Esc cancels");

  ui.click('[data-shortcut-change="openSettings"]');
  ui.press({ code: "Delete", key: "Delete" });
  await until(() => ui.saves.length === 3, "removal saved");
  assert.equal(ui.saves[2].ui?.shortcuts && (ui.saves[2].ui.shortcuts as Record<string, unknown>).openSettings, null);

  ui.click("[data-shortcut-reset-all]");
  await until(() => ui.saves.length === 4, "reset saved");
  assert.deepEqual(ui.saves[3], { ui: { shortcuts: {} } });
  assert.match(ui.keys("goChat"), /⌘1/);
  assert.equal(ui.document.querySelector("[data-shortcut-reset-all]").disabled, true);
});

test("resetting an action asks first when its default now belongs to another action", async t => {
  const ui = mountSettings({ newChat: "Mod+Digit1", goChat: null }); t.after(ui.close);
  assert.match(ui.keys("goChat"), /None/);
  ui.click('[data-shortcut-reset="goChat"]');
  assert.match(ui.row("goChat").textContent, /⌘1 is used by New chat/);
  ui.click('[data-shortcut-keep="goChat"]');
  assert.equal(ui.saves.length, 0);
  ui.click('[data-shortcut-reset="goChat"]');
  ui.click('[data-shortcut-replace="goChat"]');
  await until(() => ui.saves.length === 1, "reset saved");
  assert.deepEqual(ui.saves[0], { ui: { shortcuts: { newChat: null } } });
});

test("settings accept the send key and readable shortcuts only", () => {
  validateSettingsPatch({ ui: { sendKey: "mod-enter", shortcuts: { newChat: "Shift+Mod+KeyK", dictate: null, stopGeneration: "Escape", goChat: "F5" } } });
  validateSettingsPatch({ ui: { shortcuts: {} } });
  const refused: unknown[] = [
    { sendKey: "space" }, { shortcuts: [] }, { shortcuts: "Mod+KeyK" }, { shortcuts: { newChat: "Mod+Enter" } }, { shortcuts: { newChat: "KeyK+Mod" } },
    { shortcuts: { newChat: "Mod+KeyK", dictate: "Mod+KeyK" } }, { shortcuts: { "bad id": "Mod+KeyK" } }, { shortcuts: { newChat: 5 } },
    { shortcuts: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`action${index}`, null])) }
  ];
  for (const ui of refused) assert.throws(() => validateSettingsPatch({ ui } as never), /ui\.(?:shortcuts|sendKey)/, JSON.stringify(ui).slice(0, 80));
  assert.deepEqual(readShortcuts({ newChat: "Mod+KeyK", dictate: "Mod+KeyK", goChat: "Mod+Enter", "bad id": null, goModels: null }), { newChat: "Mod+KeyK", goModels: null });
  assert.equal(readShortcuts("Mod+KeyK"), undefined);
});
