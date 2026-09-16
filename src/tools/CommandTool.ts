import path from "path";
import { ToolExecutionRequest, ToolExecutionResult } from "../types";
import { Tool } from "./Tool.interface";
import { authorizeOperation, canonicalPath } from "./AccessPolicy";
import { runCommand } from "../utils/runCommand";

export const isCommandRequest = (input: string): boolean => {
  const text = input.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ").trim();
  // Only a direct action request opts into command execution. Examples in files, quotations,
  // explanations, model output, memory and attachments must never become executable intent.
  return /^(?:(?:please|can you|could you|пожалуйста|можешь|можешь ли ты)\s+)*(?:(?:run|execute)\b[^\n]*\b(?:command|terminal|shell)\b|ping\s+(?:the\s+)?[a-z0-9]|(?:запусти|выполни)[^\n]*команд|(?:пингани|пропингуй|пингануть)\s|проверь[^\n]*(?:интернет|сеть))/i.test(text);
};

export const commandInstruction = (input: string): string => isCommandRequest(input)
  ? ["The user requested a real command. The application has a command tool and handles approval before execution.",
    "Propose exactly one command using this format, with valid JSON and no markdown fences:",
    '<<<COMMAND>>>',
    '{"executable":"ping","args":["-c","1","example.com"],"cwd":"."}',
    '<<<END COMMAND>>>',
    `Host platform: ${process.platform}. Adapt the executable and arguments to the user request.`,
    "Use an executable and separate argument strings. Shell operators only work through an explicitly proposed shell executable.",
    "Do not claim the command ran. Its actual result will be shown by the application."].join("\n")
  : "";

export class CommandTool implements Tool {
  readonly name = "command";
  readonly description = "Runs a proposed local command after the chat access policy authorizes it.";
  constructor(private readonly workspaceDir: string) {}
  matchesIntent(input: string): boolean { return isCommandRequest(input); }
  toDescriptor() { return { name: this.name, description: this.description }; }

  async execute(input: ToolExecutionRequest): Promise<ToolExecutionResult> {
    const output = "response" in input.result ? input.result.toolPayload || input.result.response : "";
    const blocks = [...output.matchAll(/<<<COMMAND>>>\s*([\s\S]*?)\s*<<<END COMMAND>>>/g)];
    let command: { executable: string; args: string[]; cwd?: string };
    try {
      if (blocks.length !== 1) throw new Error("Expected one command proposal.");
      command = JSON.parse(blocks[0][1]);
      if (!command || typeof command.executable !== "string" || !command.executable.trim() ||
        !Array.isArray(command.args) || !command.args.every((arg) => typeof arg === "string") ||
        (command.cwd !== undefined && typeof command.cwd !== "string") ||
        [command.executable, ...command.args, command.cwd || ""].some((value) => value.includes("\0"))) {
        throw new Error("Invalid command proposal.");
      }
    } catch {
      return { tool: this.name, ok: false, output: "The model did not produce one valid command proposal. No command was executed." };
    }
    const executable = command.executable.trim();
    const args = [...command.args];
    const cwd = await canonicalPath(path.resolve(this.workspaceDir, command.cwd || "."));
    const display = [executable, ...args].map((arg) => JSON.stringify(arg)).join(" ");
    // Even apparently simple commands may execute hooks or access the network. Default asks conservatively.
    const permission = await authorizeOperation(input.context, {
      tool: this.name, operation: "command", summary: `Run ${executable}`,
      details: `${display}\n\nWorking directory: ${cwd}\nTimeout: 30 seconds`
    }, false);
    if (permission) return permission;
    input.context.signal?.throwIfAborted();
    if (await canonicalPath(cwd) !== cwd) throw new Error("Command working directory changed while awaiting approval.");
    const result = await runCommand(executable, args, cwd, 30_000, input.context.signal);
    return { tool: this.name, ok: result.exitCode === 0,
      output: `${display}\nExit code: ${result.exitCode}\n${result.stdout}${result.stderr}`.trim(),
      metadata: { operation: "command", executable, args, cwd, ...result } };
  }
}
