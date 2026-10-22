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
  // Synthesis agents only: files taken for one agent's work, like a Perforce checkout.
  // A longer wait is cut to the most one may wait (600 s), not refused: a refusal costs the agent a turn.
  "file.checkout": z.object({ paths: z.array(filePath).min(1).max(24), waitSeconds: z.number().min(0).default(0) }).strict(),
  "file.submit": z.object({ paths: z.array(filePath).min(1).max(24).optional() }).strict(),
  "file.revert": z.object({ paths: z.array(filePath).min(1).max(24).optional() }).strict(),
  "terminal.run": z.object({ command: z.string().min(1).max(20), args: z.array(z.string().max(4000)).max(64).default([]), cwd: filePath.default("."), timeoutSeconds: z.number().min(1).default(60) }).strict(),
  "command.run": z.object({ executable: z.string().trim().min(1).max(4096), args: z.array(z.string().max(32_000)).max(200), cwd: filePath.default("."), timeoutMs: z.number().int().min(1000).max(120_000).default(30_000) }).strict(),
  // A Synthesis agent's HTTP request, performed by the engine against the agent's allowlist.
  "http.request": z.object({ method: z.string().min(1).max(10).default("GET"), url: z.string().min(1).max(4096), headers: z.record(z.string().max(128), z.string().max(4096)).optional(), body: z.string().max(1_000_000).optional() }).strict()
};
export type AgentToolName = keyof typeof agentToolSchemas;
export interface AgentAction { tool: AgentToolName; arguments: Record<string, unknown> }
/** The value, or a refusal a model can act on: each problem as "field: what is wrong", not zod's JSON list. */
function checked<T>(schema: z.ZodType<T>, value: unknown, prefix?: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const problems = result.error.issues.map(issue => `${[prefix, ...issue.path.map(String)].filter(Boolean).join(".") || "the action"}: ${issue.message}`);
  throw new Error(`${problems.join("; ")}. No action was executed.`);
}

/** The tools whose arguments these are. */
const fittingTools = (args: unknown): string[] => Object.entries(agentToolSchemas).filter(([, schema]) => schema.safeParse(args).success).map(([name]) => name);
const fitHint = (fits: string[]) => fits.length ? `. These arguments fit ${fits.slice(0, 3).join(" or ")}: {"type":"tool_call","tool":"${fits[0]}","arguments":{…}}` : "";

/** The tool a name means: its own (file.read) or its function's (file_read). */
export const toolByName = (name: unknown): AgentToolName | undefined => typeof name !== "string" ? undefined
  : (Object.keys(agentToolSchemas) as AgentToolName[]).find(tool => tool === name || tool.replaceAll(".", "_") === name);

/** A reply that is only a tool's arguments, with neither "type" nor "tool" (DeepSeek's, before its DSML
 * closers): the refusal that names the tools they fit, or undefined when they fit none. Never guessed. */
export function bareArgumentsError(value: Record<string, unknown>): Error | undefined {
  const fits = fittingTools(value);
  return fits.length ? new Error(`Your reply was only a tool's arguments, with no "type" and "tool", so nothing ran: send the whole action${fitHint(fits)}. No action was executed.`) : undefined;
}

export function parseAgentAction(value: unknown): AgentAction {
  // A tool_call without its tool's name (DeepSeek sends {"type":"tool_call","arguments":{…}} now and then, and
  // sent the same again after "tool: expected string"): refused with the tools those arguments fit. Never guessed.
  const named = value && typeof value === "object" ? value as { tool?: unknown; arguments?: unknown } : undefined;
  if (named && named.tool === undefined && named.arguments && typeof named.arguments === "object") {
    throw new Error(`Your tool_call names no "tool": send it again with the tool's name beside "arguments"${fitHint(fittingTools(named.arguments))}. No action was executed.`);
  }
  const shape = checked(z.object({ tool: z.string(), arguments: z.record(z.string(), z.unknown()) }).strict(), value);
  if (!Object.hasOwn(agentToolSchemas, shape.tool)) throw new Error(`Unknown tool: ${shape.tool}`);
  const tool = shape.tool as AgentToolName;
  if (["file.write", "file.replace", "file.append", "file.delete"].includes(tool) && typeof shape.arguments.expectedVersion !== "string") {
    throw new Error(`${tool} requires arguments.expectedVersion. For a NEW file pass the exact string "missing". For an existing file, read it first and copy its returned version. No action was executed.`);
  }
  const args = { ...shape.arguments };
  for (const [key, field] of Object.entries(agentToolSchemas[tool].shape)) if (args[key] === null && field.isOptional()) delete args[key];
  return { tool, arguments: checked(agentToolSchemas[tool] as z.ZodType<Record<string, unknown>>, args, "arguments") };
}
// plugins.call is a dispatcher; PluginManager enforces read-only against the actual tool.
export const readTool = (tool: string): boolean => ["file.read", "file.list", "file.search", "plugins.search", "plugins.call", "mcp.search"].includes(tool);
/** Tools only an agent that names them gets (a Synthesis agent's checkouts); never a chat's. */
const NAMED_ONLY = new Set(["file.checkout", "file.submit", "file.revert", "terminal.run", "http.request"]);
export interface AgentToolOptions { plugins?: boolean; mcp?: boolean; pluginOnly?: boolean;
  /** Only these tools (a Synthesis agent's rights); undefined offers every tool the rest allows. */
  only?: string[]; }

export function agentFunctionTools(readOnly = false, options: AgentToolOptions = {}): LLMFunctionTool[] {
  return Object.entries(agentToolSchemas).filter(([name]) =>
    (name.startsWith("plugins.") ? options.plugins : name.startsWith("mcp.") ? options.mcp : !options.pluginOnly) && (!readOnly || readTool(name)) &&
    (!options.only || options.only.includes(name)) && (!NAMED_ONLY.has(name) || !!options.only?.includes(name))).map(([action, schema]) => {
    const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    const required = (json.required ?? []) as string[];
    return { name: action.replaceAll(".", "_"), action,
      description: action === "mcp.search" ? "Find tools from connected external MCP servers such as Unreal Engine or Blender. Returns exact tool IDs and schemas. Search first; never invent IDs or arguments."
        : action === "mcp.call" ? "Call a tool found by mcp.search. toolId must match exactly; argumentsJson must be a JSON object serialized as a string matching the returned schema. A call may wait for the user's approval (approvalRequired in search results) and is never retried automatically."
        : action === "plugins.search" ? "Find tools from enabled connected plugins by service name or task keywords. Returns exact tool IDs, account names, schemas and read/write status. Search first; never invent IDs or arguments."
        : action === "file.checkout" ? "Take files for your work, all of them or none, like a Perforce checkout: until you submit, revert or finish, the other agents read their last submitted version and change nothing of them. Include files your change depends on that you only read. waitSeconds (up to 600) waits for files another agent holds, when you hold none."
        : action === "terminal.run" ? "Run a command in a sandbox: a copy of the files you may read, with your current changes, without network. What it writes stays in that copy; change files with the file tools. Use it to build, run tests and check your work before you answer."
        : action === "file.submit" ? "Make your changes to checked-out files visible to the other agents and release the files (all of them without paths)."
        : action === "file.revert" ? "Drop your changes to checked-out files and release them (all of them without paths)."
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
