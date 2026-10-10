import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, flush } from "./fixtures/appHarness";

test("a waiting update shows in the top bar, and its button opens Settings → About with the version", async () => {
  let listener: (state: unknown) => void = () => undefined;
  const available = { phase: "available", current: "0.1.0", available: { version: "0.2.0", date: null, size: null, notes: [] } };
  const app = await bootApp({ updates: {
    state: async () => available, check: async () => available, download: async () => available, cancel: async () => available,
    install: async () => ({ started: false, state: available }),
    onChange: (callback: (state: unknown) => void) => { listener = callback; return () => undefined; }, onOpen: () => () => undefined
  } });
  try {
    const pill = app.document.querySelector(".app-topbar__actions #update-pill") as HTMLAnchorElement;
    assert.ok(pill, "the button is in the top bar");
    assert.equal(pill.textContent, "Update to 0.2.0");
    listener({ ...available, phase: "downloading", progress: { percent: 42 } });
    assert.equal(app.document.querySelector("#update-pill")!.textContent, "Downloading 42%");
    listener(available);
    (app.document.querySelector("#update-pill") as HTMLAnchorElement).click();
    await flush(40);
    assert.equal(app.window.location.hash, "#/settings/about");
    assert.match(app.document.querySelector("[data-updates-panel]")?.textContent ?? "", /Version 0\.2\.0 is available/);
  } finally { app.close(); }
});

test("without the desktop app's update bridge the top bar has no update button", async () => {
  const app = await bootApp();
  try { assert.equal(app.document.querySelector("[data-update-pill], #update-pill"), null); } finally { app.close(); }
});
