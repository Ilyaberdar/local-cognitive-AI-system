import net from "net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RuntimeManager } from "../app/RuntimeManager";
import type { SessionIndexStore } from "../session/SessionIndexStore";
import { registerLocalCognitiveMcpTools } from "../transports/mcp/tools";
import { appVersion } from "../utils/appVersion";

/** Server side: one MCP session over a control-socket connection, using the running runtime. */
export const serveMcpSession = (socket: net.Socket, deps: { runtimeManager: RuntimeManager; sessionIndexStore: SessionIndexStore; defaultSessionId: string }) => {
  const server = new McpServer({ name: "local-cognitive-ai-system", version: appVersion() });
  registerLocalCognitiveMcpTools(server, deps);
  void server.connect(new StdioServerTransport(socket, socket));
  socket.once("close", () => { void server.close(); });
};

/** Client side (src/mcp.ts): relays an MCP client's stdio to the running server, so a second
 * runtime with its own model processes is never started. Resolves when the session ends. */
export const bridgeStdio = (socketPath: string): Promise<void> => new Promise((resolve, reject) => {
  const socket = net.connect(socketPath);
  let buffer = Buffer.alloc(0), attached = false;
  socket.on("connect", () => socket.write(`${JSON.stringify({ v: 1, op: "mcp" })}\n`));
  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf(10);
    if (end < 0) return;
    socket.off("data", onData);
    const reply = JSON.parse(buffer.subarray(0, end).toString("utf8")) as { ok?: boolean; error?: { message?: string } };
    if (!reply.ok) { socket.destroy(); reject(new Error(reply.error?.message ?? "The server refused the MCP session.")); return; }
    attached = true;
    const rest = buffer.subarray(end + 1);
    if (rest.length) process.stdout.write(rest);
    socket.pipe(process.stdout);
    process.stdin.pipe(socket);
    process.stdin.once("end", () => socket.end());
  };
  socket.on("data", onData);
  socket.on("error", error => { if (!attached) reject(error); });
  socket.on("close", () => { if (attached) resolve(); });
});
