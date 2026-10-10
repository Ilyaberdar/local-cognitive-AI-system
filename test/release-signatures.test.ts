import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";

const gate = path.resolve(__dirname, "..", "..", "scripts", "verify-release-signatures.mjs");
const verify = (directory: string) => {
  const result = spawnSync(process.execPath, [gate, directory], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};
const releaseDir = (t: TestContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lc-gate-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};

/** A minimal PE32+ file; `signature` sets the size of its security (Authenticode) directory. */
const peFile = (file: string, signature: number) => {
  const bytes = Buffer.alloc(0x200);
  bytes.write("MZ", 0, "latin1");
  bytes.writeUInt32LE(0x40, 0x3c);
  bytes.write("PE\0\0", 0x40, "latin1");
  bytes.writeUInt16LE(0x20b, 0x40 + 24);
  const security = 0x40 + 24 + 112 + 4 * 8;
  bytes.writeUInt32LE(signature ? 0x100 : 0, security);
  bytes.writeUInt32LE(signature, security + 4);
  fs.writeFileSync(file, bytes);
};

test("the release gate refuses an unsigned Windows installer and a directory with nothing to publish", async t => {
  const empty = releaseDir(t);
  fs.mkdirSync(path.join(empty, ".previous-mac-arm64"));
  peFile(path.join(empty, ".previous-mac-arm64", "scratch.exe"), 0);
  const nothing = verify(empty);
  assert.equal(nothing.status, 1);
  assert.match(nothing.output, /Nothing to verify/, "hidden builder folders are not artifacts");

  const directory = releaseDir(t);
  peFile(path.join(directory, "Local Cognitive Setup.exe"), 0);
  const unsigned = verify(directory);
  assert.equal(unsigned.status, 1);
  assert.match(unsigned.output, /✗ .*Local Cognitive Setup\.exe\n\s+it has no Authenticode signature/);

  // A signature table that no tool vouches for is not enough either.
  peFile(path.join(directory, "Local Cognitive Setup.exe"), 0x40);
  const unverified = verify(directory);
  assert.equal(unverified.status, 1);
  assert.doesNotMatch(unverified.output, /no Authenticode signature/);
});

test("the release gate refuses an ad-hoc signed macOS app, with each reason", { skip: process.platform !== "darwin" }, async t => {
  const directory = releaseDir(t);
  const app = path.join(directory, "mac-arm64", "Demo.app");
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>demo</string><key>CFBundleIdentifier</key><string>com.example.lc-gate</string>
<key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n`);
  fs.copyFileSync("/usr/bin/true", path.join(app, "Contents", "MacOS", "demo"));
  execFileSync("codesign", ["--sign", "-", "--force", app], { stdio: "ignore" });
  const result = verify(directory);
  assert.equal(result.status, 1);
  for (const reason of [/signed ad hoc, not with a Developer ID/, /no team identifier/, /hardened runtime/, /Gatekeeper does not accept it as notarized/, /no stapled notarization ticket/]) {
    assert.match(result.output, reason);
  }
  assert.match(result.output, /1 of 1 artifacts are not ready to publish/);
});
