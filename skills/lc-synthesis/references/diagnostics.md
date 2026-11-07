# Diagnostics and their fixes

Every problem the check reports has a code. Fix errors before anything else: a module with an error never runs.
Warnings do not block a run but usually mean a clause or gate does less than intended.

## Reading and size

| Code | Fix |
| --- | --- |
| `SOURCE_READ` | Both `Name.lcspec` and `Name.lcflow` must exist side by side and be readable, at most 128 KiB each. |
| `SOURCE_TOO_LARGE` | A DSL file is at most 256 KiB (the app reads at most 128 KiB): shorten the description or split the module. |
| `MODULE_NAME` | The file name, `module Name` and `implement Name` must be the same name: an ASCII letter, then letters, digits and `_`, at most 64. |

## Lexical

| Code | Fix |
| --- | --- |
| `LEX_CHARACTER` | Remove the character: only ASCII punctuation the language uses is allowed outside strings and comments. |
| `LEX_UNTERMINATED_STRING` | Close the string on the same line. |
| `LEX_STRING_NEWLINE` | A string stays on one line: write `\n` for a line break inside it. |
| `LEX_ESCAPE` | Use a valid escape: `\n \r \t \b \f \\ \" \' \/` or `\u` with four hex digits. A regex backslash is written `\\`. |
| `LEX_NUMBER` | Write a complete number: digits after an exponent (`1e3`). |
| `LEX_UNIT` | Use a known unit with no space: `ms s m h`, `B KiB MiB GiB`, `usd` (not `min`, `GB`, `MB`, `USD`). |
| `LEX_UNTERMINATED_COMMENT` | Close the `/* */` comment; block comments do not nest. |
| `LEX_TOKEN_LIMIT` | A DSL file holds fewer than 16,384 tokens: shorten it. |
| `PARSE_SYNTAX` | The message says what was expected where: usually a missing `;`, `{`, `}`, `)` or a misspelled keyword. |

## Contract (`.lcspec`)

| Code | Fix |
| --- | --- |
| `SPEC_VERSION` | Give the module a nonempty version string: `module Name version "1" {`. |
| `SPEC_EVALUATOR` | Add one `evaluate "contract-v1" { ... }` block with the gates. |
| `SPEC_EVALUATE_COUNT` | Keep exactly one `evaluate` block. |
| `SPEC_HARD_GATE` | Mark at least one gate `hard`: only hard gates decide acceptance. |
| `SPEC_EVALUATOR_ID` | `Pass("...")` needs a nonempty evaluator id. Prefer `Tests`, `Exports`, `Imports`, `Forbid`. |
| `SPEC_EVALUATOR_UNREGISTERED` (warning) | `Pass(...)` with an id no evaluator has can never pass. Replace it with `Tests(...)` and the other built-in checks. |
| `SPEC_GATE_EXPRESSION` | A gate is `hard name = Tests(...)`, `Exports(...)`, `Imports(...)`, `Forbid(...)`, `Grounded(...)` or `Pass("id")`, with the arguments the message names. |
| `SPEC_DUPLICATE_GATE` | Give each gate its own name. |
| `SPEC_DUPLICATE_SECTION` | Keep one of each section (`target`, `description`, `artifacts`, `tests`). |
| `SPEC_DUPLICATE_TARGET` | Set each `target` field once. |
| `SPEC_TARGET_FIELD` / `SPEC_TARGET_VALUE` | `target { language = TypeScript; }`: an identifier or a plain value, no expressions. |
| `SPEC_UNSUPPORTED_TARGET` | `language` is `JavaScript`, `TypeScript`, `Python` or `Cpp`; other target fields (engines, platforms) need an adapter: remove them. |
| `SPEC_UNSUPPORTED_SECTION` | Formal sections (`interface`, `behavior`, `invariants`, `constraints`, `architecture`, …) are not executed: move their content into numbered clauses of the description and enforce them with gates and tests. |
| `SPEC_ARTIFACT_LIMIT` | Declare 1 to 12 `file` lines (or a `files` area), at most 12 areas and 12 `frozen` files. |
| `SPEC_ARTIFACT_PATH` | Paths are relative, with `/`, no spaces, no hidden folders, no `.` or `..`, no `node_modules`, at most 240 characters. |
| `SPEC_ARTIFACT_TYPE` | Use a supported extension: `.js .mjs .cjs .ts .mts .cts .py .c .cc .cpp .cxx .h .hh .hpp .hxx .inl .json .html .css .txt .md`. |
| `SPEC_DUPLICATE_ARTIFACT` | Declare each file once. |
| `SPEC_PATH_CONFLICT` | A path appears as two kinds (artifact, frozen, test): they share one folder when tests run, so rename one. |
| `SPEC_CHECK_FILE` | `Exports` names a file the contract declares (`file` or `frozen`). |
| `SPEC_CHECK_SYMBOL` | `Exports` takes names such as `"RateLimiter"` or `"Owner::method"`, not expressions. |
| `SPEC_CHECK_PATTERN` | `Imports` and `Forbid` patterns are nonempty, at most 200 characters; a `Forbid` expression must be a valid JavaScript regular expression (backslashes doubled). |
| `SPEC_TEST_TYPE` | One `Tests` gate runs files of one language: `.ts .mts .js .mjs .cjs` (Node.js), `.py` (Python) or `.cpp .cc .cxx` (C++). |
| `SPEC_TEST_TIMEOUT` | A test timeout is from `1s` to `120s`. |
| `SPEC_TEST_PATH` | Test paths are relative to the contract's folder, with the same rules as artifact paths. |
| `SPEC_TEST_LIMIT` | At most 24 test files, 512 KiB together. |
| `SPEC_TEST_MISSING` | Write the test file at the path the contract names, relative to the `.lcspec` folder (usually `tests/...`). |
| `SPEC_CLAUSE_UNTESTED` (warning) | A numbered clause nothing checks: add a test named after it (`test("[C3] ...")`; in Python a docstring or comment, in C++ a comment above `LC_TEST`) or mark the gate that checks it with `// [C3]`. |
| `SPEC_CLAUSE_UNKNOWN` (warning) | A test names a clause the description does not number: fix the number or add the clause. |

## Flow (`.lcflow`)

| Code | Fix |
| --- | --- |
| `FLOW_MODULE` | `implement Name` must name the contract's module. |
| `FLOW_EVALUATOR` | `using "group"` must match the contract's `evaluate "group"`. |
| `FLOW_POLICY` | Declare exactly one top-level `policy = "local-files-v1";` (or `"cloud-files-v1"`, `"agents-v1"`). |
| `FLOW_POLICY_PROVIDER` | A provider other than `llamacpp` needs `policy = "cloud-files-v1"` (or `"agents-v1"`). |
| `FLOW_POLICY_CAPABILITY` | Agents (`agent`, `files.*`, `parallel_map`, `split`, `synthesize`) need `policy = "agents-v1"`. |
| `FLOW_PROVIDER_LITERAL` | Write the provider as a string: `provider = "deepseek"`, never a variable. |
| `FLOW_ITERATION_LIMIT` / `FLOW_TIME_LIMIT` | Declare `limit iterations N, time T;` with a positive whole number and a duration. |
| `FLOW_LIMIT_RANGE` | At most 32 iterations, `120m` and 1,000,000 steps. |
| `FLOW_LIMIT_UNIT` | Iterations are a plain whole number: `iterations 6`, not `6s`. |
| `FLOW_LIMIT_NAME` | Budgets are `iterations`, `time`, `cost` and `steps`. |
| `FLOW_LIMIT_SCOPE` | Put `limit ...;` at the top level of the flow, not inside a block. |
| `FLOW_DUPLICATE_LIMIT` | Name each budget once in the `limit` line. |
| `FLOW_COST_LIMIT` | Cost is a nonnegative `usd` amount: `cost 0usd`. |
| `FLOW_STEP_LIMIT` | `steps` is a positive whole number. |
| `FLOW_UNKNOWN_CALL` | Use the runtime's actions only (`models.list`, `models.select`, `models.load`, `model`, `freeze`, `checkout`, `inspect`, `evaluate`, `verify`, `accepted`, `checkpoint`, `merge`, `stagnant`, terminal actions, role methods). |
| `FLOW_AWAIT_REQUIRED` | Put `await` before `models.list`, `models.load`, `evaluate` and role methods (`revise`, `propose`, …). |
| `FLOW_AWAIT` | `await` goes only before a runtime action call. |
| `FLOW_ARGUMENT_COUNT` | Pass the number of positional arguments the message names. |
| `FLOW_ARGUMENT_ORDER` | Positional arguments come before named ones. |
| `FLOW_NAMED_ARGUMENT` | Use only the named arguments that action takes (`file`, `format`, `instruction` for `revise`; `max_size`, `prefer`, `id`, `provider` for `models.select`; `keep` for `evaluate`). |
| `FLOW_DUPLICATE_ARGUMENT` | Name each argument once. |
| `FLOW_UNDEFINED_NAME` | Assign the variable on every path before it is read: `feedback = none;` before the loop. |
| `FLOW_ASSIGNMENT_TYPE` | A variable keeps its type: use a new name for a different kind of value. |
| `FLOW_RESERVED_NAME` | Pick another variable name: that one belongs to the language. |
| `FLOW_MEMBER` | Read only documented fields: `.status` and `.violations` of a verdict, `.length` of a list, `.id` of a model or candidate. |
| `FLOW_TYPE` | `!`, `&&` and `\|\|` take booleans; compare with `==` first. |
| `FLOW_INDEX` | Index a list with a whole number: `list[0]`. |
| `FLOW_CONTINUE` | `continue` goes inside a `while` or `for` loop. |
| `FLOW_FOR_VARIABLE` | Give a `for` loop variable a new name; it exists only inside the loop. |
| `FLOW_ACCEPT_GUARD` | Put `return accept(candidate, evidence);` inside `if (verdict.status == Pass) { }`, where `verdict = verify(spec, evidence);`. |
| `FLOW_TERMINAL_RETURN` | Return terminal actions directly: `return accept(...)`, `return needs_review(...)`, `return unresolved()`. |
| `FLOW_RETURN` | A flow returns only `accept(...)`, `needs_review(...)` or `unresolved()`. |
| `FLOW_AGENT_MODEL` | Name an agent's model once: `agent(role, tools = [...])` or `agent(provider = "...", model = "...", tools = [...])`. |
| `FLOW_FILE_PATTERN` | Agent rights take project-relative patterns such as `"src/**"`, without hidden folders or `..`. |
| `FLOW_ANSWER_FILE` | `answer_file` is a path with `{n}`, such as `"review/notes/agent-{n}.md"`, no wildcards. |
| `FLOW_HTTP_TARGET` | `http(allow = [...])` names `https://host[/path]` origins, without credentials, query or fragment. |

## This computer (shown by the app, not by an offline check)

| Code | Fix |
| --- | --- |
| `SYNTHESIS_PROVIDER` | Set the provider and its key up in Settings → Models & Providers. |
| `SYNTHESIS_CLOUD_CONSENT` | Turn on **Cloud models** for the project in the Synthesis workspace (on a server: `sudo local-cognitive-server cloud-models allow <project>`). |
| `SYNTHESIS_WEB_CONSENT` | The project must allow an agent's `http` targets (on a server: `sudo local-cognitive-server web-targets allow <project> <url>…`). |
| `SYNTHESIS_SANDBOX` | Agents' terminals need a sandbox; on Windows a terminal runs only `node`, `npm` and `npx`. |
