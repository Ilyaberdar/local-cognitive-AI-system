import assert from "node:assert/strict";
import test from "node:test";
import { activityBetween, banner, box, COMMANDS, statusPanel, summaryLine, terminalStyle, uptime, visibleWidth, type Overview } from "../src/server/console";

const plain = { color: false, unicode: true, width: 100 };
const ascii = { color: false, unicode: false, width: 60 };
const running: Overview = {
  version: "0.2.0", phase: "running", startedAt: "2026-10-10T10:00:00.000Z", hostName: "fedora",
  inference: { backend: "cuda", active: "CUDA" },
  remote: { state: "online", claimed: true, devices: 2, sessions: 1 },
  connected: [{ deviceId: "d1", deviceName: "Alice's MacBook" }],
  models: [{ id: "m1", name: "Qwen 27B", status: "ready", placement: "GPU 0" }],
  metrics: { cpuPercent: 12.4, memoryUsedBytes: 6 * 1024 ** 3, memoryTotalBytes: 32 * 1024 ** 3, gpus: [{ index: 0, name: "GTX 1070 Ti", usedBytes: 7.5 * 1024 ** 3, totalBytes: 8 * 1024 ** 3 }] },
  activeWork: { total: 1, chatRuns: 1, workflowRuns: 0, inferenceBusy: true, inferenceQueued: 2 },
  update: { available: "0.3.0" }
};

test("the console adapts to the terminal: colours, box drawing and the banner's size", () => {
  assert.deepEqual(terminalStyle({ LANG: "en_US.UTF-8" }, { isTTY: true, columns: 120 }), { color: true, unicode: true, width: 120 });
  assert.equal(terminalStyle({ LANG: "en_US.UTF-8", NO_COLOR: "" }, { isTTY: true }).color, false);
  assert.equal(terminalStyle({ TERM: "dumb" }, { isTTY: true }).color, false);
  assert.equal(terminalStyle({ LANG: "C" }, { isTTY: false }).unicode, false);
  assert.equal(terminalStyle({ FORCE_COLOR: "1" }, { isTTY: false }).color, true);
  assert.equal(banner({ ...plain, width: 100 }).length, 8, "the large logo on a wide terminal");
  assert.equal(banner({ ...plain, width: 80 }).length, 5, "a smaller one on 80 columns");
  assert.deepEqual(banner({ ...plain, width: 60 }), ["◆ Local Cognitive"], "one line when narrow");
  for (const width of [80, 100]) for (const line of banner({ ...plain, width })) assert.ok(line.length <= width, line);
});

test("the command box lines up and fits the terminal, in Unicode and in ASCII", () => {
  for (const style of [plain, ascii]) {
    const lines = box(style, "Available commands:", COMMANDS);
    const widths = new Set(lines.map(visibleWidth));
    assert.equal(widths.size, 1, `every line of the box has the same width (${[...widths]})`);
    assert.ok([...widths][0]! <= style.width, "it fits the terminal");
    assert.match(lines[0]!, style.unicode ? /^╭─+╮$/ : /^\+-+\+$/);
  }
  const coloured = box({ ...plain, color: true }, "Available commands:", COMMANDS);
  assert.equal(new Set(coloured.map(visibleWidth)).size, 1, "colours do not count as width");
});

test("status shows the computers, the GPU, the models, the work and an available update", () => {
  const panel = statusPanel(plain, running, Date.parse("2026-10-10T12:14:00.000Z")).join("\n");
  assert.match(panel, /^Server +running · 0\.2\.0 · up 2h 14m$/m);
  assert.match(panel, /^Remote +● online · Alice's MacBook connected · 2 computers paired$/m);
  assert.match(panel, /^Inference +CUDA$/m);
  assert.match(panel, /^GPU 0 +GTX 1070 Ti +█{15}░ +7\.5 \/ 8\.0 GB$/m);
  assert.match(panel, /^Machine +CPU 12% · RAM 6\.0 \/ 32\.0 GB$/m);
  assert.match(panel, /^Models +● Qwen 27B \(ready, GPU 0\)$/m);
  assert.match(panel, /^Work +1 chat · model busy \(2 waiting\)$/m);
  assert.match(panel, /^Update +0\.3\.0 is available — type update$/m);
  assert.match(statusPanel(plain, { ...running, remote: { state: "online", claimed: false, devices: 0 }, connected: [] }).join("\n"), /no owner yet: type pair to connect your computer/);
  assert.match(summaryLine(plain, running), /^fedora · 0\.2\.0 · CUDA · ● Remote online · 1 computer connected$/);
  assert.equal(uptime("2026-10-08T10:00:00.000Z", Date.parse("2026-10-10T12:00:00.000Z")), "2d 2h");
});

test("watch turns changes into activity: computers, models, work, updates", () => {
  const before: Overview = { ...running, connected: [], models: [], activeWork: { chatRuns: 0, workflowRuns: 1 }, update: {}, remote: { state: "offline" } };
  assert.deepEqual(activityBetween(undefined, running), [], "nothing on the first look");
  assert.deepEqual(activityBetween(before, running), [
    "Alice's MacBook connected", "Remote online", "Model Qwen 27B ready (GPU 0)", "Chat started", "Workflow finished", "Update 0.3.0 is available"
  ]);
  assert.deepEqual(activityBetween(running, { ...running, connected: [], models: [{ id: "m1", name: "Qwen 27B", status: "error" }] }), ["Alice's MacBook disconnected", "Model Qwen 27B failed"]);
  assert.deepEqual(activityBetween(running, { ...running, models: [] }), ["Model Qwen 27B unloaded"]);
  assert.deepEqual(activityBetween(running, running), []);
});
