import { spawn } from "child_process";
import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";
import { NextFunction, Request, Response } from "express";
import { RuntimeManager } from "../app/RuntimeManager";
import { isWorkspacePath } from "../tools/AccessPolicy";

class ReviewError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// An explicitly opened, previously completed file action may be reviewed even
// outside the workspace. A session's access mode alone is not a read grant.
export async function resolveReviewPath(manager: RuntimeManager, requestedPath: string, sessionId?: string): Promise<string> {
  if (!requestedPath) throw new ReviewError(400, "A file path is required.");
  const target = await fs.realpath(path.resolve(requestedPath));
  const runtime = manager.getRuntime();
  if (await isWorkspacePath(target, runtime.config.filesystem.allowedDirectories)) return target;
  if (sessionId) {
    const settings = await manager.getSettings();
    const entries = await runtime.memoryService.recent({
      actor: { sessionId, userId: settings.memory.localProfileId, channel: "http" }, limit: 500
    });
    for (const entry of entries) {
      // Stored tool results, never paths supplied by request metadata or model prose.
      const tools = entry.metadata?.tools;
      if (!Array.isArray(tools)) continue;
      for (const tool of tools) {
        if (tool?.tool !== "file" || !tool.ok) continue;
        const files = Array.isArray(tool.metadata?.files) ? tool.metadata.files : [tool.metadata];
        if (files.some((file: { filePath?: string }) => file?.filePath === target)) return target;
      }
    }
  }
  throw new ReviewError(403, "This file is outside the workspace and has no completed file action in this chat.");
}

async function readReviewFile(manager: RuntimeManager, requestedPath: string, sessionId?: string) {
  const filePath = await resolveReviewPath(manager, requestedPath, sessionId);
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new ReviewError(400, "Requested path is not a file.");
    const limit = 5 * 1024 * 1024;
    if (stat.size > limit) throw new ReviewError(413, "File is larger than the 5 MB viewer limit.");
    // Bound the read even if another process grows the file after stat().
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit) throw new ReviewError(413, "File is larger than the 5 MB viewer limit.");
    const bytes = buffer.subarray(0, size);
    if (bytes.includes(0)) throw new ReviewError(415, "Review supports text files. Open this file in its own application.");
    return { path: filePath, name: path.basename(filePath), sizeBytes: size,
      content: bytes.toString("utf8"), version: createHash("sha256").update(bytes).digest("hex") };
  } finally { await handle.close(); }
}

function report(error: unknown, res: Response, next: NextFunction) {
  if (error instanceof ReviewError) res.status(error.status).json({ error: error.message });
  else if ((error as NodeJS.ErrnoException).code === "ENOENT") res.status(404).json({ error: "File no longer exists. It may have been moved or deleted." });
  else next(error);
}

export const createReadWorkspaceFileController = (manager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await readReviewFile(manager, typeof req.query.path === "string" ? req.query.path : "",
        typeof req.query.sessionId === "string" ? req.query.sessionId : undefined));
    } catch (error) { report(error, res, next); }
  };

export function textEditorCommand(filePath: string, platform = process.platform): [string, string[]] {
  // Always open as text: shell associations can execute scripts instead of editing them.
  if (platform === "darwin") return ["/usr/bin/open", ["-t", filePath]];
  if (platform === "win32") return ["notepad.exe", [filePath]];
  return ["gedit", ["--", filePath]];
}

function launchEditor(command: string, args: string[], platform: NodeJS.Platform): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    // macOS open is a short-lived launcher. Editors on other platforms can
    // stay alive until the window closes, so do not keep HTTP waiting for them.
    if (platform === "darwin") child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Editor launch failed.")));
    else child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export async function openWorkspaceEditor(filePath: string, platform = process.platform, launch = launchEditor): Promise<"vscode" | "text"> {
  let candidates: Array<[string, string[]]>;
  if (platform === "darwin") {
    // Launch Services finds VS Code even outside /Applications, without needing
    // its optional command-line launcher installed in PATH.
    candidates = [["/usr/bin/open", ["-b", "com.microsoft.VSCode", filePath]]];
  } else if (platform === "win32") {
    const installations = [
      process.env.LOCALAPPDATA && path.win32.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"),
      process.env.ProgramFiles && path.win32.join(process.env.ProgramFiles, "Microsoft VS Code", "Code.exe"),
      process.env["ProgramFiles(x86)"] && path.win32.join(process.env["ProgramFiles(x86)"]!, "Microsoft VS Code", "Code.exe")
    ].filter((entry): entry is string => Boolean(entry));
    candidates = [...new Set([...installations, "Code.exe"])].map((command) => [command, [filePath]]);
  } else {
    candidates = [["code", ["--reuse-window", "--", filePath]]];
  }
  for (const [command, args] of candidates) {
    try { await launch(command, args, platform); return "vscode"; }
    catch { /* VS Code is unavailable; try the next editor. */ }
  }
  try {
    const [command, args] = textEditorCommand(filePath, platform);
    await launch(command, args, platform);
    return "text";
  } catch {
    // A missing editor executable is not a missing source file (HTTP 404).
    throw new ReviewError(503, "Unable to open an editor. Install Visual Studio Code or a text editor and try again.");
  }
}

export const createOpenWorkspaceEditorController = (manager: RuntimeManager) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const file = await readReviewFile(manager, typeof req.body?.path === "string" ? req.body.path : "",
        typeof req.body?.sessionId === "string" ? req.body.sessionId : undefined);
      const editor = await openWorkspaceEditor(file.path);
      res.json({ ok: true, path: file.path, editor });
    } catch (error) { report(error, res, next); }
  };
