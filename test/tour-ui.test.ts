import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSync } from "esbuild";
import { config } from "../src/config/config";
import { AppSettingsStore } from "../src/app/AppSettingsStore";
import { validateSettingsPatch } from "../src/app/settingsValidation";
import { bootApp, defaultBootstrap } from "./fixtures/appHarness";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require("jsdom");
const tourBundle = buildSync({ entryPoints: ["public/assets/tour.js"], bundle: true, write: false, format: "iife", globalName: "Tour" }).outputFiles[0].text;

// Objects made in the page's realm, compared as plain data.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
async function until(check: () => boolean, label: string) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 5_000) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// The first screen as the tour sees it: the sidebar's places, the composer and the profile menu.
const SCREEN = `<div id="app">
  <aside class="sidebar"><nav>
    <button class="nav-button" data-route="chat">Chat</button><button class="nav-button" data-route="orchestration">Workflow</button>
    <button class="nav-button" data-route="synthesis">Synthesis</button><button class="nav-button" data-route="models">Models</button>
    <button class="nav-button" data-route="remote">Remote</button></nav>
    <div class="sidebar-conversations"><section class="sidebar-section" data-rect="20,300,200,60">Projects</section><section class="sidebar-section" data-rect="20,380,200,80">Chats</section></div>
    <button id="local-profile-button">Local profile</button>
  </aside>
  <form id="chat-form"><textarea id="message"></textarea></form>
</div>`;

type Options = Record<string, unknown>;
function mount(options: Options = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${SCREEN}</body></html>`, { url: "http://localhost/#/chat", runScripts: "outside-only", pretendToBeVisual: true });
  const window = dom.window, document = window.document;
  // JSDOM has <dialog> without showModal.
  window.HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  window.eval(`${tourBundle}\nwindow.Tour = Tour;`);
  const closed: string[] = [];
  let offers = 0;
  // A place is on screen while it is in the document and not hidden; its rect comes from data-rect.
  const isVisible = (element: HTMLElement | null) => Boolean(element?.isConnected) && !element!.closest("[hidden]");
  const rectOf = (element: HTMLElement) => {
    const [left, top, width, height] = (element.dataset.rect ?? "20,40,200,36").split(",").map(Number);
    return { left, top, width, height };
  };
  const tour = window.Tour.createTour({ doc: document, isVisible, rectOf, poll: 5, fallbackFocus: () => document.querySelector("#message"),
    onClose: (reason: string) => closed.push(reason), onOffer: () => { offers += 1; }, ...options });
  const dialog = () => document.querySelector("dialog.app-tour");
  const button = (name: string) => dialog().querySelector(`[data-tour="${name}"]`);
  const key = (key: string, init: Record<string, unknown> = {}) => (document.activeElement ?? dialog()).dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  return { dom, window, document, tour, dialog, button, key, closed, offers: () => offers, close: () => window.close(), Tour: window.Tour };
}

const shown = (ui: ReturnType<typeof mount>) => ({
  step: ui.dialog().dataset.step, title: ui.dialog().querySelector("#app-tour-title").textContent,
  count: ui.dialog().querySelector("[data-tour-count]").textContent, next: ui.button("next").textContent,
  back: !ui.button("back").hidden, skip: ui.button("skip").hidden ? null : ui.button("skip").textContent
});

test("the tour shows its places in order, from a welcome to the profile menu, and ends with Done", async t => {
  const ui = mount(); t.after(ui.close);
  assert.equal(ui.tour.start(), true);
  assert.ok(ui.dialog().hasAttribute("open"));
  assert.deepEqual(shown(ui), { step: "welcome", title: "Welcome to Local Cognitive", count: "", next: "Show me around", back: false, skip: "Not now" });
  assert.equal(ui.document.activeElement, ui.button("next"), "focus starts on the main button");
  const steps = [ui.tour.step()];
  while (ui.button("next").textContent !== "Done") { ui.button("next").click(); steps.push(ui.tour.step()); }
  assert.deepEqual(steps, ["welcome", "models", "chat", "projects", "workflow", "synthesis", "remote", "settings"]);
  assert.deepEqual(shown(ui), { step: "settings", title: "Settings and account", count: "7 of 7", next: "Done", back: true, skip: null });
  ui.button("back").click();
  assert.deepEqual([ui.tour.step(), ui.dialog().querySelector("[data-tour-count]").textContent], ["remote", "6 of 7"]);
  ui.button("next").click(); ui.button("next").click();
  assert.equal(ui.dialog(), null, "Done closes the tour");
  assert.deepEqual(ui.closed, ["done"]);
  assert.equal(ui.document.activeElement.id, "message", "focus goes to the composer when it came from nowhere");
});

test("the highlight covers the place (or the named parts of it), and the bubble stands beside it", async t => {
  const ui = mount(); t.after(ui.close);
  ui.tour.start();
  const spot = () => ui.dialog().querySelector("[data-tour-spot]");
  assert.ok(spot().classList.contains("is-empty"), "the welcome dims the window without a highlight");
  assert.equal(ui.dialog().querySelector("[data-tour-bubble]").dataset.side, "none");
  ui.button("next").click();
  assert.equal(ui.tour.step(), "models");
  assert.ok(!spot().classList.contains("is-empty"));
  assert.deepEqual([spot().style.left, spot().style.top, spot().style.width, spot().style.height], ["16px", "36px", "208px", "44px"], "the place, 4 px around it");
  ui.button("next").click(); ui.button("next").click();
  assert.equal(ui.tour.step(), "projects");
  assert.deepEqual([spot().style.top, spot().style.height], ["296px", "168px"], "the two sections of the list, not the empty space under them");
});

test("a place that is not on screen is left out, forward and back, and not counted", async t => {
  const ui = mount(); t.after(ui.close);
  ui.document.querySelector("#chat-form").hidden = true;
  ui.document.querySelector(".sidebar-conversations").remove();
  ui.tour.start();
  ui.button("next").click();
  assert.deepEqual([ui.tour.step(), ui.dialog().querySelector("[data-tour-count]").textContent], ["models", "1 of 5"]);
  ui.button("next").click();
  assert.deepEqual([ui.tour.step(), ui.dialog().querySelector("[data-tour-count]").textContent], ["workflow", "2 of 5"]);
  ui.button("back").click();
  assert.equal(ui.tour.step(), "models", "Back skips the hidden places too");

  // A place that goes while its step is shown: the bubble waits in the middle, and follows it back.
  ui.button("next").click();
  const workflow = ui.document.querySelector('[data-route="orchestration"]');
  const parent = workflow.parentElement, after = workflow.nextSibling;
  workflow.remove();
  await settle();
  assert.equal(ui.tour.step(), "workflow");
  assert.ok(ui.dialog().querySelector("[data-tour-spot]").classList.contains("is-empty"));
  assert.equal(ui.dialog().querySelector("[data-tour-bubble]").dataset.side, "none");
  parent.insertBefore(workflow, after);
  await settle();
  assert.ok(!ui.dialog().querySelector("[data-tour-spot]").classList.contains("is-empty"), "the highlight is back on the place");
});

test("with no place on screen and no welcome, the tour does not open", async t => {
  const ui = mount({ steps: [{ id: "gone", target: "#nowhere", title: "Gone", text: "Not here." }] }); t.after(ui.close);
  assert.equal(ui.tour.start(), false);
  assert.equal(ui.dialog(), null);
  assert.deepEqual(ui.closed, ["unavailable"]);
});

test("Esc skips the tour, arrows move through it, Tab stays in the bubble, and focus goes back", async t => {
  const ui = mount(); t.after(ui.close);
  const message = ui.document.querySelector("#message");
  message.focus();
  ui.tour.start();
  ui.key("ArrowRight");
  assert.equal(ui.tour.step(), "models");
  ui.key("ArrowRight"); ui.key("ArrowLeft");
  assert.equal(ui.tour.step(), "models");
  // Skip tour, Back, Next: Tab wraps from the last to the first and Shift+Tab back.
  assert.equal(ui.document.activeElement, ui.button("next"));
  ui.key("Tab");
  assert.equal(ui.document.activeElement, ui.button("skip"));
  ui.key("Tab", { shiftKey: true });
  assert.equal(ui.document.activeElement, ui.button("next"));
  ui.button("back").focus();
  ui.key("ArrowLeft");
  assert.equal(ui.tour.step(), "welcome");
  assert.ok(ui.button("back").hidden);
  assert.equal(ui.document.activeElement, ui.button("next"), "the hidden Back hands focus to the main button");
  ui.key("Escape");
  assert.equal(ui.dialog(), null);
  assert.deepEqual(ui.closed, ["skipped"]);
  assert.equal(ui.document.activeElement, message, "focus returns where it was");

  // The dialog's own cancel (Esc in a real window) is a skip too, and Skip tour is.
  ui.tour.start();
  ui.dialog().dispatchEvent(new ui.window.Event("cancel", { cancelable: true }));
  ui.tour.start(); ui.button("next").click(); ui.button("skip").click();
  assert.deepEqual(ui.closed, ["skipped", "skipped", "skipped"]);
});

test("the dialog is named by its step, and each new step is read out", async t => {
  const ui = mount(); t.after(ui.close);
  ui.tour.start();
  const dialog = ui.dialog();
  assert.equal(ui.document.getElementById(dialog.getAttribute("aria-labelledby")).textContent, "Welcome to Local Cognitive");
  assert.match(ui.document.getElementById(dialog.getAttribute("aria-describedby")).textContent, /runs? on your computer/);
  const live = dialog.querySelector("[aria-live=polite]");
  assert.equal(live.textContent, "", "the first step is read as the dialog's name and description");
  ui.button("next").click(); ui.button("next").click();
  assert.match(live.textContent, /^2 of 7\. Chat\. Ask anything here\./);
  assert.equal(ui.document.getElementById(dialog.getAttribute("aria-labelledby")).textContent, "Chat");
  for (const element of dialog.querySelectorAll("button")) assert.equal(element.type, "button");
});

test("seen is kept in the settings and in localStorage, and a launch picks the tour, the offer or nothing", async t => {
  const ui = mount(); t.after(ui.close);
  const { createTourStore, tourAtLaunch, TOUR_VERSION } = ui.Tour;
  assert.equal(TOUR_VERSION, 1);
  const saved: unknown[] = [];
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const store = createTourStore({ storage, save: (patch: unknown) => { saved.push(patch); } });
  assert.equal(store.seen(undefined), 0);
  assert.equal(store.seen({ theme: "dark" }), 0);
  assert.equal(store.seen({ tourSeen: 1 }), 1);
  assert.equal(store.seen({ tourSeen: "1" }), 0, "only an integer counts");
  await store.mark();
  assert.deepEqual(plain(saved), [{ ui: { tourSeen: 1 } }]);
  assert.equal(values.get("lcai.tourSeen"), "1");
  assert.equal(store.seen({ theme: "dark" }), 1, "localStorage keeps it when the settings did not");

  // Storage that throws and a save that fails never throw.
  const broken = createTourStore({ storage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } }, save: () => Promise.reject(new Error("offline")) });
  assert.equal(broken.seen(undefined), 0);
  await broken.mark();

  assert.equal(tourAtLaunch({ ui: undefined, seen: 0 }), "tour", "a new profile: its settings have no appearance yet");
  assert.equal(tourAtLaunch({ ui: { theme: "dark" }, seen: 0 }), "offer", "an existing profile that has not seen it");
  assert.equal(tourAtLaunch({ ui: { theme: "dark", tourSeen: 1 }, seen: 1 }), null);
  assert.equal(tourAtLaunch({ ui: undefined, seen: 1 }), null);
});

test("a launch waits while something else holds the window, and the tour can be taken again", async t => {
  let blocked = true;
  const ui = mount({ blocked: () => blocked }); t.after(ui.close);
  ui.tour.launch("tour", { delay: 0 });
  await settle();
  assert.equal(ui.dialog(), null, "another dialog or Settings is open");
  blocked = false;
  await until(() => Boolean(ui.dialog()), "the tour opens once the window is free");
  ui.tour.close();
  assert.deepEqual(ui.closed, ["skipped"]);
  ui.tour.launch("tour");
  await until(() => Boolean(ui.dialog()), "taken again");
  assert.equal(ui.tour.step(), "welcome", "again from the start");
  assert.equal(ui.tour.start(), false, "never twice at once");
});

test("the offer stands beside the profile menu once, starts the tour or goes away", async t => {
  const ui = mount(); t.after(ui.close);
  const card = () => ui.document.querySelector(".app-tour-offer");
  ui.tour.launch("offer");
  await until(() => Boolean(card()), "offer shown");
  assert.equal(ui.offers(), 1);
  assert.equal(card().querySelector("#app-tour-offer-title").textContent, "New: a tour of the app");
  assert.notEqual(card().dataset.side, undefined);
  assert.equal(ui.document.activeElement.id, "", "the offer does not take the focus");
  assert.equal(ui.tour.offer(), false, "one at a time");
  await until(() => /New: a tour of the app\./.test(card().querySelector("[data-tour-offer-live]").textContent), "read out");

  // Hidden while the profile menu is not on screen, back when it is.
  ui.document.querySelector("#local-profile-button").hidden = true;
  await settle();
  assert.equal(card().hidden, true);
  ui.document.querySelector("#local-profile-button").hidden = false;
  await settle();
  assert.equal(card().hidden, false);

  card().querySelector('[data-tour-offer="take"]').click();
  assert.equal(card(), null);
  assert.equal(ui.tour.step(), "welcome");
  ui.tour.close();

  ui.tour.offer();
  card().querySelector('[data-tour-offer="decline"]').focus();
  card().querySelector('[data-tour-offer="decline"]').click();
  assert.equal(card(), null);
  assert.equal(ui.document.activeElement.id, "message", "focus does not fall to the page");
  ui.tour.offer();
  card().querySelector("button").dispatchEvent(new ui.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(card(), null, "Esc dismisses it");
  assert.equal(ui.dialog(), null);
});

test("the bubble goes on the preferred side when it fits, else on another, else inside the window", async t => {
  const ui = mount(); t.after(ui.close);
  const placeBubble = (...args: unknown[]) => plain(ui.Tour.placeBubble(...args));
  const view = { width: 1280, height: 800 }, size = { width: 340, height: 180 };
  const nav = { left: 12, top: 300, width: 208, height: 40 };
  assert.deepEqual(placeBubble(nav, size, view, "right"), { side: "right", left: 234, top: 230, arrow: 90 });
  // At the right edge, the right side has no room: the first side that does.
  assert.equal(placeBubble({ left: 1100, top: 300, width: 160, height: 40 }, size, view, "right").side, "bottom");
  // Low in the window: above it, the arrow under the bubble aims at its middle.
  const composer = placeBubble({ left: 400, top: 620, width: 600, height: 150 }, size, view, "top");
  assert.deepEqual(composer, { side: "top", left: 530, top: 426, arrow: 170 });
  // A narrow window with no room on any side: kept inside it, without an arrow.
  const tight = placeBubble({ left: 0, top: 0, width: 360, height: 600 }, size, { width: 380, height: 620 }, "right");
  assert.equal(tight.side, "none");
  assert.ok(tight.left >= 12 && tight.left + size.width <= 380 - 12 + 1 && tight.top >= 12);
  // No place: the middle of the window.
  assert.deepEqual(placeBubble(null, size, view), { side: "none", left: 470, top: 310, arrow: 0 });
  // Near the bottom on the right side, the bubble stays in the window and the arrow follows the place.
  const profile = placeBubble({ left: 12, top: 740, width: 208, height: 44 }, size, view, "right");
  assert.deepEqual([profile.side, profile.top, profile.arrow], ["right", 608, 154]);
});

test("ui.tourSeen is a device setting: validated, kept, cleaned up, and a new profile has no ui yet", async t => {
  validateSettingsPatch({ ui: { tourSeen: 1 } });
  for (const tourSeen of [-1, 1.5, "1", 1001, null]) assert.throws(() => validateSettingsPatch({ ui: { tourSeen } } as never), /ui\.tourSeen/, String(tourSeen));
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tour-settings-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = new AppSettingsStore(root, config);
  assert.equal((await store.get()).ui, undefined, "the window shows the tour while the profile has no ui preferences");
  await store.update({ ui: { theme: "light" } } as never);
  const updated = await store.update({ ui: { tourSeen: 1 } } as never);
  assert.deepEqual([updated.ui?.theme, updated.ui?.tourSeen], ["light", 1]);
  const file = path.join(root, "settings.json"), stored = JSON.parse(await fsp.readFile(file, "utf8"));
  assert.equal(stored.ui.tourSeen, 1);
  stored.ui.tourSeen = "yes";
  await fsp.writeFile(file, JSON.stringify(stored));
  assert.equal((await new AppSettingsStore(root, config).get()).ui?.tourSeen, undefined, "a value that is not one is dropped");
});

// The whole window: the tour at a new profile's first launch, the offer for an existing one, and
// the ways to take it again.
const appSettingsRoute = (saved: string[]) => (method: string, url: string, body?: string) => {
  if (url !== "/app/settings" || method !== "PUT") return undefined;
  saved.push(body ?? "");
  const patch = JSON.parse(body ?? "{}");
  return { settings: { ...defaultBootstrap().appSettings, ui: { theme: "dark", animations: false, ...patch.ui } } };
};

test("a new profile gets the tour at its first launch, and seen is saved when it ends", async t => {
  const saved: string[] = [];
  const bootstrap = () => { const value = defaultBootstrap() as any; delete value.appSettings.ui; return value; };
  const page = await bootApp({ bootstrap, route: appSettingsRoute(saved) });
  t.after(page.close);
  const dialog = () => page.document.querySelector("dialog.app-tour");
  await until(() => Boolean(dialog()), "the tour opens by itself");
  assert.equal(dialog().dataset.step, "welcome");
  assert.equal(page.document.querySelector(".app-tour-offer"), null, "a new profile gets the tour, not the offer");
  // JSDOM lays nothing out: every element gets a box, as on a screen.
  page.window.Element.prototype.getBoundingClientRect = () => ({ left: 20, top: 40, width: 200, height: 36, right: 220, bottom: 76, x: 20, y: 40 });
  dialog().querySelector('[data-tour="next"]').click();
  assert.equal(dialog().dataset.step, "models", "the first place is on the real screen");
  assert.ok(page.document.querySelector('.nav-button[data-route="models"]'));
  dialog().dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(dialog(), null);
  await until(() => saved.some(body => body === JSON.stringify({ ui: { tourSeen: 1 } })), "seen saved");
  assert.equal(page.window.localStorage.getItem("lcai.tourSeen"), "1");
  assert.equal(page.document.activeElement, page.document.querySelector("#chat-form textarea"), "focus goes to the composer");
});

test("an existing profile is offered the tour once; the profile menu and Help → Take the Tour start it", async t => {
  const saved: string[] = [];
  let helpTour: (() => void) | undefined;
  const bootstrap = () => { const value = defaultBootstrap() as any; delete value.appSettings.ui.tourSeen; return value; };
  const page = await bootApp({ bootstrap, route: appSettingsRoute(saved), desktopApp: { onTour: (callback: () => void) => { helpTour = callback; }, openDataFolder() {}, getInfo: async () => ({}) } });
  t.after(page.close);
  const card = () => page.document.querySelector(".app-tour-offer");
  await until(() => Boolean(card()), "the offer appears");
  assert.equal(page.document.querySelector("dialog.app-tour"), null, "not the tour itself");
  await until(() => saved.includes(JSON.stringify({ ui: { tourSeen: 1 } })), "offered once: seen when shown");
  card().querySelector('[data-tour-offer="decline"]').click();
  assert.equal(card(), null);

  page.document.getElementById("local-profile-button").click();
  const item = page.document.querySelector('#profile-menu [data-profile-route="tour"]');
  assert.equal(item?.textContent, "Take the tour");
  item.click();
  await until(() => Boolean(page.document.querySelector("dialog.app-tour")), "from the profile menu");
  page.document.querySelector('dialog.app-tour [data-tour="skip"]').click();

  // From Settings, Help → Take the Tour returns to the screen first.
  page.window.location.hash = "#/settings/appearance";
  await until(() => !page.document.getElementById("settings-root").hidden, "settings open");
  assert.ok(helpTour, "the window listens to Help → Take the Tour");
  helpTour!();
  await until(() => Boolean(page.document.querySelector("dialog.app-tour")), "from the Help menu");
  assert.equal(page.document.getElementById("settings-root").hidden, true);
  assert.equal(page.document.querySelector("dialog.app-tour").dataset.step, "welcome");
});
