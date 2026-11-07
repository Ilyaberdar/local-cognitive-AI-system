---
name: lc-synthesis
description: Write Local Cognitive Synthesis modules — a contract (.lcspec), its flow (.lcflow) and the engineer's tests — that local or cloud models then implement under trusted gates. Use when the user asks to create, draft, fix or review a Synthesis module, a .lcspec or .lcflow file, or to turn a feature description into a contract with tests.
---

# Writing a Synthesis module

A module is a contract (`Name.lcspec`), a flow (`Name.lcflow`) and the engineer's tests next to the contract. In the
Local Cognitive app a run has models write the module's files and accepts them only when the contract's gates pass;
the tests you write here decide what "accepted" means. Read `references/language.md` before writing, and keep
`references/diagnostics.md` at hand for the check's codes.

## Steps

1. **Pin down the module with the user.** Its language (TypeScript, JavaScript, Python or C++), the files the model
   will write and their paths, the public interface with exact signatures, the inputs and outputs, every failure
   case and what it raises, and what the code may not use (clocks, network, packages). Ask when one of these is
   unclear rather than guessing: an ambiguous clause becomes code that passes the tests and does something else.
2. **Lay it out** as `Synthesis/Name/Name.lcspec`, `Synthesis/Name/Name.lcflow` and `Synthesis/Name/tests/...` inside
   the user's project, unless they keep modules elsewhere. Pick the output folder for `checkout(...)` (never inside
   `Synthesis/`). An interface the engineer fixes (a header, a types file) is a `frozen` file in that output folder,
   written by you or the user before the run.
3. **Write the contract.** The description is numbered clauses, `[C1] ... [C2] ...`, each one observable and
   checkable; restate the exact interface in a clause. Declare the files the model writes in dependency order. Add
   gates: `Exports` for the public names, `Imports` for what the files may depend on, `Forbid` for what they may not
   use, and `Tests` for behavior. Mark a gate that checks a clause with a comment, `// [C7]`.
4. **Write the tests**, at least one per clause that a gate does not cover, named after the clause:
   `test("[C3] refuses a fractional request", ...)` in Node.js, a docstring `"""[C3] ..."""` in Python, a comment
   `// [C3]` above `LC_TEST(...)` in C++. Test the edges a careless implementation gets wrong (empty input, zero,
   fractions, limits, the exact error type), deterministically: no network, no real time, no randomness. Import the
   module by its path relative to the test file. Write only visible tests unless the user asks for a sealed holdout;
   a holdout (`hidden = true`) is the engineer's own, written apart from these. Work out every expected value from
   the clauses, step by step: a wrong one is a test no correct code passes, and a run can never be accepted.
5. **Write the flow** from the standard skeleton in `references/language.md`: one `revise` line per file in the
   contract's order, `evaluate(..., keep = "best")`, accept on Pass. Use `policy = "local-files-v1"` with
   `models.select(...)` for installed models, or `policy = "cloud-files-v1"` with `model("id", provider = "name")` for a
   provider the user has set up (the project must allow cloud models). Start with `limit iterations 6, time 20m` for
   one file and more for several.
6. **Try the tests** when you can run code: write a throwaway reference implementation outside the project, run the
   tests against it, and delete it. A test it fails is wrong, or its clause is ambiguous: fix the test, or ask the user.
7. **Check it:** `node scripts/check.mjs Synthesis/Name` (this skill's folder; Node.js 18+), or
   `local-cognitive-server synthesis check Synthesis/Name` on a Local Cognitive server. Each problem is one line,
   `path:line:column severity CODE message`. Fix every error by its code (`references/diagnostics.md`) and re-run until
   the module reads `ok`; treat `SPEC_CLAUSE_UNTESTED` as a missing test, not as noise.
8. **Hand it over.** Tell the user what each clause and test covers, which clauses only a reviewer can judge, and that
   they should read the contract and tests before running: those are theirs now, and a run accepts exactly what they
   check. In the app: Synthesis → select the project → Refresh → the module → Run synthesis.

## Rules

- Never write implementation code into the output folder: the model writes those files during the run. A reference
  implementation, if you make one to try the tests, stays outside the project or is deleted afterwards.
- Never weaken or delete a test to make a run pass. If a test is wrong, say so and fix it with the user.
- Use only what V1 runs (`references/language.md`, last section). Requirements it cannot run go into clauses and are
  checked by tests or left to review, not into new sections.
- Keep `description` on one line (a DSL string cannot span lines) and the whole contract under 128 KiB.

## Examples

Complete modules that pass their gates, in `references/examples/`:

- `typescript-rate-limiter`: one TypeScript file, numbered clauses, `Exports`, `Imports`, `Forbid`, tests per clause.
- `python-slug`: one Python file, an import allow-list, unittest tests per clause.
- `cpp-ability-system`: C++ against a frozen header, with the `lc_test.hpp` framework.
