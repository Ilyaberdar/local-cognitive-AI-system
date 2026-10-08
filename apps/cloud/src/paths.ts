import { existsSync } from "node:fs";
import path from "node:path";

// Works from tsx (src/), compiled output (dist/src/) and the container image alike.
const findPackageRoot = (start: string): string => {
  for (let directory = start; ; directory = path.dirname(directory)) {
    if (existsSync(path.join(directory, "package.json"))) return directory;
    if (path.dirname(directory) === directory) throw new Error("package.json not found");
  }
};

export const PACKAGE_ROOT = findPackageRoot(import.meta.dirname);
export const MIGRATIONS_DIR = path.join(PACKAGE_ROOT, "migrations");
