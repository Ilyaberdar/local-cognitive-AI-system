// F: Remote, in the owner's installed app (the only place their server is paired; the owner allowed
// it on 2026-10-12): This computer → fedora → a real request answered by the model on the server.
// The packaged app refuses Playwright, so the real pointer and keyboard (pointer.swift) drive it at
// positions read off screenshots before the take, and the server's own status
// (`local-cognitive-server status` over SSH, read-only) tells when the answer is done.
//
// Was blocked on 2026-10-12: the server's CUDA runtime could not load its libraries (links into the
// pruned 0.1.0 release). Fixed in c4c7021 and repaired on the server the same night.
//
// Privacy: only the window to the right of the sidebar is recorded (the sidebar holds the owner's
// chats and avatar). Off camera before the take: an empty chat on This computer and an empty chat on
// fedora (so the switch opens that one, not an old test chat). Nothing is paired, removed or typed
// into Remote or Settings.
//
//   node scripts/capture/f-remote.mjs
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { project } from "./app.mjs";
import { killRecorderSync, startPointer } from "./recorder.mjs";

const shotId = "F-remote";
// Screen points, measured on 2026-10-12 with the window at 0,33 1728×1084 (see handoff/shot-list.md).
const region = { x: 260, y: 33, width: 1468, height: 1084 };
const at = {
  switchLocal: { x: 1647, y: 49 },
  switchServer: { x: 1664, y: 49 },
  optionLocal: { x: 1477, y: 116 },
  optionServer: { x: 1457, y: 153 },
  composer: { x: 575, y: 992 },
  rest: { x: 900, y: 420 },
};
// One line: Shift+Enter sent as a key event did not add a line in the first try, it sent the message.
const request = "Summarize these launch notes into three action items: Maya prepares screenshots by Friday. Alex verifies the workflow demo. Sam updates the documentation.";

const serverWork = () => {
  const out = execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "dex-node", "sudo -n local-cognitive-server status"]).toString();
  return (out.match(/Work:\s*(.+)/)?.[1] ?? "").trim();
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

execFileSync("open", ["-a", "Local Cognitive"]);
await sleep(1500);
const window = JSON.parse(execFileSync(path.join(project, ".bin", "pointer"), { input: '{"op":"window","owner":"Local Cognitive"}\n' }).toString());
if (window.x !== 0 || window.y !== 33 || window.width !== 1728 || window.height !== 1084) throw new Error(`the app window moved: ${JSON.stringify(window)}`);
if (serverWork() !== "idle") throw new Error("the server is busy");

const captures = path.join(project, "public", "captures");
const video = path.join(captures, `${shotId}.mov`);
fs.rmSync(video, { force: true });

const pointer = startPointer();
// Off camera: an empty chat on fedora (so the switch opens it, not an old test chat), then an empty
// chat on this computer (so the take does not open with one of the owner's chats).
const prepare = async (point, ms = 450) => {
  if ((await pointer.front()) !== "Local Cognitive") throw new Error("Local Cognitive is not in front");
  await pointer.move(point.x, point.y, ms); await sleep(250); await pointer.click(point.x, point.y);
};
await prepare(at.switchLocal); await sleep(900); await prepare(at.optionServer); await sleep(2500);
await pointer.key(45, ["cmd"]); await sleep(1800);
await prepare(at.switchServer); await sleep(900); await prepare(at.optionLocal); await sleep(400);
await pointer.key(45, ["cmd"]); await sleep(2000);
const steps = [];
const started = Date.now();
const recorder = spawn("screencapture", ["-v", "-k", "-x", "-R", `${region.x},${region.y},${region.width},${region.height}`, video], { stdio: "ignore" });
const exited = new Promise(resolve => recorder.on("exit", resolve));
let finished = false;
const abort = () => {
  if (finished) return;
  finished = true;
  pointer.close();
  killRecorderSync(recorder, video);
};
process.once("exit", abort);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => { abort(); process.exit(130); });
const log = (step, extra = {}) => steps.push({ step, ms: Date.now() - started, ...extra });
const mustBeFront = async () => {
  const owner = await pointer.front();
  if (owner !== "Local Cognitive") throw new Error(`${owner || "another app"} is in front, not Local Cognitive: the take stops`);
};
const click = async (point, step, moveMs = 700) => {
  await mustBeFront();
  await pointer.move(point.x, point.y, moveMs);
  await sleep(450);
  log(step);
  await pointer.click(point.x, point.y);
};

try {
  await sleep(1200);
  log("recording");
  await pointer.move(at.rest.x, at.rest.y, 500);
  await sleep(1500);
  await click(at.switchLocal, "open the switch");
  await sleep(1400);
  await click(at.optionServer, "choose fedora");
  await sleep(3200);
  await click(at.composer, "composer");
  await sleep(700);
  // Pasted, not typed: key events for each character did not reach the composer (Russian layout
  // active). The owner's clipboard is put back afterwards.
  const clipboard = execFileSync("pbpaste").toString();
  execFileSync("pbcopy", { input: request });
  await sleep(500);
  await mustBeFront();
  log("paste request");
  await pointer.key(9, ["cmd"]);
  await sleep(300);
  execFileSync("pbcopy", { input: clipboard });
  await sleep(1400);
  await mustBeFront();
  log("Enter");
  await pointer.key(36, []);
  await pointer.move(at.rest.x, at.rest.y, 900);
  // The server's status says when it works; if a chat never shows there, the take ends after 150 s.
  let busySeen = false;
  const waitStart = Date.now();
  for (;;) {
    const work = serverWork();
    if (work !== "idle" && !busySeen) { busySeen = true; log("server busy", { work }); }
    if (busySeen && work === "idle") { log("server idle"); break; }
    if (!busySeen && Date.now() - waitStart > 150_000) { log("no work seen in status"); break; }
    if (Date.now() - waitStart > 600_000) { log("still working after 10 min"); break; }
    await sleep(1500);
  }
  await sleep(4500);
  const wallMs = Date.now() - started;
  finished = true;
  recorder.kill("SIGINT");
  await exited;
  pointer.close();
  const videoMs = Math.round(Number(execFileSync("npx", ["remotion", "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video], { cwd: project }).toString().trim()) * 1000);
  const record = { shotId, recorded: new Date(started).toISOString(), region, wallMs, videoMs, videoOffsetMs: Math.max(0, wallMs - videoMs), steps };
  fs.writeFileSync(path.join(captures, `${shotId}.json`), `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify({ videoMs, steps: steps.map(s => `${s.step}@${s.ms}`) }));
} catch (error) {
  abort();
  throw error;
}
