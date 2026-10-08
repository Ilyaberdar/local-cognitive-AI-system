import http, { IncomingMessage, ServerResponse } from "http";
import type { AddressInfo } from "net";
import { sendAuthPage } from "../security/AuthCompletionPage";
import { AccountError } from "./errors";

export interface LoopbackServer { redirectUri: string; close(): void }

/** Single-purpose loopback listener for an OAuth redirect. It is bound before the browser
 * opens, only on 127.0.0.1, and never falls back to another port: the redirect URI is
 * registered exactly at the identity provider. */
export const openLoopback = async (options: { port: number; path: string; handle(url: URL, response: ServerResponse): void }): Promise<LoopbackServer> => {
  let host = "";
  const server = http.createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (request.method !== "GET" || request.headers.host !== host || url.pathname !== options.path) {
      sendAuthPage(response, 400, { outcome: "failure", title: "Invalid request", message: "This page only completes sign-in for Local Cognitive." });
      return;
    }
    options.handle(url, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(new AccountError(error.code === "EADDRINUSE" ? "callback_port_in_use" : error.code === "EACCES" ? "callback_port_unavailable" : "network"));
    });
    server.listen({ port: options.port, host: "127.0.0.1", exclusive: true }, () => resolve());
  });
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    redirectUri: `http://${host}${options.path}`,
    close: () => { server.close(); server.closeAllConnections(); }
  };
};
