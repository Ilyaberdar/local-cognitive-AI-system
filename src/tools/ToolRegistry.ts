import { ToolDescriptor } from "../types";
import { Tool } from "./Tool.interface";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name.toLowerCase(), tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name.toLowerCase());
  }

  list(): ToolDescriptor[] {
    return Array.from(this.tools.values()).map((tool) => tool.toDescriptor());
  }

  resolveFromInput(input: string): Tool[] {
    return Array.from(this.tools.values()).filter((tool) => tool.matchesIntent(input));
  }
}
