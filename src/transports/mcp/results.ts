import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { LocalModelError } from "../../local/types";

export type McpRequestContext = RequestHandlerExtra<ServerRequest, ServerNotification>;

export const textResult = (text: string, data?: unknown) => ({
  content: [{ type: "text" as const, text }],
  ...(data === undefined ? {} : { structuredContent: { result: data } })
});

export const jsonResult = (data: unknown) => textResult(JSON.stringify(data, null, 2), data);

export const errorResult = (error: unknown, signal?: AbortSignal) => {
  const cancelled = signal?.aborted;
  const code = cancelled ? "cancelled" : error instanceof LocalModelError ? error.code : "runtime_error";
  const message = cancelled ? "Request cancelled." : error instanceof Error ? error.message : "The request failed.";
  return { ...textResult(message, { error: { code, message } }), isError: true as const };
};

/** MCP progress is an increasing event counter, not a fabricated percentage. */
export const progressReporter = (extra: McpRequestContext) => {
  let progress = 0;
  return (message: string): void => {
    const progressToken = extra._meta?.progressToken;
    if (progressToken === undefined || extra.signal.aborted) return;
    void extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress: ++progress, message }
    }).catch(() => {});
  };
};
