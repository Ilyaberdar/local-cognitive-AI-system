import { ExecutionContext, Mode, ModeResult } from "../types";

export type ModeHandler = (input: string, context: ExecutionContext) => Promise<ModeResult>;

export class Router {
  private readonly handlers = new Map<Mode, ModeHandler>();

  register(mode: Mode, handler: ModeHandler): void {
    this.handlers.set(mode, handler);
  }

  route(mode: Mode): ModeHandler {
    const handler = this.handlers.get(mode);

    if (!handler) {
      throw new Error(`No handler registered for mode "${mode}"`);
    }

    return handler;
  }
}
