import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ExternalMcpExecutor } from "../src/mcp/client/ExternalMcpExecutor";
import type { McpClientService, McpDiscoveredTool } from "../src/mcp/client/types";
import type { OperationInput } from "../src/tools/OperationExecutor";
import { agentFunctionTools } from "../src/tools/AgentTool";

const definition: Tool = {
  name: "spawn_actor", description: "Spawn an actor in the current Unreal level",
  inputSchema: { type: "object", properties: { className: { type: "string" } }, required: ["className"], additionalProperties: false }
};

async function fixture(t: test.TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lcai-external-mcp-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tool: McpDiscoveredTool = { id: "mcp:unreal:spawn_actor", bindingId: "unreal", serverId: "unreal", definition };
  const calls: Array<{ bindingId: string; toolName: string; arguments: unknown }> = [];
  const clients: McpClientService = {
    list: () => [{ bindingId: "unreal", serverId: "unreal", enabled: true, state: "connected", reconnectAttempt: 0 }],
    status: () => ({ bindingId: "unreal", serverId: "unreal", enabled: true, state: "connected", reconnectAttempt: 0 }),
    tools: () => [structuredClone(tool)],
    connect: async () => ({ bindingId: "unreal", serverId: "unreal", enabled: true, state: "connected", reconnectAttempt: 0 }),
    disconnect: async () => {}, discoverTools: async () => [structuredClone(tool)],
    callTool: async request => {
      calls.push({ bindingId: request.bindingId, toolName: request.toolName, arguments: request.arguments });
      return { callId: "call-1", bindingId: request.bindingId, toolId: tool.id, outcome: "success",
        durationMs: 1, result: { content: [{ type: "text", text: "Actor created" }], structuredContent: { actor: "Cube" } } };
    },
    reconcile: async () => {}, subscribe: () => () => {}, dispose: async () => {}
  };
  const workspace = { version: 1 as const, kind: "project" as const, rootPath: root, outputDir: root, allowedDirectories: [root], memoryScope: "project:test" };
  const operation = (): OperationInput => ({ id: "operation-1", agentRunId: "run:agent:main", workspace, accessMode: "full", tool: "mcp.call",
    arguments: { toolId: tool.id, argumentsJson: '{"className":"StaticMeshActor"}' }, pauseForApproval: true });
  return { executor: new ExternalMcpExecutor(root, clients), calls, operation };
}

test("external MCP tools are discoverable and calls are approval-gated, journaled, and not replayed", async t => {
  const f = await fixture(t);
  const discovery = await f.executor.execute({ ...f.operation(), tool: "mcp.search", arguments: { query: "spawn unreal" } });
  assert.deepEqual(JSON.parse(discovery.result!.output), [{
    id: "mcp:unreal:spawn_actor", serverId: "unreal", bindingId: "unreal", name: "spawn_actor",
    description: "Spawn an actor in the current Unreal level", inputSchema: definition.inputSchema, approvalRequired: true
  }]);

  const operation = f.operation();
  const pending = await f.executor.execute(operation);
  assert.ok(pending.pendingApproval);
  assert.equal(f.calls.length, 0);
  operation.approval = { id: pending.pendingApproval!.id, approved: true };
  const completed = await f.executor.execute(operation);
  assert.equal(completed.result?.ok, true);
  assert.deepEqual(f.calls, [{ bindingId: "unreal", toolName: "spawn_actor", arguments: { className: "StaticMeshActor" } }]);
  assert.equal((await f.executor.execute(operation)).result?.ok, true);
  assert.equal(f.calls.length, 1, "a completed external call is never automatically replayed");
});

test("external MCP tool schemas are enforced before an approval or remote call", async t => {
  const f = await fixture(t);
  const invalid = f.operation(); invalid.arguments = { toolId: "mcp:unreal:spawn_actor", argumentsJson: '{"unexpected":true}' };
  const result = await f.executor.execute(invalid);
  assert.equal(result.result?.ok, false);
  assert.match(result.result!.output, /schema/);
  assert.equal(f.calls.length, 0);
});

test("agents receive MCP discovery and invocation dispatchers only when an external server is available", () => {
  assert.deepEqual(agentFunctionTools(false, { mcp: true, pluginOnly: true }).map(tool => tool.action), ["mcp.search", "mcp.call"]);
  assert.deepEqual(agentFunctionTools(true, { mcp: true, pluginOnly: true }).map(tool => tool.action), ["mcp.search"]);
  assert.ok(!agentFunctionTools(false, { pluginOnly: true }).some(tool => tool.action.startsWith("mcp.")));
});
