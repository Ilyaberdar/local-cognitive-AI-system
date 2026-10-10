import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppSettingsStore } from "../src/app/AppSettingsStore";
import { RuntimeManager } from "../src/app/RuntimeManager";
import { AppConfig, config } from "../src/config/config";
import { bugReportFormSchema, clientDiagnostics, composeBugReport } from "../src/diagnostics/BugReport";
import { DiagnosticLog, setDiagnosticSink } from "../src/diagnostics/DiagnosticLog";
import { rewriteAppFrames, scrubSentryBreadcrumb, scrubSentryEvent } from "../src/diagnostics/sentryScrub";
import { collectRuntimeDiagnostics } from "../src/diagnostics/snapshot";
import { createDiagnosticsOperations } from "../src/runtime/diagnosticsOperations";
import { Logger } from "../src/utils/Logger";

// Secrets and private text in the forms they really take, planted where failures pick things up.
const CANARY = {
  providerKey: `sk-proj-${randomBytes(24).toString("base64url")}`,
  prompt: "canary prompt: please summarise my private diary entry",
  toolOutput: "canary tool output: rows of the customer table",
  oauthState: randomBytes(32).toString("base64url"),
  pairingKey: `LCR1-${"A".repeat(40)}${randomBytes(60).toString("hex").toUpperCase().replace(/[^A-Z2-7]/g, "Q").slice(0, 124)}-ABCDEFG`,
  folder: "canary-secret-project"
};

test("canaries never leave: the technical log, diagnostics, a bug report, error events and the server's diagnostics", { timeout: 30_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${CANARY.folder}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // A provider that refuses the key and echoes what it was sent.
  const provider = http.createServer((request, response) => {
    let body = ""; request.on("data", chunk => { body += chunk; });
    request.on("end", () => { response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${CANARY.providerKey}. Request: ${body.slice(0, 500)}` } })); });
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => provider.close(() => resolve())));
  const providers = Object.fromEntries(Object.entries(config.providers).map(([id, value]) => [id, { ...value, enabled: false, apiKey: "" }])) as AppConfig["providers"];
  providers.openai = { ...providers.openai, enabled: true, apiKey: CANARY.providerKey, baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`, model: "gpt-x" } as never;
  const options: AppConfig = {
    ...config, providers, appDataDir: path.join(root, "app"), llm: { ...config.llm, defaultProvider: "openai" },
    mcp: { ...config.mcp, client: {
      servers: { editor: { id: "editor", enabled: true, transport: "stdio", command: path.join(root, "bin", "no-such-mcp"), args: [CANARY.toolOutput, CANARY.oauthState],
        connectTimeoutMs: 2000, requestTimeoutMs: 2000, reconnect: { maxAttempts: 0, initialDelayMs: 10, maxDelayMs: 10 } } as never },
      bindings: { editor: { id: "editor", serverId: "editor", enabled: true } } } },
    sessions: { baseDir: path.join(root, "sessions") }, memory: { ...config.memory, adapter: "local-json", baseDir: path.join(root, "memory") },
    outputDir: path.join(root, "output"), plugins: { dir: path.resolve(process.cwd(), "plugins"), overrides: {} },
    telegram: { ...config.telegram, enabled: false, botToken: "" },
    localModels: { ...config.localModels!, runtimeDir: path.join(root, "runtime"), executablePath: undefined, modelsDir: path.join(root, "models"), contextSize: 4096 }
  };
  const log = new DiagnosticLog(path.join(options.appDataDir, "diagnostics"));
  setDiagnosticSink(log);
  t.after(() => setDiagnosticSink(undefined));
  const manager = new RuntimeManager(options, new AppSettingsStore(options.appDataDir, options), new Logger());
  await manager.init();
  t.after(() => manager.dispose());

  // Failures: the provider refuses (its answer carries the key and the prompt); the MCP server cannot start.
  const answer = await manager.getRuntime().llmService.generateText({ prompt: CANARY.prompt }, "openai");
  assert.match(answer.error ?? "", /401/);
  assert.ok(log.tail().some(entry => entry.event === "provider.call_failed"), "the refusal is in the log");
  assert.ok(log.tail().some(entry => entry.event === "mcp.connection_failed"), "so is the MCP failure");

  // An uncaught error as the error tracker would get it, carrying everything at once.
  const crash = scrubSentryEvent(rewriteAppFrames({
    server_name: os.hostname(), user: { ip_address: "203.0.113.7" }, extra: { pairing: CANARY.pairingKey },
    breadcrumbs: [{ category: "console", message: CANARY.toolOutput }, { category: "lc", message: "provider.call_failed", data: { httpStatus: 401 } }],
    exception: { values: [{ type: "SyntaxError", stacktrace: { frames: [{ filename: path.join(root, "app", "plugin.js"), context_line: CANARY.prompt }] },
      value: `OAuth callback ${CANARY.oauthState} for ${path.join(root, "notes.md")} with ${CANARY.providerKey} on ${os.hostname()}: Unexpected token 'c', "${CANARY.prompt}" is not valid JSON; key ${CANARY.pairingKey}` }] }
  }, "/opt/local-cognitive/app"), true);
  const crumb = scrubSentryBreadcrumb({ category: "console", message: CANARY.toolOutput });

  // A bug report with everything attached, and the server's diagnostics with its log.
  const runtime = await collectRuntimeDiagnostics({ runtimeManager: manager, diagnosticLog: log, runtimeKind: "desktop" });
  const server = await createDiagnosticsOperations({ runtimeManager: manager, diagnosticLog: log, owner: () => "owner", status: () => ({ phase: "running", activeWork: { chatRuns: 0 } }) })
    ["diagnostics.collect"]!({ includeLog: true }, { accountId: "owner", deviceId: "d", signal: new AbortController().signal });
  const reportId = randomUUID();
  const report = composeBugReport(bugReportFormSchema.parse({ reportId, message: "It stopped working", include: { diagnostics: true, screenshot: false } }), {
    reportId, createdAt: new Date().toISOString(), appVersion: "0.1.0", log: log.tail(), server,
    diagnostics: { client: clientDiagnostics({ versions: process.versions as Record<string, string>, osVersion: "15.0", signedIn: true, remote: { state: "online", hostName: os.hostname() } as never }), runtime }
  });

  const leaving = JSON.stringify({ log: fs.readFileSync(log.file, "utf8"), tail: log.tail(), runtime, server, report: report.file, attachments: report.attachments.map(item => String(item.data)), crash, crumb });
  for (const [name, canary] of Object.entries(CANARY)) assert.equal(leaving.includes(canary), false, `${name} left`);
  if (os.hostname().length >= 6) assert.equal(leaving.toLowerCase().includes(os.hostname().toLowerCase()), false, "the computer's name left");
  assert.equal(leaving.includes("203.0.113.7"), false, "an address left");
  assert.equal(leaving.includes(root), false, "a folder left");
});
