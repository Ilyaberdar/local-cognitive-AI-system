import { OperationExecutor } from "../../tools/OperationExecutor";
import { NodeResult } from "../types";
import { readConfigString, renderWorkflowTemplate } from "../template";
import { NodeExecutionContext, NodeExecutor } from "./NodeExecutor";
import { executeWorkflowOperation } from "./WorkflowOperation";

const ON_HOST = "This step calls a tool of an application on the server (MCP). It runs only in workflows started on the server.";

/** A JSON value with every string rendered as a template: results of earlier steps are inserted
 * as text, so they can never change the arguments' structure. */
const renderArguments = (value: unknown, context: NodeExecutionContext): unknown =>
  typeof value === "string" ? renderWorkflowTemplate(value, context)
    : Array.isArray(value) ? value.map(item => renderArguments(item, context))
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderArguments(item, context)]))
    : value;

/** Calls one tool of an external MCP server with arguments from a template, without a model:
 * the same approvals, journal and never-replayed calls as an agent's `mcp.call`. Its result's
 * text, structured content and error flag are fields later steps can use. */
export class McpCallNodeExecutor implements NodeExecutor {
  readonly type = "mcp_call" as const;

  constructor(private readonly operations?: OperationExecutor) {}

  async execute(context: NodeExecutionContext): Promise<NodeResult> {
    context.signal?.throwIfAborted();
    const fail = (summary: string): NodeResult => ({ status: "failed", event: "mcp_call.failed", summary, data: {}, error: summary });
    // A device started this run, or wrote the workflow it runs: the host's applications stay the host's.
    if (context.run.deviceOrigin) return fail(ON_HOST);
    if (!this.operations?.mcp) return fail("External MCP tools are unavailable in this runtime.");
    const config = context.node.config;
    const serverId = readConfigString(config, "serverId", ""), toolName = readConfigString(config, "toolName", "");
    let args: unknown;
    try {
      const template = readConfigString(config, "argumentsTemplate", "").trim();
      args = renderArguments(template ? JSON.parse(template) : {}, context);
    } catch (error) {
      return fail(error instanceof SyntaxError ? "The step's arguments are not a JSON object." : error instanceof Error ? error.message : String(error));
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) return fail("The step's arguments are not a JSON object.");
    const toolId = await this.operations.mcp.toolIdFor(serverId, toolName);
    if (!toolId) return fail(`${serverId} · ${toolName} is not available. Check that the server is enabled and connected in Settings → MCP, and that the tool is offered to agents.`);
    const result = await executeWorkflowOperation(context, this.operations, "mcp.call", { toolId, argumentsJson: JSON.stringify(args) });
    if (result.status === "needs_input" || typeof result.data.output !== "string") return result;
    // The tool's answer as fields: its text, its structured content, whether it reported an error.
    let parsed: { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown; isError?: boolean } = {};
    try { parsed = JSON.parse(result.data.output); } catch { /* A bounded, truncated result stays as output. */ }
    const text = (parsed.content ?? []).filter(item => item.type === "text" && typeof item.text === "string").map(item => item.text).join("\n");
    return {
      ...result,
      summary: (text || result.summary).slice(0, 1000),
      data: { ...result.data, server: serverId, toolName, text,
        ...(parsed.structuredContent !== undefined ? { structured: parsed.structuredContent } : {}), isError: parsed.isError === true }
    };
  }
}
