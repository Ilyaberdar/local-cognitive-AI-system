# Local model control through MCP

The inbound MCP stdio server lets a client load an installed GGUF model, select it for a session, generate a response, and unload it. There is no need to click **Load model** in the UI first. Loading a model into memory and selecting it for a session are separate operations; `selectForSession: true` explicitly combines them.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `local_ai_local_model_status` | `{}` | Installed models and their exact `id` values, compatibility, load state, runtime availability, and queue. |
| `local_ai_load_model` | `{ "modelId": "…", "selectForSession": true, "sessionId": "…" }` | Waits until the model is ready. With `selectForSession: true`, saves it as the specified session's `defaultTarget` after a successful load. |
| `local_ai_unload_model` | `{ "modelId": "…" }` | Frees memory while preserving model files and session selection. A busy model returns `model_busy`. |
| `local_ai_chat` | `{ "input": "Answer briefly: what is 2 + 2?", "mode": "general" }` | Uses the session's selected model and loads it automatically when needed. |

`sessionId` is optional; when omitted, the configured MCP default session is used. `selectForSession` defaults to `false`, so loading alone does not change session settings. Explicit `providerId` and `model` arguments in a chat request take precedence. Mode settings, debate participants, and other sessions remain unchanged.

Call the tools in this order from an MCP client:

```json
{"name":"local_ai_local_model_status","arguments":{}}
```

Use the desired model's `id` from `structuredContent.result.models`:

```json
{"name":"local_ai_load_model","arguments":{"modelId":"ID_FROM_LIST","selectForSession":true}}
```

Once `runtime.status` is `"ready"`:

```json
{"name":"local_ai_chat","arguments":{"input":"Answer briefly: what is 2 + 2?","mode":"general"}}
```

To free memory:

```json
{"name":"local_ai_unload_model","arguments":{"modelId":"ID_FROM_LIST"}}
```

For a one-off call without changing the session, use `local_ai_chat` directly with `providerId: "llamacpp"` and `model: "ID_FROM_LIST"`; the backend loads the installed model automatically.

## Errors and cancellation

Load and preflight failures return `isError: true`, text content, and `structuredContent.result.error` containing `code` and `message`. For example:

```json
{"error":{"code":"model_not_selected","message":"No local model is selected. …"}}
```

An uninstalled model returns `model_not_installed`. An unavailable runtime or library returns `local_runtime_unavailable` with the reason. Generation failures also return `isError: true` while preserving the diagnostic `ProcessResult`. An empty model response is treated as an error.

Loading and generation support MCP cancellation. Cancelling a queued load removes it from the queue without interrupting another active operation. Cancelling an active load or generation stops its native process. A failed load does not select the model for the session. If the client provides a progress token, the server sends progress notifications. For large models, configure the client's tool timeout to allow enough time for loading and generation.

## Startup and the desktop UI's model library

From the repository root:

```sh
npm run build:server
npm run --silent mcp:stdio
```

The MCP client normally launches the second command and communicates with it over stdin/stdout. A regular terminal is not an MCP client. Restart the connection after building so the client discovers the new tools.

Stdio starts a separate runtime that owns its model process; it does not connect to the desktop UI's running backend. To use the same installed library, configure the same `APP_DATA_DIR` (settings and manifests) and `LOCAL_MODELS_DIR` (GGUF files). Relative paths are resolved against the working directory; use absolute paths in the MCP client.

For the default macOS desktop data directory in this installation:

```sh
APP_DATA_DIR="$HOME/Library/Application Support/local-cognitive-ai-system/app" \
LOCAL_MODELS_DIR="$HOME/Library/Application Support/local-cognitive-ai-system/models" \
npm run --silent mcp:stdio
```

If the storage directory was changed in the UI, use the actual path from its settings. Saved settings take precedence over the initial directory value.

Only one runtime may own a data directory at a time (`APP_DATA_DIR/runtime/data-root.lock`). The second process is refused at startup: a stdio server pointed at the data of a running desktop app exits with `[MCP] Bootstrap failed: … already used by desktop …`, and the desktop app shows the same reason if the stdio server started first. Until the MCP server can attach to the running app (Remote plan, stage R2), either quit the desktop application before using its data through stdio, or give the MCP server its own `APP_DATA_DIR`, `SESSION_DIR`, `MEMORY_DIR` and `LOCAL_MODELS_DIR`. A crashed process never leaves a stale lock.

These tools work with installed GGUF models, including any saved vision adapter. Downloading, importing, and deleting model files are not yet exposed through MCP; use Models in the UI to add files. The outbound MCP Client Manager connects to external tools and is a separate part of the system.

## Repeatable test with a real model

```sh
npm run test:mcp-model -- "/absolute/path/model.gguf"
```

For a sharded GGUF, pass every shard as a separate argument. For a custom runtime location, set `LLAMA_RUNTIME_DIR` or `LLAMA_SERVER_PATH`.

The script imports a copy of the file into a temporary library, starts the actual stdio entrypoint, and checks: missing selection → explicit load and selection → readiness → real generation → unload → automatic reload → unknown model ID error → process shutdown. The original library's settings and files are preserved, and no model download is required. The temporary copy is removed after the test. The test verifies the integration and a nonempty response; response quality depends on the selected model.

Verified on this machine on 2026-09-20: SmolLM2-135M-Instruct-Q4_K_M, 105,454,432 bytes, llama.cpp b10809, Metal. Explicit loading took about 435 ms; the first response was `"Hi! How can I help you today?"`. Unloading, generation with automatic reload, missing-selection and unknown-model errors, and MCP process shutdown all passed.

In addition, `npm test` built the backend and UI: 261 tests, 260 passed, 0 failed, and 1 existing opt-in catalog download test skipped. Five new deterministic tests use actual SDK stdio and a controlled native HTTP fixture to also verify active and queued load cancellation, busy-model handling, session isolation, and child-process cleanup. These results are from macOS arm64; Windows and Linux were not exercised in this verification.
