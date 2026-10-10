import { createHash, createPublicKey, verify } from "crypto";
import { z } from "zod";
import { compareVersions, isVersion } from "./version";

/** Signatures cover `context ‖ 0x00 ‖ manifest bytes`, so they verify for nothing else. */
export const MANIFEST_SIGNATURE_CONTEXT = "lc-release-manifest/v1";

export interface ReleaseKey { id: string; publicKey: string }

const version = z.string().refine(isVersion, "a release version");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** What a release of the server is: signed as a whole, its artifacts pinned by digest. */
export const serverManifestSchema = z.object({
  schema: z.literal(1),
  product: z.literal("local-cognitive-server"),
  version,
  channel: z.enum(["stable", "beta"]),
  releasedAt: z.iso.datetime({ offset: true }),
  commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  protocol: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }).strict(),
  hostDbSchema: z.number().int().min(1),
  node: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/),
  notes: z.string().max(20_000).default(""),
  notesUrl: z.url().optional(),
  artifacts: z.array(z.object({
    platform: z.enum(["linux", "darwin", "win32"]), arch: z.enum(["x64", "arm64"]),
    url: z.url(), size: z.number().int().positive().max(4 * 1024 ** 3), sha256
  }).strict()).min(1).max(16)
}).strict();
export type ServerManifest = z.infer<typeof serverManifestSchema>;

export class ManifestError extends Error { constructor(message: string, readonly code: string) { super(message); this.name = "ManifestError"; } }

export const keyIdOf = (publicKey: Buffer): string => createHash("sha256").update(publicKey).digest("hex").slice(0, 16);

/** Checks the manifest's signature with one of the release keys this build trusts, then its form.
 * Nothing else about a release is believed before this passes. */
export const verifyManifest = (manifestBytes: Buffer, signatureJson: string, keys: readonly ReleaseKey[]): ServerManifest => {
  if (!keys.length) throw new ManifestError("This build has no release key: updates cannot be verified.", "no_release_key");
  let signature: { keyId?: unknown; signature?: unknown };
  try { signature = JSON.parse(signatureJson); } catch { throw new ManifestError("The release signature is not readable.", "bad_signature"); }
  const key = keys.find(entry => entry.id === signature.keyId);
  if (!key) throw new ManifestError("The release was signed with a key this build does not trust.", "unknown_key");
  const bytes = typeof signature.signature === "string" ? Buffer.from(signature.signature, "base64url") : Buffer.alloc(0);
  const raw = Buffer.from(key.publicKey, "base64url");
  let valid = false;
  try {
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
    valid = bytes.length === 64 && verify(null, Buffer.concat([Buffer.from(MANIFEST_SIGNATURE_CONTEXT), Buffer.from([0]), manifestBytes]), publicKey, bytes);
  } catch { valid = false; }
  if (!valid) throw new ManifestError("The release signature does not match: the release was changed or is not ours.", "bad_signature");
  let parsed: unknown;
  try { parsed = JSON.parse(manifestBytes.toString("utf8")); } catch { throw new ManifestError("The release manifest is not readable.", "bad_manifest"); }
  const manifest = serverManifestSchema.safeParse(parsed);
  if (!manifest.success) throw new ManifestError(`The release manifest is not valid: ${z.prettifyError(manifest.error)}`, "bad_manifest");
  return manifest.data;
};

/** The artifact for this machine, or a clear refusal. */
export const artifactFor = (manifest: ServerManifest, platform: string = process.platform, arch: string = process.arch) => {
  const artifact = manifest.artifacts.find(entry => entry.platform === platform && entry.arch === arch);
  if (!artifact) throw new ManifestError(`Release ${manifest.version} has no build for ${platform}-${arch}.`, "no_artifact");
  return artifact;
};

/** Only a newer release is offered: a signed older one replayed by a mirror is refused. */
export const isUpgrade = (manifest: ServerManifest, current: string): boolean => compareVersions(manifest.version, current) > 0;
