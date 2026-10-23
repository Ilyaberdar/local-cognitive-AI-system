import assert from "node:assert/strict";
import test from "node:test";
import { checkTypes, hasTypeScript } from "../src/synthesis/checks/typecheck";

// The candidate's TypeScript type-checked in process, as the runner runs it: what fails at run time
// (or never shows) is said with the candidate's file and line.

const pattern = "export class Pattern {\n  constructor(readonly source: string) {}\n  match(path: string): Record<string, string> | null { return path === this.source ? {} : null; }\n}\n";
const check = (candidate: Record<string, string>, suite: Record<string, string> = {}, tests: string[] = []) => checkTypes({ candidate, frozen: {}, suite }, tests);

test("a class imported with import type and then constructed is found, with the candidate's relative file and line", () => {
  const result = check({ "src/pattern.ts": pattern.replace("constructor(readonly source: string) {}", "readonly source: string;\n  constructor(source: string) { this.source = source; }"),
    "src/router.ts": "import type { Pattern } from \"./pattern.ts\";\n\nexport class Router {\n  add(path: string) { return new Pattern(path); }\n}\n" });
  assert.equal(result.status, "Fail");
  assert.deepEqual(result.feedback, ["src/router.ts:4: 'Pattern' cannot be used as a value because it was imported using 'import type'. (TS1361)"]);
  assert.equal(result.message, "1 type error in 1 file");
});

test("a visible test's call with the wrong arguments is found with where the candidate declares it; a hidden test is never read", () => {
  const limiter = "export class RateLimiter {\n  private tokens = 1;\n  tryAcquire(tokens: number): boolean {\n    return tokens <= this.tokens;\n  }\n}\n";
  const visible = "import assert from \"node:assert/strict\";\nimport test from \"node:test\";\nimport { RateLimiter } from \"../src/rateLimiter.ts\";\n\ntest(\"takes one\", () => {\n  assert.equal(new RateLimiter().tryAcquire(), true);\n});\n";
  const hidden = "import { RateLimiter } from \"../src/rateLimiter.ts\";\nnew RateLimiter().missing();\n";
  const result = check({ "src/rateLimiter.ts": limiter }, { "tests/visible.test.ts": visible, "tests/hidden.test.ts": hidden }, ["tests/visible.test.ts"]);
  assert.deepEqual(result.feedback, ["tests/visible.test.ts:6: Expected 1 arguments, but got 0. (An argument for 'tokens' was not provided: src/rateLimiter.ts:3) (TS2554)"]);
  assert.ok(!JSON.stringify(result).includes("hidden"), "the hidden test is not read");
});

test("what the runner rejects or loses at run time: erasable syntax only, a type imported as a value, a missing module or export", () => {
  const result = check({
    "src/kinds.ts": "export enum Kind { A, B }\nexport interface Shape { kind: Kind }\n",
    "src/use.ts": "import { Shape } from \"./kinds.ts\";\nimport { Missing } from \"./kinds.ts\";\nimport { gone } from \"./gone.ts\";\nexport const shape: Shape | undefined = undefined;\nexport const both = [Missing, gone];\n"
  });
  const text = result.feedback.join("\n");
  assert.match(text, /src\/kinds\.ts:1: This syntax is not allowed when 'erasableSyntaxOnly' is enabled\. \(TS1294\)/);
  assert.match(text, /src\/use\.ts:1: 'Shape' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled\. \(TS1484\)/);
  assert.match(text, /src\/use\.ts:2: Module '"\.\/kinds\.ts"' has no exported member 'Missing'\. \(TS2305\)/);
  assert.match(text, /src\/use\.ts:3: Cannot find module '\.\/gone\.ts' or its corresponding type declarations\. \(TS2307\)/);
  assert.ok(!/\/lc-candidate|\/Users\/|\/private\//.test(text), "no absolute path reaches the model");
});

test("what this check cannot see is not the candidate's fault: Node's modules and globals, packages", () => {
  const result = check({ "src/a.ts": "import fs from \"node:fs\";\nimport { z } from \"zod\";\nexport const read = () => [fs, z, process.argv, Buffer.from(\"x\"), console.log];\n" });
  assert.deepEqual([result.status, result.feedback], ["Pass", []]);
});

test("errors that fail when the code runs come first, each message once with its lines, at most six items", () => {
  const many = Array.from({ length: 9 }, (_, i) => `export const v${i} = ({} as { a: number }).missing${i};`).join("\n");
  const result = check({ "src/a.ts": `${many}\nimport type { B } from "./b.ts";\nexport const b = new B();\n`, "src/b.ts": "export class B {}\n" });
  assert.equal(result.feedback.length, 6);
  assert.match(result.feedback[0]!, /^src\/a\.ts:11: 'B' cannot be used as a value/);
  assert.match(result.feedback[1]!, /^src\/a\.ts:1: Property 'missing0' does not exist on type '\{ a: number; \}'\. \(TS2339\)$/);
});

test("no TypeScript, or too much of it, is not judged", () => {
  assert.equal(hasTypeScript({ "calculator.js": "", "index.html": "" }), false);
  assert.equal(hasTypeScript({ "src/a.ts": "" }), true);
  assert.equal(check({ "calculator.js": "x" }).message, "No TypeScript to check");
  const large = check({ "src/a.ts": `export const a = "${"x".repeat(600 * 1024)}";\n` });
  assert.deepEqual([large.status, large.message], ["Unknown", "More than 512 KiB of TypeScript: not type-checked"]);
});
