// Recording helpers for one shot: the real pointer (pointer.swift), macOS screen recording of the
// app window (screencapture -v, real cursor, clicks shown) and an action log with timestamps.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { project } from "./app.mjs";

const pointerBinary = path.join(project, ".bin", "pointer");
const pointerSource = path.join(project, "scripts", "capture", "pointer.swift");

function buildPointer() {
  const stale = !fs.existsSync(pointerBinary) || fs.statSync(pointerBinary).mtimeMs < fs.statSync(pointerSource).mtimeMs;
  if (!stale) return;
  fs.mkdirSync(path.dirname(pointerBinary), { recursive: true });
  execFileSync("swiftc", ["-O", pointerSource, "-o", pointerBinary], { stdio: "inherit" });
}

export function startPointer() {
  buildPointer();
  const child = spawn(pointerBinary, [], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = readline.createInterface({ input: child.stdout });
  const waiting = [];
  lines.on("line", line => waiting.shift()?.(JSON.parse(line)));
  const send = command => new Promise((resolve, reject) => {
    waiting.push(answer => (answer.error ? reject(new Error(answer.error)) : resolve(answer)));
    child.stdin.write(`${JSON.stringify(command)}\n`);
  });
  return {
    move: (x, y, ms = 650) => send({ op: "move", x, y, ms }),
    click: (x, y) => send({ op: "click", x, y }),
    position: () => send({ op: "pos" }),
    close: () => { child.stdin.end(); },
  };
}

// Brings the app window to the front, so real clicks land on it and nothing covers the recording.
// On macOS the sidebar and title bar are translucent and show whatever lies behind the window, so a
// plain backdrop window of one soft colour goes behind it first: other apps' windows never show
// through. The backdrop is a recording aid, not part of the app's interface.
export async function bringToFront(app) {
  await app.evaluate(({ app: electronApp, BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find(each => !each.__recordingBackdrop);
    if (!BrowserWindow.getAllWindows().some(each => each.__recordingBackdrop)) {
      const area = screen.getDisplayMatching(window.getBounds()).workArea;
      const backdrop = new BrowserWindow({
        ...area, frame: false, focusable: false, resizable: false, movable: false, hasShadow: false,
        skipTaskbar: true, backgroundColor: "#dde4ec", show: false,
      });
      backdrop.__recordingBackdrop = true;
      backdrop.setIgnoreMouseEvents(true);
      backdrop.showInactive();
    }
    electronApp.focus({ steal: true });
    window.show();
    window.moveTop();
    window.focus();
  });
}

export async function contentBounds(app) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(each => !each.__recordingBackdrop).getContentBounds());
}

// A shot: the pointer, the recording and the log. Every step is logged with its time from the
// moment screencapture was started; `videoOffsetMs` (how long screencapture took to begin) is
// measured at the end from the file's real duration, so log times map onto the video.
export async function startShot({ app, page, shotId }) {
  const captures = path.join(project, "public", "captures");
  fs.mkdirSync(captures, { recursive: true });
  const video = path.join(captures, `${shotId}.mov`);
  const logFile = path.join(captures, `${shotId}.json`);
  fs.rmSync(video, { force: true });

  await bringToFront(app);
  const bounds = await contentBounds(app);
  const pointer = startPointer();
  const steps = [];
  const started = Date.now();
  const recorder = spawn("screencapture", ["-v", "-k", "-x", "-R", `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`, video], { stdio: "ignore" });
  const exited = new Promise(resolve => recorder.on("exit", resolve));
  const log = (step, extra = {}) => { steps.push({ step, ms: Date.now() - started, ...extra }); };

  const screenPoint = box => ({ x: bounds.x + box.x + box.width / 2, y: bounds.y + box.y + box.height / 2 });

  const shot = {
    pointer,
    log,
    pause: ms => page.waitForTimeout(ms),
    // Moves the real pointer onto an element, waits a beat so viewers see where it is, then clicks.
    async click(locator, step, { moveMs = 700, settleMs = 450 } = {}) {
      await locator.waitFor({ state: "visible" });
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      if (!box) throw new Error(`no box for ${step}`);
      const point = screenPoint(box);
      await pointer.move(point.x, point.y, moveMs);
      await page.waitForTimeout(settleMs);
      log(step, { x: point.x - bounds.x, y: point.y - bounds.y });
      await pointer.click(point.x, point.y);
    },
    async hover(locator, step, { moveMs = 700 } = {}) {
      const box = await locator.boundingBox();
      if (!box) throw new Error(`no box for ${step}`);
      const point = screenPoint(box);
      await pointer.move(point.x, point.y, moveMs);
      log(step, { x: point.x - bounds.x, y: point.y - bounds.y });
    },
    // Parks the pointer at a point of the window (fractions of its size), e.g. out of the way.
    async park(fx, fy, ms = 600) {
      await pointer.move(bounds.x + bounds.width * fx, bounds.y + bounds.height * fy, ms);
    },
    async type(text, step, delay = 45) {
      log(step, { text });
      await page.keyboard.type(text, { delay });
    },
    async stop() {
      const wallMs = Date.now() - started;
      recorder.kill("SIGINT");
      await exited;
      pointer.close();
      const probe = execFileSync("npx", ["remotion", "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video], { cwd: project }).toString().trim();
      const videoMs = Math.round(Number(probe) * 1000);
      const record = { shotId, recorded: new Date(started).toISOString(), bounds, wallMs, videoMs, videoOffsetMs: Math.max(0, wallMs - videoMs), steps };
      fs.writeFileSync(logFile, `${JSON.stringify(record, null, 2)}\n`);
      return record;
    },
  };
  // screencapture needs a moment before the first frame; the log above measures it.
  await page.waitForTimeout(1200);
  log("recording");
  return shot;
}
