import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAeadVaultCipher } from "../src/security/AeadVaultCipher";
import { devVaultDirectory, migrateVaultRecords, openDevVault, usesDevVault } from "../src/security/devVault";
import { loadVaultKey } from "../src/security/vaultKey";

const digest = (key: string) => createHash("sha256").update(key).digest("hex");

test("the Keychain vault's records move to the development vault: readable, never overwritten, nothing deleted", async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dev-vault-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dataRoot = path.join(base, "data"), appData = path.join(dataRoot, "app"), keyFile = path.join(base, "config", "dev-vault.key");
  const old = path.join(appData, "integrations", "vault");
  fs.mkdirSync(old, { recursive: true });
  // The Keychain cipher stands in as a reversible transform here.
  const keychain = (value: string) => Buffer.from(`kc:${value}`);
  fs.writeFileSync(path.join(old, `${digest("account/session")}.enc`), keychain('{"refreshToken":"r1"}'));
  fs.writeFileSync(path.join(old, `${digest("remote/device/acc")}.enc`), keychain('{"tls":"pem"}'));
  fs.writeFileSync(path.join(old, `${digest("broken")}.enc`), Buffer.from("garbage"));
  fs.writeFileSync(path.join(old, "notes.txt"), "not a record");

  const vault = openDevVault(appData, dataRoot, keyFile);
  if (process.platform !== "win32") assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  const cipher = createAeadVaultCipher([loadVaultKey(keyFile, { forbiddenRoots: [dataRoot] })]);
  const decrypt = (blob: Buffer) => { const text = blob.toString(); if (!text.startsWith("kc:")) throw new Error("unreadable"); return text.slice(3); };
  assert.deepEqual(migrateVaultRecords(old, devVaultDirectory(appData), decrypt, cipher), { copied: 2, kept: 0, unreadable: 1 });
  assert.equal(await vault.read("account/session"), '{"refreshToken":"r1"}');
  assert.equal(await vault.read("remote/device/acc"), '{"tls":"pem"}');
  assert.equal(fs.readdirSync(old).length, 4, "the old vault is left as it was");
  // A second run keeps what is there (it may have changed since).
  await vault.write("account/session", '{"refreshToken":"r2"}');
  assert.deepEqual(migrateVaultRecords(old, devVaultDirectory(appData), decrypt, cipher), { copied: 0, kept: 2, unreadable: 1 });
  assert.equal(await vault.read("account/session"), '{"refreshToken":"r2"}');
  // Its key never lives with the data it protects.
  assert.throws(() => openDevVault(appData, dataRoot, path.join(dataRoot, "dev-vault.key")), /outside the data directories/);
});

test("only a development run on macOS keeps its secrets out of the Keychain; a packaged app never does", () => {
  assert.equal(usesDevVault({ isPackaged: false, platform: "darwin", env: {} }), true);
  assert.equal(usesDevVault({ isPackaged: true, platform: "darwin", env: {} }), false, "a release uses the Keychain");
  assert.equal(usesDevVault({ isPackaged: false, platform: "win32", env: {} }), false);
  assert.equal(usesDevVault({ isPackaged: false, platform: "linux", env: {} }), false);
  assert.equal(usesDevVault({ isPackaged: false, platform: "darwin", env: { LOCAL_COGNITIVE_DEV_KEYCHAIN: "1" } }), false);
});
