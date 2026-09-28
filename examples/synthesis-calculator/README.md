# Local Cognitive Synthesis calculator

For syntax and authoring instructions, see the [LC Spec and LC Flow language guide](../../docs/lc-language.md).

Authored programs are under `Synthesis/Calculator/` (tiny-model experiment, 2 GiB cap) and `Synthesis/Calculator7B/` (7B reference, 6 GiB cap).
There is no hand-written calculator implementation: `calculator-7b/` contains the exact output of the accepted real 7B run, applied through the UI. See [verification.md](verification.md) for both successes and failures.

## In the application

1. Add this directory as a project, then open **Synthesis** in the main navigation.
2. Select its workspace and Calculator7B module (or Calculator for the tiny-model experiment). Use **Open in editor** for your IDE.
3. Inspect the contract and flow. The flow enumerates installed models, selects one by size/preference, loads it and executes a bounded repair loop. Per-file `instruction` and `format = "source"` keep the actual generation tasks small; these are authored in DSL, not baked-in code solutions.
4. Click **Run synthesis**. Activity shows model loading, file generation, iterations and trusted gates.
5. Inspect **Preview**, **Changes**, evidence and the model identity. Only **Apply verified patch** writes the candidate to the declared checkout (`calculator/` or `calculator-7b/`). Use **Run snapshot** to inspect the exact contract/flow behind historical evidence.

Saved IDE changes are read by Refresh and recompiled on every Run. Syntax errors include file, line and column. No embedded full editor is required. **New module** creates a named empty starter or calculator template in a chosen project folder; it does not import old experiment histories. Matching externally authored DSL files are discovered automatically on project selection and Refresh, including in nested source folders.

## Reproducible local-model run

Build the app, then use an existing GGUF (nothing is downloaded):

```sh
npm run build
node scripts/run-synthesis-demo.cjs --module Calculator7B --model-path /absolute/path/qwen2.5-7b-instruct-q4_k_m.gguf --serve
```

The demo uses isolated settings under `.tmp/synthesis-demo/`, imports a copy of the selected GGUF, disables remote providers, and serves `http://127.0.0.1:4317/#/synthesis`. Its report contains the real model ID, token usage, events, evaluator verdicts and candidate changes. It never applies the candidate automatically. Without `--serve`, it exits after the run and returns a nonzero exit code for non-acceptance.

For a clean synthesis experiment, copy only `Synthesis/` to an empty directory and pass that directory with `--project`; otherwise the existing generated files become the next run's baseline. To test 0.6B/1.5B, use `--module Calculator` and the corresponding GGUF. The UI's new calculator template defaults to the tested focused flow preferring 7B. Edit selection in the flow to suit your installed models; model size does not guarantee correctness.

An opt-in automated real-model test is also available: `SYNTHESIS_MODEL_PATH=/absolute/path/model.gguf node --test dist/test/synthesis-local-model.integration.test.js`. It uses the tiny Calculator module and intentionally fails if the model cannot meet the contract. Ordinary test runs skip native inference.

## Scope and honesty of acceptance

- LC Flow is parsed into an AST and interpreted: assignments, expressions, units, `await`, `if/else`, `while`, `continue`, `return`, role methods and runtime calls. It is not JSON and does not execute host JavaScript.
- V1's `local-files-v1` policy permits installed built-in llama.cpp models and declared artifact generation only. No shell, unrestricted tools, downloads or cloud fallback. `max_size` is GGUF file size, not parameter count; local inference has zero metered API cost, not zero electricity cost.
- Roles can propose/reconsider/review; advice and generated test suggestions are **not** trusted acceptance evidence. The application supplies trusted calculator evaluators.
- Arithmetic is checked in memory/time-bounded QuickJS WASM with no host bindings. UI checks exercise a fixed semantic DOM harness. The app also provides an opaque-origin, network-restricted preview. A semantic harness is not a complete browser/layout test.
- A Pass is bound to the exact candidate bytes, frozen contract and evaluator version. It proves those registered checks, **not arbitrary natural-language requirements**. Unsupported Unreal/architecture/invariant sections produce diagnostics until a trusted adapter exists.
- Failed checks go back into the model loop. Missing evaluators give Unknown. Budgets give Unresolved; runtime failures give Blocked. Restart creates a **new** run from frozen DSL, checking out the current project baseline; it is not a program-counter resume. Old runs remain immutable history.
- Apply refuses stale/conflicting project files and symlink paths. The candidate tree is isolated in the run record until Apply.

This calculator is a small-model feasibility test, not proof that a 1.5B model can synthesize a full Unreal Ability System. That requires target-specific build/runtime evaluators and research across progressively larger contracts.
