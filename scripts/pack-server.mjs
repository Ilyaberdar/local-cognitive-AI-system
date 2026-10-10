#!/usr/bin/env node
// Builds a release of local-cognitive-server: one tarball with the compiled server, its production
// node_modules, a pinned official Node runtime (checked against nodejs.org's SHASUMS256) and the CPU
// llama.cpp runtime, plus an unsigned server-manifest.json to sign (scripts/release-key.mjs sign).
// Nothing runs on the host at install time: no npm, no install scripts.
//
//   npm run build && node scripts/pack-server.mjs --out release/server [--platform linux --arch x64]
//     [--node 22.23.3] [--channel stable] [--url-base https://github.com/<repo>/releases/download/v<version>/]
//     [--notes-file NOTES.md] [--skip-llama]
//
// Run it on the target platform (CI on Linux for linux-x64): optional native packages are chosen
// for the platform npm runs on.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const option = (name, fallback) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const flag = name => argv.includes(name);
const fail = message => { console.error(message); process.exit(1); };

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const platform = option("--platform", process.platform), arch = option("--arch", process.arch);
const nodeVersion = option("--node", "22.23.3");
const channel = option("--channel", "stable");
const out = path.resolve(option("--out", path.join(root, "release", "server")));
const urlBase = option("--url-base", `https://github.com/Ilyaberdar/local-cognitive-AI-system/releases/download/v${version}/`);
if (platform !== process.platform || arch !== process.arch) console.warn(`Packing ${platform}-${arch} on ${process.platform}-${process.arch}: native optional packages follow npm's platform.`);
if (!fs.existsSync(path.join(root, "dist", "src", "server", "cli.js"))) fail("Build first: npm run build");

const name = `local-cognitive-server-${version}-${platform}-${arch}`;
const stage = path.join(out, name);
const cache = path.join(out, "cache");
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(cache, { recursive: true });
const copy = (from, to = from) => { const source = path.join(root, from); if (fs.existsSync(source)) fs.cpSync(source, path.join(stage, to), { recursive: true }); };

// The server's code: compiled sources only (no tests), its manifest and lock.
fs.cpSync(path.join(root, "dist", "src"), path.join(stage, "dist", "src"), { recursive: true });
for (const file of ["package.json", "package-lock.json", "LICENSE", "THIRD_PARTY_NOTICES.txt"]) copy(file);
copy("plugins");
copy("resources/models");
copy("resources/llama/runtime-manifest.json");
copy("resources/llama/THIRD_PARTY_NOTICES.txt");
copy("deploy/server");
copy("scripts/prepare-llama-runtime.mjs");
copy("scripts/lib");
// The workspace's manifest only, so npm accepts the lock without the Cloud's sources.
fs.mkdirSync(path.join(stage, "apps", "cloud"), { recursive: true });
fs.copyFileSync(path.join(root, "apps", "cloud", "package.json"), path.join(stage, "apps", "cloud", "package.json"));

console.log("Installing production packages…");
execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--workspaces=false", "--include-workspace-root", "--no-audit", "--no-fund"], { cwd: stage, stdio: "inherit" });
fs.rmSync(path.join(stage, "apps"), { recursive: true, force: true });

// The pinned Node runtime, verified against nodejs.org's published digests.
const nodeName = `node-v${nodeVersion}-${platform}-${arch}`;
const nodeTar = path.join(cache, `${nodeName}.tar.gz`);
const sums = await (await fetch(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`)).text();
const expected = sums.split("\n").find(line => line.endsWith(`  ${nodeName}.tar.gz`))?.split(/\s+/)[0];
if (!expected) fail(`nodejs.org lists no ${nodeName}.tar.gz`);
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
if (!fs.existsSync(nodeTar) || digest(nodeTar) !== expected) {
  console.log(`Downloading Node ${nodeVersion}…`);
  const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${nodeName}.tar.gz`);
  if (!response.ok) fail(`Node download failed: HTTP ${response.status}`);
  fs.writeFileSync(nodeTar, Buffer.from(await response.arrayBuffer()));
}
if (digest(nodeTar) !== expected) fail("The Node download does not match nodejs.org's SHASUMS256.");
fs.mkdirSync(path.join(stage, "node"));
execFileSync("tar", ["-xzf", nodeTar, "-C", path.join(stage, "node"), "--strip-components=1"]);
// Only the runtime: npm and headers are not needed to run the server.
for (const unused of ["include", "share", "lib/node_modules", "bin/npm", "bin/npx", "bin/corepack"]) fs.rmSync(path.join(stage, "node", unused), { recursive: true, force: true });

// The CPU llama.cpp runtime of the platform (the CUDA one is prepared on the host).
if (!flag("--skip-llama")) {
  execFileSync(process.execPath, [path.join(root, "scripts", "prepare-llama-runtime.mjs"), "--platform", platform, "--arch", arch,
    "--destination", path.join(stage, "resources", "llama", `${platform}-${arch}`)], { stdio: "inherit" });
}

let commit = "";
try { commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { /* Not a checkout. */ }
fs.writeFileSync(path.join(stage, "RELEASE.json"), `${JSON.stringify({ product: "local-cognitive-server", version, platform, arch, node: nodeVersion, ...(commit ? { commit } : {}) }, null, 2)}\n`);

// Links in the release would be refused by the updater: none may be packed.
const links = [];
const walk = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
  const full = path.join(directory, entry.name);
  if (entry.isSymbolicLink()) links.push(path.relative(stage, full)); else if (entry.isDirectory()) walk(full);
} };
walk(stage);
for (const link of links) {
  // npm's .bin shims are links; the server does not use them.
  if (/(^|\/)node_modules\/\.bin\//.test(link)) fs.rmSync(path.join(stage, link));
  else fail(`The release would contain a link: ${link}`);
}

console.log("Checking for secrets…");
execFileSync(process.execPath, [path.join(root, "scripts", "verify-package-secrets.mjs"), stage], { stdio: "inherit" });

// A reproducible tarball where GNU tar is available (CI); bsdtar elsewhere.
const tarball = path.join(out, `${name}.tar.gz`);
const gnu = (() => { try { return execFileSync("tar", ["--version"], { encoding: "utf8" }).includes("GNU tar"); } catch { return false; } })();
const files = fs.readdirSync(stage).sort();
if (gnu) execFileSync("tar", ["--format=ustar", "--sort=name", "--owner=0", "--group=0", "--numeric-owner", "--mtime=@0", "--mode=go-w", "-czf", tarball, "-C", stage, ...files]);
else execFileSync("tar", ["--uid", "0", "--gid", "0", "-czf", tarball, "-C", stage, ...files]);
const bytes = fs.readFileSync(tarball);
const sha256 = createHash("sha256").update(bytes).digest("hex");

// What this release speaks and stores, read from its own build.
const require = createRequire(import.meta.url);
const { PROTOCOL_VERSION } = require(path.join(root, "dist", "src", "remote", "channel.js"));
const { hostMigrations } = require(path.join(root, "dist", "src", "runtime", "db", "hostSchema.js"));
const notesFile = option("--notes-file");
const manifest = {
  schema: 1, product: "local-cognitive-server", version, channel, releasedAt: new Date().toISOString(), ...(commit ? { commit } : {}),
  protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION }, hostDbSchema: hostMigrations.length, node: nodeVersion, notes: notesFile ? fs.readFileSync(notesFile, "utf8").slice(0, 20_000) : "",
  artifacts: [{ platform, arch, url: `${urlBase}${name}.tar.gz`, size: bytes.length, sha256 }]
};
fs.writeFileSync(path.join(out, "server-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${tarball}\n  ${(bytes.length / 1024 ** 2).toFixed(1)} MB, sha256 ${sha256}\n${path.join(out, "server-manifest.json")} (sign it: node scripts/release-key.mjs sign …)`);
