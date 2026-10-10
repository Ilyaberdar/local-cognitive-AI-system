#!/usr/bin/env node
// The release gate (spec §12): nothing is published unless every desktop artifact is signed for
// the people who download it. An unsigned or ad-hoc signed macOS app makes macOS ask for the login
// password again and again (Keychain) and Gatekeeper refuses it; an unsigned Windows installer is
// blocked by SmartScreen.
//
//   node scripts/verify-release-signatures.mjs <release dir> [--team-id <Apple team>] [--publisher <Windows signer>]
//
// macOS (run on macOS): each .app, and the app inside each .dmg and .zip, must have a valid
// Developer ID signature with the hardened runtime, be accepted by Gatekeeper as notarized and
// carry its stapled ticket. Windows: each .exe must carry a valid Authenticode signature (checked
// on Windows, or with osslsigncode elsewhere). Exits 1 on any failure, or when there is nothing.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { status: result.error ? 127 : result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};
const has = command => run("/usr/bin/env", ["which", command]).status === 0;

/** Why a macOS app is not ready to publish (empty when it is). */
export const appProblems = (app, teamId) => {
  const problems = [];
  const verify = run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  if (verify.status !== 0) problems.push(`its signature does not verify: ${verify.output.trim().split("\n").at(-1)}`);
  const details = run("codesign", ["-dv", "--verbose=4", app]).output;
  if (/Signature=adhoc/.test(details)) problems.push("it is signed ad hoc, not with a Developer ID");
  else if (!/^Authority=Developer ID Application: /m.test(details)) problems.push("it is not signed with a Developer ID Application certificate");
  const team = /^TeamIdentifier=(.+)$/m.exec(details)?.[1]?.trim();
  if (!team || team === "not set") problems.push("it has no team identifier");
  else if (teamId && team !== teamId) problems.push(`it is signed by team ${team}, not ${teamId}`);
  if (!/flags=0x[0-9a-f]+\([^)]*\bruntime\b/.test(details)) problems.push("it does not use the hardened runtime");
  const gatekeeper = run("spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
  if (gatekeeper.status !== 0 || !/Notarized Developer ID/.test(gatekeeper.output)) problems.push(`Gatekeeper does not accept it as notarized (${gatekeeper.output.trim().split("\n").at(-1) || "no answer"})`);
  if (run("xcrun", ["stapler", "validate", app]).status !== 0) problems.push("it has no stapled notarization ticket");
  return problems;
};

/** Whether a PE file (.exe) carries an Authenticode signature at all: its security directory. */
export const peHasSignature = file => {
  const bytes = fs.readFileSync(file);
  if (bytes.length < 0x40 || bytes.toString("latin1", 0, 2) !== "MZ") return false;
  const pe = bytes.readUInt32LE(0x3c);
  if (pe + 24 + 2 > bytes.length || bytes.toString("latin1", pe, pe + 4) !== "PE\0\0") return false;
  const optional = pe + 24, magic = bytes.readUInt16LE(optional);
  const directories = optional + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : NaN);
  const security = directories + 4 * 8;
  if (!Number.isFinite(directories) || security + 8 > bytes.length) return false;
  return bytes.readUInt32LE(security + 4) > 0;
};

/** Why a Windows executable is not ready to publish (empty when it is). */
export const exeProblems = (file, publisher) => {
  if (!peHasSignature(file)) return ["it has no Authenticode signature"];
  if (process.platform === "win32") {
    const script = `$s = Get-AuthenticodeSignature -LiteralPath '${file.replaceAll("'", "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`;
    const [status, subject = ""] = run("powershell", ["-NoProfile", "-Command", script]).output.trim().split("|");
    if (status !== "Valid") return [`its signature is ${status || "unreadable"}`];
    if (publisher && !subject.includes(publisher)) return [`it is signed by ${subject}, not ${publisher}`];
    return [];
  }
  if (!has("osslsigncode")) return ["its signature cannot be checked here: run on Windows or install osslsigncode"];
  const checked = run("osslsigncode", ["verify", "-in", file]);
  if (checked.status !== 0) return [`its signature does not verify: ${checked.output.trim().split("\n").at(-1)}`];
  if (publisher && !checked.output.includes(publisher)) return [`it is not signed by ${publisher}`];
  return [];
};

// Hidden folders are the builder's scratch space, never published.
const walk = (root, found = []) => {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory() && entry.name.endsWith(".app")) found.push(full);
    else if (entry.isDirectory()) walk(full, found);
    else if (/\.(dmg|zip|exe)$/i.test(entry.name)) found.push(full);
  }
  return found;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const option = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
  const directory = argv.find((value, index) => !value.startsWith("--") && !argv[index - 1]?.startsWith("--"));
  const teamId = option("--team-id") ?? process.env.LC_APPLE_TEAM_ID;
  const publisher = option("--publisher") ?? process.env.LC_WINDOWS_PUBLISHER;
  if (!directory || !fs.existsSync(directory)) { console.error("Use: verify-release-signatures.mjs <release dir> [--team-id <id>] [--publisher <name>]"); process.exit(64); }
  const artifacts = walk(path.resolve(directory));
  const results = [];
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lc-release-gate-"));
  try {
    for (const artifact of artifacts) {
      const kind = artifact.endsWith(".app") ? "app" : path.extname(artifact).slice(1).toLowerCase();
      if (kind === "exe") { results.push({ artifact, problems: exeProblems(artifact, publisher) }); continue; }
      if (process.platform !== "darwin") { results.push({ artifact, problems: ["macOS artifacts are checked on macOS"] }); continue; }
      if (kind === "app") { results.push({ artifact, problems: appProblems(artifact, teamId) }); continue; }
      // What people download: the app inside the dmg or zip, checked as they would get it.
      const into = fs.mkdtempSync(path.join(scratch, kind));
      let apps = [];
      try {
        if (kind === "dmg") execFileSync("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", into, artifact], { stdio: "ignore" });
        else execFileSync("ditto", ["-x", "-k", artifact, into], { stdio: "ignore" });
        apps = fs.readdirSync(into).filter(name => name.endsWith(".app")).map(name => path.join(into, name));
        const problems = apps.length ? apps.flatMap(app => appProblems(app, teamId).map(problem => `${path.basename(app)}: ${problem}`)) : ["it contains no app"];
        results.push({ artifact, problems });
      } catch (error) {
        results.push({ artifact, problems: [`it could not be opened (${error.message.split("\n")[0]})`] });
      } finally {
        if (kind === "dmg") spawnSync("hdiutil", ["detach", into, "-force"], { stdio: "ignore" });
      }
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  if (!results.length) { console.error(`Nothing to verify in ${directory}: no .app, .dmg, .zip or .exe.`); process.exit(1); }
  for (const { artifact, problems } of results) console.log(`${problems.length ? "✗" : "✓"} ${path.relative(process.cwd(), artifact)}${problems.map(problem => `\n    ${problem}`).join("")}`);
  const failed = results.filter(result => result.problems.length).length;
  console.log(failed ? `\n${failed} of ${results.length} artifacts are not ready to publish.` : `\nAll ${results.length} artifacts are signed for release.`);
  process.exit(failed ? 1 : 0);
}
