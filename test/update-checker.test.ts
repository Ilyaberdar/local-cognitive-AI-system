import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { keyIdOf, MANIFEST_SIGNATURE_CONTEXT } from "../src/update/manifest";
import { UpdateChecker } from "../src/update/updateChecker";

const signed = (version: string, key = generateKeyPairSync("ed25519")) => {
  const manifest = Buffer.from(JSON.stringify({ schema: 1, product: "local-cognitive-server", version, channel: "stable", releasedAt: "2026-10-10T00:00:00Z",
    protocol: { min: 1, max: 1 }, hostDbSchema: 3, node: "22.23.3", notes: "Faster downloads.",
    artifacts: [{ platform: "linux", arch: "x64", url: "https://releases.example/s.tar.gz", size: 10, sha256: "a".repeat(64) }] }));
  const raw = Buffer.from(key.publicKey.export({ format: "jwk" }).x!, "base64url");
  const id = keyIdOf(raw);
  const signature = JSON.stringify({ keyId: id, signature: sign(null, Buffer.concat([Buffer.from(MANIFEST_SIGNATURE_CONTEXT), Buffer.from([0]), manifest]), key.privateKey).toString("base64url") });
  return { manifest, signature, keys: [{ id, publicKey: raw.toString("base64url") }] };
};
const serving = (files: Record<string, string | Buffer>, calls: string[] = []) =>
  (async (url: string) => { calls.push(url); return url in files ? new Response(new Uint8Array(Buffer.from(files[url]!))) : new Response("", { status: 404 }); }) as unknown as typeof fetch;

test("a newer signed release is reported with its notes; the same version, a bad signature or no answer are not", async () => {
  const release = signed("0.2.0");
  const url = "https://releases.example/server-manifest.json";
  const checker = new UpdateChecker({ manifestUrl: url, keys: release.keys, currentVersion: "0.1.0", enabled: true,
    fetchImpl: serving({ [url]: release.manifest, [`${url}.sig`]: release.signature }) });
  const result = await checker.checkNow();
  assert.deepEqual(result.available, { version: "0.2.0", notes: "Faster downloads.", releasedAt: "2026-10-10T00:00:00Z" });
  assert.equal(result.error, undefined);
  const current = await new UpdateChecker({ manifestUrl: url, keys: release.keys, currentVersion: "0.2.0", enabled: true,
    fetchImpl: serving({ [url]: release.manifest, [`${url}.sig`]: release.signature }) }).checkNow();
  assert.equal(current.available, null);
  const forged = await new UpdateChecker({ manifestUrl: url, keys: release.keys, currentVersion: "0.1.0", enabled: true,
    fetchImpl: serving({ [url]: release.manifest, [`${url}.sig`]: signed("0.2.0").signature }) }).checkNow();
  assert.deepEqual([forged.available, forged.error], [null, "unknown_key"], "never shown unless our key signed it");
  const unpublished = await new UpdateChecker({ manifestUrl: url, keys: release.keys, currentVersion: "0.1.0", enabled: true, fetchImpl: serving({}) }).checkNow();
  assert.deepEqual([unpublished.available, unpublished.error, typeof unpublished.checkedAt], [null, undefined, "string"], "no release yet is not an error");
  const offline = await new UpdateChecker({ manifestUrl: url, keys: release.keys, currentVersion: "0.1.0", enabled: true,
    fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch }).checkNow();
  assert.equal(offline.error, "unreachable");
});

test("without a release key in the build, or turned off, nothing is fetched", async () => {
  const calls: string[] = [];
  for (const [keys, enabled, error] of [[[], true, "no_release_key"], [signed("0.2.0").keys, false, "checks_off"]] as const) {
    const checker = new UpdateChecker({ manifestUrl: "https://releases.example/m.json", keys, currentVersion: "0.1.0", enabled, fetchImpl: serving({}, calls), firstDelayMs: 0 });
    checker.start();
    assert.equal((await checker.checkNow()).error, error);
    checker.stop();
  }
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(calls, []);
});
