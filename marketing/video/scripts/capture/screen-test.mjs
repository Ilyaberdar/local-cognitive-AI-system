// Checks that macOS screen recording works from this terminal: opens the app, records two seconds of
// its window with `screencapture -v` (real cursor, clicks shown) and prints what came out.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { launchApp, project } from "./app.mjs";

const out = path.join(project, "out", "screen-test.mov");
fs.rmSync(out, { force: true });
const { app, page } = await launchApp({ profile: "style", theme: "light", fontScale: 115 });
try {
  const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  const recorder = spawn("screencapture", ["-v", "-k", "-x", "-V", "3", "-R", `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`, out]);
  await page.waitForTimeout(800);
  await page.mouse.move(300, 300);
  await page.mouse.move(800, 600, { steps: 30 });
  await new Promise(resolve => recorder.on("exit", resolve));
  console.log(JSON.stringify({ bounds, exists: fs.existsSync(out), bytes: fs.existsSync(out) ? fs.statSync(out).size : 0 }));
} finally {
  await app.close();
}
