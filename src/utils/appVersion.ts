import fs from "fs";
import path from "path";

let cached: string | undefined;

/** Application version from package.json, from both src (tsx) and dist/src (compiled). */
let root: string | undefined;

/** Directory of the application release (its package.json), independent of the working directory. */
export const releaseRoot = (): string => {
  if (root) return root;
  for (const candidate of [path.resolve(__dirname, "..", ".."), path.resolve(__dirname, "..", "..", "..")]) {
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8")) as { name?: string };
      if (metadata.name === "local-cognitive-ai-system") return root = candidate;
    } catch { /* Try the next location. */ }
  }
  return root = path.resolve(__dirname, "..", "..");
};

export const appVersion = (): string => {
  if (cached) return cached;
  for (const candidate of [path.resolve(__dirname, "..", "..", "package.json"), path.resolve(__dirname, "..", "..", "..", "package.json")]) {
    try {
      const metadata = JSON.parse(fs.readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (metadata.name === "local-cognitive-ai-system" && metadata.version) return cached = metadata.version;
    } catch { /* Try the next location. */ }
  }
  return cached = "unknown";
};
