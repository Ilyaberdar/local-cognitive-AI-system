import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const windows = process.platform === "win32";

/** What a local MCP server receives of the app's own environment, as Codex passes it: enough to
 * find its tools, its home and temporary folders, nothing else the app was started with. */
const INHERITED = windows
  ? ["APPDATA", "COMSPEC", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "NUMBER_OF_PROCESSORS", "OS", "PATH", "PATHEXT",
    "PROCESSOR_ARCHITECTURE", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "SYSTEMDRIVE", "SYSTEMROOT",
    "TEMP", "TMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR"]
  : ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "PATH", "SHELL", "TERM", "TMPDIR", "TZ", "USER", "__CF_USER_TEXT_ENCODING"];

/** Windows names variables without regard to case (`Path`, `PATH`). */
const sameName = (left: string, right: string) => windows ? left.toUpperCase() === right.toUpperCase() : left === right;
const lookup = (env: Record<string, string | undefined>, name: string) => Object.entries(env).find(([key]) => sameName(key, name))?.[1];

let loginPath: Promise<string | undefined> | undefined;
/** The PATH of the user's login shell on macOS. An app opened from Finder starts with only the
 * system folders, so `uvx` (Homebrew, `~/.local/bin`) or `npx` would not be found. */
export function loginShellPath(): Promise<string | undefined> {
  if (process.platform !== "darwin") return Promise.resolve(undefined);
  return loginPath ??= new Promise(resolve => {
    const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : "/bin/zsh";
    const marker = "__LOCAL_COGNITIVE_PATH__";
    // The startup files may print; only what lies between the markers is read.
    execFile(shell, ["-ilc", `printf '%s%s%s' '${marker}' "$PATH" '${marker}'`], {
      timeout: 5_000, windowsHide: true, maxBuffer: 1024 * 1024,
      env: { HOME: os.homedir(), USER: os.userInfo().username, LOGNAME: os.userInfo().username, SHELL: shell, TERM: "dumb", LANG: process.env.LANG ?? "en_US.UTF-8" }
    }, (_error, stdout) => resolve(new RegExp(`${marker}(.*?)${marker}`, "s").exec(String(stdout ?? ""))?.[1] || undefined));
  });
}

/** Folders the usual installers put command-line tools in, when they exist. */
function usualFolders(): string[] {
  const home = os.homedir();
  const python = (root: string) => { try { return fs.readdirSync(root).map(version => path.join(root, version, "bin")); } catch { return []; } };
  const folders = windows
    ? [path.join(home, ".local", "bin"), process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : "", path.join(home, ".cargo", "bin")]
    : process.platform === "darwin"
      ? ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", path.join(home, ".local", "bin"), path.join(home, ".cargo", "bin"),
        path.join(home, ".bun", "bin"), ...python(path.join(home, "Library", "Python"))]
      : [path.join(home, ".local", "bin"), "/usr/local/bin", path.join(home, ".cargo", "bin")];
  return folders.filter(folder => { try { return Boolean(folder) && fs.statSync(folder).isDirectory(); } catch { return false; } });
}

/** The environment a server starts with: the inherited variables, a PATH that finds what the user
 * finds in a terminal, then the server's own variables. A PATH the server sets is used as given. */
export function launchEnvironment(own: Record<string, string> = {}, shellPath?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = lookup(process.env, name);
    // Shell functions exported into the environment are not passed on.
    if (value !== undefined && !value.startsWith("()")) env[name] = value;
  }
  const separator = windows ? ";" : ":";
  const folders = [...(shellPath ?? "").split(separator), ...(lookup(process.env, "PATH") ?? "").split(separator), ...usualFolders()]
    .filter(Boolean);
  env.PATH = [...new Set(folders)].join(separator);
  for (const [name, value] of Object.entries(own)) {
    for (const key of Object.keys(env)) if (sameName(key, name)) delete env[key];
    env[name] = value;
  }
  return env;
}

const runnable = (file: string) => {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (!windows) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
};

/** The file a command names, found as the system would: a path as given (from `cwd`), otherwise
 * on PATH, with PATHEXT's endings on Windows. Undefined when there is none. */
export function resolveCommand(command: string, env: Record<string, string>, cwd?: string): string | undefined {
  const endings = windows && !path.extname(command)
    ? (lookup(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  if (/[\\/]/.test(command)) {
    const base = path.resolve(cwd ?? process.cwd(), command);
    return endings.map(ending => base + ending).find(runnable);
  }
  for (const folder of (lookup(env, "PATH") ?? "").split(windows ? ";" : ":").filter(Boolean)) {
    const found = endings.map(ending => path.join(folder.replace(/^"(.*)"$/, "$1"), command + ending)).find(runnable);
    if (found) return found;
  }
  return undefined;
}

/** The last lines a server wrote to stderr, for the host's own Settings: values of its environment
 * and anything shaped like a credential are hidden. */
export class OutputTail {
  private text = "";
  constructor(private readonly secrets: string[] = [], private readonly limit = 8 * 1024) {}
  append(chunk: Buffer | string): void {
    this.text = (this.text + chunk.toString()).slice(-this.limit * 2);
  }
  read(): string {
    let text = this.text.slice(-this.limit);
    for (const secret of this.secrets) if (secret.length >= 6) text = text.split(secret).join("‹hidden›");
    return text
      // Terminal colours and cursor movement.
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1‹hidden›")
      .replace(/((?:api[_-]?key|access[_-]?token|token|secret|password|passwd|authorization)["']?\s*[:=]\s*["']?)[^\s"',;)\]}]+/gi, "$1‹hidden›")
      .trim();
  }
}
