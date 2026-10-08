# Outbound MCP client manager

The TypeScript backend can connect to external MCP servers through stdio and Streamable HTTP. The existing inbound stdio MCP entrypoint and built-in file/command tools retain their behavior. External servers are configured in **Settings → MCP Servers**, where the app displays connection state and discovered tool count, and can reconnect or disconnect an existing binding.

Once a binding is connected and its tools are discovered, chat and workflow agents receive `mcp.search` and `mcp.call`. The agent must search first and use an exact returned ID and JSON schema. Every `mcp.call` pauses for explicit approval, including tools that label themselves read-only: a third-party MCP schema is not treated as a sufficient safety classification. Calls are journaled, never replayed automatically, and transport interruption leaves the result unknown. Calls to the same binding are serial, which is required by Unreal MCP's game-thread execution model.

This manager remains separate from the in-process plugin loader and `ToolRegistry`: discovery does not register a remote tool as a local compatibility plugin. Instead, the agent loop uses the controlled `mcp.search` and `mcp.call` dispatchers. See [Plugin module: current implementation](plugin-module-current.md) for the separate plugin boundary and the legacy direct Notion plugin path.

The inbound server also provides explicit local GGUF load/unload/status tools and session selection. See [MCP local model control](mcp-local-model-control.md) for the client workflow, process ownership, and the real-model smoke test.

`RuntimeManager` owns one `McpClientManager` for the application lifetime. Each rebuilt `AppRuntime` exposes that same instance as `runtime.mcpClients`. Call `RuntimeManager.dispose()` during shutdown. Direct callers of `buildRuntime` own its `mcpClients` and `localModelService` and must dispose both.

## Configure and invoke a local fixture

Build first with `npm run build:server`. This example belongs in an internal TypeScript caller using the existing application configuration:

```ts
import path from "node:path";
import { AppSettingsStore } from "../src/app/AppSettingsStore";
import { RuntimeManager } from "../src/app/RuntimeManager";
import { config } from "../src/config/config";
import { McpClientError } from "../src/mcp/client";
import { Logger } from "../src/utils/Logger";

const owner = new RuntimeManager(config, new AppSettingsStore(config.appDataDir, config), new Logger());
try {
  await owner.init();
  const { runtime } = await owner.updateSettings({ mcp: { client: {
    servers: { fixture: {
      id: "fixture", enabled: true, transport: "stdio", command: process.execPath,
      args: [path.resolve("dist/test/fixtures/mcpStdio.js")],
      connectTimeoutMs: 10_000, requestTimeoutMs: 30_000,
      reconnect: { maxAttempts: 2, initialDelayMs: 250, maxDelayMs: 5_000 }
    } },
    bindings: { personal: { id: "personal", serverId: "fixture", enabled: true } }
  } } });

  const clients = runtime.mcpClients;
  await clients.connect("personal"); // Reuses the connection established by reconciliation.
  const tools = await clients.discoverTools("personal");
  console.log(tools.map(tool => ({ id: tool.id, name: tool.definition.name })));

  const abort = new AbortController();
  const invocation = await clients.callTool({
    bindingId: "personal", toolName: "sum", arguments: { a: 2, b: 3 },
    runId: "example-run", sessionId: "example-session"
  }, { signal: abort.signal, timeoutMs: 5_000 });
  console.log(invocation.outcome, invocation.result.structuredContent); // success, sum: 5
} catch (error) {
  if (error instanceof McpClientError) console.error(error.code, error.message);
  else throw error;
} finally {
  await owner.dispose();
}
```

The example persists the fixture definition. Remove it afterward with `owner.updateSettings({mcp: {client: {servers: {fixture: null}}}})` before disposing, or disable its binding with `{bindings: {personal: {enabled: false}}}`. Deleting a server also removes its bindings. Patches merge entries by ID and preserve other settings, servers, and inbound `mcp.server` configuration. Invalid updates and failed writes reject. Existing installations receive an empty client configuration; invalid saved settings are reported without replacing them with defaults. Writes are atomic and serialized across store instances in the same process, including runtime settings transactions.

## HTTP and credentials

Use `{id: "remote", enabled: true, transport: "streamable-http", endpoint: "https://example.com/mcp"}` for a remote definition. Create distinct binding IDs for distinct accounts, even when they share that server. Bindings may hold a nonsecret `accountId` and an opaque `credentialRef`. A `McpCredentialProvider` injected through the optional fourth `RuntimeManager` constructor argument resolves transient material:

```ts
const owner = new RuntimeManager(config, store, logger, {
  credentialProvider: {
    async resolve({ binding, signal }) {
      signal.throwIfAborted();
      // vault is an application-provided credential store, not settings.json.
      const token = await vault.read(binding.credentialRef, signal);
      return token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
    }
  }
});
```

For stdio, return `{env: {SERVICE_API_KEY: token}}` instead. Saved `env` values, command arguments and endpoints are for nonsecret configuration only. Common secret environment names and embedded URL credentials are rejected; arbitrary strings cannot be reliably classified as secrets, so callers remain responsible for keeping them out of saved configuration. Credentials are never included in manager diagnostics or activity events. HTTP redirects are rejected to prevent forwarding credential headers to redirected endpoints.

A missing referenced credential or HTTP 401/403 produces `authentication-required`, clears tool availability, and stops automatic retries. After updating the credential provider, call `connect(bindingId)` again. To rotate material on a live connection without changing its reference, disconnect and reconnect. Browser OAuth and token refresh/storage for arbitrary third-party MCP servers remain later milestones; credentials are not accepted in the Settings form.

## Unreal Engine and Blender

- **Unreal Engine 5.8:** enable the experimental **Unreal MCP** and **All Toolsets** plugins, enable Auto Start Server, then add a Streamable HTTP server with endpoint `http://127.0.0.1:8000/mcp` (or the port/path set in Unreal Editor Preferences). `ModelContextProtocol.GenerateClientConfig` is useful to verify the address, but Local Cognitive stores its own connection.
- **Blender:** install and start an MCP-capable add-on/server, choose Streamable HTTP, and enter the endpoint it reports. Blender add-ons do not use a single standard port, so the UI intentionally does not hard-code one. Use stdio instead for a Blender MCP server that documents a launch command.

Both engines should remain local unless the server provides suitable authentication and network controls. Unreal MCP has no authentication by default and is intended for same-machine editor use.

## Lifecycle and errors

- `list()`, `status(bindingId)`, and `tools(bindingId?)` return detached snapshots. Tool IDs combine binding ID and the original server tool name; names and schemas remain unchanged in `definition`.
- `reconcile(config)` validates the whole configuration, automatically connects new or changed enabled bindings, and preserves unchanged connections and active calls. A disconnected binding remains disconnected during unrelated settings changes. Re-enabling, changing its connection configuration, or restarting the application reconnects it. Display-name edits preserve connections.
- `connect` coalesces concurrent attempts. Cancellation of a duplicate waiter ends that wait; it does not cancel the shared attempt. The initiating caller can cancel its attempt. Failed external connections are reported in status without blocking startup of other configured bindings.
- Recovery uses bounded exponential backoff, defaulting to two attempts with 250 ms initial delay and a 5 s maximum. Explicit disconnect, disable, removal, and disposal stop retries. Successful initialization resets the retry count. No invocation is ever automatically replayed.
- Discovery follows pagination and refreshes after supported tool-list notifications. Invalid schemas fail closed. JSON Schema Draft 2020-12 is the default; explicitly declared Draft 7 and 2019-09 are supported. Validation does not coerce arguments or insert defaults; remote schema references are not fetched.
- `callTool` rejects before dispatch for missing/disabled/disconnected bindings, unavailable tools, invalid arguments, or an already aborted signal. Successful protocol results preserve content, structured content, and `isError`. A server's `isError` result has outcome `tool-error`; protocol/transport failures reject with `McpClientError`.
- Cancellation and timeouts request MCP protocol cancellation where supported. An external side effect may already have happened; interruption does not imply rollback. Disable/disconnect abort active calls and clear cached tools.
- `subscribe` emits typed connection, tool availability, and invocation events. Invocation events include call ID, qualified tool identity, duration, outcome and optional run/session references, without arguments, results, or remote error text. These events do not perform model token accounting.

Owned stdio processes receive bounded shutdown and termination through the SDK. This is process management, not an OS sandbox, and the SDK does not manage arbitrary descendants launched by a server. HTTP shutdown attempts bounded session termination and always closes the local transport. Credentials are resolved for each new connection; live credential refresh requires reconnection. Legacy SSE-only servers are not supported.

## Verification

```sh
npm run build:server
node --test dist/test/mcp*.test.js dist/test/runtimeManager.test.js
npm test
```

The tests launch actual SDK stdio and localhost Streamable HTTP fixtures, including separate authenticated sessions, pagination, notifications, cancellations, recovery, settings restart, and shutdown. They also exercise the existing inbound stdio server and built-in tool registration. Localhost listeners must be permitted by the execution environment. Tests use temporary data directories and fixture credentials; they do not require an external MCP account or a model download.

Verified on macOS arm64 with Node 22.18.0 on 2026-09-20: `npm test` built the backend and UI and ran 256 tests, with 255 passing and one existing opt-in llama model test skipped. The pre-change baseline was 216 passing and the same skipped test. Three independent implementation reviews were followed by regression fixes and rechecks for cancellation state, discovery notification timing, process cleanup during initialization (including forced termination), late responses after interruption, and preservation of backend-owned runtime options. Windows and Linux were not exercised in this milestone.

## Implementation map

| Owner | Files and responsibility |
| --- | --- |
| Shared API | `src/mcp/client/types.ts`, `errors.ts`, `index.ts`: saved/live contracts, internal service, credential provider, typed redacted errors and events. |
| Persistence | `src/mcp/client/configuration.ts`, `src/app/AppSettingsStore.ts`, `src/config/config.ts`, `src/types/index.ts`: strict outbound validation, isolated patches, migration defaults and atomic serialized settings transactions. |
| Connections and calls | `src/mcp/client/McpClientManager.ts`, `transports.ts`, `operation.ts`, `schema.ts`: per-binding SDK ownership, lifecycle, discovery, JSON Schema validation and bounded execution. `ExternalMcpExecutor.ts` exposes discovered tools to agents with approval, operation journaling and per-binding serialization. `package.json` and its lockfile add explicit Ajv runtime dependencies. |
| Application lifetime | `src/app/RuntimeManager.ts`, `src/app/buildRuntime.ts`: reuse the owner across rebuilt runtimes, apply relevant configuration, clean up on shutdown. |
| Settings and local API | `public/assets/settings-shell.js`, `settings-data.js`, `src/api/mcpControllers.ts`, `src/api/routes.ts`: create/edit/remove stdio or Streamable HTTP definitions, show redacted live state, and reconnect/disconnect bindings. |
| Verification | `test/mcpClientManager.test.ts`, `mcpConfiguration.test.ts`, `mcpRuntime.test.ts`, `mcpSchema.test.ts`, `mcpTransports.test.ts`, updated `test/runtimeManager.test.ts`, and `test/fixtures/mcpServer.ts`, `mcpStdio.ts`, `mcpHttp.ts`. |
