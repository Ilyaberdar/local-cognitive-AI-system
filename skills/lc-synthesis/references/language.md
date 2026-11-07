# LC Spec and LC Flow: what a module author needs

A Synthesis module is two files with the same name: `Name.lcspec`, the contract (what the code must satisfy), and
`Name.lcflow`, the flow (how models write it). The engineer's test files live next to the contract. A run revises
the module's files with a model, checks them with the contract's gates, feeds the failures back, and accepts a
candidate only on fresh passing evidence; the project changes only when the user applies an accepted candidate.

Layout: `Synthesis/Name/Name.lcspec`, `Synthesis/Name/Name.lcflow`, `Synthesis/Name/tests/...`. The two file names,
`module Name` and `implement Name` agree. A name starts with an ASCII letter, then letters, digits and `_`, at most 64.

## Syntax shared by both files

- Case-sensitive. Statements and properties end with `;`. Blocks use `{ }`; `if` and `while` need parentheses and braces.
- Strings use `"..."` or `'...'` and stay on one line: `\n`, `\t`, `\\`, `\"`, `\uXXXX`. No template strings.
- In a contract string a regular-expression backslash is written twice: `"Date\\.now"`.
- Comments: `//` and `/* */` (not nested).
- Units attach to numbers: durations `250ms`, `30s`, `15m`, `2h`; sizes `64KiB`, `512MiB`, `6GiB`; cost `0usd`.
  `GB`, `MB`, `min`, `USD` are not units.

## The contract (`.lcspec`)

```lcspec
module Bucket version "1" {
    target { language = TypeScript; }          // JavaScript (JS), TypeScript (TS), Python or Cpp

    description = "...";                       // the requirements, as numbered clauses (below)

    artifacts {
        frozen "src/types.ts";                 // the engineer's interface: the model reads it, never changes it
        file "src/clock.ts";                   // files the model writes, dependencies first
        file "src/bucket.ts";
    }

    tests {
        file "tests/helpers.ts";               // files the tests use but no gate runs (fixtures, helpers)
    }

    evaluate "contract-v1" {
        hard shape = Exports("src/bucket.ts", ["Bucket"]);                       // [C1]
        hard dependencies = Imports("src/**", allow = ["src/**"], deny = ["node:*"]);
        hard clock = Forbid("src/**", "Date\\.now|setTimeout", message = "take the time from options.now()");   // [C6]
        hard behavior = Tests("tests/bucket.test.ts", timeout = 30s);
        soft holdout = Tests("tests/holdout.test.ts", hidden = true);
    }
}
```

- `version` is any nonempty string.
- `description` is what the model reads. It is not executed: only gates decide. Write it as numbered clauses,
  `[C1] ... [C2] ...`, each one observable and checkable: the public interface with exact signatures, inputs and
  their units, outputs, every failure case and the error it raises, and what the code may not use. Name
  files by their paths. A clause a test does not check is a clause a run can accept code that ignores.
- Paths in `artifacts` are relative to the flow's `checkout(...)` folder. 1 to 12 `file` lines (or a `files "notes/**";`
  area), at most 12 `frozen`. Extensions: `.js .mjs .cjs .ts .mts .cts .py .c .cc .cpp .cxx .h .hh .hpp .hxx .inl .json
  .html .css .txt .md`. A frozen file must exist in the checkout folder before the run.
- Every declared file must be present and nonempty (an implicit hard gate `artifacts`). TypeScript candidates are also
  type-checked by an implicit soft gate `types`.
- Test paths are relative to the `.lcspec` folder. When tests run, the module's files (at their paths under the
  checkout folder) and the test files (at their paths under the contract's folder) share one folder, so
  `tests/bucket.test.ts` imports `../src/bucket.ts`. A path may appear only once across artifacts, frozen files and
  tests. At most 24 test files, 512 KiB together.
- Exactly one `evaluate "group" { }` with at least one `hard` gate; its name matches the flow's `using "group"`. Use
  `"contract-v1"` for modules checked by these gates. Gate names are unique identifiers.
- `hard` gates decide: any hard Fail is Fail; else any hard Unknown is Unknown; else Pass. `soft` gates are reported
  and fed back but never block acceptance.

### Gates

| Gate | Passes when |
| --- | --- |
| `Tests("a.test.ts" [, "b.test.ts"] [, timeout = 30s] [, hidden = true])` | At least one test ran and every test passed. One language per gate, by extension. Timeout 1–120 s. |
| `Exports("file", ["Name", ...])` | The file declares or exports each name (TS/JS exports, Python top-level names, C++ classes, functions, `Owner::method`). |
| `Imports("pattern", allow = [...], deny = [...])` | Every import of the model's files that match the pattern avoids `deny` and, with `allow`, matches it. Relative imports are module paths (`./math` in `src/core/a.ts` is `src/core/math`); others as written (`node:fs`, `os`, `<thread>`). `**` any path, `*` within one folder. |
| `Forbid("pattern", "regex" [, message = "..."])` | The regular expression (JavaScript syntax) matches nothing in the model's files, outside comments and strings. |
| `Grounded("REPORT.md" [, min = N])` | Every path a report cites exists (and cited lines are in range), and at least `min` files are cited. For agent reports. |
| `Pass("evaluator-id")` | A registered evaluator passes. Only `"calculator-v1"` has them (`calculator-arithmetic-v1`, `calculator-ui-v1`); any other id is Unknown and can never pass. |

How tests run (always in a sandbox: no network, no home folder, writes only in a temporary folder):

| Files | Runner |
| --- | --- |
| `.ts .mts .js .mjs .cjs` | `node --test`. TypeScript needs Node.js 22.18+ and erasable syntax only (no `enum`, `namespace`, parameter properties); local imports name the `.ts` file. Use `node:test` and `node:assert/strict`. |
| `.py` | Python 3 `unittest`. The shared folder is on `sys.path`: `from src.slug import slugify`. Write for Python 3.9. |
| `.cpp .cc .cxx` | Built as C++20 with every C/C++ source of the module, with sanitizers, then run. Tests include `lc_test.hpp`: `LC_TEST(name)`, `LC_CHECK(expr)`, `LC_CHECK_EQ(a, b)`, `LC_CHECK_NEAR(a, b, eps)`, `LC_CHECK_THROWS(expr)`. Each folder with a header is on the include path. |

The model's files may not import `assert`, `node:test`, `unittest` or `lc_test.hpp`, end the process, define `main()`
in C++, or read the environment variable that signs test results.

`hidden = true` seals a test file: the model never sees it, and its feedback says only how many sealed tests failed.
Use it for a holdout the engineer writes beside the visible tests. Hidden tests are never sent to a cloud model.

## The flow (`.lcflow`)

The flow most modules need: revise each file the model writes, in the contract's order, evaluate keeping the best
candidate, accept on Pass, stop for review on Unknown, else feed the failures back.

```lcflow
implement Bucket using "contract-v1" {
    limit iterations 6, time 20m, cost 0usd;
    policy = "local-files-v1";

    available = await models.list(provider = "llamacpp");
    selected = models.select(available, max_size = 6GiB, prefer = "coder");
    developer = await models.load(selected);

    spec = freeze(Bucket.spec);
    candidate = checkout("generated/Bucket");
    feedback = none;

    while (!accepted(candidate, spec)) {
        candidate = await developer.revise(candidate, spec, feedback, file = "src/clock.ts", format = "source");
        candidate = await developer.revise(candidate, spec, feedback, file = "src/bucket.ts", format = "source");
        evidence = await evaluate(candidate, spec, keep = "best");
        verdict = verify(spec, evidence);
        checkpoint(candidate, evidence, verdict);

        if (verdict.status == Pass) {
            return accept(candidate, evidence);
        }
        if (verdict.status == Unknown) {
            return needs_review(evidence);
        }
        feedback = verdict.violations;
    }
    return unresolved();
}
```

- `limit iterations N, time T [, cost C] [, steps S];` exactly once at the top: iterations 1–32 (every entry into a
  `while` body), time up to `120m`, steps up to 1,000,000 (10,000 by default). Exhausting one ends the run Unresolved.
- `policy` exactly once: `"local-files-v1"` (installed llama.cpp models only), `"cloud-files-v1"` (also providers set
  up in Settings, in a project that allows cloud models), `"agents-v1"` (agents with file tools, see the full guide).
- A cloud model: `policy = "cloud-files-v1";` and `developer = await model("deepseek-flash", provider = "deepseek");`.
  The provider is always a string literal. A cloud model receives the description, frozen files, visible tests and the
  candidate, never hidden tests.
- `models.select(list, max_size = 6GiB, prefer = "coder", id = "exact-id")`: all named arguments optional; `prefer` is a
  preference, `id` is exact; without a limit the larger, higher-bit model wins. `await models.load(selected)`.
- `checkout("folder")`: the project folder the files go to on Apply (no `Synthesis` segment). One per run.
- `revise(candidate, spec, feedback, file = "path", format = "source")` rewrites one declared file (never a frozen one)
  and returns the candidate. Without `file` it visits every file in order. `instruction = "..."` (up to 6,000
  characters) replaces the description for that request: then repeat the interface it needs.
- `await evaluate(candidate, spec, keep = "best")` runs the gates; with `keep = "best"` a worse candidate is set aside
  (hidden gates never count). `verify(spec, evidence)` returns `{status, violations}`.
- Terminal actions are returned directly: `return accept(candidate, evidence);` only inside
  `if (verdict.status == Pass) { }` after `verify`; `return needs_review(evidence);`; `return unresolved();`.
- Variables need no declaration but must be assigned on every path before use (`feedback = none;` before the loop) and
  keep their type. `await` is required for `models.list`, `models.load`, `evaluate` and role methods; write it
  with `model(...)` too.
  No functions, `break`, `try`, imports or object literals. Named arguments use `=` and come after positional ones.

## Trust rules

- Only the engineer's tests decide. A model's own test ideas (`propose_tests`) never run.
- Tests and frozen files are the engineer's: the model reads them and never writes them; a run copies them when it
  starts. Never weaken a test to make a run pass; fix the contract or the code instead, and say so.
- Acceptance proves the gates, not every sentence of the description. Read an accepted candidate's diff before Apply.
- Agents never read a contract or its tests.

## What V1 does not run

`extends`, cross-module imports, formal `interface`/`behavior`/`invariants`/`constraints`/`architecture` sections,
`implies`, `Eventually(...)`, `environment`/`workload`, `soft minimize`, user-defined functions, downloads, and engine
builds (C++ is plain C++20 with the standard library). Such sections are rejected (`SPEC_UNSUPPORTED_SECTION`):
express the architecture with `Exports`, `Imports`, `Forbid` and tests.
