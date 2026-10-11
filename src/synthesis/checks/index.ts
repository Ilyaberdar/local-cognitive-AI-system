import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContractCheck } from "../language";
import { checkExports, checkForbidden, checkHarnessIntegrity, checkImportBoundary, checkImports } from "./architecture";
import { runContractTests } from "./runners";
import { platformSandbox } from "./sandbox";
import { CheckFiles, CheckResult, SandboxProvider } from "./types";

export * from "./types";
/** Part of every piece of evidence: a change to what the checks accept makes older evidence stale. */
export const contractChecksVersion = "contract-v1";
export interface CheckOptions { sandbox?: SandboxProvider; workRoot?: string; signal?: AbortSignal }

/** Runs one of the contract's built-in checks: Exports, Imports and Forbid read the files; Tests
 * runs the engineer's tests against them in a sandbox. */
export async function runCheck(check: ContractCheck, files: CheckFiles, options: CheckOptions = {}): Promise<CheckResult> {
  switch (check.kind) {
    case "exports": return checkExports(files, check.file, check.symbols);
    case "imports": return checkImports(files, check.pattern, { allow: check.allow, deny: check.deny });
    case "forbid": return checkForbidden(files, check.pattern, check.regex, check.message);
    case "tests": {
      // Nothing runs that names a file outside the module or reaches into the test harness, sandbox or not.
      for (const guard of [checkImportBoundary(files), checkHarnessIntegrity(files)]) {
        if (guard.status !== "Pass") return { ...guard, message: `Tests not run: ${guard.message}` };
      }
      const workRoot = options.workRoot ?? path.join(os.tmpdir(), "lc-synthesis");
      await fs.mkdir(workRoot, { recursive: true });
      return runContractTests({ files, tests: check.files, timeoutMs: check.timeoutMs ?? 30_000, hidden: check.hidden,
        signal: options.signal, sandbox: options.sandbox ?? platformSandbox(), workRoot });
    }
  }
}
