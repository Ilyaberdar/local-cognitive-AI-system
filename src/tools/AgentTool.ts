import { z } from "zod";

const filePath = z.string().min(1).max(4096).refine(value => !value.includes("\0"), "Path contains a null byte.");
const text = z.string().max(1_000_000);
const version = z.string().min(1).max(128);
export const agentToolSchemas = {
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
  return { tool, arguments: agentToolSchemas[tool].parse(shape.arguments) };
}
export const readTool = (tool: string): boolean => ["file.read", "file.list", "file.search"].includes(tool);

export const agentToolInstructions = `Available tools (arguments are JSON):
file.list {path:".",limit?:100}
file.search {path:".",query:"literal text",limit?:40,maxFiles?:500}
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
