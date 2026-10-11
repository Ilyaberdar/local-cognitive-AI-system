// F: Remote, in the owner's installed app (the only place their server is paired; the owner allowed
// it on 2026-10-12): This computer → fedora → a real request answered by the model on the server.
// The packaged app refuses Playwright, so the real pointer and keyboard (pointer.swift) drive it at
// positions read off screenshots before the take, and the server's own status
// (`local-cognitive-server status` over SSH, read-only) tells when the answer is done.
//
// Was blocked on 2026-10-12: the server's CUDA runtime could not load its libraries (links into the
// pruned 0.1.0 release). Fixed in c4c7021 and repaired on the server the same night.
//
// Privacy: the sidebar is collapsed to its icons for the take (it holds the owner's chats and projects). Off camera before the take: an empty chat on This computer and an empty chat on
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
// Positions measured on 2026-10-12, as offsets from the window edge each element is anchored to (the
// target switch and its menu to the top right, the composer to the bottom left), so any window size
// works. The whole window is recorded with the sidebar collapsed to its icons (the owner's chats and
// projects stay out of the frame; the avatar left in its corner is blurred in the edit).
const placeIn = w => {
  const right = w.x + w.width, bottom = w.y + w.height;
  return {
    region: { x: w.x, y: w.y, width: w.width, height: w.height },
    at: {
      sidebarToggle: { x: w.x + 102, y: w.y + 16 },
      switchLocal: { x: right - 81, y: w.y + 16 },
      switchServer: { x: right - 64, y: w.y + 16 },
      optionLocal: { x: right - 251, y: w.y + 83 },
      optionServer: { x: right - 271, y: w.y + 120 },
      composer: { x: w.x + 380, y: bottom - 125 },
      rest: { x: w.x + w.width * 0.45, y: w.y + w.height * 0.35 },
    },
  };
};
// One line: Shift+Enter sent as a key event did not add a line in the first try, it sent the message.
const request = "Turn these launch notes into a release checklist. For each item give the owner, a due date, one risk and how to reduce it: Maya prepares screenshots by Friday. Alex verifies the workflow demo. Sam updates the documentation.";

const serverWork = () => {
  const out = execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "dex-node", "sudo -n local-cognitive-server status"]).toString();
  return (out.match(/Work:\s*(.+)/)?.[1] ?? "").trim();
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// The server's own loopback API, over SSH (the same calls its UI makes). Used off camera only.
const serverApi = (method, route, body) => execFileSync("ssh", ["-o", "BatchMode=yes", "dex-node",
  `curl -s -X ${method} http://127.0.0.1:3900${route} -H "Host: 127.0.0.1:3900" -H "Content-Type: application/json" -H "X-Local-Cognitive: 1"${body ? ` --data '${JSON.stringify(body)}'` : ""}`]).toString();
const serverSessions = () => { const d = JSON.parse(serverApi("GET", "/sessions") || "[]"); return Array.isArray(d) ? d : d.sessions ?? d.items ?? []; };
// The server model for the demo chat: Qwen2.5-14B (a new chat on this server defaults to its 0.5B).
const serverModel = "gguf-4f4be285ad4e3493957ef839";

execFileSync("open", ["-a", "Local Cognitive"]);
await sleep(1500);
const window = JSON.parse(execFileSync(path.join(project, ".bin", "pointer"), { input: '{"op":"window","owner":"Local Cognitive"}\n' }).toString());
if (window.error || window.width < 1200 || window.height < 800) throw new Error(`the app window is missing or too small: ${JSON.stringify(window)}`);
const { region, at } = placeIn(window);
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
await prepare(at.sidebarToggle); await sleep(900);
await prepare(at.switchLocal); await sleep(900); await prepare(at.optionServer); await sleep(2500);
await pointer.key(45, ["cmd"]); await sleep(2200);
const demoChat = serverSessions().sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)))[0];
if (!demoChat) throw new Error("no chat was created on the server");
serverApi("PUT", `/sessions/${demoChat.id}/settings`, { defaultTarget: { providerId: "llamacpp", model: serverModel } });
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
  // Off camera: the owner's app as it was, on This computer with the sidebar open.
  try {
    await sleep(800);
    await prepare(at.switchServer); await sleep(900); await prepare(at.optionLocal); await sleep(1200);
    await prepare(at.sidebarToggle); await sleep(600);
  } catch (error) { console.error(`restore: ${error.message}`); }
  pointer.close();
  const videoMs = Math.round(Number(execFileSync("npx", ["remotion", "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video], { cwd: project }).toString().trim()) * 1000);
  const record = { shotId, recorded: new Date(started).toISOString(), region, wallMs, videoMs, videoOffsetMs: Math.max(0, wallMs - videoMs), steps };
  fs.writeFileSync(path.join(captures, `${shotId}.json`), `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify({ videoMs, steps: steps.map(s => `${s.step}@${s.ms}`) }));
} catch (error) {
  abort();
  throw error;
}
