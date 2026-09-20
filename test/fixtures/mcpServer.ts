import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, Tool } from "@modelcontextprotocol/sdk/types.js";

export interface McpFixtureState {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  cancellations: number;
  listRequests: Array<string | undefined>;
  revision: number;
}

export interface McpFixtureOptions {
  account?: string;
  onCrash?: () => void;
  pageSize?: number;
}

const emptyInput: Tool["inputSchema"] = { type: "object", additionalProperties: false };
const fixtureTools: Tool[] = [
  { name: "echo", description: "Return text with account and process identity.", inputSchema: {
    type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false
  } },
  { name: "sum", inputSchema: {
    type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false
  } },
  { name: "tool_error", inputSchema: emptyInput },
  { name: "protocol_error", inputSchema: emptyInput },
  { name: "slow", inputSchema: {
    type: "object", properties: { delayMs: { type: "integer", minimum: 0, maximum: 60_000 }, text: { type: "string" } },
    required: ["delayMs"], additionalProperties: false
  } },
  { name: "stats", inputSchema: emptyInput },
  { name: "change_tools", inputSchema: emptyInput },
  { name: "crash", inputSchema: emptyInput }
];

/** Real SDK protocol handlers, shared by stdio and HTTP integration fixtures. */
export function createMcpFixtureServer(options: McpFixtureOptions = {}) {
  const state: McpFixtureState = { calls: [], cancellations: 0, listRequests: [], revision: 0 };
  const server = new Server({ name: "controlled-mcp-fixture", version: "1.0.0" }, {
    capabilities: { tools: { listChanged: true } }
  });
  const notifyToolsChanged = async () => {
    state.revision++;
    await server.notification({ method: "notifications/tools/list_changed" });
  };
  server.setRequestHandler(ListToolsRequestSchema, async request => {
    state.listRequests.push(request.params?.cursor);
    const allTools = [...fixtureTools, ...(state.revision ? [{ name: "added", inputSchema: emptyInput }] : [])];
    const offset = request.params?.cursor === undefined ? 0 : Number(request.params.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= allTools.length) {
      throw new McpError(ErrorCode.InvalidParams, "Invalid fixture cursor");
    }
    const end = Math.min(offset + (options.pageSize ?? 2), allTools.length);
    return { tools: allTools.slice(offset, end), ...(end < allTools.length ? { nextCursor: String(end) } : {}) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    state.calls.push({ name, args: structuredClone(args) });
    const identity = { account: options.account ?? "anonymous", pid: process.pid };
    if (name === "tool_error") return { isError: true, content: [{ type: "text", text: "Fixture tool rejected the operation" }] };
    if (name === "protocol_error") throw new McpError(ErrorCode.InvalidParams, "Fixture private protocol diagnostics");
    if (name === "crash") {
      if (options.onCrash) options.onCrash();
      else await server.close();
      return { content: [] };
    }
    if (name === "slow") {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          state.cancellations++;
          extra.signal.removeEventListener("abort", onAbort);
          reject(new Error("Fixture request cancelled"));
        };
        const timer = setTimeout(() => {
          extra.signal.removeEventListener("abort", onAbort);
          resolve();
        }, Number(args.delayMs));
        extra.signal.addEventListener("abort", onAbort, { once: true });
        if (extra.signal.aborted) onAbort();
      });
    }
    if (name === "change_tools") await notifyToolsChanged();
    const result: Record<string, unknown> = name === "stats" ? { ...state, ...identity }
      : name === "sum" ? { sum: Number(args.a) + Number(args.b), ...identity }
      : { text: String(args.text ?? name), ...identity };
    return {
      content: [{ type: "text", text: name === "sum" ? String(result.sum) : String(result.text ?? JSON.stringify(result)) }],
      structuredContent: result
    };
  });
  return { server, state, notifyToolsChanged };
}
