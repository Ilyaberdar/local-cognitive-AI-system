import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { parseMcpConfiguration } from "./configuration";
import { McpClientError, safeMcpError } from "./errors";
import { mcpOperation } from "./operation";
import { compileToolArguments, snapshotArguments } from "./schema";
import { SdkMcpConnector } from "./transports";
import {
  McpCallRequest, McpClientConfiguration, McpClientService, McpConnection, McpConnectionBinding,
  McpConnectionStatus, McpConnector, McpCredentialProvider, McpDiscoveredTool,
  McpInvocationResult, McpLifecycleEvent, McpOperationOptions, McpServerDefinition
} from "./types";

export interface McpClientManagerOptions { connector?: McpConnector; credentialProvider?: McpCredentialProvider }
interface AvailableTool { tool: McpDiscoveredTool; validate: (args: unknown) => boolean }
interface ToolSnapshot { available: Map<string, AvailableTool>; revision: number }
interface Entry {
  server: McpServerDefinition;
  binding: McpConnectionBinding;
  fingerprint: string;
  status: McpConnectionStatus;
  wanted: boolean;
  generation: number;
  toolRevision: number;
  publishedToolRevision: number;
  refreshRequested: boolean;
  available: Map<string, AvailableTool>;
  connection?: McpConnection;
  controller?: AbortController;
  connecting?: Promise<McpConnectionStatus>;
  initializing?: Promise<void>;
  discovering?: Promise<McpDiscoveredTool[]>;
  retiring?: Promise<void>;
  retryTimer?: ReturnType<typeof setTimeout>;
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
};
export const mcpToolId = (bindingId: string, toolName: string): string =>
  `mcp:${encodeURIComponent(bindingId)}:${encodeURIComponent(toolName)}`;

/** Application-lifetime owner. It never retries a tool invocation, including ambiguous failures. */
export class McpClientManager implements McpClientService {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(event: McpLifecycleEvent) => void>();
  private readonly cleanups = new Set<Promise<void>>();
  private readonly closings = new WeakMap<McpConnection, Promise<void>>();
  private readonly connector: McpConnector;
  private disposed = false;
  private disposing?: Promise<void>;

  constructor(private readonly options: McpClientManagerOptions = {}) {
    this.connector = options.connector ?? new SdkMcpConnector();
  }

  list(): McpConnectionStatus[] { return [...this.entries.values()].map(entry => structuredClone(entry.status)); }
  status(bindingId: string): McpConnectionStatus { return structuredClone(this.entry(bindingId).status); }
  tools(bindingId?: string): McpDiscoveredTool[] {
    const entries = bindingId === undefined ? [...this.entries.values()] : [this.entry(bindingId)];
    return entries.flatMap(entry => [...entry.available.values()].map(({ tool }) => structuredClone(tool)));
  }
  subscribe(listener: (event: McpLifecycleEvent) => void): () => void {
    this.assertAlive();
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async reconcile(configuration: McpClientConfiguration): Promise<void> {
    this.assertAlive();
    const next = parseMcpConfiguration(configuration);
    const work: Promise<unknown>[] = [];
    // Apply invalidation synchronously. A later reconcile/disable can interrupt an earlier connect.
    for (const [id, entry] of this.entries) {
      if (!next.bindings[id]) {
        work.push(this.stop(entry));
        this.entries.delete(id);
      }
    }
    for (const binding of Object.values(next.bindings)) {
      const server = next.servers[binding.serverId];
      const { name: _serverName, ...connectionServer } = server;
      const { name: _bindingName, ...connectionBinding } = binding;
      const fingerprint = canonical({ server: connectionServer, binding: connectionBinding });
      const previous = this.entries.get(binding.id);
      if (previous?.fingerprint === fingerprint) {
        previous.server = server;
        previous.binding = binding;
        continue;
      }
      const retiring = previous ? this.stop(previous) : undefined;
      const entry: Entry = {
        server, binding, fingerprint, wanted: server.enabled && binding.enabled,
        generation: 0, toolRevision: 0, publishedToolRevision: -1, refreshRequested: false, available: new Map(), retiring,
        status: { bindingId: binding.id, serverId: server.id, enabled: server.enabled && binding.enabled,
          state: "disconnected", reconnectAttempt: 0 }
      };
      this.entries.set(binding.id, entry);
      if (retiring) work.push(retiring);
      if (entry.wanted) work.push(this.startConnect(entry));
      else this.emitStatus(entry);
    }
    // One unavailable external server cannot prevent the application from starting.
    await Promise.allSettled(work);
  }

  async connect(bindingId: string, options: McpOperationOptions = {}): Promise<McpConnectionStatus> {
    this.assertAlive();
    if (options.signal?.aborted) throw new McpClientError("cancelled");
    const entry = this.entry(bindingId);
    if (!entry.status.enabled) throw new McpClientError("binding_disabled");
    if (entry.status.state === "connected") return this.status(bindingId);
    if (entry.connecting) {
      // Cancelling a duplicate waiter does not cancel another caller's shared connection attempt.
      return mcpOperation(options, entry.server.connectTimeoutMs ?? 10_000, async () => entry.connecting!);
    }
    entry.wanted = true;
    this.clearRetry(entry);
    entry.status.reconnectAttempt = 0;
    return this.startConnect(entry, options);
  }

  async disconnect(bindingId: string): Promise<void> {
    this.assertAlive();
    await this.stop(this.entry(bindingId));
  }

  async discoverTools(bindingId: string, options: McpOperationOptions = {}): Promise<McpDiscoveredTool[]> {
    this.assertAlive();
    if (options.signal?.aborted) throw new McpClientError("cancelled");
    const entry = this.connectedEntry(bindingId);
    if (entry.discovering) return mcpOperation(options, entry.server.requestTimeoutMs ?? 30_000, async () => entry.discovering!);
    const generation = entry.generation;
    const connection = entry.connection!;
    const signal = this.operationSignal(entry, options.signal);
    let succeeded = false;
    const pending = mcpOperation({ ...options, signal }, entry.server.requestTimeoutMs ?? 30_000, async (signal, timeoutMs) => {
      for (let refresh = 0; refresh < 10; refresh++) {
        const snapshot = await this.fetchTools(entry, connection, { signal, timeoutMs });
        if (!this.current(entry, generation)) throw new McpClientError("cancelled");
        // Revision validation and publication must share the same turn, with no await between them.
        if (snapshot.revision !== entry.toolRevision) continue;
        entry.available = snapshot.available;
        entry.publishedToolRevision = snapshot.revision;
        succeeded = true;
        this.emitTools(entry);
        return this.tools(bindingId);
      }
      throw new McpClientError("protocol_error");
    }).catch(error => {
      const safe = safeMcpError(error);
      if (this.current(entry, generation)) {
        this.invalidateTools(entry);
        if (safe.code === "authentication_required" || safe.code === "transport_error") this.lost(entry, safe);
      }
      throw safe;
    });
    entry.discovering = pending;
    try { return await pending; }
    finally {
      if (entry.discovering === pending) {
        entry.discovering = undefined;
        const refreshAgain = succeeded && entry.refreshRequested && entry.publishedToolRevision !== entry.toolRevision;
        entry.refreshRequested = false;
        if (refreshAgain && this.current(entry, generation) && entry.status.state === "connected") {
          void this.discoverTools(bindingId).catch(() => {});
        }
      }
    }
  }

  async callTool(request: McpCallRequest, options: McpOperationOptions = {}): Promise<McpInvocationResult> {
    const callId = randomUUID();
    const started = performance.now();
    const toolId = mcpToolId(request.bindingId, request.toolName);
    let entry: Entry | undefined;
    let generation: number | undefined;
    try {
      this.assertAlive();
      if (options.signal?.aborted) throw new McpClientError("cancelled");
      entry = this.connectedEntry(request.bindingId);
      generation = entry.generation;
      const available = entry.available.get(request.toolName);
      if (!available) throw new McpClientError("tool_not_found");
      const args = snapshotArguments(request.arguments === undefined ? {} : request.arguments);
      if (!available.validate(args)) throw new McpClientError("invalid_arguments");
      const connection = entry.connection!;
      const result = await mcpOperation({ ...options, signal: this.operationSignal(entry, options.signal) },
        entry.server.requestTimeoutMs ?? 30_000, (signal, timeoutMs) => connection.callTool(request.toolName, args, { signal, timeoutMs }));
      const outcome = result.isError ? "tool-error" : "success";
      const durationMs = Math.max(0, performance.now() - started);
      this.emit({ type: "invocation", callId, bindingId: request.bindingId, toolId, outcome, durationMs,
        runId: request.runId, sessionId: request.sessionId });
      return { callId, bindingId: request.bindingId, toolId, outcome, durationMs, result };
    } catch (error) {
      let safe = safeMcpError(error);
      if (safe.code === "cancelled" && !options.signal?.aborted && entry?.status.error) {
        safe = new McpClientError(entry.status.error.code);
      }
      if (entry && this.current(entry, generation!) && (safe.code === "transport_error" || safe.code === "authentication_required")) {
        this.lost(entry, safe);
      }
      this.emit({ type: "invocation", callId, bindingId: request.bindingId, toolId,
        outcome: safe.code === "cancelled" ? "cancelled" : safe.code === "timeout" ? "timeout" : "error",
        durationMs: Math.max(0, performance.now() - started), runId: request.runId, sessionId: request.sessionId,
        error: safe.toJSON() });
      throw safe;
    }
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    const work = [...this.entries.values()].map(entry => this.stop(entry));
    this.disposing = (async () => {
      await Promise.allSettled(work);
      await Promise.allSettled([...this.cleanups]);
      this.listeners.clear();
    })();
    return this.disposing;
  }

  private startConnect(entry: Entry, options: McpOperationOptions = {}): Promise<McpConnectionStatus> {
    const generation = ++entry.generation;
    const controller = new AbortController();
    entry.controller = controller;
    entry.status.state = "connecting";
    delete entry.status.error;
    this.emitStatus(entry);
    let connection: McpConnection | undefined;
    let connectionError: McpClientError | undefined;
    const callerAbort = () => { entry.wanted = false; controller.abort(); };
    options.signal?.addEventListener("abort", callerAbort, { once: true });
    if (options.signal?.aborted) callerAbort();
    const onFailure = (error: unknown) => {
      if (!this.current(entry, generation)) return;
      const safe = safeMcpError(error);
      if (entry.status.state === "connecting") {
        // SDK failures may report an auth error followed by a generic close notification.
        connectionError ??= safe;
        if (safe.code === "authentication_required") connectionError = safe;
        controller.abort();
      }
      else this.lost(entry, safe);
    };
    const pending = (async () => {
      try {
        await mcpOperation({ signal: controller.signal, timeoutMs: options.timeoutMs }, entry.server.connectTimeoutMs ?? 10_000,
          (signal, timeoutMs) => {
            const initializing = (async () => {
              if (signal.aborted || !this.current(entry, generation)) throw new McpClientError("cancelled");
              await entry.retiring;
              if (signal.aborted || !this.current(entry, generation)) throw new McpClientError("cancelled");
              connection = await this.connector.open(structuredClone(entry.server), structuredClone(entry.binding), {
                signal, timeoutMs, credentialProvider: this.options.credentialProvider,
                onClose: () => onFailure(new McpClientError("transport_error")), onError: onFailure,
                onToolsChanged: () => {
                  if (!this.current(entry, generation)) return;
                  this.invalidateTools(entry);
                  entry.refreshRequested = true;
                  if (entry.status.state === "connected") void this.discoverTools(entry.binding.id).catch(() => {});
                }
              });
              if (signal.aborted || !this.current(entry, generation)) {
                await this.close(connection);
                throw new McpClientError("cancelled");
              }
              entry.connection = connection;
              for (let refresh = 0; refresh < 10; refresh++) {
                const snapshot = await this.fetchTools(entry, connection, { signal, timeoutMs });
                if (signal.aborted || !this.current(entry, generation)) throw new McpClientError("cancelled");
                if (snapshot.revision !== entry.toolRevision) continue;
                entry.available = snapshot.available;
                entry.publishedToolRevision = snapshot.revision;
                entry.refreshRequested = false;
                entry.status.state = "connected";
                entry.status.reconnectAttempt = 0;
                this.emitStatus(entry);
                this.emitTools(entry);
                return;
              }
              throw new McpClientError("protocol_error");
            })();
            // The caller deadline can finish before SDK initialization cleanup. Keep
            // ownership of the actual action so shutdown/replacement awaits its teardown.
            entry.initializing = initializing;
            this.trackCleanup(initializing.then(() => {}, () => {}));
            return initializing;
          });
        return structuredClone(entry.status);
      } catch (error) {
        const safe = connectionError ?? safeMcpError(error);
        if (this.owned(entry, generation)) {
          // Detach callbacks before close so an intentional cleanup cannot overwrite the error.
          ++entry.generation;
          entry.connection = undefined;
          controller.abort();
          this.invalidateTools(entry);
          entry.status.state = safe.code === "authentication_required" ? "authentication-required" :
            safe.code === "cancelled" ? "disconnected" : "error";
          entry.status.error = safe.toJSON();
          this.emitStatus(entry);
          entry.retiring = entry.initializing?.then(() => {}, () => {});
          if (connection) await this.close(connection);
          if (safe.retryable) this.scheduleRetry(entry);
        } else if (connection) await this.close(connection);
        throw safe;
      } finally {
        options.signal?.removeEventListener("abort", callerAbort);
      }
    })();
    entry.connecting = pending;
    void pending.finally(() => { if (entry.connecting === pending) entry.connecting = undefined; }).catch(() => {});
    return pending;
  }

  private fetchTools(entry: Entry, connection: McpConnection, options: McpOperationOptions): Promise<ToolSnapshot> {
    return mcpOperation(options, entry.server.requestTimeoutMs ?? 30_000, async (signal, timeoutMs) => {
      // A notification invalidates in-flight discovery. Restart its snapshot within the same deadline.
      for (let refresh = 0; refresh < 10; refresh++) {
        const revision = entry.toolRevision;
        const available = new Map<string, AvailableTool>();
        const cursors = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; ; page++) {
          if (signal.aborted) throw new McpClientError("cancelled");
          if (page >= 100) throw new McpClientError("protocol_error");
          const result = await connection.listTools(cursor, { signal, timeoutMs });
          for (const definition of result.tools) {
            if (available.has(definition.name)) throw new McpClientError("protocol_error");
            available.set(definition.name, {
              tool: { id: mcpToolId(entry.binding.id, definition.name), bindingId: entry.binding.id,
                serverId: entry.server.id, definition: structuredClone(definition) },
              validate: compileToolArguments(definition.inputSchema)
            });
          }
          cursor = result.nextCursor;
          if (cursor === undefined) break;
          if (cursors.has(cursor)) throw new McpClientError("protocol_error");
          cursors.add(cursor);
        }
        if (revision === entry.toolRevision) return { available, revision };
      }
      throw new McpClientError("protocol_error");
    });
  }

  private lost(entry: Entry, error: McpClientError): void {
    ++entry.generation;
    const connection = entry.connection;
    entry.connection = undefined;
    entry.controller?.abort();
    this.invalidateTools(entry);
    entry.status.state = error.code === "authentication_required" ? "authentication-required" : "error";
    entry.status.error = error.toJSON();
    this.emitStatus(entry);
    entry.retiring = connection ? this.close(connection) : undefined;
    if (error.retryable) this.scheduleRetry(entry);
  }

  private scheduleRetry(entry: Entry): void {
    const policy = entry.server.reconnect ?? { maxAttempts: 2, initialDelayMs: 250, maxDelayMs: 5_000 };
    if (this.disposed || !entry.wanted || !entry.status.enabled || entry.retryTimer || entry.status.reconnectAttempt >= policy.maxAttempts) return;
    const delay = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** entry.status.reconnectAttempt);
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = undefined;
      if (this.disposed || !entry.wanted || this.entries.get(entry.binding.id) !== entry) return;
      entry.status.reconnectAttempt++;
      void this.startConnect(entry).catch(() => {});
    }, delay);
    entry.retryTimer.unref();
  }

  private stop(entry: Entry): Promise<void> {
    entry.wanted = false;
    ++entry.generation;
    this.clearRetry(entry);
    entry.controller?.abort();
    const connection = entry.connection;
    entry.connection = undefined;
    this.invalidateTools(entry);
    entry.status.state = "disconnected";
    entry.status.reconnectAttempt = 0;
    delete entry.status.error;
    this.emitStatus(entry);
    return this.trackCleanup(Promise.allSettled([
      connection ? this.close(connection) : Promise.resolve(), entry.connecting, entry.initializing, entry.discovering, entry.retiring
    ]).then(() => {}));
  }

  private close(connection: McpConnection): Promise<void> {
    const previous = this.closings.get(connection);
    if (previous) return previous;
    const closing = this.trackCleanup(Promise.resolve().then(() => connection.close()).catch(() => {}));
    this.closings.set(connection, closing);
    return closing;
  }
  private trackCleanup(cleanup: Promise<void>): Promise<void> {
    this.cleanups.add(cleanup);
    void cleanup.finally(() => { this.cleanups.delete(cleanup); });
    return cleanup;
  }
  private operationSignal(entry: Entry, caller?: AbortSignal): AbortSignal {
    return caller ? AbortSignal.any([entry.controller!.signal, caller]) : entry.controller!.signal;
  }
  private current(entry: Entry, generation: number): boolean {
    return entry.wanted && this.owned(entry, generation);
  }
  private owned(entry: Entry, generation: number): boolean {
    return !this.disposed && entry.generation === generation && this.entries.get(entry.binding.id) === entry;
  }
  private clearRetry(entry: Entry): void { if (entry.retryTimer) clearTimeout(entry.retryTimer); entry.retryTimer = undefined; }
  private invalidateTools(entry: Entry): void { entry.toolRevision++; entry.available.clear(); this.emitTools(entry); }
  private emitTools(entry: Entry): void {
    this.emit({ type: "tools", bindingId: entry.binding.id, toolIds: [...entry.available.values()].map(({ tool }) => tool.id) });
  }
  private emitStatus(entry: Entry): void { this.emit({ type: "connection", status: structuredClone(entry.status) }); }
  private emit(event: McpLifecycleEvent): void {
    for (const listener of this.listeners) {
      const snapshot = structuredClone(event);
      // Observers run after the state transition completes, preventing reentrant connects.
      queueMicrotask(() => {
        if (!this.listeners.has(listener)) return;
        try { listener(snapshot); } catch { /* Observers cannot break the owner or another observer. */ }
      });
    }
  }
  private entry(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new McpClientError("binding_not_found");
    return entry;
  }
  private connectedEntry(id: string): Entry {
    const entry = this.entry(id);
    if (!entry.status.enabled) throw new McpClientError("binding_disabled");
    if (entry.status.state !== "connected" || !entry.connection) throw new McpClientError("disconnected");
    return entry;
  }
  private assertAlive(): void { if (this.disposed) throw new McpClientError("disposed"); }
}
