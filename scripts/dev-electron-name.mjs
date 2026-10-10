#!/usr/bin/env node
// A development run is Electron itself: macOS shows Electron.app's bundle name in the Dock and the
// menu bar. This names the development copy (node_modules/electron) after the app; builds take their
// name from package.json. Runs after npm install (postinstall); nothing to do outside macOS.
// Electron's development copy is signed ad hoc without its Info.plist bound, so the edit keeps it valid.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

if (process.platform !== "darwin") process.exit(0);
const require = createRequire(import.meta.url);
let plist;
try { plist = path.join(path.dirname(require.resolve("electron/package.json")), "dist", "Electron.app", "Contents", "Info.plist"); } catch { process.exit(0); }
if (!fs.existsSync(plist)) process.exit(0);
const name = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).build?.productName;
if (!name || /['"\\]/.test(name)) process.exit(0);
for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
  try { execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} '${name}'`, plist], { stdio: "ignore" }); }
  catch { execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string '${name}'`, plist], { stdio: "ignore" }); }
}
console.log(`Development Electron shows as ${name}.`);
