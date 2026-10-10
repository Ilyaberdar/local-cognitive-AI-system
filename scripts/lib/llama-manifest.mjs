// Reads resources/llama/runtime-manifest.json. `platforms` are the default runtime per platform
// (schema 1). Schema 2 adds `runtimes`, variants such as a CUDA build, each with a verified overlay
// archive of extra files. A variant either extends a platform build (`base`: linux-x64-cuda12 adds our
// CUDA backend and NVIDIA's libraries to upstream's CPU build) or has an archive of its own
// (`archive`: win32-x64-cuda12 is upstream's CUDA build plus upstream's archive of NVIDIA's DLLs).
// Archives are .tar.gz or .zip, as their URL says.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

const SHA256 = /^[0-9a-f]{64}$/;
// Bare file names, or names inside licenses/: nothing else may be written by an overlay.
const FILE_NAME = /^(?:licenses\/)?[A-Za-z0-9][A-Za-z0-9._+-]*$/;
// An overlay may bring the CUDA backend, never replace the base's own ggml libraries.
const BACKEND_FILE = /^(?:lib)?ggml-/i;
const OVERLAY_BACKEND = /^(?:lib)?ggml-cuda\.(?:so|dll)$/i;
// Runtime ids become directory names.
const RUNTIME_ID = /^[a-z0-9]+-[a-z0-9]+(?:-[a-z0-9]+)+$/;
const VERSION = /^\d+(?:\.\d+){0,3}$/;

const fail = (message) => { throw new Error(`Invalid runtime manifest: ${message}`); };
const https = (url, where) => {
  let parsed;
  try { parsed = new URL(url); } catch { fail(`${where} url is not a URL`); }
  if (parsed.protocol !== 'https:') fail(`${where} url must use https`);
  return url;
};
const sha = (value, where) => { if (typeof value !== 'string' || !SHA256.test(value)) fail(`${where} sha256 must be 64 lowercase hex characters`); return value; };
const text = (value, where) => { if (typeof value !== 'string' || !value) fail(`${where} is required`); return value; };
/** zip or tar.gz, from the archive's URL. */
const archiveKind = (url, where) => {
  const name = new URL(url).pathname;
  if (name.endsWith('.zip')) return 'zip';
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) return 'tar.gz';
  return fail(`${where} url must name a .zip or .tar.gz archive`);
};
const archive = (value, where) => {
  const url = https(value?.url, where);
  if (value.size !== undefined && !(Number.isSafeInteger(value.size) && value.size > 0)) fail(`${where} size`);
  return { url, sha256: sha(value.sha256, where), kind: archiveKind(url, where), ...(value.size ? { size: value.size } : {}) };
};
/** What a host needs for a variant: versions such as { nvidiaDriver: "551.78", minComputeCapability: "5.0" }. */
const requirements = (value, id) => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${id} requires`);
  for (const [key, item] of Object.entries(value)) {
    const valid = Array.isArray(item) ? item.every(version => typeof version === 'string' && VERSION.test(version)) : typeof item === 'string' && VERSION.test(item);
    if (!valid) fail(`${id} requires ${key}`);
  }
  return value;
};

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
    const url = https(entry.url, id);
    entries.set(id, { id, platform: match[1], arch: match[2], backend: text(entry.backend, `${id} backend`), executable: text(entry.executable, `${id} executable`),
      url, sha256: sha(entry.sha256, id), kind: archiveKind(url, id) });
  }
  if (schema === 1 && manifest.runtimes) fail('runtimes require schemaVersion 2');
  for (const [id, entry] of Object.entries(manifest.runtimes ?? {})) {
    if (!RUNTIME_ID.test(id)) fail(`runtime id ${id}`);
    if (entries.has(id)) fail(`${id} is defined twice`);
    if ((entry.base === undefined) === (entry.archive === undefined)) fail(`${id} needs either a base or an archive of its own`);
    const base = entry.base === undefined ? undefined : entries.get(entry.base);
    if (entry.base !== undefined && !base) fail(`${id} has an unknown base ${entry.base}`);
    if (base && (entry.platform !== base.platform || entry.arch !== base.arch)) fail(`${id} is ${entry.platform}-${entry.arch} but its base is ${base.id}`);
    const own = entry.archive === undefined ? undefined : archive(entry.archive, `${id} archive`);
    const platform = base?.platform ?? text(entry.platform, `${id} platform`), arch = base?.arch ?? text(entry.arch, `${id} arch`);
    if (!id.startsWith(`${platform}-${arch}-`)) fail(`${id} must start with ${platform}-${arch}-`);
    const files = entry.files && typeof entry.files === 'object' && !Array.isArray(entry.files) ? Object.entries(entry.files) : [];
    if (!files.length) fail(`${id} lists no files`);
    for (const [name, digest] of files) {
      if (!FILE_NAME.test(name)) fail(`${id} file name ${name}`);
      if (BACKEND_FILE.test(name) && !OVERLAY_BACKEND.test(name)) fail(`${id} may not replace the base backend ${name}`);
      sha(digest, `${id} ${name}`);
    }
    const notices = Array.isArray(entry.notices) ? entry.notices : [];
    for (const name of notices) if (typeof name !== 'string' || !FILE_NAME.test(name)) fail(`${id} notice ${name}`);
    const requires = requirements(entry.requires, id);
    entries.set(id, { id, platform, arch, backend: text(entry.backend, `${id} backend`), executable: entry.executable ?? base?.executable ?? text(undefined, `${id} executable`),
      url: own?.url ?? base.url, sha256: own?.sha256 ?? base.sha256, kind: own?.kind ?? base.kind, ...(own?.size ? { size: own.size } : {}), ...(base ? { base: base.id } : {}),
      overlay: archive(entry.overlay, `${id} overlay`), files: Object.fromEntries(files), notices, validation: entry.validation, ...(requires ? { requires } : {}) });
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
