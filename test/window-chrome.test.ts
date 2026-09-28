import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

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
