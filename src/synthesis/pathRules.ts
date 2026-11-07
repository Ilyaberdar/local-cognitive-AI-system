/** A project-relative path as the DSL and the runtime accept it: `/` only, no hidden or reserved
 * folders, no traversal, at most 240 characters. */
export const isProjectRelative = (value: unknown): value is string => typeof value === "string" && Boolean(value) && value.length <= 240 && !value.includes("\\") &&
  value.split("/").every(part => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) && part !== "node_modules");
