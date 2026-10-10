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

test("the packaged app's fuses refuse running it as Node, NODE_OPTIONS, --inspect and file:// privileges, and a build publishes nothing itself", () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
  const fuses = manifest.build.electronFuses;
  // Native runtimes start through /bin/sh or directly (src/local/guardedProcess.ts), not as Node children.
  assert.equal(fuses.runAsNode, false);
  assert.equal(fuses.enableNodeOptionsEnvironmentVariable, false);
  assert.equal(fuses.enableNodeCliInspectArguments, false);
  assert.equal(fuses.grantFileProtocolExtraPrivileges, false);
  // Flipping a fuse changes the binary: without a signing identity it must be signed again (ad hoc),
  // or macOS kills it at launch.
  assert.equal(fuses.resetAdHocDarwinSignature, true);
  // The updater's feed: GitHub releases of the public repository, never a token (it would ship in
  // app-update.yml); artifact names without spaces (GitHub renames them, and the feed would point nowhere).
  assert.deepEqual(manifest.build.publish, { provider: "github", owner: "Ilyaberdar", repo: "local-cognitive-AI-system" });
  for (const name of [manifest.build.mac.artifactName, manifest.build.nsis.artifactName]) assert.doesNotMatch(name, /\s/);
  for (const script of ["dist:mac", "dist:mac:arm64", "dist:mac:x64", "dist:win"]) assert.match(manifest.scripts[script], /--publish never$/);
});
