import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ListToolsResultSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { connectTimeoutMs, MAX_CALL_MS, requestTimeoutMs } from "./configuration";
import { McpClientError, safeMcpError } from "./errors";
import { mcpOperation } from "./operation";
import { LocalStdioTransport } from "./stdioTransport";
import { McpConnection, McpConnectionBinding, McpConnector, McpServerDefinition } from "./types";

const HTTP_CLOSE_TIMEOUT_MS = 1_000;

class OwnedHttpTransport extends StreamableHTTPClientTransport {
  private closing?: Promise<void>;
  override close(): Promise<void> {
    return this.closing ??= this.closeOwnedSession();
  }

  private async closeOwnedSession(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Local shutdown remains bounded even when DELETE never receives a response.
      await Promise.race([
        this.terminateSession().catch(() => undefined),
        new Promise<void>(resolve => { timer = setTimeout(resolve, HTTP_CLOSE_TIMEOUT_MS); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      await super.close();
    }
  }
}

function adapterError(error: unknown): McpClientError {
  return error instanceof UnauthorizedError
    ? new McpClientError("authentication_required")
    : safeMcpError(error);
}

/** Owns one SDK client and transport for each account binding. Never retries tool calls. */
export class SdkMcpConnector implements McpConnector {
  async open(
    server: McpServerDefinition,
    binding: McpConnectionBinding,
    options: Parameters<McpConnector["open"]>[2]
  ): Promise<McpConnection> {
    let transport: LocalStdioTransport | OwnedHttpTransport | undefined;
    let closing = false;
    let closed = false;
    let closePromise: Promise<void> | undefined;
    const client = new Client({ name: "local-cognitive-ai-system", version: "0.1.0" }, { capabilities: {} });
    const close = (): Promise<void> => {
      closing = true;
      return closePromise ??= (async () => {
        // Await the owned transport even if the SDK already detached it after failure.
        await transport?.close();
        await client.close();
        closed = true;
      })();
    };
    client.onclose = () => {
      if (closed) return;
      closed = true;
      options.onClose(transport instanceof LocalStdioTransport ? transport.failure() : undefined);
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      if (!closing && !closed && client.getServerCapabilities()?.tools?.listChanged) options.onToolsChanged();
    });

    try {
      return await mcpOperation(options, connectTimeoutMs(server), async (signal, timeoutMs) => {
        const credentials = await options.credentialProvider?.resolve({ server, binding, signal });
        signal.throwIfAborted();
        if (binding.credentialRef && !credentials) throw new McpClientError("authentication_required");

        transport = server.transport === "stdio"
          // A subprocess may print credentials: its output reaches only the host's Settings, with them hidden.
          ? new LocalStdioTransport({ command: server.command, args: server.args, cwd: server.cwd, env: { ...server.env, ...credentials?.env } },
              Object.values(credentials?.env ?? {}))
          : new OwnedHttpTransport(new URL(server.endpoint), {
              requestInit: { headers: { ...server.headers, ...credentials?.headers }, redirect: "error" },
              // SDK standalone GET streams do not spread requestInit, so enforce
              // this on every request before any transient headers can be redirected.
              fetch: (url, init) => fetch(url, { ...init, redirect: "error" }),
              // The manager owns reconnect policy. No SDK stream or invocation replay.
              reconnectionOptions: {
                maxRetries: 0,
                initialReconnectionDelay: 1_000,
                maxReconnectionDelay: 1_000,
                reconnectionDelayGrowFactor: 1
              }
            });
        // The SDK preserves existing transport handlers when it takes ownership.
        // Its separate client.onerror callback also reports harmless protocol
        // diagnostics, including replies arriving after a cancelled request.
        // Only transport failures should retire the connection and other calls.
        transport.onerror = error => {
          if (!closing && !closed) options.onError(adapterError(error));
        };
        try { await client.connect(transport, { signal, timeout: timeoutMs }); }
        catch (error) {
          // A process that exits while starting says why in its output.
          if (transport instanceof LocalStdioTransport && !(error instanceof McpClientError) && !signal.aborted) throw transport.failure();
          throw error;
        }
        signal.throwIfAborted();
        if (closed || closing) throw new McpClientError("disconnected");

        const request: McpConnection["listTools"] = async (cursor, requestOptions) => {
          try {
            if (closed || closing) throw new McpClientError("disconnected");
            return await mcpOperation(requestOptions, requestTimeoutMs(server), (requestSignal, requestTimeout) =>
              // The manager owns pagination and schema validation. SDK listTools caches
              // output validators for only its most recently fetched page.
              client.getServerCapabilities()?.tools
                ? client.request({ method: "tools/list", params: cursor === undefined ? {} : { cursor } },
                    ListToolsResultSchema, { signal: requestSignal, timeout: requestTimeout })
                : Promise.resolve({ tools: [] }));
          } catch (error) { throw adapterError(error); }
        };
        return {
          listTools: request,
          callTool: async (name, args, requestOptions) => {
            try {
              if (closed || closing) throw new McpClientError("disconnected");
              // A server reporting progress (a render, a compile) keeps its call alive up to MAX_CALL_MS.
              return await mcpOperation(requestOptions, requestTimeoutMs(server), (requestSignal, requestTimeout, progressed) =>
                client.request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema, {
                  signal: requestSignal, timeout: requestTimeout, resetTimeoutOnProgress: true, maxTotalTimeout: MAX_CALL_MS,
                  onprogress: () => { progressed(); requestOptions.onProgress?.(); }
                }), MAX_CALL_MS);
            } catch (error) { throw adapterError(error); }
          },
          close
        };
      });
    } catch (error) {
      await close();
      throw adapterError(error);
    }
  }
}
