import assert from "node:assert/strict";
import test from "node:test";
import { setDiagnosticSink } from "../src/diagnostics/DiagnosticLog";
import { LLMRegistry } from "../src/llm/LLMRegistry";
import { LLMService } from "../src/llm/LLMService";
import { OpenAICompatibleProvider } from "../src/llm/OpenAICompatibleProvider";
import { OutputSanitizer } from "../src/llm/OutputSanitizer";
import { McpClientManager } from "../src/mcp/client/McpClientManager";
import { Logger } from "../src/utils/Logger";

const CANARY = "sk-CANARY-7f3a9 /Users/canary/secret-project prompt: my diary";

test("failures reach the technical log as codes: a provider's refusal and an MCP server that cannot start", async t => {
  const recorded: Array<[string, unknown]> = [];
  setDiagnosticSink({ record: (event, fields) => { recorded.push([event, fields]); } });
  t.after(() => setDiagnosticSink(undefined));

  const registry = new LLMRegistry();
  const transport = (async () => new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${CANARY}` } }), { status: 401, headers: { "content-type": "application/json" } })) as typeof fetch;
  registry.register(new OpenAICompatibleProvider({ id: "openai", name: "OpenAI", model: "gpt-x", baseUrl: "https://api.example/v1", apiKey: CANARY, timeoutMs: 5000 }, new Logger(), transport));
  const llm = new LLMService(registry, "openai", new Logger(), new OutputSanitizer());
  const response = await llm.generateText({ prompt: CANARY });
  assert.match(response.error ?? "", /401/);

  const manager = new McpClientManager();
  t.after(() => manager.dispose());
  await manager.reconcile({ servers: { editor: { id: "editor", name: "Editor", transport: "stdio", command: "/Users/canary/secret-project/no-such-mcp", args: [CANARY], enabled: true } as never },
    bindings: { editor: { id: "editor", serverId: "editor", enabled: true } } });

  assert.deepEqual(recorded, [
    ["provider.call_failed", { provider: "openai", outcome: "rejected", httpStatus: 401 }],
    ["mcp.connection_failed", { transport: "stdio", code: "command_not_found" }]
  ]);
  assert.equal(JSON.stringify(recorded).includes("CANARY") || JSON.stringify(recorded).includes("canary"), false);
});
