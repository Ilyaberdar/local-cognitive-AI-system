import { spawn } from "child_process";
import path from "path";
import readline from "readline";
import { stripVTControlCharacters } from "util";
import { controlRequest } from "./ControlServer";
import { controlSocketPathFor, dataDirectories } from "./dataRoot";
import { printableDeep } from "./terminalText";

// The server's console: `sudo local-cognitive-server` in a terminal. A banner, what the server is
// doing, and a prompt for its commands; `watch` follows it live. It only reads the server's state
// (over its control socket) and runs the same commands as the command line.

const BIG = [
  "  _                         _    _____                      _  _    _",
  " | |                       | |  / ____|                    (_)| |  (_)",
  " | |      ___    ___  __ _ | | | |      ___    __ _  _ __   _ | |_  _ __   __ ___",
  " | |     / _ \\  / __|/ _` || | | |     / _ \\  / _` || '_ \\ | || __|| |\\ \\ / // _ \\",
  " | |____| (_) || (__| (_| || | | |____| (_) || (_| || | | || || |_ | | \\ V /|  __/",
  " |______|\\___/  \\___|\\__,_||_|  \\_____|\\___/  \\__, ||_| |_||_| \\__||_|  \\_/  \\___|",
  "                                               __/ |",
  "                                              |___/"
];
const SMALL = [
  "  _                    _    ___                   _  _    _",
  " | |    ___  __  __ _ | |  / __| ___  __ _  _ _  (_)| |_ (_)__ __ ___",
  " | |__ / _ \\/ _|/ _` || | | (__ / _ \\/ _` || ' \\ | ||  _|| |\\ V // -_)",
  " |____|\\___/\\__|\\__,_||_|  \\___|\\___/\\__, ||_||_||_| \\__||_| \\_/ \\___|",
  "                                     |___/"
];

export interface Style { color: boolean; unicode: boolean; width: number; /** Cursor control and the live view (a real terminal). */ fancy?: boolean }

/** What the terminal can show: colours unless NO_COLOR, TERM=dumb or --no-color (sudo drops
 * NO_COLOR and FORCE_COLOR, so the flags exist); box drawing on UTF-8 unless --ascii. */
export const terminalStyle = (env: NodeJS.ProcessEnv, stream: { isTTY?: boolean; columns?: number }, flags: { color?: boolean; ascii?: boolean } = {}): Style => {
  const terminal = Boolean(stream.isTTY) && Boolean(env.TERM) && env.TERM !== "dumb";
  const forced = env.FORCE_COLOR !== undefined && !["0", "false"].includes(env.FORCE_COLOR);
  return {
    color: flags.color === false ? false : forced || (terminal && env.NO_COLOR === undefined),
    unicode: !flags.ascii && /utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || ""),
    width: stream.columns || 80,
    fancy: terminal
  };
};

// The 16 basic colours: every terminal has them (256-colour codes read as blink on some).
const BLUE = "94", GREEN = "32", GREY = "90", YELLOW = "33", RED = "31";
const paint = (style: Style, code: string, text: string) => style.color ? `\x1b[${code}m${text}\x1b[0m` : text;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Columns a text takes: escape sequences take none, a character with its marks takes one. */
export const visibleWidth = (text: string) => { let width = 0; for (const _ of graphemes.segment(stripVTControlCharacters(text))) width++; return width; };
/** A line cut to the terminal: plain (colours dropped) and ended with … when it is too wide. */
const fitLine = (line: string, width: number) => visibleWidth(line) <= width ? line
  : `${[...graphemes.segment(stripVTControlCharacters(line))].slice(0, Math.max(0, width - 1)).map(part => part.segment).join("")}…`;
const padTo = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));
const arrow = (style: Style) => style.unicode ? "›" : ">";
const dot = (style: Style, code: string) => paint(style, code, style.unicode ? "●" : "*");

/** The banner that fits the terminal: the large logo, a smaller one, or one line. */
export const banner = (style: Style): string[] => {
  const art = style.width >= 86 ? BIG : style.width >= 74 ? SMALL : undefined;
  if (!art) return [paint(style, `${BLUE};1`, `${style.unicode ? "◆" : "*"} Local Cognitive`)];
  return art.map(line => paint(style, BLUE, line));
};

/** A rounded box with a title and two columns: names and what they do. */
export const box = (style: Style, title: string, rows: Array<[string, string]>): string[] => {
  const c = style.unicode ? { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" } : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };
  const nameWidth = Math.max(...rows.map(([name]) => visibleWidth(name))) + 3;
  const inner = Math.max(30, Math.min(style.width - 4, Math.max(visibleWidth(title), ...rows.map(([name, help]) => nameWidth + visibleWidth(help))) + 4));
  const line = (content: string) => `${paint(style, GREY, c.v)} ${padTo(content, inner - 2)} ${paint(style, GREY, c.v)}`;
  const fit = (text: string, width: number) => visibleWidth(text) <= width ? text : `${[...text].slice(0, Math.max(0, width - 1)).join("")}…`;
  return [
    paint(style, GREY, `${c.tl}${c.h.repeat(inner)}${c.tr}`),
    line(""),
    line(paint(style, BLUE, title)),
    ...rows.map(([name, help]) => line(`${paint(style, `${BLUE};1`, padTo(name, nameWidth))}${fit(help, inner - 2 - nameWidth)}`)),
    line(""),
    paint(style, GREY, `${c.bl}${c.h.repeat(inner)}${c.br}`)
  ];
};

export const COMMANDS: Array<[string, string]> = [
  ["status", "What the server is doing right now"],
  ["watch", "Follow it live: computers, models, GPU, work"],
  ["pair", "Connect a computer (Remote → Connect on it)"],
  ["devices", "Computers that can connect (revoke <id>)"],
  ["logs", "Follow the server's log (Ctrl+C returns here)"],
  ["start / stop / restart", "The server's service"],
  ["update", "Install the newest release"],
  ["config", "Settings (config error-reports on|off)"],
  ["clear", "Clear the screen"],
  ["help", "Show this list"],
  ["exit", "Leave the console; the server keeps running"]
];

/** The server as the console sees it (the control socket's overview). */
export interface Overview {
  version?: string; phase?: string; startedAt?: string; hostName?: string;
  inference?: { backend?: string; active?: string; fallbackReason?: string };
  remote?: { state?: string; claimed?: boolean; devices?: number; sessions?: number; reason?: string; lastError?: string };
  connected?: Array<{ deviceId: string; deviceName?: string }>;
  models?: Array<{ id: string; name: string; status: string; placement?: string }>;
  metrics?: { cpuPercent?: number; memoryUsedBytes?: number; memoryTotalBytes?: number; gpus?: Array<{ index: number; name: string; usedBytes: number; totalBytes: number }> };
  activeWork?: { total?: number; chatRuns?: number; workflowRuns?: number; synthesisRuns?: number; processRuns?: number; inferenceBusy?: boolean; inferenceQueued?: number };
  update?: { available?: string | null };
}

const gigabytes = (bytes = 0) => `${(bytes / 1024 ** 3).toFixed(1)}`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
export const uptime = (since: string | undefined, now = Date.now()) => {
  const seconds = since ? Math.max(0, Math.floor((now - Date.parse(since)) / 1000)) : 0;
  const days = Math.floor(seconds / 86_400), hours = Math.floor(seconds / 3600) % 24, minutes = Math.floor(seconds / 60) % 60;
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
};
const meter = (style: Style, used: number, total: number, width = 16) => {
  const filled = total > 0 ? Math.round(Math.min(1, used / total) * width) : 0;
  const [full, empty] = style.unicode ? ["█", "░"] : ["#", "."];
  return `${paint(style, used / total > 0.9 ? YELLOW : BLUE, full.repeat(filled))}${paint(style, GREY, empty.repeat(width - filled))}`;
};
const inferenceText = (overview: Overview) => {
  const { backend = "?", active, fallbackReason } = overview.inference ?? {};
  if (active && active.toLowerCase() !== backend.toLowerCase()) return `${backend} → ${active}${fallbackReason ? ` (${fallbackReason})` : ""}`;
  return ["cuda", "cpu", "metal"].includes(backend.toLowerCase()) ? backend.toUpperCase().replace("METAL", "Metal") : backend;
};
const remoteText = (style: Style, overview: Overview) => {
  const remote = overview.remote;
  if (!remote || remote.state === "off") return `${dot(style, GREY)} off${remote?.reason ? paint(style, GREY, ` — ${remote.reason.replace(/\.$/, "")}`) : ""}`;
  const names = (overview.connected ?? []).map(device => device.deviceName ?? "a computer");
  const paired = plural(remote.devices ?? 0, "computer");
  if (remote.state === "online") {
    if (!remote.claimed) return `${dot(style, GREEN)} online ${paint(style, GREY, "· no owner yet: type pair to connect your computer")}`;
    return `${dot(style, GREEN)} online · ${names.length ? `${names.join(", ")} connected` : "no computer connected"} ${paint(style, GREY, `· ${paired} paired`)}`;
  }
  return `${dot(style, YELLOW)} ${remote.state ?? "unknown"}${remote.lastError ? paint(style, GREY, ` (${remote.lastError})`) : ""} ${paint(style, GREY, `· ${paired} paired`)}`;
};
const workText = (overview: Overview) => {
  const work = overview.activeWork ?? {};
  const parts = [work.chatRuns ? plural(work.chatRuns, "chat") : "", work.workflowRuns ? plural(work.workflowRuns, "workflow") : "",
    work.synthesisRuns ? `${work.synthesisRuns} synthesis` : "", work.processRuns ? plural(work.processRuns, "task") : "",
    work.inferenceBusy ? `model busy${work.inferenceQueued ? ` (${work.inferenceQueued} waiting)` : ""}` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : "idle";
};

/** One line under the welcome: where this is and whether computers can reach it. */
export const summaryLine = (style: Style, overview: Overview) => {
  const remote = overview.remote?.state === "online" ? `${dot(style, GREEN)} Remote online` : overview.remote?.state === "off" ? `${dot(style, GREY)} Remote off` : `${dot(style, YELLOW)} Remote ${overview.remote?.state ?? "unknown"}`;
  const connected = overview.connected?.length ? ` · ${plural(overview.connected.length, "computer")} connected` : "";
  return paint(style, GREY, `${overview.hostName ?? "server"} · ${overview.version ?? "?"} · ${inferenceText(overview)} · `) + remote + paint(style, GREY, connected);
};

/** The status panel (`status`, and the top of `watch`). */
export const statusPanel = (style: Style, overview: Overview, now = Date.now()): string[] => {
  const label = (text: string) => paint(style, GREY, padTo(text, 11));
  const lines = [
    `${label("Server")}${overview.phase === "running" ? paint(style, GREEN, "running") : paint(style, YELLOW, overview.phase ?? "unknown")} · ${overview.version ?? "?"} · up ${uptime(overview.startedAt, now)}`,
    `${label("Remote")}${remoteText(style, overview)}`,
    `${label("Inference")}${inferenceText(overview)}`
  ];
  for (const gpu of overview.metrics?.gpus ?? []) lines.push(`${label(`GPU ${gpu.index}`)}${gpu.name}  ${meter(style, gpu.usedBytes, gpu.totalBytes)}  ${gigabytes(gpu.usedBytes)} / ${gigabytes(gpu.totalBytes)} GB`);
  const metrics = overview.metrics;
  if (metrics?.memoryTotalBytes) lines.push(`${label("Machine")}CPU ${Math.round(metrics.cpuPercent ?? 0)}% · RAM ${gigabytes(metrics.memoryUsedBytes)} / ${gigabytes(metrics.memoryTotalBytes)} GB`);
  const models = overview.models ?? [];
  lines.push(`${label("Models")}${models.length ? models.map(model => `${dot(style, model.status === "ready" ? GREEN : model.status === "error" ? RED : YELLOW)} ${model.name} ${paint(style, GREY, `(${model.status}${model.placement ? `, ${model.placement}` : ""})`)}`).join("  ") : paint(style, GREY, "none loaded")}`);
  lines.push(`${label("Work")}${workText(overview)}`);
  if (overview.update?.available) lines.push(`${label("Update")}${paint(style, YELLOW, `${overview.update.available} is available`)} ${paint(style, GREY, "— type update")}`);
  return lines;
};

/** What changed between two overviews, as lines for the activity feed. */
export const activityBetween = (before: Overview | undefined, after: Overview): string[] => {
  if (!before) return [];
  const events: string[] = [];
  const names = (overview: Overview) => new Map((overview.connected ?? []).map(device => [device.deviceId, device.deviceName ?? "A computer"]));
  const was = names(before), is = names(after);
  for (const [id, name] of is) if (!was.has(id)) events.push(`${name} connected`);
  for (const [id, name] of was) if (!is.has(id)) events.push(`${name} disconnected`);
  if (before.remote?.state !== after.remote?.state && after.remote?.state) events.push(`Remote ${after.remote.state}`);
  const models = (overview: Overview) => new Map((overview.models ?? []).map(model => [model.id, model]));
  const had = models(before), has = models(after);
  for (const [id, model] of has) {
    const previous = had.get(id);
    if (previous?.status === model.status) continue;
    if (model.status === "ready") events.push(`Model ${model.name} ready${model.placement ? ` (${model.placement})` : ""}`);
    else if (model.status === "loading") events.push(`Loading ${model.name}…`);
    else if (model.status === "error") events.push(`Model ${model.name} failed`);
  }
  for (const [id, model] of had) if (!has.has(id)) events.push(`Model ${model.name} unloaded`);
  const count = (overview: Overview, key: "chatRuns" | "workflowRuns" | "synthesisRuns") => overview.activeWork?.[key] ?? 0;
  for (const [key, noun] of [["chatRuns", "Chat"], ["workflowRuns", "Workflow"], ["synthesisRuns", "Synthesis"]] as const) {
    const difference = count(after, key) - count(before, key);
    if (difference > 0) events.push(`${noun} started${difference > 1 ? ` (${difference})` : ""}`);
    if (difference < 0) events.push(`${noun} finished${difference < -1 ? ` (${-difference})` : ""}`);
  }
  if (after.update?.available && after.update.available !== before.update?.available) events.push(`Update ${after.update.available} is available`);
  if (before.phase !== after.phase && after.phase) events.push(`Server ${after.phase}`);
  return events;
};

/** One frame of `watch`: never taller than the terminal, no line wider than it. */
export const watchFrame = (style: Style, overview: Overview | undefined, activity: string[], rows: number): string[] => {
  const width = Math.max(20, style.width - 1);
  const rule = paint(style, GREY, (style.unicode ? "─" : "-").repeat(width));
  const top = [`${paint(style, `${BLUE};1`, "Local Cognitive Server")}${paint(style, GREY, overview?.hostName ? ` · ${overview.hostName}` : "")}`, rule,
    ...(overview ? statusPanel(style, overview) : [paint(style, YELLOW, "The server is not answering (stopped or starting)…")]), rule, paint(style, BLUE, "Activity")];
  // The way back stays on screen however small the terminal: the middle gives way first.
  const bottom = rows >= 4 ? ["", paint(style, GREY, "q or Esc: back to the console")] : [paint(style, GREY, "q or Esc: back")];
  const room = Math.max(0, rows - bottom.length);
  const feed = (activity.length ? activity : [paint(style, GREY, "Nothing yet: changes appear here as they happen.")]).slice(0, Math.max(0, room - top.length));
  return [...[...top, ...feed].slice(0, room), ...bottom].slice(-Math.max(1, rows)).map(line => fitLine(line, width));
};

export interface ConsoleOptions {
  dataDir: string;
  /** Runs a command line command (pair, logs, update…) with the terminal; resolves with its exit code. */
  run?: (args: string[]) => Promise<number>;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
  /** --no-color and --ascii: sudo drops NO_COLOR, so the console takes flags. */
  color?: boolean;
  ascii?: boolean;
}

/** The release's command script when installed (it switches users and knows the unit), else this CLI. */
const defaultRunner = (dataDir: string) => (args: string[]) => new Promise<number>(resolve => {
  const prefix = process.env.LC_PREFIX;
  const script = prefix ? path.join(prefix, "current", "deploy", "server", "local-cognitive-server") : undefined;
  // `start` typed here does not open a second console.
  const env = { ...process.env, LOCAL_COGNITIVE_CONSOLE_CHILD: "1" };
  const child = script ? spawn("bash", [script, ...args], { stdio: "inherit", env })
    : spawn(process.execPath, [path.join(__dirname, "cli.js"), ...args, "--data-dir", dataDir], { stdio: "inherit", env });
  child.on("error", () => resolve(127));
  child.on("exit", code => resolve(code ?? 1));
});

/** Runs the console until `exit`, Ctrl+D or Ctrl+C twice. */
export const runConsole = async (options: ConsoleOptions): Promise<number> => {
  const input = options.input ?? process.stdin, output = options.output ?? process.stdout, env = options.env ?? process.env;
  const style = () => terminalStyle(env, output, { color: options.color, ascii: options.ascii });
  const socket = controlSocketPathFor(dataDirectories(path.resolve(options.dataDir)).app);
  let denied = false;
  const overview = async (): Promise<Overview | undefined> => {
    // Names come from computers and model files: printed only once made harmless for the terminal.
    try { const response = await controlRequest(socket, { op: "overview" }, { timeoutMs: 5_000 }); return response.ok ? printableDeep(response.result as Overview) : undefined; }
    catch (error) { denied = ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""); return undefined; }
  };
  const unavailable = (s: Style) => paint(s, YELLOW, denied ? "Permission denied: open the console with sudo local-cognitive-server." : "The server is not running: type start.");
  const run = options.run ?? defaultRunner(options.dataDir);
  const write = (lines: string[]) => output.write(`${lines.join("\n")}\n`);
  const welcome = async () => {
    const s = style();
    // The banner at once; the summary when the server has answered.
    write(["", ...banner(s), "",
      `${paint(s, `${GREEN};1`, `${arrow(s)} Welcome to Local Cognitive Server!`)}`,
      `  ${paint(s, GREY, "Your models on your GPU, for your computers anywhere.")}`,
      `  ${paint(s, GREY, "Built for your machine. Your context. Your control.")}`,
      ""]);
    const state = await overview();
    write([`  ${state ? summaryLine(s, state) : unavailable(s)}`,
      "", ...box(s, "Available commands:", COMMANDS), "",
      paint(s, GREY, "Ready when you are. Type a command to get started.")]);
  };

  const names = ["status", "watch", "pair", "devices", "revoke", "logs", "start", "stop", "restart", "update", "config", "clear", "help", "exit"];
  const following: Record<string, string[]> = { config: ["error-reports"], "error-reports": ["on", "off"] };
  /** One Tab completes a single match (with a space); two list them. Words after the first: config's. */
  const completer = (line: string): [string[], string] => {
    const words = line.trimStart().split(/\s+/);
    const current = words[words.length - 1] ?? "";
    const pool = words.length <= 1 ? names : following[words[words.length - 2] ?? ""] ?? [];
    const hits = pool.filter(name => name.startsWith(current));
    return [hits.length === 1 ? [`${hits[0]} `] : hits, current];
  };
  // Created after the welcome is shown: anything typed earlier waits in the terminal, not lost.
  let rl!: readline.Interface;
  const prompt = () => { rl.setPrompt(`${paint(style(), `${GREEN};1`, arrow(style()))} `); rl.prompt(); };

  // Whatever ends the console (q, a signal, a dropped SSH session, an exception), the terminal is
  // given back as it was: normal screen, cursor shown, line wrap on, no raw mode.
  const ALT_ON = "\x1b[?1049h\x1b[?25l\x1b[?7l", ALT_OFF = "\x1b[?7h\x1b[?25h\x1b[?1049l";
  let altScreen = false, childRunning = false;
  const restoreTerminal = () => {
    if (altScreen) { altScreen = false; try { output.write(ALT_OFF); } catch { /* The terminal is gone. */ } }
    try { if (input.isTTY && input.isRaw) input.setRawMode(false); } catch { /* The terminal is gone. */ }
  };
  const onSignal = (code: number) => () => { restoreTerminal(); process.exit(code); };
  const signals: Array<[NodeJS.Signals, () => void]> = [["SIGTERM", onSignal(143)], ["SIGHUP", onSignal(129)], ["SIGQUIT", onSignal(131)],
    // Ctrl+C reaches a child (pair, logs) and the console alike: the child stops, the console stays.
    ["SIGINT", () => { if (!childRunning) onSignal(130)(); }]];
  for (const [signal, handler] of signals) process.on(signal, handler);
  process.on("exit", restoreTerminal);
  const releaseSignals = () => { for (const [signal, handler] of signals) process.off(signal, handler); process.off("exit", restoreTerminal); };

  // A child (pair, logs, update…) gets the terminal: Ctrl+C reaches it, not the console.
  const handOver = async (args: string[]) => {
    rl.pause();
    if (input.isTTY) input.setRawMode(false);
    childRunning = true;
    try { return await run(args); }
    finally {
      childRunning = false;
      // The child may have left the cursor mid-line (after ^C) or hidden it.
      if (style().fancy) output.write(`${" ".repeat(Math.max(0, (output.columns || 80) - 1))}\r\x1b[?25h`);
      if (input.isTTY) input.setRawMode(true);
      rl.resume();
    }
  };

  const watch = () => new Promise<void>(resolve => {
    const activity: string[] = [];
    let latest: Overview | undefined, previous: Overview | undefined, timer: NodeJS.Timeout | undefined, stopped = false;
    // Drawn over the previous frame (no clearing, so no flicker), one terminal high and wide.
    const paintFrame = () => {
      if (stopped) return;
      const lines = watchFrame(style(), latest, activity, output.rows || 24);
      output.write(`\x1b[?2026h\x1b[H${lines.map(line => `${line}\x1b[K`).join("\n")}\x1b[J\x1b[?2026l`);
    };
    // Fetched apart from drawing: a slow answer never overlaps the next, and a resize redraws at once.
    const poll = async () => {
      const next = await overview();
      if (stopped) return;
      const time = new Date().toTimeString().slice(0, 8);
      if (next) for (const event of activityBetween(previous, next)) activity.unshift(`${paint(style(), GREY, time)}  ${event}`);
      activity.splice(50);
      if (next) previous = next;
      latest = next;
      paintFrame();
      timer = setTimeout(() => void poll(), 1_000);
    };
    const onKey = (_text: string, key: { name?: string; ctrl?: boolean } = {}) => {
      if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) finish();
    };
    // The prompt's own key handling steps aside: keys go to the live view until it closes.
    const prompting = input.listeners("keypress") as Array<(...args: unknown[]) => void>;
    input.removeAllListeners("keypress");
    readline.emitKeypressEvents(input);
    input.on("keypress", onKey);
    output.on("resize", paintFrame);
    function finish() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      input.off("keypress", onKey);
      for (const listener of prompting) input.on("keypress", listener);
      output.off("resize", paintFrame);
      restoreTerminal();
      if (input.isTTY) input.setRawMode(true);
      resolve();
    }
    if (input.isTTY) input.setRawMode(true);
    input.resume();
    output.write(ALT_ON);
    altScreen = true;
    void poll();
  });

  const execute = async (line: string): Promise<boolean> => {
    const [command = "", ...rest] = line.trim().split(/\s+/);
    const s = style();
    switch (command) {
      case "": return true;
      case "help": write(["", ...box(s, "Available commands:", COMMANDS), ""]); return true;
      case "clear": if (s.fancy) output.write("\x1b[H\x1b[2J"); await welcome(); return true;
      case "status": {
        const state = await overview();
        write(["", ...(state ? statusPanel(s, state).map(text => `  ${text}`) : [`  ${unavailable(s)}`]), ""]);
        return true;
      }
      case "watch":
        if (!s.fancy) { const state = await overview(); write(["", ...(state ? statusPanel(s, state).map(text => `  ${text}`) : [`  ${unavailable(s)}`]), paint(s, GREY, "  (the live view needs a terminal)"), ""]); return true; }
        await watch(); return true;
      case "pair": case "devices": case "logs": case "start": case "stop": case "restart": case "update":
        await handOver([command, ...rest]); return true;
      case "revoke":
        if (!rest[0]) { write([`  ${paint(s, YELLOW, "Use: revoke <device id> (see devices)")}`]); return true; }
        await handOver(["revoke-device", rest[0]]); return true;
      case "config":
        if (rest[0] === "error-reports" && ["on", "off"].includes(rest[1] ?? "")) await handOver(["error-reports", rest[1]!]);
        else {
          await handOver(["error-reports"]);
          write([paint(s, GREY, "  Inference, the data folder and Remote are set at install; see sudo local-cognitive-server help.")]);
        }
        return true;
      case "exit": case "quit": return false;
      default: {
        const close = names.find(name => name.startsWith(command.slice(0, 2)));
        write([`  ${paint(s, YELLOW, `Unknown command: ${command}.`)}${close ? ` Did you mean ${paint(s, `${BLUE};1`, close)}?` : ""} Type help for the list.`]);
        return true;
      }
    }
  };

  await welcome();
  rl = readline.createInterface({ input, output, terminal: true, historySize: 200, removeHistoryDuplicates: true, completer });
  return await new Promise<number>(resolve => {
    let armed = false, working = false;
    // Commands run one at a time and in order, also when several lines arrive at once (pasted).
    const queue: string[] = [];
    const work = async () => {
      if (working) return;
      working = true;
      while (queue.length) {
        let keep = true;
        try { keep = await execute(queue.shift()!); }
        catch (error) { write([`  ${paint(style(), RED, error instanceof Error ? error.message : String(error))}`]); }
        if (!keep) { rl.close(); return; }
      }
      working = false;
      prompt();
    };
    rl.on("line", line => { armed = false; queue.push(line); void work(); });
    // Ctrl+C clears a typed line; on an empty line it asks once, and the second one leaves.
    rl.on("SIGINT", () => {
      if (rl.line.length > 0) { armed = false; rl.write(null, { ctrl: true, name: "e" }); rl.write(null, { ctrl: true, name: "u" }); return; }
      if (armed) { rl.close(); return; }
      armed = true;
      output.write(`\n${paint(style(), GREY, "  (To leave, type exit or press Ctrl+C again. The server keeps running.)")}\n`);
      prompt();
    });
    rl.on("SIGTSTP", () => undefined);
    rl.on("close", () => { releaseSignals(); restoreTerminal(); output.write(`\n${paint(style(), GREY, "Bye. The server keeps running.")}\n`); resolve(0); });
    prompt();
  });
};
