import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { refusedSwitch } = require(path.resolve("electron/launch-guard.cjs"));
const switches = (...names: string[]) => (name: string) => names.includes(name);

test("a packaged app refuses a debugger on its pages and a stand-in Keychain", () => {
  for (const name of ["remote-debugging-port", "remote-debugging-pipe", "use-mock-keychain"]) {
    assert.equal(refusedSwitch({ isPackaged: true, hasSwitch: switches("lang", name) }), name);
  }
  assert.equal(refusedSwitch({ isPackaged: true, hasSwitch: switches("lang", "disable-gpu") }), undefined);
});

test("a development run keeps its debugging switches", () => {
  assert.equal(refusedSwitch({ isPackaged: false, hasSwitch: switches("remote-debugging-port", "use-mock-keychain") }), undefined);
});

test("the packaged app's fuses ignore NODE_OPTIONS, --inspect and file:// privileges, and a build publishes nothing", () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
  const fuses = manifest.build.electronFuses;
  assert.equal(fuses.enableNodeOptionsEnvironmentVariable, false);
  assert.equal(fuses.enableNodeCliInspectArguments, false);
  assert.equal(fuses.grantFileProtocolExtraPrivileges, false);
  // Flipping a fuse changes the binary: without a signing identity it must be signed again (ad hoc),
  // or macOS kills it at launch.
  assert.equal(fuses.resetAdHocDarwinSignature, true);
  assert.equal(manifest.build.publish, null);
  for (const script of ["dist:mac", "dist:mac:arm64", "dist:mac:x64", "dist:win"]) assert.match(manifest.scripts[script], /--publish never$/);
});
