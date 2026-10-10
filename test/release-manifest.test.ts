import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { artifactFor, isUpgrade, keyIdOf, verifyManifest, type ReleaseKey } from "../src/update/manifest";
import { RELEASE_KEYS } from "../src/update/releaseKeys";
import { compareVersions } from "../src/update/version";

const script = path.resolve(__dirname, "..", "..", "scripts", "release-key.mjs");
const manifest = (version = "0.2.0") => ({ schema: 1, product: "local-cognitive-server", version, channel: "stable", releasedAt: "2026-10-10T00:00:00Z",
  protocol: { min: 1, max: 1 }, hostDbSchema: 3, node: "22.23.3", notes: "Fixes.",
  artifacts: [{ platform: "linux", arch: "x64", url: "https://github.com/o/r/releases/download/v0.2.0/server.tar.gz", size: 1000, sha256: "a".repeat(64) }] });

test("versions order as releases do", () => {
  assert.ok(compareVersions("0.2.0", "0.1.9") > 0);
  assert.ok(compareVersions("0.10.0", "0.9.0") > 0, "numbers, not text");
  assert.ok(compareVersions("1.0.0-beta.2", "1.0.0-beta.10") < 0);
  assert.ok(compareVersions("1.0.0-beta.1", "1.0.0") < 0, "a pre-release comes before its release");
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.throws(() => compareVersions("1.2", "1.2.3"));
});

test("a release is believed only when a trusted key signed exactly its manifest", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, "keys", "release.key");
  const generated = execFileSync(process.execPath, [script, "generate", "--out", keyFile], { encoding: "utf8" });
  if (process.platform !== "win32") assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.throws(() => execFileSync(process.execPath, [script, "generate", "--out", keyFile], { stdio: "pipe" }), "an existing key is never overwritten");
  const [, id, publicKey] = /id: "([0-9a-f]{16})", publicKey: "([A-Za-z0-9_-]{43})"/.exec(generated)!;
  const raw = Buffer.from(createPublicKey(fs.readFileSync(keyFile, "utf8")).export({ format: "jwk" }).x!, "base64url");
  assert.equal(keyIdOf(raw), id);
  const keys: ReleaseKey[] = [{ id: id!, publicKey: publicKey! }];
  const file = path.join(dir, "server-manifest.json");
  fs.writeFileSync(file, JSON.stringify(manifest()));
  execFileSync(process.execPath, [script, "sign", file, "--key", keyFile]);
  const signature = fs.readFileSync(`${file}.sig`, "utf8");
  const verified = verifyManifest(fs.readFileSync(file), signature, keys);
  assert.equal(verified.version, "0.2.0");
  assert.equal(artifactFor(verified, "linux", "x64").sha256, "a".repeat(64));
  assert.throws(() => artifactFor(verified, "linux", "arm64"), /no build for linux-arm64/);
  assert.equal(isUpgrade(verified, "0.1.0"), true);
  assert.equal(isUpgrade(verified, "0.2.0"), false, "the same version is not an update");
  // Any change to the bytes, another key, or no key at all.
  const changed = Buffer.from(JSON.stringify({ ...manifest(), notes: "Fixes!" }));
  assert.throws(() => verifyManifest(changed, signature, keys), /does not match/);
  assert.throws(() => verifyManifest(fs.readFileSync(file), signature, [{ id: "0".repeat(16), publicKey: publicKey! }]), /does not trust/);
  assert.throws(() => verifyManifest(fs.readFileSync(file), signature, []), /no release key/);
  assert.throws(() => execFileSync(process.execPath, [script, "generate", "--out", path.resolve(__dirname, "..", "..", "leaked.key")], { stdio: "pipe" }), "never inside the repository");
});

test("the build trusts only well-formed release keys", () => {
  for (const key of RELEASE_KEYS) {
    assert.match(key.id, /^[0-9a-f]{16}$/);
    assert.equal(keyIdOf(Buffer.from(key.publicKey, "base64url")), key.id);
  }
});
