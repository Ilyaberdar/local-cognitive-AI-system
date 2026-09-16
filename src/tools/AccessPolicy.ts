import fs from "fs/promises";
import path from "path";
import { ApprovalOperation, ExecutionContext, ToolExecutionResult } from "../types";

// Resolve existing ancestors too, so a symlink cannot turn a workspace write into external access.
export async function canonicalPath(target: string, symlinkDepth = 0): Promise<string> {
  if (symlinkDepth > 40) throw new Error("Too many symbolic links in operation path.");
  try { return await fs.realpath(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const stat = await fs.lstat(target).catch((failure: NodeJS.ErrnoException) => {
      if (failure.code !== "ENOENT") throw failure;
      return undefined;
    });
    if (stat?.isSymbolicLink()) {
      return canonicalPath(path.resolve(path.dirname(target), await fs.readlink(target)), symlinkDepth + 1);
    }
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(await canonicalPath(parent, symlinkDepth), path.basename(target));
  }
}

export async function isWorkspacePath(target: string, directories: string[]): Promise<boolean> {
  const resolved = await canonicalPath(target);
  const roots = await Promise.all(directories.map((directory) => canonicalPath(path.resolve(directory))));
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

export async function authorizeOperation(
  context: ExecutionContext, operation: ApprovalOperation, safeByDefault: boolean, readOnly = false
): Promise<ToolExecutionResult | undefined> {
  context.signal?.throwIfAborted();
  const mode = context.sessionSettings.defaultAccessMode;
  if (mode === "full" || (safeByDefault && (mode === "default" || readOnly))) return;
  if (!context.requestApproval) {
    return { tool: operation.tool, ok: false, output: `Permission required: ${operation.summary}`,
      metadata: { permissionRequired: true, operation: operation.operation } };
  }
  const approved = await context.requestApproval(operation);
  context.signal?.throwIfAborted();
  if (!approved) return { tool: operation.tool, ok: false, output: `Cancelled: ${operation.summary}. Nothing was executed.`,
    metadata: { cancelled: true, operation: operation.operation } };
}
