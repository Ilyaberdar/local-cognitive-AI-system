import { spawn } from "node:child_process";
import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

/** A stdio MCP server shaped like an editor's (Blender, Unreal): it may refuse to start until its
 * application runs, reports progress on long work, carries one tool with an unusable schema and,
 * like `uvx`/`npx`, may leave a process of its own running. */
if (process.env.MCP_GATE_FILE && !fs.existsSync(process.env.MCP_GATE_FILE)) {
  console.error("\u001b[31mError:\u001b[0m the editor is not running (token=secret123456)");
  process.exit(3);
}
if (process.env.MCP_GRANDCHILD_PID_FILE) {
  // A process that ignores end of input, as a grandchild of a launcher might.
  const sleeper = spawn(process.execPath, ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"], { stdio: ["pipe", "ignore", "ignore"] });
  fs.writeFileSync(process.env.MCP_GRANDCHILD_PID_FILE, String(sleeper.pid));
}
const object = (properties: Record<string, object>): Tool["inputSchema"] => ({ type: "object", properties, additionalProperties: false });
const tools: Tool[] = [
  { name: "ok", inputSchema: object({}) },
  { name: "progress_op", inputSchema: object({ steps: { type: "integer" }, intervalMs: { type: "integer" } }) },
  { name: "quiet_op", inputSchema: object({ delayMs: { type: "integer" } }) },
  { name: "bad_schema", inputSchema: { type: "object", properties: { x: { type: "no-such-type" } } } as unknown as Tool["inputSchema"] }
];
const server = new Server({ name: "editor-like", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const args = (request.params.arguments ?? {}) as Record<string, number>;
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  if (request.params.name === "progress_op") {
    const token = request.params._meta?.progressToken;
    for (let step = 1; step <= args.steps!; step++) {
      await pause(args.intervalMs!);
      if (token !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: step, total: args.steps } });
    }
  }
  if (request.params.name === "quiet_op") await pause(args.delayMs!);
  return { content: [{ type: "text", text: `${request.params.name} done` }] };
});
process.stdin.once("end", () => { void server.close().then(() => process.exit(0)); });
void server.connect(new StdioServerTransport());
