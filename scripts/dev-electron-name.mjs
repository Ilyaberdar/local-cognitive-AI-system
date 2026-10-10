#!/usr/bin/env node
// A development run is Electron itself, and macOS names it after its bundle: the Dock and Finder show
// the bundle folder's name (Electron.app), the menu bar its CFBundleName. This gives the development
// copy (node_modules/electron) the app's name in both and points the electron package (path.txt) at
// it; builds take their name from package.json. Runs after npm install (postinstall), so again after
// Electron is reinstalled; nothing to do outside macOS. Electron's development copy is signed ad hoc
// without its Info.plist bound, so the edit keeps it valid. Never run it while the app is open: its
// helper processes start from the bundle's path.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

if (process.platform !== "darwin") process.exit(0);
const require = createRequire(import.meta.url);
let electron;
try { electron = path.dirname(require.resolve("electron/package.json")); } catch { process.exit(0); }
const name = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).build?.productName;
if (!name || !/^[\w .-]+$/.test(name)) process.exit(0);
const dist = path.join(electron, "dist"), original = path.join(dist, "Electron.app"), named = path.join(dist, `${name}.app`);
if (fs.existsSync(original)) {
  // A fresh Electron (installed or updated) replaces a renamed copy left from before.
  fs.rmSync(named, { recursive: true, force: true });
  fs.renameSync(original, named);
}
if (!fs.existsSync(named)) process.exit(0);
fs.writeFileSync(path.join(electron, "path.txt"), `${name}.app/Contents/MacOS/Electron`);
const plist = path.join(named, "Contents", "Info.plist");
for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
  try { execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} '${name}'`, plist], { stdio: "ignore" }); }
  catch { execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string '${name}'`, plist], { stdio: "ignore" }); }
}
// LaunchServices (which the Dock asks) learns the new name at once.
try { execFileSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", named], { stdio: "ignore" }); }
catch { /* It notices by itself later. */ }
console.log(`Development Electron shows as ${name}.`);
