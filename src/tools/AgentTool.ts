import { z } from "zod";
import { LLMFunctionTool, LLMResponseFormat } from "../types";
import { strictJsonSchema } from "../llm/StructuredOutput";

// A model that runs on into prose inside a path gets a short reason to correct itself, not a
// file system error echoing the text (ENAMETOOLONG): one line, parts the file system accepts.
const filePath = z.string().min(1).max(4096).refine(value => !value.includes("\0"), "Path contains a null byte.")
  .refine(value => !/[\u0000-\u001f\u007f]/.test(value), "A path is one line naming a file or folder, such as notes/README.md, without line breaks or tabs.")
  .refine(value => value.split(/[\\/]/).every(part => Buffer.byteLength(part) <= 255), "Each part of a path is at most 255 bytes long; pass only the file or folder name.");
const text = z.string().max(1_000_000);
const version = z.string().min(1).max(128);
export const agentToolSchemas = {
  "mcp.search": z.object({ query: z.string().max(1000) }).strict(),
  "mcp.call": z.object({ toolId: z.string().min(1).max(1000), argumentsJson: z.string().min(2).max(200_000) }).strict(),
  "plugins.search": z.object({ query: z.string().max(1000) }).strict(),
  "plugins.call": z.object({ toolId: z.string().min(1).max(1000), argumentsJson: z.string().min(2).max(200_000) }).strict(),
  "file.list": z.object({ path: filePath.default("."), limit: z.number().int().min(1).max(300).default(100) }).strict(),
  "file.search": z.object({ path: filePath.default("."), query: z.string().max(1000), limit: z.number().int().min(1).max(200).default(40), maxResults: z.number().int().min(1).max(200).optional(), maxFiles: z.number().int().min(1).max(5000).default(500), include:z.array(z.string().max(200)).max(50).optional(),exclude:z.array(z.string().max(200)).max(50).optional(),maxFileBytes:z.number().int().min(1024).max(5_000_000).default(524288) }).strict(),
  "file.read": z.object({ path: filePath, startLine: z.number().int().min(1).default(1), endLine: z.number().int().min(1).optional() }).strict(),
  "file.write": z.object({ path: filePath, content: text, expectedVersion: version }).strict(),
  "file.replace": z.object({ path: filePath, oldText: z.string().min(1).max(1_000_000), newText: text, expectedVersion: version }).strict(),
  "file.append": z.object({ path: filePath, content: text, expectedVersion: version }).strict(),
  "file.mkdir": z.object({ path: filePath }).strict(),
  "file.delete": z.object({ path: filePath, expectedVersion: version }).strict(),
  "command.run": z.object({ executable: z.string().trim().min(1).max(4096), args: z.array(z.string().max(32_000)).max(200), cwd: filePath.default("."), timeoutMs: z.number().int().min(1000).max(120_000).default(30_000) }).strict()
};
export type AgentToolName = keyof typeof agentToolSchemas;
export interface AgentAction { tool: AgentToolName; arguments: Record<string, unknown> }
export function parseAgentAction(value: unknown): AgentAction {
  const shape = z.object({ tool: z.string(), arguments: z.record(z.string(), z.unknown()) }).strict().parse(value);
  if (!Object.hasOwn(agentToolSchemas, shape.tool)) throw new Error(`Unknown tool: ${shape.tool}`);
  const tool = shape.tool as AgentToolName;
  if (["file.write", "file.replace", "file.append", "file.delete"].includes(tool) && typeof shape.arguments.expectedVersion !== "string") {
    throw new Error(`${tool} requires arguments.expectedVersion. For a NEW file pass the exact string "missing". For an existing file, read it first and copy its returned version. No action was executed.`);
  }
  const args = { ...shape.arguments };
  for (const [key, field] of Object.entries(agentToolSchemas[tool].shape)) if (args[key] === null && field.isOptional()) delete args[key];
  return { tool, arguments: agentToolSchemas[tool].parse(args) };
}
// plugins.call is a dispatcher; PluginManager enforces read-only against the actual tool.
export const readTool = (tool: string): boolean => ["file.read", "file.list", "file.search", "plugins.search", "plugins.call", "mcp.search"].includes(tool);
export interface AgentToolOptions { plugins?: boolean; mcp?: boolean; pluginOnly?: boolean; }

export function agentFunctionTools(readOnly = false, options: AgentToolOptions = {}): LLMFunctionTool[] {
  return Object.entries(agentToolSchemas).filter(([name]) =>
    (name.startsWith("plugins.") ? options.plugins : name.startsWith("mcp.") ? options.mcp : !options.pluginOnly) && (!readOnly || readTool(name))).map(([action, schema]) => {
    const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    const required = (json.required ?? []) as string[];
    return { name: action.replaceAll(".", "_"), action,
      description: action === "mcp.search" ? "Find tools from connected external MCP servers such as Unreal Engine or Blender. Returns exact tool IDs and schemas. Search first; never invent IDs or arguments."
        : action === "mcp.call" ? "Call a tool found by mcp.search. toolId must match exactly; argumentsJson must be a JSON object serialized as a string matching the returned schema. Every external MCP invocation requires approval and is never retried automatically."
        : action === "plugins.search" ? "Find tools from enabled connected plugins by service name or task keywords. Returns exact tool IDs, account names, schemas and read/write status. Search first; never invent IDs or arguments."
        : action === "plugins.call" ? "Call a tool found by plugins.search. toolId must match exactly; argumentsJson must be a JSON object serialized as a string matching the returned schema. External writes require approval. Never repeat a denied or unknown operation."
        : `Execute ${action} in the workspace. ${action.startsWith("file.") && !readTool(action) ? 'Read existing files first and pass their returned expectedVersion; use "missing" only for a new file.' : "Use the actual result as evidence before answering."}${action === "file.search" || action === "file.read" ? " Pass a search result's absolutePath directly to file.read; its path is relative to the search root, not necessarily the workspace." : ""}`,
      parameters: strictJsonSchema(json), optionalArguments: Object.keys(schema.shape).filter(key => !required.includes(key)) };
  });
}

/** The wrapper keeps a valid object root even on APIs that disallow a root union. */
export function agentActionFormat(readOnly = false, finalOnly = false, options: AgentToolOptions = {}): LLMResponseFormat {
  const alternatives: Record<string, unknown>[] = (finalOnly ? [] : agentFunctionTools(readOnly, options)).map(tool => ({
    type: "object", properties: { type: { const: "tool_call", type: "string" }, tool: { const: tool.action, type: "string" }, arguments: tool.parameters },
    required: ["type", "tool", "arguments"], additionalProperties: false
  }));
  alternatives.push({ type: "object", properties: { type: { const: "final", type: "string" }, text: { type: "string", minLength: 1 } },
    required: ["type", "text"], additionalProperties: false });
  return { type: "json_schema", name: "agent_action", strict: true, schema: {
    type: "object", properties: { action: { anyOf: alternatives } }, required: ["action"], additionalProperties: false
  } };
}

export const agentToolInstructions = `Available tools (arguments are JSON):
file.list {path:".",limit?:100}
file.search {path:".",query:"literal text",include?:["*.ts"],exclude?:["*.test.ts"],limit?:40,maxFiles?:500}
Search filename globs such as *.ts match at every depth. Globs containing / are relative to the search root. An empty query finds file paths. Pass a result's absolutePath directly to file.read; its path is relative to the search root, not necessarily the workspace. Narrow the root or query when results are truncated.
file.read {path,startLine?:1,endLine?}
file.write {path,content,expectedVersion}
Example to create a new file: {"type":"tool_call","tool":"file.write","arguments":{"path":"result.txt","content":"your actual content","expectedVersion":"missing"}}
file.replace {path,oldText,newText,expectedVersion} (oldText must occur exactly once)
file.append {path,content,expectedVersion}
file.mkdir {path}
file.delete {path,expectedVersion} (files or empty directories only)
command.run {executable,args:["separate","arguments"],cwd?:".",timeoutMs?:30000}
Read existing files first. Use the version returned by file.read to edit them. For a NEW file use expectedVersion:"missing". Never guess a version. Directory deletion requires expectedVersion:"directory" and explicit permission. Read/search results have bounds and truncation information; request another range if needed.
Do not overwrite a whole existing file without reading it. Prefer file.replace. A command runs with OS permissions and may need confirmation; never claim it ran until its tool result arrives.`;
