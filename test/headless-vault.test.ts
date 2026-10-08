import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { config } from "../src/config/config";
import { EncryptedCredentialVault } from "../src/plugins/EncryptedCredentialVault";
import { createAeadVaultCipher } from "../src/security/AeadVaultCipher";
import { headlessVaultDirectory, resolveHeadlessVault } from "../src/security/headlessVault";
import { initVaultKey, loadVaultKey, parseVaultKey } from "../src/security/vaultKey";

const posix = process.platform !== "win32";
const SECRET = "refresh-token-value-that-must-not-leak";

function temp(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "host-vault-")));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const key = (root: string, name = "vault.key") => {
  const file = path.join(root, "keys", name);
  return { file, id: initVaultKey(file, { forbiddenRoots: [] }).id };
};
const vaultWith = (directory: string, ...files: string[]) =>
  new EncryptedCredentialVault(directory, createAeadVaultCipher(files.map(file => loadVaultKey(file, { forbiddenRoots: [] }))));

test("records round-trip, are owner-only and contain no plaintext", { skip: !posix }, async t => {
  const root = temp(t), { file } = key(root), directory = path.join(root, "data", "vault");
  const vault = vaultWith(directory, file);
  assert.equal(await vault.read("account/session"), undefined);
  await vault.write("account/session", SECRET);
  assert.equal(await vault.read("account/session"), SECRET);
  const [record] = fs.readdirSync(directory);
  const blob = fs.readFileSync(path.join(directory, record!));
  assert.equal(blob.includes(Buffer.from(SECRET)), false);
  assert.equal(blob.includes(Buffer.from("account/session")), false);
  assert.equal(fs.statSync(path.join(directory, record!)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  await vault.write("account/session", SECRET);
  assert.notDeepEqual(fs.readFileSync(path.join(directory, record!)), blob, "a fresh nonce on every write");
});

test("tampering, truncation, moved records and unknown keys are rejected", { skip: !posix }, async t => {
  const root = temp(t), { file } = key(root), other = key(root, "other.key"), directory = path.join(root, "vault");
  const vault = vaultWith(directory, file);
  await vault.write("a", "value-a"); await vault.write("b", "value-b");
  const files = fs.readdirSync(directory).map(name => path.join(directory, name));
  const recordA = files[0]!;
  const original = fs.readFileSync(recordA);
  for (let index = 0; index < original.length; index++) {
    const changed = Buffer.from(original); changed[index]! ^= 1;
    fs.writeFileSync(recordA, changed);
    await assert.rejects(Promise.all([vault.read("a"), vault.read("b")]), Error, `byte ${index}`);
  }
  for (const changed of [original.subarray(0, original.length - 1), Buffer.concat([original, Buffer.from([0])])]) {
    fs.writeFileSync(recordA, changed);
    await assert.rejects(Promise.all([vault.read("a"), vault.read("b")]));
  }
  fs.writeFileSync(recordA, original);
  const [first, second] = files;
  const saved = fs.readFileSync(first!);
  fs.copyFileSync(second!, first!);
  await assert.rejects(Promise.all([vault.read("a"), vault.read("b")]), Error, "a record copied under another name");
  fs.writeFileSync(first!, saved);
  assert.deepEqual(await Promise.all([vault.read("a"), vault.read("b")]), ["value-a", "value-b"]);
  await assert.rejects(vaultWith(directory, other.file).read("a"), /could not be read/);
});

test("key files must be private, well formed and outside the data", { skip: !posix }, t => {
  const root = temp(t), { file } = key(root);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(file, "utf8"), /^[A-Za-z0-9+/]{43}=\n$/);
  const before = fs.readFileSync(file);
  assert.equal(initVaultKey(file, { forbiddenRoots: [] }).created, false);
  assert.deepEqual(fs.readFileSync(file), before, "an existing key is never overwritten");
  for (const mode of [0o640, 0o604]) {
    fs.chmodSync(file, mode);
    assert.throws(() => loadVaultKey(file, { forbiddenRoots: [] }), /accessible to other users/);
  }
  fs.chmodSync(file, 0o400);
  loadVaultKey(file, { forbiddenRoots: [] });
  assert.throws(() => loadVaultKey(file, { forbiddenRoots: [], euid: 12345 }), /owned by another user/);
  assert.throws(() => loadVaultKey(file, { forbiddenRoots: [path.dirname(file)] }), /outside the data/);
  const link = path.join(root, "link.key"); fs.symlinkSync(file, link);
  assert.throws(() => loadVaultKey(link, { forbiddenRoots: [path.dirname(file)] }), /outside the data/, "symlinks are resolved");
  assert.throws(() => initVaultKey(path.join(root, "data", "vault.key"), { forbiddenRoots: [path.join(root, "data")] }), /outside the data/);
  assert.throws(() => loadVaultKey("relative.key", { forbiddenRoots: [] }), /absolute/);
  for (const content of ["", "short", "A".repeat(44), Buffer.alloc(33).toString("base64")]) assert.throws(() => parseVaultKey(Buffer.from(content)));
  assert.equal(parseVaultKey(Buffer.alloc(32, 7)).length, 32);
  assert.equal(parseVaultKey(Buffer.from(`${Buffer.alloc(32, 1).toString("base64")}\r\n`)).length, 32);
});

test("without a key the server vault is unavailable with a reason, never plaintext", t => {
  const root = temp(t), settings = { ...config, appDataDir: path.join(root, "app") };
  const unset = resolveHeadlessVault(settings, {});
  assert.equal(unset.vault.available(), false);
  assert.match(unset.vault.unavailableReason() ?? "", /local-cognitive-server init/);
  assert.equal(unset.configured, false);
  const missing = resolveHeadlessVault(settings, { LOCAL_COGNITIVE_VAULT_KEY_FILE: path.join(root, "absent.key") });
  assert.match(missing.error ?? "", /does not exist/);
  assert.equal(headlessVaultDirectory(settings.appDataDir), path.join(root, "app", "integrations", "host-vault"));
});

test("rotation reads old records, writes with the new key and re-encrypts on rekey", { skip: !posix }, async t => {
  const root = temp(t), oldKey = key(root, "old.key"), newKey = key(root, "new.key"), directory = path.join(root, "vault");
  const before = vaultWith(directory, oldKey.file);
  await before.write("a", "1"); await before.write("b", "2");
  const rotating = vaultWith(directory, newKey.file, oldKey.file);
  assert.equal(await rotating.read("a"), "1");
  await rotating.write("c", "3");
  assert.deepEqual(await rotating.recordStatus(), { [oldKey.id]: 2, [newKey.id]: 1 });
  assert.deepEqual(await rotating.rekey(), { rekeyed: 2, current: 1, unreadable: 0 });
  assert.deepEqual(await rotating.rekey(), { rekeyed: 0, current: 3, unreadable: 0 });
  const newOnly = vaultWith(directory, newKey.file);
  assert.deepEqual(await Promise.all(["a", "b", "c"].map(name => newOnly.read(name))), ["1", "2", "3"]);
  await assert.rejects(vaultWith(directory, oldKey.file).read("a"));
});
