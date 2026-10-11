import assert from "node:assert/strict";
import test from "node:test";
import { checkExports, checkForbidden, checkImportBoundary, checkImports, extractImports, languageOf, matchesGlob, resolveImport, checkHarnessIntegrity } from "../src/synthesis/checks/architecture";
import type { CheckFiles } from "../src/synthesis/checks/types";

const files = (candidate: Record<string, string>, frozen: Record<string, string> = {}): CheckFiles => ({ candidate, frozen, suite: {} });
const lines = (...items: string[]) => items.join("\n");
const imports = (path: string, source: string) => extractImports(path, source).map(item => `${item.line}:${item.specifier}`);

test("languages come from the extension; unknown files have no imports", () => {
  for (const [path, language] of [["a.ts", "typescript"], ["a.mts", "typescript"], ["a.cts", "typescript"], ["a.tsx", "typescript"],
    ["a.js", "javascript"], ["a.mjs", "javascript"], ["a.cjs", "javascript"], ["a.jsx", "javascript"], ["a.py", "python"],
    ["a.c", "cpp"], ["a.cc", "cpp"], ["a.cpp", "cpp"], ["a.cxx", "cpp"], ["a.h", "cpp"], ["a.hh", "cpp"], ["a.hpp", "cpp"],
    ["a.hxx", "cpp"], ["a.inl", "cpp"], ["src/A.CPP", "cpp"]] as const) assert.equal(languageOf(path), language, path);
  for (const path of ["README.md", "Makefile", "src/a.rs", "src.ts/readme"]) assert.equal(languageOf(path), undefined, path);
  assert.deepEqual(extractImports("style.css", '@import "x.css";'), []);
});

test("matchesGlob: ** spans any number of segments, * and ? stay inside one, the rest is literal", () => {
  for (const [value, pattern, expected] of [
    ["src/a.ts", "src/**", true], ["src/x/y.ts", "src/**", true], ["src", "src/**", true],
    ["srcx/a.ts", "src/**", false], ["lib/src/a.ts", "src/**", false],
    ["a.ts", "**/*.ts", true], ["x/y/a.ts", "**/*.ts", true], ["a.tsx", "**/*.ts", false],
    ["src/test/a.ts", "src/**/test/*.ts", true], ["src/x/y/test/a.ts", "src/**/test/*.ts", true], ["src/test/x/a.ts", "src/**/test/*.ts", false],
    ["src/a.ts", "src/*.ts", true], ["src/x/a.ts", "src/*.ts", false], ["a.ts", "?.ts", true], ["ab.ts", "?.ts", false], ["a/b", "a?b", false],
    ["node:fs", "node:*", true], ["node:fs/promises", "node:*", false], ["node:fs/promises", "node:**", true],
    ["<thread>", "<*>", true], ["<sys/stat.h>", "<*>", false], ["<sys/stat.h>", "<**>", true],
    ["a+b(c)[1]{2}^$|.ts", "a+b(c)[1]{2}^$|.ts", true], ["axts", "a.ts", false], ["a\\b", "a\\b", true],
    ["anything/at/all", "**", true], ["x", "", false]
  ] as const) assert.equal(matchesGlob(value, pattern), expected, `${value} ~ ${pattern}`);
});

test("JavaScript and TypeScript imports: static, multi-line, re-exports, dynamic and require; comments and strings cannot fake one", () => {
  const source = lines(
    "import def, { a, type B,",
    '  c as d } from "./multi";',
    '// import x from "comment"',
    '/* require("block") */',
    "const s = \"import y from 'string'\";",
    'const t = `require("template-text") ${require("in-hole")} end`;',
    "const re = /[\"'`]/g; const half = total / 2 / 3;",
    'import "side-effect";',
    "export * from \"./star\"; export { z } from './named';",
    'export * as ns from "./ns";',
    'const m = await import("./dyn"); const n = import(`./tpl`);',
    'const skip = import(name); const skip2 = require("a" + b);',
    'import x = require("ts-equals");',
    "const meta = import.meta.url;",
    'import type { T } from "./types";',
    'const escaped = require("\\x2e\\x2e/escaped");',
    'obj.require("not-a-require"); foo.import("nope");'
  );
  assert.deepEqual(imports("src/a.ts", source), ["2:./multi", "6:in-hole", "8:side-effect", "9:./star", "9:./named", "10:./ns",
    "11:./dyn", "11:./tpl", "13:ts-equals", "15:./types", "16:../escaped"]);
  assert.deepEqual(imports("src/a.mjs", "#!/usr/bin/env node\nimport { x } from 'y';"), ["2:y"]);
});

test("Python imports keep relative dots; comments, docstrings and f-string text are ignored", () => {
  const source = lines(
    "import os",
    "import a.b, c as d",
    "from x.y import z",
    "from . import sibling",
    "from ..pkg import y",
    "from .rel.mod import (",
    "    p,",
    "    q,",
    ")",
    "# import commented",
    '"""',
    "import docstring",
    '"""',
    "s = f\"{__import__('in_hole')} import text\"",
    'mod = importlib.import_module("dyn.mod")',
    "import first, \\",
    "    second",
    "if ready: import inline_one; import inline_two",
    "raise Error() from cause",
    "half = 1 // 2"
  );
  assert.deepEqual(imports("pkg/sub/m.py", source), ["1:os", "2:a.b", "2:c", "3:x.y", "4:.", "5:..pkg", "6:.rel.mod",
    "14:in_hole", "15:dyn.mod", "16:first", "17:second", "18:inline_one", "18:inline_two"]);
});

test("C++ includes: quoted and angle forms; comments, strings, raw strings and char literals are ignored", () => {
  const source = lines(
    '#include "local.h"',
    "#include <thread>",
    "  #  include <sys/stat.h>",
    '// #include "commented.h"',
    '/* #include "block.h" */',
    'auto raw = R"x(#include "raw.h")x";',
    'const char* text = "#include \\"str.h\\"";',
    "char quote = '\"'; int big = 1'000'000;",
    '#include "after.h"',
    "// a comment spliced to the next line \\",
    '#include "spliced.h"'
  );
  assert.deepEqual(imports("src/a.cpp", source), ["1:local.h", "2:<thread>", "3:<sys/stat.h>", "9:after.h"]);
});

test("resolveImport turns relative specifiers into root paths, keeps ../ when they leave it and other forms as written", () => {
  const cases: Array<[string, string, string]> = [
    ["src/a/b.ts", "./c", "src/a/c"], ["src/a/b.ts", "../c/d", "src/c/d"], ["src/a.ts", ".", "src"], ["src/a.ts", "..", "."],
    ["a.ts", "../x", "../x"], ["src/a.ts", "../../x", "../x"], ["src/a.ts", "node:fs", "node:fs"], ["src/a.ts", "lodash/fp", "lodash/fp"],
    ["pkg/sub/m.py", ".", "pkg/sub"], ["pkg/sub/m.py", ".x", "pkg/sub/x"], ["pkg/sub/m.py", "..pkg2.y", "pkg/pkg2/y"],
    ["pkg/sub/m.py", "...", "."], ["pkg/sub/m.py", "....x", "../x"], ["m.py", ".", "."], ["pkg/m.py", "os.path", "os.path"],
    ["src/a.cpp", "x.h", "src/x.h"], ["src/a.cpp", "../include/x.h", "include/x.h"], ["a.cpp", "../x.h", "../x.h"],
    ["src/a.cpp", "..\\..\\x.h", "../x.h"], ["src/a.cpp", "<thread>", "<thread>"], ["src/a.cpp", "/etc/passwd", "/etc/passwd"]
  ];
  for (const [from, specifier, expected] of cases) assert.equal(resolveImport(from, specifier), expected, `${from} -> ${specifier}`);
});

test("checkExports finds TypeScript and CommonJS exports and names each missing symbol", () => {
  const limiter = lines(
    "export class RateLimiter {}",
    "export default async function main() {}",
    "export abstract class Base {}",
    "export interface Options { burst: number }",
    "export type Mode = 'fixed' | 'sliding';",
    "export enum Level { Low, High }",
    "export const DEFAULT = 1;",
    "function helper() {}",
    "export { helper as publicHelper };",
    "// export class Hidden {}",
    "const text = 'export class InString {}';",
    "class Internal {}"
  );
  const project = files({ "src/rateLimiter.ts": limiter });
  assert.deepEqual(checkExports(project, "src/rateLimiter.ts", ["RateLimiter", "main", "Base", "Options", "Mode", "Level", "DEFAULT", "publicHelper"]),
    { status: "Pass", message: "Every symbol is exported", feedback: [] });
  assert.deepEqual(checkExports(project, "src/rateLimiter.ts", ["RateLimiter", "helper", "Hidden", "InString", "Internal"]), {
    status: "Fail", message: "4 symbols are missing from src/rateLimiter.ts",
    feedback: ["src/rateLimiter.ts must export helper.", "src/rateLimiter.ts must export Hidden.", "src/rateLimiter.ts must export InString.", "src/rateLimiter.ts must export Internal."]
  });
  const common = files({ "lib/limiter.js": "exports.a = 1;\nmodule.exports.b = () => {};\nmodule.exports = { c, d: { nested: 1 }, async e() {}, ...rest };\n" });
  assert.equal(checkExports(common, "lib/limiter.js", ["a", "b", "c", "d", "e"]).status, "Pass");
  assert.deepEqual(checkExports(common, "lib/limiter.js", ["nested"]).feedback, ["lib/limiter.js must export nested."]);
  assert.deepEqual(checkExports(project, "src/missing.ts", ["RateLimiter"]),
    { status: "Fail", message: "src/missing.ts is missing", feedback: ["src/missing.ts does not exist; it must export RateLimiter."] });
  assert.equal(checkExports(files({}, { "src/api.ts": "export function frozen() {}" }), "src/api.ts", ["frozen"]).status, "Pass");
});

test("checkExports reads Python definitions at the top level only", () => {
  const source = lines(
    "def allow(): pass",
    "async def fetch(): pass",
    "class Limiter:",
    "    burst = 1",
    "    def inner(self): pass",
    "RATE = 5",
    "WINDOW: int = 60",
    "COUNT == 3",
    '"""',
    "DOC = 1",
    '"""',
    "from .clock import Clock as SystemClock"
  );
  const project = files({ "limiter/core.py": source });
  assert.equal(checkExports(project, "limiter/core.py", ["allow", "fetch", "Limiter", "RATE", "WINDOW", "SystemClock"]).status, "Pass");
  assert.deepEqual(checkExports(project, "limiter/core.py", ["burst", "inner", "COUNT", "DOC"]), {
    status: "Fail", message: "4 symbols are missing from limiter/core.py",
    feedback: ["limiter/core.py must export burst.", "limiter/core.py must export inner.", "limiter/core.py must export COUNT.", "limiter/core.py must export DOC."]
  });
});

test("checkExports reads C++ declarations and qualified members such as AbilitySystem::TryActivate", () => {
  const header = lines(
    "#pragma once",
    "#include <vector>",
    "namespace limits { constexpr int kMax = 5; }",
    "enum class Level : int { Low, High };",
    "using Clock = long;",
    "struct Options { int burst; };",
    "class GAME_API AbilitySystem : public Base {",
    "public:",
    "  bool TryActivate(int id);",
    "  [[nodiscard]] int Inline() const { return 1; }",
    "  int OnlyDeclared();",
    "};",
    "std::vector<int> make_list(int n);"
  );
  const source = lines(
    '#include "AbilitySystem.h"',
    "bool AbilitySystem::TryActivate(int id) {",
    "  return id > 0;",
    "}",
    "void caller() { if (AbilitySystem::OnlyDeclared()) { helper(); } }"
  );
  const project = files({ "src/AbilitySystem.h": header, "src/AbilitySystem.cpp": source });
  assert.deepEqual(checkExports(project, "src/AbilitySystem.h", ["AbilitySystem", "Options", "Level", "Clock", "limits", "make_list", "TryActivate",
    "AbilitySystem::TryActivate", "AbilitySystem::Inline"]), { status: "Pass", message: "Every symbol is exported", feedback: [] });
  assert.equal(checkExports(project, "src/AbilitySystem.cpp", ["AbilitySystem::TryActivate", "caller"]).status, "Pass");
  assert.deepEqual(checkExports(project, "src/AbilitySystem.h", ["AbilitySystem::OnlyDeclared", "Missing::Thing", "helper"]), {
    status: "Fail", message: "3 symbols are missing from src/AbilitySystem.h",
    feedback: [
      "src/AbilitySystem.h must export AbilitySystem::OnlyDeclared: define AbilitySystem::OnlyDeclared(…) with a body.",
      "src/AbilitySystem.h must export Missing::Thing: declare Missing and define Missing::Thing(…) with a body.",
      "src/AbilitySystem.h must export helper."
    ]
  });
  // A call is not a definition, and a definition needs its owner declared somewhere.
  const callOnly = files({ "src/AbilitySystem.h": header, "src/use.cpp": "void use() {\n  AbilitySystem::TryActivate(1);\n}" });
  assert.deepEqual(checkExports(callOnly, "src/AbilitySystem.h", ["AbilitySystem::TryActivate"]).feedback,
    ["src/AbilitySystem.h must export AbilitySystem::TryActivate: define AbilitySystem::TryActivate(…) with a body."]);
  const ownerless = files({ "src/a.cpp": "bool AbilitySystem::TryActivate(int id) { return true; }" });
  assert.deepEqual(checkExports(ownerless, "src/a.cpp", ["AbilitySystem::TryActivate"]).feedback,
    ["src/a.cpp must export AbilitySystem::TryActivate: declare AbilitySystem."]);
  assert.equal(checkExports(files({ "src/lib.rs": "pub fn f() {}" }), "src/lib.rs", ["f"]).status, "Unknown");
});

test("checkImports holds the candidate's raw and resolved imports to deny, then allow; frozen files are trusted", () => {
  const project = files({
    "src/core/a.ts": lines('import { b } from "./b";', 'import _ from "lodash";', 'import fs from "node:fs";', 'import { view } from "../ui/view";'),
    "src/core/b.ts": "export const b = 1;",
    "src/ui/view.ts": 'import fs from "node:fs";'
  }, { "src/core/frozen.ts": 'import fs from "node:fs";' });
  assert.deepEqual(checkImports(project, "src/core/**", { allow: [], deny: ["node:*"] }), {
    status: "Fail", message: "1 import breaks the contract's rules",
    feedback: ['src/core/a.ts:3 imports "node:fs", which the contract does not allow.']
  });
  assert.deepEqual(checkImports(project, "src/core/**", { allow: ["src/core/**", "lodash"], deny: [] }).feedback, [
    'src/core/a.ts:3 imports "node:fs", which the contract does not allow.',
    'src/core/a.ts:4 imports "../ui/view" (src/ui/view), which the contract does not allow.'
  ]);
  assert.deepEqual(checkImports(project, "src/**", { allow: ["src/**", "lodash", "node:*"], deny: [] }),
    { status: "Pass", message: "Every import follows the contract's rules", feedback: [] });
  assert.equal(checkImports(project, "src/**", { allow: ["node:*", "src/**", "lodash"], deny: ["node:fs"] }).status, "Fail");
});

test("checkImports matches system headers against <*> and fails a pattern that matches no candidate file", () => {
  const project = files({ "src/a.cpp": lines("#include <thread>", "#include <sys/stat.h>", '#include "local.h"', '#include "../ui/x.h"') });
  assert.deepEqual(checkImports(project, "src/**", { allow: ["<*>", "src/**"], deny: [] }).feedback, [
    'src/a.cpp:2 includes "<sys/stat.h>", which the contract does not allow.',
    'src/a.cpp:4 includes "../ui/x.h" (ui/x.h), which the contract does not allow.'
  ]);
  assert.equal(checkImports(project, "src/**", { allow: ["<**>", "src/**", "ui/**"], deny: [] }).status, "Pass");
  const typo = checkImports(project, "src/cor/**", { allow: [], deny: ["<thread>"] });
  assert.equal(typo.status, "Fail"); assert.equal(typo.message, 'No candidate file matches "src/cor/**"');
  assert.equal(checkImports(files({}, { "src/a.cpp": "#include <thread>" }), "src/**", { allow: [], deny: [] }).status, "Fail");
});

test("checks keep at most eight feedback items, the last one counting the rest", () => {
  const many = Object.fromEntries(Array.from({ length: 10 }, (_, k) => [`src/f${k}.ts`, 'import fs from "node:fs";']));
  const result = checkImports(files(many), "src/**", { allow: [], deny: ["node:fs"] });
  assert.equal(result.message, "10 imports break the contract's rules");
  assert.equal(result.feedback.length, 8);
  assert.equal(result.feedback[0], 'src/f0.ts:1 imports "node:fs", which the contract does not allow.');
  assert.equal(result.feedback[7], "…and 3 more.");
  const long = checkImports(files({ [`src/${"x".repeat(200)}.ts`]: `import a from "${"y".repeat(200)}";` }), "src/**", { allow: [], deny: ["**"] });
  assert.ok(long.feedback[0].length <= 300 && long.feedback[0].endsWith("…"));
});

test("checkForbidden ignores comments and literals, reads interpolated code and reports lines", () => {
  const clock = lines(
    "const a = 1;",
    "// Date.now() in a comment",
    'const s = "Date.now() in a string";',
    "const t = `Date.now() in template text ${Date.now()} hole`;",
    "/* Date.now() in a block */ const now = Date.now();",
    "const re = /Date.now()/;"
  );
  const project = files({ "src/clock.ts": clock, "test/clock.test.ts": "Date.now();" });
  assert.deepEqual(checkForbidden(project, "src/**", "Date\\.now", "Use the injected clock."), {
    status: "Fail", message: "2 forbidden uses of /Date\\.now/",
    feedback: ['src/clock.ts:4 uses "Date.now": Use the injected clock.', 'src/clock.ts:5 uses "Date.now": Use the injected clock.']
  });
  assert.equal(checkForbidden(project, "src/**", "Date\\.now").feedback[0],
    'src/clock.ts:4 uses "Date.now", which matches the forbidden pattern /Date\\.now/.');
  assert.deepEqual(checkForbidden(project, "src/**", "Math\\.random"), { status: "Pass", message: "No file uses /Math\\.random/", feedback: [] });
  const python = lines("# time.time()", '"""', "time.time()", '"""', 's = f"{time.time()} time.time()"', "q = 'time.time()'");
  assert.deepEqual(checkForbidden(files({ "clock.py": python }), "**/*.py", "time\\.time\\(").feedback,
    ['clock.py:5 uses "time.time(", which matches the forbidden pattern /time\\.time\\(/.']);
  const cpp = lines("// rand()", 'auto s = R"(rand())";', "char c = 'r';", 'const char* q = "rand()";', "int x = rand();", "/* rand() */");
  assert.deepEqual(checkForbidden(files({ "src/dice.cpp": cpp }), "src/*.cpp", "\\brand\\(").feedback,
    ['src/dice.cpp:5 uses "rand(", which matches the forbidden pattern /\\brand\\(/.']);
});

test("checkForbidden reports an invalid regular expression as Unknown", () => {
  for (const regex of ["(", "[a-", "a{2,1}"]) {
    const result = checkForbidden(files({ "src/a.ts": "x" }), "src/**", regex);
    assert.equal(result.status, "Unknown", regex); assert.deepEqual(result.feedback, []);
  }
});

test("checkImportBoundary rejects absolute paths and imports that climb out of the module", () => {
  const cpp = checkImportBoundary(files({
    "src/a.cpp": lines("#include <vector>", '#include "/etc/passwd"', '#include "../include/ok.h"', '#include "../../secret.h"',
      "#include <../escape.h>", '#include "..\\..\\windows.h"')
  }, { "src/frozen.cpp": '#include "/etc/passwd"' }));
  assert.deepEqual(cpp, {
    status: "Fail", message: "4 imports reach outside the module",
    feedback: [
      'src/a.cpp:2 includes "/etc/passwd": files may only include files of the module or system headers.',
      'src/a.cpp:4 includes "../../secret.h": files may only include files of the module or system headers.',
      'src/a.cpp:5 includes "<../escape.h>": files may only include files of the module or system headers.',
      'src/a.cpp:6 includes "..\\..\\windows.h": files may only include files of the module or system headers.'
    ]
  });
  const js = checkImportBoundary(files({
    "src/b.ts": lines('import a from "/abs";', 'import b from "../ok";', 'const c = require("../../out");', 'const d = import("file:///etc/passwd");',
      'const e = require("C:\\\\x");', 'const f = require("\\x2e\\x2e/\\x2e\\x2e/x");', 'const g = require("lodash/../../../x");')
  }));
  assert.deepEqual(js.feedback.map(item => item.slice(0, item.indexOf(" "))), ["src/b.ts:1", "src/b.ts:3", "src/b.ts:4", "src/b.ts:5", "src/b.ts:6", "src/b.ts:7"]);
  assert.equal(js.feedback[4], 'src/b.ts:6 imports "../../x": files may only import files of the module or installed packages.');
  assert.deepEqual(checkImportBoundary(files({ "pkg/m.py": "from ... import x\nfrom .. import ok" })).feedback,
    ['pkg/m.py:1 imports "...": files may only import files of the module or installed packages.']);
  assert.deepEqual(checkImportBoundary(files({ "src/a.ts": 'import x from "./x";\nimport y from "../y";', "src/b.cpp": '#include <vector>\n#include "../include/x.h"' })),
    { status: "Pass", message: "Every import stays inside the module", feedback: [] });
});

test("checkHarnessIntegrity: the module may not use the test harness, read the token or end the process", () => {
  const verdict = (file: string, source: string) => checkHarnessIntegrity({ candidate: { [file]: source }, frozen: {}, suite: {} });
  const tampered = verdict("src/limiter.ts", "import assert from \"node:assert/strict\";\nassert.equal = () => {};\nexport class Limiter {}\n");
  assert.equal(tampered.status, "Fail");
  assert.match(tampered.feedback[0], /^src\/limiter\.ts:1 imports "node:assert\/strict": the module may not use the test harness\.$/);
  assert.equal(verdict("src/a.js", "module.exports = () => process.exit(0);\n").status, "Fail");
  assert.equal(verdict("src/a.ts", "export const done = () => { console.log(\"process.exit(0) is only text\"); };\n// process.exit(1) in a comment\n").status, "Pass");

  assert.equal(verdict("src/limits.py", "import unittest\n").status, "Fail");
  assert.equal(verdict("src/limits.py", "import os\nos._exit(0)\n").status, "Fail");
  assert.equal(verdict("src/limits.py", "def stop():\n    exit(0)\n").status, "Fail");
  assert.equal(verdict("src/limits.py", "def stop(door):\n    door.exit(1)\n    return 'exit(0)'\n").status, "Pass");
  assert.equal(verdict("src/door.py", "class Door:\n    def exit(self):\n        return True\n").status, "Pass");

  const main = verdict("src/core.cpp", "#include \"core.h\"\nint main() { return 0; }\n");
  assert.equal(main.status, "Fail");
  assert.match(main.feedback[0], /src\/core\.cpp:2 uses "int main\(": while its tests run/);
  assert.equal(verdict("src/core.cpp", "#include \"lc_test.hpp\"\n").status, "Fail");
  assert.equal(verdict("src/core.cpp", "#include <cstdlib>\nvoid stop() { std::exit(1); }\n").status, "Fail");
  assert.equal(verdict("src/core.cpp", "#include <stdlib.h>\nvoid stop(bool now) { if (now) exit(1); else exit(2); }\n").status, "Fail");
  assert.equal(verdict("src/core.cpp", "#include <cstdlib>\nconst char* home() { return getenv(\"HOME\"); }\n").status, "Fail");
  assert.equal(verdict("src/core.cpp", "#include <algorithm>\nint clampTo(int v) { return std::max(0, v); }\nstruct Door { void exit(); };\nvoid leave(Door& d) { d.exit(); }\n").status, "Pass");
});
