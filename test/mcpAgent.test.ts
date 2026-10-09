import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { AgentLoopRunner } from "../src/agents/runtime/AgentLoopRunner";
import type { LLMService } from "../src/llm/LLMService";
import { applyMcpConfigurationPatch, parseMcpConfiguration } from "../src/mcp/client/configuration";
import { MCP_MEDIA_DIR } from "../src/mcp/client/ExternalMcpExecutor";
import { McpClientManager } from "../src/mcp/client/McpClientManager";
import type { McpApprovalMode, McpClientService, McpConnector, McpDiscoveredTool } from "../src/mcp/client/types";
import { SessionSettingsStore } from "../src/session/SessionSettingsStore";
import { OperationExecutor, type OperationInput } from "../src/tools/OperationExecutor";
import type { ExecutionContext, LLMImage, LLMRequest } from "../src/types";

// A real 1x1 PNG, as a viewport screenshot would arrive (base64 in an MCP image item).
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const tools: Tool[] = [
  { name: "look", description: "Screenshot of the viewport", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "execute_blender_code", description: "Run Python in Blender", inputSchema: {
    type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false } }
];

function clients(): { service: McpClientService; calls: string[] } {
  const calls: string[] = [];
  const discovered = (tool: Tool): McpDiscoveredTool => ({ id: `mcp:blender:${tool.name}`, bindingId: "blender", serverId: "blender", definition: tool });
  const service: McpClientService = {
    list: () => [{ bindingId: "blender", serverId: "blender", enabled: true, state: "connected", reconnectAttempt: 0 }],
    status: () => ({ bindingId: "blender", serverId: "blender", enabled: true, state: "connected", reconnectAttempt: 0 }),
    tools: () => tools.map(discovered),
    connect: async () => ({ bindingId: "blender", serverId: "blender", enabled: true, state: "connected", reconnectAttempt: 0 }),
    disconnect: async () => {}, discoverTools: async () => tools.map(discovered),
    callTool: async request => {
      calls.push(request.toolName);
      const result: CallToolResult = request.toolName === "look"
        ? { content: [{ type: "text", text: "Viewport" }, { type: "image", data: PNG, mimeType: "image/png" }] }
        : { content: [{ type: "text", text: "done" }] };
      return { callId: "c", bindingId: "blender", toolId: `mcp:blender:${request.toolName}`, outcome: "success", durationMs: 1, result };
    },
    reconcile: async () => {}, subscribe: () => () => {}, dispose: async () => {}
  };
  return { service, calls };
}

async function folder(t: test.TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lcai-mcp-agent-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const operation = (root: string, tool: string, args: Record<string, unknown>, extra: Partial<OperationInput> = {}): OperationInput => ({
  id: `op-${tool}-${JSON.stringify(args).length}-${extra.accessMode ?? "default"}`, agentRunId: "run:agent:main", tool, arguments: args, accessMode: "default",
  workspace: { version: 1, kind: "project", rootPath: root, outputDir: root, allowedDirectories: [root], memoryScope: "project:test" }, pauseForApproval: true, ...extra
});

test("a server's approval mode decides which calls wait; a chat that asks first always asks", async t => {
  const root = await folder(t);
  for (const [mode, access, tool, waits] of [
    ["ask", "default", "look", true], ["read-only", "default", "look", false], ["read-only", "default", "execute_blender_code", true],
    ["trust", "default", "execute_blender_code", false], ["trust", "ask", "execute_blender_code", true]
  ] as Array<[McpApprovalMode, "ask" | "default", string, boolean]>) {
    const f = clients();
    const executor = new OperationExecutor(path.join(root, `${mode}-${access}-${tool}`), undefined, f.service, () => ({ approval: mode }));
    const args = tool === "look" ? {} : { code: "print(1)" };
    const found = JSON.parse((await executor.execute(operation(root, "mcp.search", { query: tool }, { accessMode: access }))).result!.output);
    assert.equal(found.find((item: { name: string }) => item.name === tool).approvalRequired, waits, `${mode}/${access}/${tool} in search`);
    const outcome = await executor.execute(operation(root, "mcp.call", { toolId: `mcp:blender:${tool}`, argumentsJson: JSON.stringify(args) }, { accessMode: access }));
    assert.equal(Boolean(outcome.pendingApproval), waits, `${mode}/${access}/${tool}`);
    assert.deepEqual(f.calls, waits ? [] : [tool]);
  }
});

test("wrong arguments come back with what is wrong, so the model can correct them", async t => {
  const root = await folder(t);
  const executor = new OperationExecutor(root, undefined, clients().service, () => ({ approval: "trust" }));
  const output = (await executor.execute(operation(root, "mcp.call", { toolId: "mcp:blender:execute_blender_code", argumentsJson: '{"script":"print(1)"}' }))).result!.output;
  assert.match(output, /must have required property 'code'/);
  assert.match(output, /must NOT have additional properties "script"/);
  assert.match((await executor.execute(operation(root, "mcp.call", { toolId: "mcp:blender:look", argumentsJson: "{oops" }))).result!.output, /argumentsJson must be one serialized JSON object/);
});

test("an image a tool returns is kept in a file, not as base64 in the result", async t => {
  const root = await folder(t);
  const executor = new OperationExecutor(root, undefined, clients().service, () => ({ approval: "trust" }));
  const result = (await executor.execute(operation(root, "mcp.call", { toolId: "mcp:blender:look", argumentsJson: "{}" }))).result!;
  assert.equal(result.output.includes(PNG.slice(0, 40)), false);
  assert.deepEqual(JSON.parse(result.output).content[1], { type: "image", mimeType: "image/png", bytes: Buffer.from(PNG, "base64").length, image: 1 });
  const [image] = result.metadata!.images as Array<{ file: string; mimeType: string }>;
  assert.deepEqual(await fs.readFile(path.join(root, MCP_MEDIA_DIR, image!.file)), Buffer.from(PNG, "base64"));
});

async function agent(t: test.TestContext, options: { vision?: boolean; deviceRun?: boolean } = {}) {
  const root = await folder(t);
  const settings = await new SessionSettingsStore({ baseDir: root }, { providerId: "fixture", model: "test" }, {}).get("chat");
  const context: ExecutionContext = { actor: { sessionId: "chat", channel: "http" }, memory: [], conversation: [], providerId: "fixture",
    activeTarget: settings.defaultTarget, sessionSettings: settings, ...(options.deviceRun ? { requestMetadata: { deviceRun: true } } : {}),
    workspace: { version: 1, kind: "project", projectId: "p", rootPath: root, outputDir: root, allowedDirectories: [root], memoryScope: "project:p" } };
  const f = clients();
  const operations = new OperationExecutor(root, undefined, f.service, () => ({ approval: "trust" }));
  const requests: LLMRequest[] = [];
  let turns: Array<Record<string, unknown>> = [];
  const llm = { generateObject: async (request: LLMRequest) => {
    requests.push(request);
    const data = turns.shift() ?? { type: "final", text: "Done." };
    return { data, response: { provider: "fixture", model: "test", text: JSON.stringify(data), usage: { totalTokens: 1 } } };
  } } as unknown as LLMService;
  const runner = new AgentLoopRunner(llm, operations, root, {}, () => options.vision);
  const run = (id: string) => runner.run({ id: `${id}:agent:main`, input: "Look at the scene.", instructions: "", context, target: context.activeTarget });
  return { root, calls: f.calls, requests, run, set: (values: typeof turns) => { turns = values; } };
}
const call = (tool: string, args: Record<string, unknown> = {}) => ({ type: "tool_call", tool: "mcp.call", arguments: { toolId: `mcp:blender:${tool}`, argumentsJson: JSON.stringify(args) } });

test("a model that sees images gets the screenshot on its next step; one that does not is told so", async t => {
  const seeing = await agent(t, { vision: true });
  seeing.set([call("look")]);
  assert.equal((await seeing.run("vision")).text, "Done.");
  const images = seeing.requests[1]!.images as LLMImage[];
  assert.equal(images.length, 1);
  assert.equal(images[0]!.dataUrl, `data:image/png;base64,${PNG}`);
  assert.match(seeing.requests[1]!.prompt, /image\(s\) attached to this request come from the latest tool result \(look\)/);
  assert.equal(seeing.requests[1]!.prompt.includes(PNG.slice(0, 40)), false, "the transcript names the image, never its data");

  const blind = await agent(t, { vision: false });
  blind.set([call("look")]);
  await blind.run("blind");
  assert.equal(blind.requests[1]!.images, undefined);
  assert.match(blind.requests[1]!.prompt, /This model cannot see images/);

  // LM Studio, Ollama: whether the model sees images is not known, so none is sent.
  const unknown = await agent(t, {});
  unknown.set([call("look")]);
  await unknown.run("unknown");
  assert.equal(unknown.requests[1]!.images, undefined);
  assert.match(unknown.requests[1]!.prompt, /its image support is not known/);
});

test("an MCP call may repeat (the editor changes between calls), but not three times in a row", async t => {
  const f = await agent(t, { vision: false });
  f.set([call("look"), call("execute_blender_code", { code: "x" }), call("look"), call("look"), call("look")]);
  await f.run("repeat");
  assert.deepEqual(f.calls, ["look", "execute_blender_code", "look", "look"]);
  assert.match(f.requests[5]!.prompt, /Repeated identical action/);
});

test("a paired device's turn is not offered the host's MCP tools", async t => {
  const f = await agent(t, { deviceRun: true });
  f.set([call("look")]);
  await f.run("device");
  assert.deepEqual(f.calls, []);
  assert.doesNotMatch(f.requests[0]!.systemPrompt ?? "", /mcp\.search/);
  assert.match(f.requests[1]!.prompt, /not available in this context/);
});

test("an approval mode is checked on save, and changing it or a name keeps the server running; null removes a field", async t => {
  const base = parseMcpConfiguration({ servers: { blender: { id: "blender", enabled: true, transport: "stdio", command: "uvx", args: ["blender-mcp"], cwd: "/tmp", env: { A: "1" } } },
    bindings: { blender: { id: "blender", serverId: "blender", enabled: true } } });
  assert.throws(() => applyMcpConfigurationPatch(base, { servers: { blender: { approval: "sometimes" as McpApprovalMode } } }));
  const trusted = applyMcpConfigurationPatch(base, { servers: { blender: { approval: "trust", name: "Blender" } } });
  assert.equal(trusted.servers.blender!.approval, "trust");
  const cleared = applyMcpConfigurationPatch(trusted, { servers: { blender: { approval: null, cwd: null, env: null } as never } });
  assert.deepEqual([cleared.servers.blender!.approval, (cleared.servers.blender as { cwd?: string }).cwd, (cleared.servers.blender as { env?: object }).env], [undefined, undefined, undefined]);

  let opens = 0;
  const connector: McpConnector = { open: async () => { opens++; return { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), close: async () => {} }; } };
  const manager = new McpClientManager({ connector });
  t.after(() => manager.dispose());
  await manager.reconcile(base);
  await manager.reconcile(trusted);
  assert.equal(opens, 1, "the server process is not restarted");
});

test("arguments with raw line breaks in a string, or text after the object, are read as the object the tool gets", async t => {
  const root = await folder(t);
  const f = clients();
  const calls: unknown[] = [];
  const service = { ...f.service, callTool: async (request: Parameters<McpClientService["callTool"]>[0]) => { calls.push(request.arguments); return f.service.callTool(request); } };
  const executor = new OperationExecutor(root, undefined, service, () => ({ approval: "trust" }));
  const code = "import bpy\nfor o in bpy.data.objects:\n\tprint(o.name)";
  const raw = `{"code":"${code}"}`;
  assert.equal((await executor.execute(operation(root, "mcp.call", { toolId: "mcp:blender:execute_blender_code", argumentsJson: raw }))).result!.ok, true);
  assert.equal((await executor.execute({ ...operation(root, "mcp.call", { toolId: "mcp:blender:execute_blender_code", argumentsJson: '{"code":"x"}}' }), id: "op-trailing" })).result!.ok, true);
  // Python's own escapes inside the code string (\d, \.) mean a backslash.
  assert.equal((await executor.execute({ ...operation(root, "mcp.call", { toolId: "mcp:blender:execute_blender_code", argumentsJson: String.raw`{"code":"re.match(r'\d+\.blend', n)"}` }), id: "op-escape" })).result!.ok, true);
  assert.deepEqual(calls, [{ code }, { code: "x" }, { code: String.raw`re.match(r'\d+\.blend', n)` }]);
  assert.match((await executor.execute({ ...operation(root, "mcp.call", { toolId: "mcp:blender:execute_blender_code", argumentsJson: '{"code": ' }), id: "op-cut" })).result!.output,
    /argumentsJson must be one serialized JSON object/, "an unfinished object is still refused");
});

test("a server's tool filter hides tools from agents, and changing it or the call timeout keeps the server running", async t => {
  const root = await folder(t);
  const executor = new OperationExecutor(root, undefined, clients().service, () => ({ approval: "trust", disabledTools: ["execute_blender_code"] }));
  const found = JSON.parse((await executor.execute(operation(root, "mcp.search", { query: "" }))).result!.output);
  assert.deepEqual(found.map((tool: { name: string }) => tool.name), ["look"]);
  assert.match((await executor.execute(operation(root, "mcp.call", { toolId: "mcp:blender:execute_blender_code", argumentsJson: '{"code":"x"}' }))).result!.output, /unavailable/);
  const only = new OperationExecutor(path.join(root, "only"), undefined, clients().service, () => ({ approval: "trust", enabledTools: ["execute_blender_code"] }));
  assert.deepEqual(JSON.parse((await only.execute(operation(root, "mcp.search", { query: "" }))).result!.output).map((tool: { name: string }) => tool.name), ["execute_blender_code"]);

  const base = parseMcpConfiguration({ servers: { blender: { id: "blender", enabled: true, transport: "stdio", command: "uvx" } },
    bindings: { blender: { id: "blender", serverId: "blender", enabled: true } } });
  assert.throws(() => applyMcpConfigurationPatch(base, { servers: { blender: { disabledTools: ["look", "look"] } } }), "a tool named twice");
  let opens = 0;
  const connector: McpConnector = { open: async () => { opens++; return { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), close: async () => {} }; } };
  const manager = new McpClientManager({ connector });
  t.after(() => manager.dispose());
  await manager.reconcile(base);
  await manager.reconcile(applyMcpConfigurationPatch(base, { servers: { blender: { disabledTools: ["look"], requestTimeoutMs: 120000 } } }));
  assert.equal(opens, 1, "filters and the call timeout do not restart it");
  await manager.reconcile(applyMcpConfigurationPatch(base, { servers: { blender: { connectTimeoutMs: 90000 } } }));
  assert.equal(opens, 2, "a new startup timeout starts it again");
});
