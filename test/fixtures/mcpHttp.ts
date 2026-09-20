import express from "express";
import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpFixtureServer } from "./mcpServer";

type Fixture = ReturnType<typeof createMcpFixtureServer>;

/** Real loopback HTTP and SDK sessions; no SDK client methods are mocked. */
export async function createMcpHttpFixture(options: { accounts?: Record<string, string> } = {}) {
  const app = express();
  app.use(express.json());
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; fixture: Fixture; account: string }>();
  const fixtures: Fixture[] = [];
  const requests: Array<{ method: string; authorization?: string; sessionId?: string }> = [];
  let server: HttpServer;
  let deletedSessions = 0;
  app.all("/mcp", async (req, res) => {
    const authorization = req.headers.authorization;
    const sessionId = req.header("mcp-session-id");
    requests.push({ method: req.method, authorization, sessionId });
    const account = options.accounts ? options.accounts[authorization ?? ""] : "anonymous";
    if (!account) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="mcp-fixture"');
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    let session = sessionId ? sessions.get(sessionId) : undefined;
    if (session && session.account !== account) {
      res.status(403).json({ error: "wrong_account" });
      return;
    }
    try {
      if (!session && !sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
        const fixture = createMcpFixtureServer({ account });
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (id: string): void => { sessions.set(id, { transport, fixture, account }); }
        });
        fixtures.push(fixture);
        session = { transport, fixture, account };
        await fixture.server.connect(transport);
      }
      if (!session) {
        res.status(404).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } });
        return;
      }
      await session.transport.handleRequest(req, res, req.body);
      if (req.method === "DELETE" && sessionId) {
        deletedSessions++;
        sessions.delete(sessionId);
        await session.fixture.server.close();
      }
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: "fixture_request_failed" });
      else res.end();
    }
  });
  server = await new Promise<HttpServer>((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback address");
  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    fixtures,
    sessions,
    get deletedSessions() { return deletedSessions; },
    async close() {
      await Promise.all(fixtures.map(fixture => fixture.server.close()));
      sessions.clear();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
}
