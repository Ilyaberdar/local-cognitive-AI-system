/**
 * Note: When using the Node.JS APIs, the config file
 * doesn't apply. Instead, pass options directly to the APIs.
 *
 * All configuration options: https://remotion.dev/docs/config
 */

import { Config } from "@remotion/cli/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

Config.setRspack(true);
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);

// The headless shell Remotion downloads crashes on this Mac (macOS 26: its GPU process exits with
// "icudtl.dat not found in bundle"), so renders use Playwright's headless shell instead:
// REMOTION_BROWSER_EXECUTABLE if set, else the newest one in Playwright's cache. Install it with
// `npx playwright-core install --only-shell chromium`. Studio previews in your own browser either way.
const playwrightShell = (): string | null => {
  const cache = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  if (!fs.existsSync(cache)) return null;
  const builds = fs
    .readdirSync(cache)
    .filter((name) => name.startsWith("chromium_headless_shell-"))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const build of builds) {
    const binary = path.join(cache, build, `chrome-headless-shell-mac-${process.arch}`, "chrome-headless-shell");
    if (fs.existsSync(binary)) return binary;
  }
  return null;
};

const browser = process.env.REMOTION_BROWSER_EXECUTABLE || (process.platform === "darwin" ? playwrightShell() : null);
if (browser) Config.setBrowserExecutable(browser);
