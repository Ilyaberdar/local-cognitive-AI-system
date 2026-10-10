import fs from "fs";
import net from "net";
import path from "path";
import type { Logger } from "../utils/Logger";

export class ControlError extends Error { constructor(message: string, readonly code: string) { super(message); } }
export type RemoteControlOp = "connect-key" | "invitation" | "devices" | "revoke-device" | "reset-owner";
export interface RemoteControlRequest { ttlSec?: number; deviceId?: string; invitationId?: string }

export interface ControlHandlers {
  status(): unknown;
  /** Everything the console shows: status, loaded models, machine metrics, connected computers. */
  overview?(): unknown;
  /** Pairing administration; errors with a code (ControlError or RemoteOperationError) reach the CLI. */
  remote?(op: RemoteControlOp, request: RemoteControlRequest): Promise<unknown>;
  drain(timeoutSec: number | undefined, progress: (active: number) => void): Promise<{ drained: boolean; remaining: number; elapsedMs: number }>;
  /** Takes over the connection for an MCP session; undefined when MCP is disabled. */
  mcp?(socket: net.Socket): void;
}

const MAX_LINE = 64 * 1024;

/** Local admin channel of the running server: a Unix socket readable only by its owner,
 * one NDJSON request per connection. */
export class ControlServer {
  private constructor(private readonly server: net.Server, private readonly socketPath: string) {}

  static async listen(socketPath: string, handlers: ControlHandlers, logger: Logger): Promise<ControlServer> {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    // The data-root lock is held, so a socket file left here belongs to a dead process.
    fs.rmSync(socketPath, { force: true });
    const server = net.createServer({ allowHalfOpen: false }, socket => ControlServer.handle(socket, handlers, logger));
    server.maxConnections = 16;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => resolve()); });
    fs.chmodSync(socketPath, 0o600);
    return new ControlServer(server, socketPath);
  }

  close(): Promise<void> {
    return new Promise(resolve => this.server.close(() => { fs.rmSync(this.socketPath, { force: true }); resolve(); }));
  }

  private static handle(socket: net.Socket, handlers: ControlHandlers, logger: Logger) {
    let buffer = "";
    const send = (value: unknown) => { if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };
    const fail = (code: string, message: string) => { send({ v: 1, ok: false, error: { code, message } }); socket.end(); };
    const timer = setTimeout(() => socket.destroy(), 5_000);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_LINE) { fail("bad_request", "Request too large."); return; }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer);
      socket.off("data", onData);
      let request: { v?: number; op?: string; timeoutSec?: number; ttlSec?: number; deviceId?: string; invitationId?: string };
      try { request = JSON.parse(buffer.slice(0, end)); } catch { fail("bad_request", "Invalid JSON."); return; }
      if (request.v !== 1) { fail("unsupported_version", "Unsupported control protocol version."); return; }
      if (request.op === "status") { send({ v: 1, ok: true, result: handlers.status() }); socket.end(); return; }
      if (request.op === "overview") {
        if (!handlers.overview) { fail("unknown_op", "This server has no overview."); return; }
        send({ v: 1, ok: true, result: handlers.overview() }); socket.end(); return;
      }
      if (request.op === "drain") {
        send({ v: 1, ok: true, result: { accepted: true } });
        void handlers.drain(typeof request.timeoutSec === "number" ? request.timeoutSec : undefined, active => send({ event: "drain.progress", active }))
          .then(result => { send({ event: "drain.done", ...result }); socket.end(); }, error => fail("failure", error instanceof Error ? error.message : String(error)));
        return;
      }
      if (request.op === "mcp") {
        if (!handlers.mcp) { fail("mcp_disabled", "The MCP server is disabled on this host."); return; }
        send({ v: 1, ok: true });
        handlers.mcp(socket);
        socket.resume();
        return;
      }
      if (["connect-key", "invitation", "devices", "revoke-device", "reset-owner"].includes(request.op ?? "")) {
        if (!handlers.remote) { fail("remote_off", "Remote is not available on this server."); return; }
        const ttlSec = typeof request.ttlSec === "number" && request.ttlSec >= 60 && request.ttlSec <= 3600 ? request.ttlSec : undefined;
        const deviceId = typeof request.deviceId === "string" && /^[0-9a-f-]{36}$/i.test(request.deviceId) ? request.deviceId : undefined;
        const invitationId = typeof request.invitationId === "string" && /^[0-9a-f-]{36}$/i.test(request.invitationId) ? request.invitationId : undefined;
        if (request.op === "revoke-device" && !deviceId) { fail("bad_request", "A device id is required."); return; }
        if (request.op === "invitation" && !invitationId) { fail("bad_request", "An invitation id is required."); return; }
        void handlers.remote(request.op as RemoteControlOp, { ...(ttlSec ? { ttlSec } : {}), ...(deviceId ? { deviceId } : {}), ...(invitationId ? { invitationId } : {}) }).then(
          result => { send({ v: 1, ok: true, result }); socket.end(); },
          (error: unknown) => fail((error as { code?: string }).code ?? "failure", error instanceof Error ? error.message : String(error)));
        return;
      }
      fail("unknown_op", `Unknown operation: ${request.op}`);
    };
    socket.on("data", onData);
    socket.on("error", error => logger.debug("Control connection error", { message: error.message }));
    socket.on("close", () => clearTimeout(timer));
  }
}

/** Client side: sends one request and collects the response and events. */
export const controlRequest = (socketPath: string, request: Record<string, unknown>, options: { timeoutMs?: number; onEvent?(event: Record<string, unknown>): void } = {}) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = "", response: Record<string, unknown> | undefined;
    const timer = options.timeoutMs ? setTimeout(() => { socket.destroy(); reject(new Error("The server did not answer in time.")); }, options.timeoutMs) : undefined;
    socket.on("connect", () => socket.write(`${JSON.stringify({ v: 1, ...request })}\n`));
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
        buffer = buffer.slice(end + 1);
        if (line.event) options.onEvent?.(line); else response = line;
      }
    });
    socket.on("error", error => { clearTimeout(timer); reject(error); });
    socket.on("close", () => { clearTimeout(timer); if (response) resolve(response); else reject(new Error("The server closed the connection.")); });
  });
