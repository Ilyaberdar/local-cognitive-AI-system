// electron-builder's afterPack hook (package.json build.afterPack): every unpacked app is checked for
// credential files and credential-like strings before it is signed, notarized or put in an installer.
// A finding fails the build; the check names files and patterns, never a matched value.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/** The unpacked app folder (asar is off): inside the .app on macOS, resources/app elsewhere. */
const appFolder = (context) => context.electronPlatformName === "darwin" || context.electronPlatformName === "mas"
  ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources", "app")
  : path.join(context.appOutDir, "resources", "app");

exports.default = async function afterPack(context) {
  const folder = appFolder(context);
  if (!fs.existsSync(path.join(folder, "package.json"))) throw new Error(`afterPack: no unpacked app at ${folder}`);
  // Throws (and so fails the build) when the check exits non-zero.
  execFileSync(process.execPath, [path.join(__dirname, "verify-package-secrets.mjs"), folder], { stdio: "inherit" });
};
exports.appFolder = appFolder;
