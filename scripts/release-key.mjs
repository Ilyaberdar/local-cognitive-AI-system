#!/usr/bin/env node
// Release signing for local-cognitive-server (spec §12):
//   node scripts/release-key.mjs generate --out <file>   a new Ed25519 key; prints the public key to embed
//   node scripts/release-key.mjs sign <manifest.json> --key <file>   writes <manifest.json>.sig
// The private key never enters the repository: store it as a GitHub Environment secret, or keep it
// offline and sign releases locally. RELEASE_SIGNING_KEY (PEM) may replace --key in CI.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTEXT = "lc-release-manifest/v1";
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [command, ...rest] = process.argv.slice(2);
const option = name => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined; };
const fail = message => { console.error(message); process.exit(1); };
const keyIdOf = raw => createHash("sha256").update(raw).digest("hex").slice(0, 16);
const rawPublic = privateKey => Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url");

if (command === "generate") {
  const out = option("--out");
  if (!out) fail("Use: generate --out <file outside the repository>");
  const file = path.resolve(out);
  if (!path.relative(repository, file).startsWith("..")) fail("Keep the private key outside the repository.");
  const { privateKey } = generateKeyPairSync("ed25519");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
  const raw = rawPublic(privateKey);
  console.log(`Private key written to ${file} (mode 600). Never commit or share it.`);
  console.log(`Add to src/update/releaseKeys.ts:\n  { id: "${keyIdOf(raw)}", publicKey: "${raw.toString("base64url")}" }`);
} else if (command === "sign") {
  const manifest = rest[0];
  if (!manifest || manifest.startsWith("--")) fail("Use: sign <manifest.json> --key <file>");
  const pem = process.env.RELEASE_SIGNING_KEY || (option("--key") ? fs.readFileSync(option("--key"), "utf8") : undefined);
  if (!pem) fail("Give --key <file> or RELEASE_SIGNING_KEY.");
  const privateKey = createPrivateKey(pem);
  const bytes = fs.readFileSync(manifest);
  JSON.parse(bytes.toString("utf8"));
  const signature = sign(null, Buffer.concat([Buffer.from(CONTEXT), Buffer.from([0]), bytes]), privateKey);
  fs.writeFileSync(`${manifest}.sig`, `${JSON.stringify({ keyId: keyIdOf(rawPublic(privateKey)), signature: signature.toString("base64url") })}\n`);
  console.log(`Signed: ${manifest}.sig (key ${keyIdOf(rawPublic(privateKey))})`);
} else {
  fail("Use: generate --out <file> | sign <manifest.json> --key <file>");
}
