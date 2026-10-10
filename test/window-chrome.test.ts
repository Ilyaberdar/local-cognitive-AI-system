import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

const { windowChromeOptions, windowsTitleBarOverlay } = require(path.resolve("electron/window-chrome.cjs"));

test("macOS keeps native group geometry for traffic lights and the sharing indicator", () => {
  const options = windowChromeOptions("darwin", true);
  assert.equal(options.titleBarStyle, "hidden");
  assert.equal(options.titleBarOverlay, true);
  assert.equal(options.trafficLightPosition, undefined);
  assert.equal(options.autoHideMenuBar, undefined);
});

test("Windows retains OS caption buttons and their geometry across themes", () => {
  const dark = windowChromeOptions("win32", true);
  const light = windowsTitleBarOverlay(false);
  assert.equal(dark.titleBarStyle, "hidden");
  assert.equal(dark.autoHideMenuBar, true);
  assert.equal(dark.trafficLightPosition, undefined);
  assert.equal(dark.titleBarOverlay.height, light.height);
  assert.notEqual(dark.titleBarOverlay.color, light.color);
  assert.notEqual(dark.titleBarOverlay.symbolColor, light.symbolColor);
  assert.deepEqual(windowChromeOptions("linux", true), {});
});

test("Windows caption buttons take the title bar's reported colors, hex colors only", () => {
  assert.deepEqual(windowsTitleBarOverlay(true, { color: "#0c1117", symbolColor: "#e8eef8" }), { height: 60, color: "#0c1117", symbolColor: "#e8eef8" });
  assert.deepEqual(windowsTitleBarOverlay(true, { color: "red; background: url(x)", symbolColor: "" }), windowsTitleBarOverlay(true), "anything else keeps the theme's defaults");
  assert.equal(windowsTitleBarOverlay(false, { color: "#E9EDF2" }).color, "#E9EDF2");
});

test("only Windows gets the settings strip's name and notices below its buttons; a click on any title strip closes an open menu", () => {
  const settings = fs.readFileSync("public/assets/settings-shell.css", "utf8"), glass = fs.readFileSync("public/assets/liquid-glass.css", "utf8");
  assert.match(settings, /html\[data-desktop=win32\] #settings-root::before \{ content: 'Cognitive';/);
  assert.match(settings, /html:is\(\[data-desktop=darwin\], \[data-desktop=win32\]\) #settings-root::before \{ content: '';/, "the Mac's strip stays as it was");
  assert.match(glass, /html\[data-desktop="win32"\] \.toast-stack \{ top: calc\(var\(--desktop-titlebar-height\) \+ 12px\); \}/);
  assert.doesNotMatch(glass, /darwin[^{}]*\.toast-stack/, "notices on a Mac stay where they were");
  assert.match(glass, /:has\(:popover-open\) :is\(\.app-topbar, \.sidebar-brand\) \{ -webkit-app-region: no-drag; \}/);
  assert.match(settings, /:has\(:popover-open\) #settings-root::before \{ -webkit-app-region: no-drag; \}/);
});
