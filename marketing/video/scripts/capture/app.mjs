// Starts the app's development build for recording: its own data folder under .profiles/, the content
// area sized exactly (1600×1000 by default, ×2 on Retina), and the theme and text size set the way the
// Settings screen stores them. The packaged app refuses the debugging switches Playwright needs.
import { _electron as electron } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const appRoot = path.resolve(project, "../..");

export async function launchApp({ profile, width = 1600, height = 1000, theme = "dark", fontScale = 100 }) {
  const dataDir = path.join(project, ".profiles", profile);
  fs.mkdirSync(dataDir, { recursive: true });
  const named = path.join(appRoot, "node_modules", "electron", "dist", "Local Cognitive.app", "Contents", "MacOS", "Electron");
  const app = await electron.launch({
    executablePath: fs.existsSync(named) ? named : undefined,
    args: [appRoot],
    cwd: appRoot,
    env: { ...process.env, LOCAL_COGNITIVE_TEST_DATA_DIR: dataDir },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(({ theme, fontScale }) => {
    localStorage.setItem("lcai.theme", theme);
    localStorage.setItem("lcai.fontScale", String(fontScale));
  }, { theme, fontScale });
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(size.width, size.height);
    window.center();
  }, { width, height });
  await page.waitForFunction(size => innerWidth === size.width && innerHeight === size.height, { width, height });
  await page.waitForTimeout(1500);
  return { app, page, dataDir };
}
