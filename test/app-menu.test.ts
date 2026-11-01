import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { menuTemplate } = require(path.resolve("electron/app-menu.cjs"));

type Item = { role?: string; label?: string; type?: string; submenu?: Item[]; click?: () => void };
const roles = (items: Item[]): string[] => items.flatMap(item => [...(item.role ? [item.role] : []), ...roles(item.submenu ?? [])]);

test("an installed app has no Reload or Developer Tools; a development run keeps them", () => {
  const installed = roles(menuTemplate({ isPackaged: true, platform: "darwin", openReport: () => undefined }));
  for (const role of ["reload", "forceReload", "toggleDevTools", "viewMenu"]) assert.ok(!installed.includes(role), role);
  for (const role of ["appMenu", "editMenu", "resetZoom", "zoomIn", "zoomOut", "togglefullscreen", "windowMenu"]) assert.ok(installed.includes(role), role);
  assert.ok(!roles(menuTemplate({ isPackaged: true, platform: "win32", openReport: () => undefined })).includes("reload"), "Windows too");

  const development = roles(menuTemplate({ isPackaged: false, platform: "darwin", openReport: () => undefined }));
  for (const role of ["reload", "forceReload", "toggleDevTools"]) assert.ok(development.includes(role), role);
});

test("only macOS has the app menu, and Help takes the tour and reports a bug", () => {
  assert.ok(!roles(menuTemplate({ isPackaged: true, platform: "win32", openReport: () => undefined })).includes("appMenu"));
  let opened = 0, toured = 0;
  const help = (menuTemplate({ isPackaged: true, platform: "darwin", openReport: () => { opened++; }, openTour: () => { toured++; } }) as Item[]).find(item => item.role === "help")!;
  assert.deepEqual(help.submenu!.map(item => item.label ?? item.type), ["Take the Tour", "separator", "Report a Bug…"]);
  help.submenu![0]!.click!();
  help.submenu![2]!.click!();
  assert.deepEqual([toured, opened], [1, 1]);
  const withoutTour = (menuTemplate({ isPackaged: true, platform: "win32", openReport: () => undefined }) as Item[]).find(item => item.role === "help")!;
  assert.deepEqual(withoutTour.submenu!.map(item => item.label), ["Report a Bug…"]);
});

test("Windows names notifications after the app's id, the one its installer gives the Start menu shortcut", () => {
  const { APP_ID } = require(path.resolve("electron/app-id.cjs"));
  assert.equal(APP_ID, JSON.parse(fs.readFileSync("package.json", "utf8")).build.appId);
});

