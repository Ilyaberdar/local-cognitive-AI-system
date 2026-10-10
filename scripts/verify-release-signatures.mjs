#!/usr/bin/env node
// The release gate (spec §12): nothing is published unless every desktop artifact is signed for
// the people who download it. An unsigned or ad-hoc signed macOS app makes macOS ask for the login
// password again and again (Keychain) and Gatekeeper refuses it; an unsigned Windows installer is
// blocked by SmartScreen.
//
//   node scripts/verify-release-signatures.mjs <release dir> [--team-id <Apple team>] [--publisher <Windows signer>]
//
// macOS (run on macOS): each .app, and the app inside each .dmg and .zip, must have a valid
// Developer ID signature with the hardened runtime and the app's entitlements (the microphone),
// be accepted by Gatekeeper as notarized and carry its stapled ticket. electron-builder never
// signs or notarizes the dmg itself; the app inside it is what people run. Windows: each .exe must
// carry a valid, timestamped Authenticode signature (checked on Windows, or with osslsigncode
// elsewhere). Exits 1 on any failure, or when there is nothing to check.
//
// electron-builder's forceCodeSigning does not replace this: it accepts an ad-hoc identity or any
// other identity in the keychain, skips signing in pull-request builds, and does not cover
// notarization.
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

/** Entitlements the signed app needs under the hardened runtime (build/entitlements.mac.plist). */
const ENTITLEMENTS = {
  "com.apple.security.cs.allow-jit": "V8 cannot run its JIT",
  "com.apple.security.device.audio-input": "dictation cannot open the microphone"
};

/** Why a macOS app is not ready to publish (empty when it is). */
export const appProblems = (app, teamId) => {
  const problems = [];
  // Valid on disk; an ad-hoc signature passes this too, so the identity is checked below.
  const verify = run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  if (verify.status !== 0) problems.push(`its signature does not verify: ${verify.output.trim().split("\n").at(-1)}`);
  const details = run("codesign", ["-dv", "--verbose=4", app]).output;
  if (/Signature=adhoc/.test(details)) problems.push("it is signed ad hoc, not with a Developer ID");
  else if (!/^Authority=Developer ID Application: /m.test(details)) problems.push("it is not signed with a Developer ID Application certificate");
  const team = /^TeamIdentifier=(.+)$/m.exec(details)?.[1]?.trim();
  if (!team || team === "not set") problems.push("it has no team identifier");
  else if (teamId && team !== teamId) problems.push(`it is signed by team ${team}, not ${teamId}`);
  if (!/flags=0x[0-9a-f]+\([^)]*\bruntime\b/.test(details)) problems.push("it does not use the hardened runtime");
  const entitlements = run("codesign", ["-d", "--entitlements", "-", "--xml", app]).output;
  for (const [key, consequence] of Object.entries(ENTITLEMENTS)) {
    if (!new RegExp(`<key>${key.replaceAll(".", "\\.")}</key>\\s*<true/>`).test(entitlements)) problems.push(`it lacks the ${key} entitlement: ${consequence}`);
  }
  // Gatekeeper may also accept a notarized app online; the stapled ticket lets it open offline.
  const gatekeeper = run("spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
  if (gatekeeper.status !== 0 || !/source=Notarized Developer ID/.test(gatekeeper.output)) problems.push(`Gatekeeper does not accept it as notarized (${gatekeeper.output.trim().split("\n").at(-1) || "no answer"})`);
  if (!/^Notarization Ticket=stapled$/m.test(details)) problems.push("it has no stapled notarization ticket");
  return problems;
};

/** Whether a PE file (.exe) carries an Authenticode signature at all: its certificate table
 * (data directory 4, a file offset) holds a PKCS#7 WIN_CERTIFICATE inside the file. Presence only:
 * whether it is valid is checked by Windows or osslsigncode. */
export const peHasSignature = file => {
  const bytes = fs.readFileSync(file);
  if (bytes.length < 0x40 || bytes.toString("latin1", 0, 2) !== "MZ") return false;
  const pe = bytes.readUInt32LE(0x3c);
  if (pe + 24 + 2 > bytes.length || bytes.toString("latin1", pe, pe + 4) !== "PE\0\0") return false;
  const optional = pe + 24, magic = bytes.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b) return false;
  const plus = magic === 0x20b, security = optional + (plus ? 144 : 128);
  if (security + 8 > bytes.length || bytes.readUInt32LE(optional + (plus ? 108 : 92)) <= 4) return false;
  const offset = bytes.readUInt32LE(security), size = bytes.readUInt32LE(security + 4);
  if (size < 8 || offset + size > bytes.length) return false;
  // WIN_CERTIFICATE: wRevision 0x0200, wCertificateType 0x0002 (PKCS#7 SignedData).
  return bytes.readUInt16LE(offset + 4) === 0x0200 && bytes.readUInt16LE(offset + 6) === 0x0002;
};

/** Whether a certificate subject (CN=X, O=… on Windows, /C=…/CN=X with osslsigncode) names the publisher. */
const namesPublisher = (subject, name) => new RegExp(`(?:^|[,/]\\s*)CN=${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s*(?:,|/|$))`, "m").test(subject);

/** Why a Windows executable is not ready to publish (empty when it is). */
export const exeProblems = (file, publisher) => {
  if (!peHasSignature(file)) return ["it has no Authenticode signature"];
  if (process.platform === "win32") {
    const script = `$s = Get-AuthenticodeSignature -LiteralPath '${file.replaceAll("'", "''")}'; "$($s.Status)|$([bool]$s.TimeStamperCertificate)|$($s.SignerCertificate.Subject)"`;
    const [status, timestamped, subject = ""] = run("powershell", ["-NoProfile", "-Command", script]).output.trim().split("|");
    if (status !== "Valid") return [`its signature is ${status || "unreadable"}`];
    // Short-lived signing certificates (Azure Trusted Signing: days) stay valid only with a timestamp.
    if (timestamped !== "True") return ["its signature has no timestamp"];
    if (publisher && !namesPublisher(subject, publisher)) return [`it is signed by ${subject}, not ${publisher}`];
    return [];
  }
  if (!has("osslsigncode")) return ["its signature cannot be checked here: run on Windows or install osslsigncode"];
  // Azure Trusted Signing chains to a Microsoft root that common CA bundles lack: on Windows it is checked as Windows does.
  const checked = run("osslsigncode", ["verify", "-in", file]);
  if (checked.status !== 0 || !/Signature verification: ok/.test(checked.output)) return [`its signature does not verify: ${checked.output.trim().split("\n").at(-1)}`];
  if (publisher && !namesPublisher(checked.output, publisher)) return [`it is not signed by ${publisher}`];
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
