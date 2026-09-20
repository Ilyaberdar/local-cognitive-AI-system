import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ListToolsResultSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpClientError, safeMcpError } from "./errors";
import { mcpOperation } from "./operation";
import { McpConnection, McpConnectionBinding, McpConnector, McpServerDefinition } from "./types";

const HTTP_CLOSE_TIMEOUT_MS = 1_000;

/** The SDK can call close without awaiting it when initialization fails. */
class OwnedStdioTransport extends StdioClientTransport {
  private closing?: Promise<void>;
  override close(): Promise<void> {
    return this.closing ??= this.closeOwnedProcess();
  }

  private async closeOwnedProcess(): Promise<void> {
    if (!this.pid) return super.close();
    const onclose = this.onclose;
    let didClose!: () => void;
    const closed = new Promise<void>(resolve => { didClose = resolve; });
    this.onclose = () => { didClose(); onclose?.(); };
    await super.close();
    // SDK 1.x returns immediately after SIGKILL. Await the final child close event
    // so application exit does not outrun process reaping, with a bounded fallback.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([closed, new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}

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
    let transport: OwnedStdioTransport | OwnedHttpTransport | undefined;
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
      options.onClose();
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      if (!closing && !closed && client.getServerCapabilities()?.tools?.listChanged) options.onToolsChanged();
    });

    try {
      return await mcpOperation(options, server.connectTimeoutMs ?? 10_000, async (signal, timeoutMs) => {
        const credentials = await options.credentialProvider?.resolve({ server, binding, signal });
        signal.throwIfAborted();
        if (binding.credentialRef && !credentials) throw new McpClientError("authentication_required");

        transport = server.transport === "stdio"
          ? new OwnedStdioTransport({
              command: server.command,
              args: server.args,
              cwd: server.cwd,
              env: { ...server.env, ...credentials?.env },
              // A subprocess may print credentials in diagnostics. Do not expose its stderr.
              stderr: "ignore"
            })
          : new OwnedHttpTransport(new URL(server.endpoint), {
              requestInit: { headers: { ...credentials?.headers }, redirect: "error" },
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
        await client.connect(transport, { signal, timeout: timeoutMs });
        signal.throwIfAborted();
        if (closed || closing) throw new McpClientError("disconnected");

        const requestTimeoutMs = server.requestTimeoutMs ?? 60_000;
        const request: McpConnection["listTools"] = async (cursor, requestOptions) => {
          try {
            if (closed || closing) throw new McpClientError("disconnected");
            return await mcpOperation(requestOptions, requestTimeoutMs, (requestSignal, requestTimeout) =>
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
              return await mcpOperation(requestOptions, requestTimeoutMs, (requestSignal, requestTimeout) =>
                client.request({ method: "tools/call", params: { name, arguments: args } },
                  CallToolResultSchema, { signal: requestSignal, timeout: requestTimeout }));
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
