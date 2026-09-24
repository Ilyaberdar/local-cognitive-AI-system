import { WorkflowRunOptions } from "./types";

export function validateRunOptions(options: WorkflowRunOptions): string[] {
  if (!options || typeof options !== "object" || Array.isArray(options)) return ["Run options must be an object."];
  const errors: string[] = [];
  for (const key of ["description", "projectId", "rootPath"] as const) {
    if (options[key] !== undefined && typeof options[key] !== "string") errors.push(`${key} must be text.`);
  }
  if (options.projectId && options.rootPath) errors.push("Choose a project or a folder, not both.");
  if (typeof options.rootPath === "string" && !options.rootPath.trim()) errors.push("Choose a workspace folder or select New folder for this run.");
  if (options.accessMode !== undefined && !["ask", "default", "full"].includes(options.accessMode)) errors.push("Invalid run access mode.");
  if (options.maxSteps !== undefined && (!Number.isInteger(options.maxSteps) || options.maxSteps < 1 || options.maxSteps > 250)) errors.push("Step limit must be between 1 and 250.");
  if (typeof options.description === "string" && options.description.length > 100_000) errors.push("Run input exceeds 100,000 characters.");
  return errors;
}
