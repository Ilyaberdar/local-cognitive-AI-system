#!/usr/bin/env node
// Every package an app's package.json depends on, and every package those depend on, must resolve
// inside the app's own node_modules (Node's lookup: the requiring package's node_modules, then each
// parent's). Optional and peer dependencies are reported when missing but do not fail.
// node scripts/verify-deps-closure.mjs <app dir>: the Mac app's Contents/Resources/app, the Windows payload's resources/app, or the server pack's folder.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "");
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const top = read(path.join(root, "package.json"));
const seen = new Map(); // package dir -> name
const missing = [], optionalMissing = [];

function locate(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name, "package.json");
    if (fs.existsSync(candidate)) return path.dirname(candidate);
    if (dir === root || !dir.startsWith(root)) return undefined;
  }
}
function visit(dir, manifest, chain) {
  const groups = [[manifest.dependencies, false], [manifest.optionalDependencies, true], [manifest.peerDependencies, true]];
  const optional = new Set([...Object.keys(manifest.optionalDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);
  for (const [deps, soft] of groups) {
    for (const name of Object.keys(deps ?? {})) {
      const found = locate(name, dir);
      if (!found) { (soft || optional.has(name) || manifest.peerDependenciesMeta?.[name]?.optional ? optionalMissing : missing).push(`${[...chain, name].join(" > ")}`); continue; }
      if (seen.has(found)) continue;
      seen.set(found, name);
      visit(found, read(path.join(found, "package.json")), [...chain, name]);
    }
  }
}
visit(root, top, []);
console.log(`${seen.size} packages resolved from ${root}`);
if (optionalMissing.length) console.log(`optional or peer, not packed (${optionalMissing.length}):\n  ${[...new Set(optionalMissing)].slice(0, 40).join("\n  ")}`);
if (missing.length) { console.error(`MISSING (${missing.length}):\n  ${missing.join("\n  ")}`); process.exit(1); }
console.log("closure OK");
