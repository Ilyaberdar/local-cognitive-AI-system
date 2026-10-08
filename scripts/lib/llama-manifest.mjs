// Reads resources/llama/runtime-manifest.json. `platforms` are the default runtime per platform
// (schema 1). Schema 2 adds `runtimes`: a variant such as linux-x64-cuda12 is a platform build
// (`base`) plus a verified overlay archive of extra files (the CUDA backend and its libraries).
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

const SHA256 = /^[0-9a-f]{64}$/;
// Bare file names, or names inside licenses/: nothing else may be written by an overlay.
const FILE_NAME = /^(?:licenses\/)?[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const OVERLAY_BACKEND = /^libggml-cuda\.(?:so|dll)$/;

const fail = (message) => { throw new Error(`Invalid runtime manifest: ${message}`); };
const https = (url, where) => {
  let parsed;
  try { parsed = new URL(url); } catch { fail(`${where} url is not a URL`); }
  if (parsed.protocol !== 'https:') fail(`${where} url must use https`);
  return url;
};
const sha = (value, where) => { if (typeof value !== 'string' || !SHA256.test(value)) fail(`${where} sha256 must be 64 lowercase hex characters`); return value; };
const text = (value, where) => { if (typeof value !== 'string' || !value) fail(`${where} is required`); return value; };

/** Validates a manifest and returns { version, build, commit, entries: Map<id, entry> }. */
export function normalizeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('not an object');
  const schema = manifest.schemaVersion ?? 1;
  if (schema !== 1 && schema !== 2) fail(`unsupported schemaVersion ${schema}`);
  const build = text(manifest.build, 'build'), commit = text(manifest.commit, 'commit');
  const entries = new Map();
  for (const [id, entry] of Object.entries(manifest.platforms ?? {})) {
    const match = /^([a-z0-9]+)-([a-z0-9]+)$/.exec(id);
    if (!match) fail(`platform id ${id}`);
    entries.set(id, { id, platform: match[1], arch: match[2], backend: text(entry.backend, `${id} backend`), executable: text(entry.executable, `${id} executable`),
      url: https(entry.url, id), sha256: sha(entry.sha256, id) });
  }
  if (schema === 1 && manifest.runtimes) fail('runtimes require schemaVersion 2');
  for (const [id, entry] of Object.entries(manifest.runtimes ?? {})) {
    if (entries.has(id)) fail(`${id} is defined twice`);
    const base = entries.get(entry.base);
    if (!base) fail(`${id} has an unknown base ${entry.base}`);
    if (entry.platform !== base.platform || entry.arch !== base.arch) fail(`${id} is ${entry.platform}-${entry.arch} but its base is ${base.id}`);
    const files = entry.files && typeof entry.files === 'object' && !Array.isArray(entry.files) ? Object.entries(entry.files) : [];
    if (!files.length) fail(`${id} lists no files`);
    for (const [name, digest] of files) {
      if (!FILE_NAME.test(name)) fail(`${id} file name ${name}`);
      if (/^libggml-/.test(name) && !OVERLAY_BACKEND.test(name)) fail(`${id} may not replace the base backend ${name}`);
      sha(digest, `${id} ${name}`);
    }
    const notices = Array.isArray(entry.notices) ? entry.notices : [];
    for (const name of notices) if (typeof name !== 'string' || !FILE_NAME.test(name)) fail(`${id} notice ${name}`);
    entries.set(id, { id, platform: base.platform, arch: base.arch, backend: text(entry.backend, `${id} backend`), executable: entry.executable ?? base.executable,
      url: base.url, sha256: base.sha256, base: base.id,
      overlay: { url: https(entry.overlay?.url, `${id} overlay`), sha256: sha(entry.overlay?.sha256, `${id} overlay`) },
      files: Object.fromEntries(files), notices, validation: entry.validation });
  }
  return { version: manifest.version, build, commit, entries };
}

export function runtimeEntry(normalized, id) {
  const entry = normalized.entries.get(id);
  if (!entry) throw new Error(`No pinned llama.cpp runtime ${id}.`);
  return entry;
}

/** Names an overlay may contain besides its listed files. */
export const overlayMayContain = (entry, name) =>
  Object.hasOwn(entry.files, name) || entry.notices.includes(name) || name === 'cuda-overlay.json' || /^licenses\/[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name);

export async function sha256File(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
