# LC Spec and LC Flow — Language Guide (V1)

This guide documents the language **implemented in Local Cognitive today**, not the broader research proposal. It is intended for people writing contracts and agent workflows by hand in their preferred editor.

An LC program has two authored files:

| File | Purpose |
| --- | --- |
| `ModuleName.lcspec` | Define what the generated module must satisfy: its description, output files, and acceptance gates. |
| `ModuleName.lcflow` | Define how to construct it: select models, assign roles, generate files, evaluate, branch, and repeat. |

LC Flow is an interpreted programming language with variables, expressions, conditionals, and loops. It is **not JSON**, JavaScript, or a shell script. Calls are restricted to the runtime actions documented below.

The generated source code is a candidate implementation. An agent's statement that it has finished is not acceptance evidence.

## Contents

- [Quick start: a complete calculator program](#quick-start-a-complete-calculator-program)
- [Basic syntax](#basic-syntax)
- [LC Spec reference](#lc-spec-reference)
- [LC Flow reference](#lc-flow-reference)
- [Runtime functions](#runtime-functions)
- [Model role methods](#model-role-methods)
- [Multiple roles and a repair loop](#multiple-roles-and-a-repair-loop)
- [Acceptance and run outcomes](#acceptance-and-run-outcomes)
- [Files, editor, and application UI](#files-editor-and-application-ui)
- [Common mistakes](#common-mistakes)
- [V1 boundaries and future language features](#v1-boundaries-and-future-language-features)

## Quick start: a complete calculator program

Create this structure inside a project registered in Local Cognitive:

```text
your-project/
  Synthesis/
    Calculator/
      Calculator.lcspec
      Calculator.lcflow
```

The two filenames, `module` name, and `implement` name must agree. Module names start with an ASCII letter and contain only letters, digits, and underscores, with a maximum of 64 characters. `Synthesis/Name/Name.*` is the recommended layout, but matching `Name.lcspec` / `Name.lcflow` files may also live together at the project root or in a nested source folder. Their containing folder does not have to match the module name.

Alternatively, use **New module** in the application: enter a name, choose **Empty module** or **Calculator example**, and select the parent folder inside your project. The dialog previews both paths before creating `<folder>/<name>/<name>.lcspec` and `.lcflow`. Existing files are never overwritten. The empty template is a neutral starter with a placeholder evaluator and an unresolved flow; it does not automatically load a model or prove a contract.

### 1. Write the contract

Save as `Synthesis/Calculator/Calculator.lcspec`:

```lcspec
module Calculator version "1" {
    target {
        language = JavaScript;
    }

    description = "Build a small dark calculator using plain HTML, CSS, and JavaScript. calculator.js defines a global calculate(a, b, operation) function for numeric +, -, *, /. Division by zero throws Error. index.html has labeled number inputs id=a and id=b, a labeled select id=operation with values + - * /, button id=calculate, button id=clear, and output id=result. Calculate displays the answer or Error; Clear empties both inputs and the result. Link style.css and load a classic calculator.js script at the end of body after all controls, without async/defer. No external dependencies, network access, inline event attributes, modules, or dynamic evaluation.";

    artifacts {
        file "calculator.js";
        file "index.html";
        file "style.css";
    }

    evaluate "calculator-v1" {
        hard arithmetic = Pass("calculator-arithmetic-v1");
        hard ui = Pass("calculator-ui-v1");
    }
}
```

`description` guides the models. The `evaluate` block selects trusted application checks. The description does not automatically become executable assertions.

### 2. Write the generation process

Save as `Synthesis/Calculator/Calculator.lcflow`:

```lcflow
implement Calculator using "calculator-v1" {
    limit iterations 6, time 15m, cost 0usd;
    policy = "local-files-v1";

    available = await models.list(provider = "llamacpp");
    selected = models.select(
        available,
        max_size = 6GiB,
        prefer = "qwen2.5-7b"
    );
    developer = await models.load(selected);

    spec = freeze(Calculator.spec);
    candidate = checkout("calculator");
    feedback = none;

    while (!accepted(candidate, spec)) {
        candidate = await developer.revise(candidate, spec, feedback,
            file = "calculator.js", format = "source",
            instruction = "Write a global calculate(a,b,operation) function with numeric + - * / and throw Error on division by zero. Then wire #calculate click: convert #a.value and #b.value using Number, call calculate, display numeric answer in #result.textContent; catch errors and display Error. Wire #clear click to empty both input values and result text. Do not name a button variable calculate because that would shadow the function. No other behavior is needed.");

        candidate = await developer.revise(candidate, spec, feedback,
            file = "index.html", format = "source",
            instruction = "Write complete HTML with title Calculator. Head links style.css using link rel=stylesheet. Body has label/input type=number id=a, label/input type=number id=b, labeled select id=operation with option values + - * /, button id=calculate, button id=clear, output id=result. End body with exactly one script src=calculator.js. No inline JavaScript, no other scripts. Do not omit the second input or any label.");

        candidate = await developer.revise(candidate, spec, feedback,
            file = "style.css", format = "source",
            instruction = "Write only a tiny dark CSS stylesheet: dark body background, light text, centered main content, spaced labeled inputs, select, buttons and visible result. Use at most 12 rules. No JavaScript, no HTML, no imports, no url resources. Stop after the last closing brace.");

        evidence = await evaluate(candidate, spec);
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

### 3. Run it

1. Install or import a suitable GGUF model through **Models**. This flow does not download models.
2. Open **Synthesis**, select the project workspace, and refresh the module list.
3. Select **Calculator**, resolve any diagnostics, and choose **Run synthesis**.
4. Follow **Agent Activity**, inspect the gate results, and review **Preview** and **Changes**.
5. If accepted, choose **Apply verified patch** to write the files into `your-project/calculator/`.

`max_size` limits the GGUF file size, not parameter count, RAM, or VRAM. `prefer` is a preference, not a requirement: the runtime can choose another eligible installed model. See [model discovery and selection](#model-discovery-and-selection) for strict selection.

The existing [Calculator7B example](../examples/synthesis-calculator/Synthesis/Calculator7B/Calculator7B.lcflow) uses the same focused tasks. Its recorded 7B run passed; the recorded 0.6B and 1.5B runs did not. A syntactically valid flow does not guarantee model success. See the [experiment report](../examples/synthesis-calculator/verification.md).

## Basic syntax

### Names, strings, comments, and punctuation

- Syntax is case-sensitive: `Pass` and `pass` are different names.
- General identifiers use ASCII letters, digits, and underscores, and cannot start with a digit. The application's module naming rule is slightly stricter: no leading underscore.
- Statements and property assignments end with `;`.
- Blocks use `{ ... }`. `if` and `while` always require both parentheses and braces.
- Strings use either double or single quotes. Double quotes are used throughout this guide.
- Strings must stay on one source line. Use `\n` for an embedded newline. Escapes include `\r`, `\t`, `\b`, `\f`, `\\`, `\"`, `\'`, `\/`, and `\uXXXX`.
- Comments use `//` or `/* ... */`. Block comments do not nest.
- There are no template strings, string interpolation, or multiline string literals.

```lcflow
// A line comment.
/* A block comment. */
message = "First line\nSecond line";
label = "Calculator" + " UI";
```

### Values and units

| Kind | Examples |
| --- | --- |
| String | `"calculator.js"`, `'llamacpp'` |
| Number | `0`, `42`, `0.25`, `1e3`, `-2` |
| Boolean | `true`, `false` |
| No value | `none` or `null` |
| Array | `["src/api.js", "README.md"]` |
| Duration | `250ms`, `30s`, `15m`, `2h` |
| Byte size | `128B`, `64KiB`, `512MiB`, `6GiB` |
| Cost | `0usd`, `2.5usd` |

Units attach directly to numbers: `15m`, not `15 m`. `GB`, `MB`, `min`, and `USD` are not recognized units. Duration and size values are normalized internally to milliseconds and bytes. The compiler distinguishes numbers, durations, byte sizes, and costs; it is not a general dimensional-analysis system.

Arrays can be passed to actions and expose `.length`. V1 has no array indexing, array mutation methods, object literals, or destructuring. Runtime records expose only documented fields.

### Expressions and precedence

Operators, from highest precedence to lowest:

| Level | Operators |
| --- | --- |
| Member access and calls | `selected.id`, `verify(spec, evidence)` |
| Unary / await | `!`, unary `-`, unary `+`, `await` |
| Multiplication | `*`, `/`, `%` |
| Addition | `+`, `-` |
| Ordered comparison | `<`, `<=`, `>`, `>=` |
| Equality | `==`, `!=` |
| Logical AND | `&&` |
| Logical OR | `\|\|` |

Parentheses override precedence. Binary operators associate left to right within a level. `&&` and `||` short-circuit and require booleans. Equality does not coerce types. `+` also concatenates two strings; it does not automatically convert numbers into strings.

```lcflow
attempt = 1;
attempt = attempt + 1;
retry = attempt < 4 && !(attempt == 0);
delay = 500ms + 1s;
double_delay = delay * 2;
```

Use matching quantity types for addition and comparisons. Quantities may be multiplied or divided by a plain number on the right. V1 does not derive new unit dimensions; do not use it for physical-unit algebra.

## LC Spec reference

### Module header

The header is `module Name version "version-string" { ... }`. `system` is accepted as an alias for `module`.

The version must be a nonempty string. It is authored metadata, not a package resolver or automatic migration mechanism.

### `target`

The current application accepts only `language = JavaScript;`, with `Javascript` and `JS` as aliases. Omitting `target` is also allowed.

Target fields use scalar values or bare identifiers, not expressions, arrays, or unit quantities. Additional targets such as `engine = UnrealEngine;` and `language = Cpp;` require an adapter and are rejected by the current compiler configuration.

### `description`

Use `description = "...";` for the module's requirements and public behavior. Describe observable results, input/output conventions, and failure cases clearly.

This field is natural-language model context, not a proof system. A requirement is only independently checked when a trusted evaluator implements it.

### `artifacts`

Declare each generated file with `file "relative/path.ext";` inside `artifacts { ... }`. Paths are relative to the flow's `checkout(...)` directory, not to the `Synthesis` directory.

For example, `file "calculator.js";` combined with `checkout("calculator")` produces `<project>/calculator/calculator.js` after Apply.

The runtime allows 1–12 declared files, with lowercase `.js`, `.html`, `.css`, `.txt`, or `.md` extensions. Files cannot be added outside this list by a model. Paths must also satisfy the [project path restrictions](#project-path-restrictions). These limits, and the flow's iteration and time limits, are reported as diagnostics when the module is listed or refreshed (`SPEC_ARTIFACT_LIMIT`, `SPEC_ARTIFACT_TYPE`, `SPEC_ARTIFACT_PATH`, `FLOW_LIMIT_RANGE`), so a module that Run would refuse is never shown as valid.

Every declared file is part of the contract: a candidate missing one, or with an empty one, fails an implicit hard gate named `artifacts` even when every declared gate passes. A run cannot be accepted with part of its files.

### `evaluate`

There must be exactly one acceptance group. Its name must match `using "..."` in the flow. At least one gate must be `hard`.

Gate syntax:

```text
hard gate_name = Pass("registered-evaluator-id");
soft gate_name = Pass("registered-evaluator-id");
```

- `gate_name` is an identifier used in diagnostics and evidence; gate names must be unique.
- `Pass(...)` declares a required evaluator result. It is not a function you implement in the flow.
- `hard` gates determine acceptance. Any hard Fail produces Fail; otherwise any hard Unknown produces Unknown; otherwise the verdict is Pass.
- `soft` gates are evaluated and reported but do not prevent acceptance, including when they return Fail or Unknown. Their non-Pass messages still appear in `verdict.violations`.

The built-in acceptance group is `"calculator-v1"`, with these evaluator IDs:

| ID | What it checks |
| --- | --- |
| `"calculator-arithmetic-v1"` | The global `calculate(a, b, operation)` function, arithmetic cases, and division-by-zero behavior. |
| `"calculator-ui-v1"` | Required HTML controls, labels and resources, script placement, and interactions in a bounded semantic DOM harness. |

These checks are provided by the application, not generated by the developer model. The UI harness is not a full browser or visual-quality test. A different group name or an unregistered evaluator ID returns Unknown at runtime (and the module shows a `SPEC_EVALUATOR_UNREGISTERED` warning); changing a string does not install a new evaluator.

`environment`, `workload`, and `soft minimize Mean(...)` from the research examples are **not executable V1 features**.

## LC Flow reference

### Header, policy, and limits

The header is `implement Name using "acceptance-group" { ... }`. Both names must match the contract.

Every flow must declare exactly one top-level policy assignment and one top-level budget declaration:

```lcflow
limit iterations 6, time 15m, cost 0usd;
policy = "local-files-v1";
```

`iterations` and `time` are required; `cost` is optional. Put these declarations first for readability.

- `iterations` must be a positive integer, at most 32 in the application. It counts **all entries into all `while` bodies across the run**, including nested loops. It does not count model calls.
- `time` must be a positive duration, at most `120m`. It covers the whole executing flow, including model loading.
- `cost` must be a nonnegative USD quantity. The current provider is local-only, with no metered API charge. This field is not a limit on electricity, memory, tokens, or cloud spending; cloud calls are unavailable.
- There is also a runtime ceiling of 10,000 interpreter steps; it is not configurable in DSL.

Exhausting a budget ends the run as Unresolved. It does not jump to code after the loop. To return earlier, use a condition or `return unresolved();` inside the body.

`local-files-v1` permits installed built-in llama.cpp models, confined project reads, and declared candidate artifacts. It does not grant shell commands, downloads, network tools, or arbitrary filesystem access.

### Variables and control flow

Assignment creates or updates a variable. There is no `let`, `var`, `const`, or explicit type annotation.

```lcflow
counter = 0;

while (counter < 3) {
    counter = counter + 1;
    if (counter == 1) {
        continue;
    } else if (counter == 2) {
        checkpoint(candidate);
    } else {
        return unresolved();
    }
}
```

Variables must be assigned before use on every control-flow path. Initialize values such as `feedback = none;` before a loop when needed. Do not depend on a variable created only inside a loop being available after it. Reassignments normally retain the variable's inferred type; `none` can be used as an initial placeholder.

`continue;` skips the remainder of the innermost loop iteration. There is no `break`, `for`, `switch`, `try/catch`, user-defined function, import, or recursion.

### Calls and `await`

Call arguments can be positional or named. Named arguments use `=`, not `:`. Positional arguments must precede named ones. Repeated or unknown named arguments are errors. Trailing commas are accepted in calls and arrays.

```lcflow
selected = models.select(available, max_size = 6GiB, prefer = "qwen2.5");
developer = await models.load(selected);
```

`await` is required for `models.list`, `models.load`, `evaluate`, and every model role method. `model("exact-name")` also loads a model, but its current compiler signature allows omission of `await`; using `await model(...)` is valid and clearer.

Statements execute in order. `await` is not a facility for spawning background agents, and V1 has no authored parallel blocks. Call model methods through a variable such as `developer.revise(...)`, not a chained expression such as `models.load(selected).revise(...)`.

### Exposed fields

| Value | Readable fields |
| --- | --- |
| Module name | `Calculator.spec` |
| Selected model | `.id`, `.displayName`, `.providerId`, `.sizeBytes` |
| Model list or ordinary array | `.length` |
| Candidate | `.id`, `.path`, `.hash` |
| Evidence | `.status` |
| Verdict | `.status`, `.violations` |
| Review | `.notes`, `.violations` |

These are read-only from DSL: `candidate.path = "...";` is not valid. Evidence contains more detail in the UI/API, but arbitrary evidence fields are not accessible in the language. Treat candidate, evidence, frozen spec, and model roles as runtime handles, not objects you can construct yourself.

Status constants include `Pass`, `Fail`, `Unknown`, `Blocked`, `Unresolved`, and `NeedsReview`. The current evaluator returns only the first three. Keep evaluator verdicts separate from overall run outcomes.

## Runtime functions

In signatures below, `[argument]` means an optional positional argument. The brackets are documentation notation, not syntax to paste into a call.

### Model discovery and selection

| Function | Meaning |
| --- | --- |
| `await models.list(provider = "llamacpp")` | Return installed local models. `provider` is optional and defaults to `"llamacpp"`; no other provider is allowed. |
| `models.select(available, max_size = 6GiB, prefer = "qwen2.5-7b", provider = "llamacpp")` | Select a model from the returned list. All named arguments are optional. |
| `await models.load(selected)` | Load the selected model and return a model role handle. |
| `await model("exact-installed-id-or-display-name")` | Find and load a specific installed local model, returning a role handle. |

Selection works as follows:

1. Keep eligible models from the supplied runtime list.
2. If `max_size` is provided, require a known positive GGUF size no larger than the limit.
3. Prefer a case-insensitive substring match in the model ID or display name.
4. Sort remaining ties by smaller file size, then by model ID.

No eligible model is a runtime error, not `none`. Without a size limit, a model with unknown size can remain eligible. To require a specific model, use its exact installed ID with `model(...)`; do not rely on `prefer` as an exact match. There is no download or cloud fallback.

### Contract and workspace

| Function | Meaning |
| --- | --- |
| `freeze(Calculator.spec)` | Return the current run's frozen contract handle. Runs already snapshot both authored source files at launch. |
| `checkout("calculator")` | Create the run's candidate from the current declared files under this project-relative output directory. Only one checkout is allowed per run. |
| `inspect(["README.md", "src/api.js"])` | Read up to 12 explicit project-relative text files as context. No directory traversal, globs, or recursive directory scan. Each file is limited to 24,000 bytes. |

`checkout` is not Git checkout and does not create a branch or modify project files. Candidate revisions are stored separately until the user applies them. Existing declared output files become the baseline; absent files begin empty.

### Evaluation and lifecycle

| Function | Meaning |
| --- | --- |
| `await evaluate(candidate, spec [, tests])` | Run the contract's registered trusted evaluators and return evidence. `supplemental = tests` is an alternative named argument. Generated test suggestions are currently **not executed**. |
| `verify(spec, evidence)` | Validate evidence freshness and return `{status, violations}` as a runtime record. Stale evidence is a runtime error. |
| `accepted(candidate, spec)` | Read acceptance state; this does not evaluate the candidate. In the usual repair loop, successful termination happens through `return accept(...)`. |
| `checkpoint(value [, ...])` | Save the current run record and candidate snapshot. Takes 1–8 values. V1 does not separately serialize each argument as an arbitrary user checkpoint variable. |
| `merge(value [, ...])` | Combine 1–8 feedback values, flattening arrays one level and removing `none` values. |
| `stagnant(count)` | True when the last `count` evaluations have identical gate IDs, statuses, and messages, and the latest result is not Pass. Use a positive integer. This is not a code-quality or semantic-progress metric. |

### Terminal actions

Terminal actions must be returned directly:

```lcflow
if (verdict.status == Pass) {
    return accept(candidate, evidence);
}
if (verdict.status == Unknown) {
    return needs_review(evidence);
}
return unresolved();
```

- `accept(candidate, evidence)` requires fresh trusted Pass evidence for the current candidate and a compiler-recognized Pass guard.
- `needs_review(evidence)` requires fresh evidence and ends the run for human review. It does not automatically send a message to another agent or create a task.
- `unresolved()` ends without acceptance. An optional string argument is accepted syntactically, but V1 does not persist it as a reason; do not rely on it for reporting.

Use the explicit pattern `if (verdict.status == Pass) { return accept(...); }`, where `verdict` came from `verify`. The compiler also recognizes the reversed comparison and a Pass comparison inside `&&`; it does not prove equivalent arbitrary boolean expressions. Runtime freshness checks still apply even after the static guard check.

`result = accept(...);`, bare `accept(...);`, `return true;`, and `return;` are invalid. Falling off the end of a valid flow yields Unresolved; an explicit terminal return is clearer.

## Model role methods

A role is a variable holding a loaded model. Names such as `architect`, `developer`, `tester`, and `reviewer` are conventions, not special keywords or separately configured model aliases.

### `revise`: generate candidate files

Typical signatures:

```text
await developer.revise(candidate, spec)
await developer.revise(candidate, spec, feedback)
await developer.revise(candidate, spec, design, feedback)
```

All return the candidate handle. Optional named arguments:

| Argument | Meaning |
| --- | --- |
| `file = "calculator.js"` | Revise only this declared artifact. Without `file`, visit all declared artifacts in declaration order, one generation request per file. |
| `format = "source"` | Request raw complete file source, optionally enclosed in one complete code fence. |
| `format = "json"` | Default model-response format: an object with a `content` string. This is an internal output protocol, not the authored DSL format. |
| `instruction = "..."` | A focused file task, at most 6,000 characters. |

Revisions replace the whole selected file in the candidate; they are not patches. An invalid generation leaves that file's previous candidate content unchanged and adds feedback. Every revision invalidates earlier acceptance evidence, so evaluate again before accepting.

When `instruction` is supplied and nonempty, it replaces the full description and peer-file excerpts in that generation prompt. The model still receives the current file and bounded feedback. Include the relevant interface and integration requirements in the focused instruction. Trusted evaluation still uses the whole contract's registered gates.

V1 uses bounded prompts and responses; it is not a general coding agent with shell or repository tools. Generation settings such as token limit and temperature are currently runtime-controlled, not DSL arguments.

### Advisory methods

| Method | Result and purpose |
| --- | --- |
| `await architect.propose(spec [, context])` | A textual design proposal. |
| `await architect.reconsider(spec, design [, evidence [, feedback]])` | A revised textual design. |
| `await tester.propose_tests(spec [, candidate])` | Textual test suggestions, not executable trusted tests. |
| `await reviewer.inspect(candidate, design [, evidence])` | A review record with `.notes` and `.violations`. Currently the response is placed in notes and violations is empty. |

Advisory calls receive bounded context and candidate excerpts. They do not modify the candidate or grant acceptance. Different variable names do not ensure model independence: to use a different reviewer model, load a different installed model explicitly.

## Multiple roles and a repair loop

This alternative complete flow works with the quick-start `Calculator.lcspec`. It demonstrates advisory roles and stagnation handling, not a stronger success guarantee. It uses one model for all roles and the default JSON response protocol for revision; the focused source-format quick start is the tested 7B path.

```lcflow
implement Calculator using "calculator-v1" {
    limit iterations 6, time 15m, cost 0usd;
    policy = "local-files-v1";

    available = await models.list(provider = "llamacpp");
    selected = models.select(available, max_size = 6GiB,
        prefer = "qwen2.5-7b");
    developer = await models.load(selected);
    architect = developer;
    tester = developer;
    reviewer = developer;

    spec = freeze(Calculator.spec);
    candidate = checkout("calculator");
    context = inspect([]);
    feedback = none;
    design = await architect.propose(spec, context);

    while (!accepted(candidate, spec)) {
        candidate = await developer.revise(candidate, spec, design, feedback);
        tests = await tester.propose_tests(spec, candidate);

        // Test suggestions are advisory. Registered evaluators decide.
        evidence = await evaluate(candidate, spec, supplemental = tests);
        review = await reviewer.inspect(candidate, design, evidence);
        verdict = verify(spec, evidence);
        checkpoint(candidate, evidence, verdict);

        if (verdict.status == Pass) {
            return accept(candidate, evidence);
        }
        if (verdict.status == Unknown) {
            return needs_review(evidence);
        }

        feedback = merge(verdict.violations, review.notes);
        if (stagnant(3)) {
            design = await architect.reconsider(spec, design, evidence, feedback);
        }
    }

    return unresolved();
}
```

Replace `inspect([])` with specific project files if context is needed. Use a loaded role variable for each model; there is no per-role configuration block or parallel agent execution syntax yet.

## Acceptance and run outcomes

The normal cycle is:

```text
revise candidate -> evaluate registered gates -> verify evidence
                                                  |
                       Pass -> return accept      |
                    Unknown -> return needs_review
                       Fail -> feedback -> next iteration
```

Evidence is bound to the exact candidate file contents, frozen specification, and evaluator version. Editing the candidate invalidates earlier evidence. Model reviews and generated test ideas cannot substitute for trusted gate results.

| Run outcome | Meaning |
| --- | --- |
| Accepted | The flow returned valid acceptance with fresh passing hard-gate evidence. Files are still not applied automatically. |
| Needs review | The flow returned `needs_review(...)`, commonly because a hard gate was Unknown. |
| Unresolved | The flow returned `unresolved()`, ended without a terminal result, or exhausted a budget. |
| Blocked | A runtime action failed, for example because no model matched or a forbidden path was used. |
| Cancelled | The run was stopped by the user. |
| Interrupted | Execution was interrupted by runtime shutdown/restart. |

The UI may also show Queued and Running while work is in progress. `Fail` is a gate/verdict result, not the final run state for an exhausted repair loop.

Acceptance proves the implemented checks, not every sentence in `description`, visual quality, or production readiness. Review generated code and use additional project-specific validation as appropriate.

## Files, editor, and application UI

Edit the two DSL files in any editor. **Open in editor** opens the project/module externally; the application supplies read-only source views and diagnostics rather than a full IDE.

With a paired server selected, the screen shows that server's projects (those made from a device in its shared folders), runs on its models, and applies to its folders. Its sources are edited on the server; **Open in editor** and the candidate preview are not offered there.

**+ Project** registers an existing project folder and selects it. Selecting a project or pressing **Refresh** discovers matching DSL files recursively, without importing or copying them. **New module** creates new files and is separate from discovery. The list displays source paths, so equally named modules in different folders remain distinct; existing conventional modules retain their run-history identity. Moving a module to a different path changes its identity. Historical run records are not imported from another application data directory.

Discovery includes the root and up to 12 folder levels. It skips hidden folders, symlinks, paths outside the supported naming rules, and dependency/build folders (`node_modules`, `dist`, `build`, `release`, `coverage`, `vendor`, `target`, `Binaries`, `Intermediate`, `DerivedDataCache`). A scan stops with an explicit error above 20,000 entries or 100 modules; choose a more specific project root in that case. An incomplete pair appears with a source-read diagnostic, rather than being silently accepted. New-module folder selection is restricted to discoverable locations.

Saved changes are read on Refresh and compiled again on Run. Starting a run freezes both source files. Changes saved while a run is executing affect the next run, not the current one. Use the run snapshot view to inspect the sources behind historical results.

**Restart from snapshot** is available for unsuccessful or interrupted runs. It creates a new run from the saved DSL, reads the current project's output files as the new baseline, and starts from the beginning. It does not resume at the last statement or restore arbitrary DSL variables from a checkpoint.

**Apply verified patch** is separate from `accept(...)`. It writes accepted candidate files only after checking that the project baseline has not changed. A conflict requires review and another run; acceptance is not permission to overwrite unrelated edits.

### Project path restrictions

- Paths are project-relative and use `/`, never absolute paths or backslashes.
- No `.` or `..` segments, hidden names, `node_modules`, or symlink components.
- Each segment starts with an ASCII letter, digit, underscore, or hyphen; subsequent characters may also include dots. Spaces are not accepted in DSL-relative paths.
- The whole relative path is at most 240 characters.
- `checkout` cannot target a path with a `Synthesis` segment, protecting authored DSL files.
- Source files read by the application and each candidate artifact are limited to 128 KiB. The standalone parser has a separate 256 KiB source-length guard, but the application read limit is stricter.
- A project exposes at most 100 Synthesis modules, and at most two Synthesis runs may execute concurrently.

## Common mistakes

| Symptom or diagnostic | What to change |
| --- | --- |
| Module not discovered | Save `Name.lcspec` and `Name.lcflow` together in a discoverable project folder, match the declared module name, select the right workspace, and Refresh. Check Hidden modules if you previously removed it from view. |
| `FLOW_MODULE` / `FLOW_EVALUATOR` | Match the spec module and acceptance-group names in the flow header. |
| `FLOW_AWAIT_REQUIRED` | Add `await` before the asynchronous action. |
| `FLOW_UNDEFINED_NAME` | Assign the variable before use on every path; initialize loop feedback before the loop. |
| `FLOW_ASSIGNMENT_TYPE` | Do not reuse a variable for an unrelated value type. |
| `LEX_UNIT` | Use `GiB`, `MiB`, `m`, or `usd`, with exact spelling and no separating space. |
| `FLOW_POLICY` | Declare `policy = "local-files-v1";` exactly once at the top level. |
| `FLOW_ACCEPT_GUARD` | Put `return accept(...)` inside `if (verdict.status == Pass)` after `verify`. |
| `FLOW_TERMINAL_RETURN` | Return terminal actions directly; do not assign or invoke them as standalone statements. |
| `FLOW_UNKNOWN_CALL` | Use registered calls only. There is no `unreal.build`, `analyze`, `shell`, or `getAllModels` intrinsic. Use `models.list`. |
| `SPEC_UNSUPPORTED_SECTION` / `SPEC_UNSUPPORTED_TARGET` | The requested domain semantics need a trusted adapter; adding prose or a new section name does not implement it. |
| No installed model matches | Import an eligible GGUF or change selection. `prefer` does not download a model. |
| Unknown evaluator result | The group/ID is not registered. Use a supported evaluator or implement a trusted adapter in the application. |
| Stale evidence | Re-run `evaluate` and `verify` after the last candidate revision. |
| Apply conflict | Project output changed since checkout. Review the changes and start a new run. |

## V1 boundaries and future language features

The research syntax is broader than this implementation. The following are **not executable in the current application**:

- Contract inheritance with `extends`, or cross-module imports/dependency resolution.
- Formal `interface`, `behavior`, `invariants`, `constraints`, and `architecture` sections.
- Formal `implies`, `Eventually(...)`, lifecycle, latency, or throughput requirements.
- Unreal/C++ targets, build actions, static analysis actions, or multiplayer evaluators.
- Evaluation environment/workload selection and numeric optimization objectives such as `soft minimize Mean(...)`.
- User-defined functions, custom runtime actions declared in DSL, general object manipulation, or parallel agent orchestration.
- Executing model-proposed tests or registering new trusted evaluators from a DSL file.
- Model downloads, cloud providers, arbitrary tools, or host shell access.

The parser preserves some research-style sections as source, but the compiler rejects unsupported semantics. **Parseable does not mean executable or verified.** Do not present an Ability System contract as supported until its target adapters and trusted evaluators exist.

To extend the implementation, the primary sources are:

- [Lexer and units](../src/synthesis/language/Lexer.ts)
- [Parser and syntax](../src/synthesis/language/Parser.ts)
- [Semantic checks and call signatures](../src/synthesis/language/semanticAnalyzer.ts)
- [AST interpreter](../src/synthesis/Interpreter.ts)
- [Runtime capabilities](../src/synthesis/SynthesisService.ts)
- [Trusted evaluators](../src/synthesis/evaluators.ts)

For running the supplied experiments, see the [calculator README](../examples/synthesis-calculator/README.md).
