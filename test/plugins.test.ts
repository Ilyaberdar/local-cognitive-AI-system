import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import test, { TestContext } from "node:test";
import http from "node:http";
import express from "express";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { PluginManager } from "../src/plugins/PluginManager";
import { CredentialVault, IntegrationAdapter, PluginInvocationError } from "../src/plugins/contracts";
import { pluginCatalog, catalogEntry } from "../src/plugins/catalog";
import { EncryptedCredentialVault } from "../src/plugins/EncryptedCredentialVault";
import { OAuthConnections, loadOAuthClientRegistrations } from "../src/plugins/OAuthConnections";
import { nativeTools, callNative } from "../src/plugins/NativeServiceTools";
import { compileToolArguments } from "../src/mcp/client/schema";
import { OperationInput, OperationExecutor } from "../src/tools/OperationExecutor";
import { AgentLoopRunner } from "../src/agents/runtime/AgentLoopRunner";
import { SessionSettingsStore } from "../src/session/SessionSettingsStore";
import { ExecutionContext, LLMRequest } from "../src/types";
import { LLMService } from "../src/llm/LLMService";
import { CognitiveEngine } from "../src/core/CognitiveEngine";
import { CodeAgentCoordinator } from "../src/agents/code/CodeAgentCoordinator";
import { WorkspaceResolver } from "../src/workspace/WorkspaceResolver";
import { ProjectStore } from "../src/projects/ProjectStore";
import { SessionIndexStore } from "../src/session/SessionIndexStore";
import { MemoryService } from "../src/memory/MemoryService";
import { LocalJsonMemoryAdapter } from "../src/memory/LocalJsonMemoryAdapter";
import { VectorStore } from "../src/memory/VectorStore";
import { Logger } from "../src/utils/Logger";
import { Router } from "../src/core/Router";
import { ModeDetector } from "../src/core/ModeDetector";
import { ToolRegistry } from "../src/tools/ToolRegistry";
import { ToolRequestBuilder } from "../src/core/ToolRequestBuilder";
import { AgentNodeExecutor } from "../src/workflows/nodes/AgentNodeExecutor";
import { NodeExecutionContext } from "../src/workflows/nodes/NodeExecutor";
import { integrationOriginGuard, localApiOriginGuard } from "../src/api/integrationControllers";
import { AppSettingsStore } from "../src/app/AppSettingsStore";
import { config } from "../src/config/config";
import { agentFunctionTools, agentActionFormat } from "../src/tools/AgentTool";
import { DirectIntegrationAdapter } from "../src/plugins/DirectIntegrationAdapter";
import { McpClientManager } from "../src/mcp/client/McpClientManager";
import { createMcpHttpFixture } from "./fixtures/mcpHttp";

const read: Tool = { name: "search", description: "Search Notion notes", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } };
const write: Tool = { name: "create_note", description: "Create a Notion note", annotations: { readOnlyHint: false }, inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } };
const memoryVault = () => {
  const data = new Map<string, string>();
  const vault: CredentialVault = { available: () => true, read: async key => data.get(key), write: async (key, value) => { data.set(key, value); }, remove: async key => { data.delete(key); } };
  return { data, vault };
};
async function temporary(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lcai-integrations-")));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
async function fixture(t: TestContext) {
  const root = await temporary(t), effects: unknown[] = [], definitions = [read, write];
  const adapter: IntegrationAdapter = { id: "fixture", ready: async () => ({ ready: true }),
    connect: async (_plugin, _owner, id) => ({ accountRef: id, authorizationUrl: "https://notion.so/fixture-consent" }),
    inspect: async () => ({ state: "connected", label: "Test account", tools: structuredClone(definitions) }),
    call: async (_plugin, _connection, tool, args) => { effects.push({ name: tool.name, args }); return { content: [{ type: "text", text: `Observed ${tool.name}: actual note from service` }] }; },
    disconnect: async () => {} };
  const manager = new PluginManager(root, "local:owner-a", [adapter]); t.after(() => manager.dispose());
  await manager.install("notion");
  const { connectionId } = await manager.connect("notion"); await manager.refresh(connectionId);
  await manager.configure("notion", { permission: "read-write", enabled: true });
  const workspace = { version: 1 as const, kind: "project" as const, rootPath: root, outputDir: root, allowedDirectories: [root], memoryScope: "project:fixture" };
  const operation = (name = "create_note", args = { text: "approved contents" } as Record<string, unknown>): OperationInput => ({
    id: randomUUID(), agentRunId: "run:agent:main", workspace, accessMode: "full", tool: "plugins.call",
    arguments: { toolId: `notion:${connectionId}:${name}`, argumentsJson: JSON.stringify(args) }, pauseForApproval: true
  });
  return { root, effects, definitions, adapter, manager, connectionId, workspace, operation };
}

test("curated catalog has ten real adapters, no legacy loader, no implicit account access", async t => {
  const f = await fixture(t);
  assert.equal(pluginCatalog.length, 10); assert.equal(new Set(pluginCatalog.map(item => item.id)).size, 10);
  assert.ok(pluginCatalog.every(plugin => plugin.mcpEndpoint || nativeTools[plugin.id]?.length));
  assert.ok(!pluginCatalog.some(plugin => ["file", "vscode"].includes(plugin.id)));
  await f.manager.install("slack");
  const slack = (await f.manager.snapshot()).catalog.find(item => item.id === "slack")!;
  assert.equal(slack.installation?.enabled, false); assert.equal(slack.installation?.permission, "none");
  await assert.rejects(f.manager.configure("slack", { enabled: true, permission: "read" }), /Connect an account/);
  await f.manager.configure("notion", { permission: "read" });
  assert.deepEqual((await f.manager.search("notion")).map(tool => tool.readOnly), [true]);
  const malformed = await f.manager.execute(f.operation("search", { unexpected: true }));
  assert.match(malformed.result!.output, /schema/); assert.equal(f.effects.length, 0);
});

test("mention choices cover all ten catalog services and remove disabled, disconnected or ungranted accounts", async t => {
  const f = await fixture(t);
  for (const plugin of pluginCatalog.filter(item => item.id !== 'notion')) {
    await f.manager.install(plugin.id);
    const { connectionId } = await f.manager.connect(plugin.id); await f.manager.refresh(connectionId);
    await f.manager.configure(plugin.id, { enabled: true, permission: 'read' });
  }
  assert.equal((await f.manager.choices()).length, 10);
  assert.ok((await f.manager.choices()).every(choice => choice.icon.startsWith('/assets/plugin-icons/')));
  await f.manager.configure('slack', { enabled: false });
  await f.manager.configure('github', { permission: 'none', enabled: false });
  await f.manager.disconnect(f.connectionId);
  const choices = await f.manager.choices();
  assert.equal(choices.length, 7); assert.ok(!choices.some(choice => ['notion', 'slack', 'github'].includes(choice.id)));
  await assert.rejects(f.manager.validateSelection(['notion']), /not available/);
});

test("explicit plugin selection scopes search and dispatch and fences saved approvals", async t => {
  const f = await fixture(t);
  await f.manager.install('google-drive');
  const { connectionId } = await f.manager.connect('google-drive'); await f.manager.refresh(connectionId);
  await f.manager.configure('google-drive', { enabled: true, permission: 'read' });
  const scoped = { ...f.operation('search', { query: 'notes' }), pluginIds: ['notion'] };
  const discovery = await f.manager.execute({ ...scoped, tool: 'plugins.search', arguments: { query: '' } });
  assert.ok(JSON.parse(discovery.result!.output).every((tool: { plugin: string }) => tool.plugin === 'notion'));
  assert.deepEqual(await f.manager.search('', false, []), []);
  const denied = await f.manager.execute({ ...scoped, arguments: { toolId: `google-drive:${connectionId}:search`, argumentsJson: '{"query":"files"}' } });
  assert.equal(denied.result?.ok, false); assert.match(denied.result!.output, /not selected/); assert.equal(f.effects.length, 0);
  assert.equal((await f.manager.execute({ ...scoped, pluginIds: [] })).result?.ok, false);
  assert.equal((await f.manager.execute(scoped)).result?.ok, true);
  const write = { ...f.operation(), pluginIds: ['notion'] };
  const pending = await f.manager.execute(write); assert.ok(pending.pendingApproval);
  await assert.rejects(f.manager.execute({ ...write, pluginIds: ['google-drive', 'notion'], approval: { id: pending.pendingApproval!.id, approved: true } }), /proposal changed/);
  assert.equal(f.effects.length, 1);
  await f.manager.configure('notion', { enabled: false });
  await assert.rejects(f.manager.execute(scoped), /not available/);
});

test("writes require approval even in Full; immutable proposal survives restart and executes once", async t => {
  const f = await fixture(t), operation = f.operation();
  const waiting = await f.manager.execute(operation); assert.ok(waiting.pendingApproval); assert.equal(f.effects.length, 0);
  await assert.rejects(f.manager.execute({ ...operation, arguments: { ...operation.arguments, argumentsJson: '{"text":"different"}' } }), /proposal changed/);
  const restarted = new PluginManager(f.root, "local:owner-a", [f.adapter]); t.after(() => restarted.dispose()); await restarted.restore();
  operation.approval = { id: waiting.pendingApproval.id, approved: true };
  const [first, replay] = await Promise.all([restarted.execute(operation), f.manager.execute(operation)]);
  assert.equal(first.result?.ok, true); assert.deepEqual(replay, first); assert.equal(f.effects.length, 1);
  assert.deepEqual(f.effects[0], { name: "create_note", args: { text: "approved contents" } });
});

test("denial is durable; changing account policy or schema invalidates a pending grant", async t => {
  const f = await fixture(t), denied = f.operation(); const pending = await f.manager.execute(denied);
  denied.approval = { id: pending.pendingApproval!.id, approved: false };
  assert.equal((await f.manager.execute(denied)).result?.metadata?.cancelled, true);
  denied.approval.approved = true;
  assert.equal((await f.manager.execute(denied)).result?.metadata?.cancelled, true);
  const changed = f.operation(); await f.manager.execute(changed);
  await f.manager.configure("notion", { enabled: false }); await f.manager.configure("notion", { enabled: true });
  changed.approval = { id: changed.id, approved: true };
  assert.equal((await f.manager.execute(changed)).result?.metadata?.permissionRequired, true);
  const schema = f.operation(); await f.manager.execute(schema);
  f.definitions[1] = { ...write, description: "Changed tool meaning" }; await f.manager.refresh(f.connectionId);
  schema.approval = { id: schema.id, approved: true };
  assert.equal((await f.manager.execute(schema)).result?.metadata?.permissionRequired, true);
  assert.equal(f.effects.length, 0);
});

test("unknown effects and completion journal failures never replay; disconnect cancels in-flight work", async t => {
  const f = await fixture(t); let failSave = false;
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (from: string, to: string) => { if (failSave && to.includes("operations")) { failSave = false; throw new Error("Disk full"); } return rename(from, to); });
  const call = f.adapter.call;
  f.adapter.call = async (...args) => { const result = await call(...args); failSave = true; return result; };
  const operation = f.operation(); operation.approval = { id: operation.id, approved: true };
  assert.equal((await f.manager.execute(operation)).result?.metadata?.unknown, true);
  assert.equal((await f.manager.execute(operation)).result?.metadata?.unknown, true); assert.equal(f.effects.length, 1);
  let entered!: () => void; const dispatch = new Promise<void>(resolve => { entered = resolve; });
  f.adapter.call = async (_p, _c, _t, _a, signal) => { entered(); await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true })); throw new Error("Unreachable"); };
  const cancelled = f.operation(); cancelled.approval = { id: cancelled.id, approved: true };
  const active = f.manager.execute(cancelled); await dispatch; await f.manager.disconnect(f.connectionId);
  assert.equal((await active).result?.metadata?.unknown, true); assert.equal((await f.manager.search("")).length, 0);
});

test("owner namespaces isolate installations, credentials and operation journals", async t => {
  const f = await fixture(t), other = new PluginManager(f.root, "account:another-user", [f.adapter]); t.after(() => other.dispose());
  assert.notEqual(other.store.directory, f.manager.store.directory);
  assert.equal((await other.snapshot()).connections.length, 0); assert.equal(await other.hasEnabled(), false);
  assert.equal((await other.execute(f.operation())).result?.ok, false);
  await f.manager.uninstall("notion"); assert.equal((await f.manager.snapshot()).connections.length, 1, "Uninstall retains independent connection lifecycle");
  assert.equal(await f.manager.hasEnabled(), false);
  await f.manager.dispose(); assert.deepEqual(await f.manager.search(""), []);
});

test("ordinary chat and workflow agent consume real plugin results and retain builtin files; tool catalogs are explicit", async t => {
  const f = await fixture(t), logger = new Logger();
  const sessions = new SessionIndexStore(f.root), settings = new SessionSettingsStore({ baseDir: path.join(f.root, "session-settings") }, { providerId: "fixture", model: "fixture" }, {});
  const session = await sessions.create("Plugin chat"); await settings.update(session.id, { mode: "general", defaultAccessMode: "full" });
  const resolver = new WorkspaceResolver({ appDataDir: f.root }, new ProjectStore(f.root), sessions);
  let turn = 0;
  const llm = { generateObject: async (request: LLMRequest) => {
    assert.match(request.systemPrompt ?? '', /explicitly selected these plugins/);
    assert.match(request.systemPrompt ?? '', /notion/);
    const index = turn++ % 3;
    const data = index === 0 ? { type: "tool_call", tool: "plugins.search", arguments: { query: "notion search" } }
      : index === 1 ? { type: "tool_call", tool: "plugins.call", arguments: { toolId: `notion:${f.connectionId}:search`, argumentsJson: '{"query":"project"}' } }
      : { type: "final", text: "Found the actual note from service." };
    if (index === 2) assert.match(request.prompt, /actual note from service/);
    return { data, response: { provider: "fixture", model: "fixture", text: JSON.stringify(data) } };
  } } as unknown as LLMService;
  const runner = new AgentLoopRunner(llm, new OperationExecutor(f.root, f.manager), f.root);
  const router = new Router(); router.register("general", async () => { throw new Error("Plugin-enabled chat must use tool loop"); });
  const engine = new CognitiveEngine(new ModeDetector(), router, new MemoryService(new LocalJsonMemoryAdapter({ baseDir: path.join(f.root, "memory"), topK: 5 }, new VectorStore(), logger)), settings, new ToolRegistry(), new ToolRequestBuilder(), logger,
    "fixture", () => false, resolver, new CodeAgentCoordinator(runner), f.manager);
  const chat = await engine.process({ input: "@notion Search my notes", actor: { sessionId: session.id, channel: "http" } });
  assert.equal(chat.result.error, undefined); assert.equal(chat.tools.length, 2); assert.equal(f.effects.length, 1);
  assert.equal((await sessions.get(session.id))?.projectId, undefined);
  const workflow = await new AgentNodeExecutor(engine).execute({ agentInput: "Search Notion for workflow evidence", agentRunId: "workflow-tool-read", workspace: f.workspace,
    node: { id: "agent", type: "agent", config: { providerId: "fixture", mode: "general", accessMode: "full", pluginIds: ['notion'] } },
    workflow: { id: "fixture", version: 1 }, run: { id: "run", executionSessionId: session.id }, settings: await settings.get(session.id)
  } as unknown as NodeExecutionContext);
  const finished = workflow.status === "needs_input" ? await new AgentNodeExecutor(engine).execute({ agentInput: "Search Notion for workflow evidence", agentRunId: "workflow-tool-read", workspace: f.workspace,
    node: { id: "agent", type: "agent", config: { providerId: "fixture", mode: "general", pluginIds: ['notion'] } }, workflow: { id: "fixture", version: 1 }, run: { id: "run", executionSessionId: session.id },
    settings: await settings.get(session.id), approval: { approvalId: workflow.data.approvalId, approved: true }
  } as unknown as NodeExecutionContext) : workflow;
  assert.equal(finished.status, "ok"); assert.match(String(finished.data.response), /actual note/); assert.equal(f.effects.length, 2);
  const tools = agentFunctionTools(false, { plugins: true, pluginOnly: true });
  assert.deepEqual(tools.map(tool => tool.name), ["plugins_search", "plugins_call"]);
  assert.ok(!JSON.stringify(agentActionFormat(false, false, { plugins: true, pluginOnly: true })).includes("file.write"));
  assert.ok(!agentFunctionTools().some(tool => tool.action.startsWith("plugins.")));
  let fileTurn = 0;
  t.mock.method(llm, "generateObject", async () => { const data = fileTurn++ === 0 ? { type: "tool_call", tool: "file.write", arguments: { path: "retained.txt", content: "builtin still works", expectedVersion: "missing" } } : { type: "final", text: "File created." };
    return { data, response: { provider: "fixture", model: "fixture", text: JSON.stringify(data) } }; });
  const written = await engine.process({ input: "Create retained.txt", actor: { sessionId: session.id, channel: "http" } });
  assert.equal(written.result.error, undefined);
  assert.equal(await fs.readFile(path.join((await resolver.forPluginChat(session.id)).rootPath, "retained.txt"), "utf8"), "builtin still works");
});

test("OAuth PKCE callback validates one-use state; refresh is serialized and owner-local", async t => {
  const { vault, data } = memoryVault(); const oauth = new OAuthConnections(vault, "local:oauth-owner"); t.after(() => oauth.dispose());
  const free = http.createServer(); await new Promise<void>(resolve => free.listen(0, "127.0.0.1", resolve));
  const port = (free.address() as { port: number }).port; await new Promise<void>(resolve => free.close(() => resolve()));
  await oauth.configure(catalogEntry("dropbox"), { clientId: "fixture-app", callbackPort: port });
  const original = globalThis.fetch; let exchanges = 0, verifier = "";
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("http://127.0.0.1")) return original(input, init);
    assert.equal(String(input), "https://api.dropboxapi.com/oauth2/token"); exchanges++;
    const body = init!.body as URLSearchParams;
    if (body.get("grant_type") === "authorization_code") { verifier = body.get("code_verifier")!; assert.equal(body.get("code"), "fixture-code"); }
    else assert.equal(body.get("refresh_token"), "refresh-secret");
    return Response.json({ access_token: exchanges === 1 ? "first-access-secret" : "renewed-access-secret", refresh_token: "refresh-secret", token_type: "Bearer", expires_in: exchanges === 1 ? 1 : 3600 });
  });
  const id = randomUUID(), attempt = await oauth.begin(catalogEntry("dropbox"), id), authUrl = new URL(attempt.authorizationUrl);
  const callback = new URL(authUrl.searchParams.get("redirect_uri")!); callback.searchParams.set("code", "fixture-code"); callback.searchParams.set("state", "wrong");
  assert.equal((await original(callback)).status, 400); assert.equal(exchanges, 0);
  callback.searchParams.set("state", authUrl.searchParams.get("state")!);
  assert.equal((await original(callback)).status, 200); assert.equal(exchanges, 1);
  assert.equal(createHash("sha256").update(verifier).digest("base64url"), authUrl.searchParams.get("code_challenge"));
  const connection = { id, accountRef: id, pluginId: "dropbox", ownerId: "local:oauth-owner", adapter: "direct", label: "Dropbox", createdAt: "now", revision: "1" };
  const refreshed = await Promise.all([oauth.accessToken(catalogEntry("dropbox"), connection), oauth.accessToken(catalogEntry("dropbox"), connection)]);
  assert.deepEqual(refreshed, ["renewed-access-secret", "renewed-access-secret"]); assert.equal(exchanges, 2);
  const other = new OAuthConnections(vault, "account:other"); t.after(() => other.dispose());
  await assert.rejects(other.accessToken(catalogEntry("dropbox"), connection), /another profile/);
  assert.ok([...data.keys()].every(key => key.includes("local:oauth-owner")));
  await oauth.remove(id); assert.ok(![...data.values()].some(value => value.includes("refresh-secret")));
  await assert.rejects(oauth.accessToken(catalogEntry("dropbox"), connection), /cancelled/);
});

test("application-owned native OAuth registrations are shared across profiles without sharing account credentials", async t => {
  const root = await temporary(t), file = path.join(root, 'clients.json');
  assert.deepEqual(await loadOAuthClientRegistrations(file), {});
  await fs.writeFile(file, JSON.stringify({ 'google-drive': { clientId: 'desktop-client', clientSecret: 'desktop-secret' } }));
  const registrations = await loadOAuthClientRegistrations(file);
  const { vault, data } = memoryVault();
  const owners = ['local:first', 'account:second'].map(owner => new OAuthConnections(vault, owner, registrations));
  t.after(() => owners.forEach(owner => owner.dispose()));
  for (const owner of owners) {
    const setup = await owner.configuration(catalogEntry('google-drive'));
    assert.equal(setup.configured, true); assert.equal(setup.clientId, 'desktop-client');
    assert.equal(setup.hasClientSecret, true); assert.ok(!JSON.stringify(setup).includes('desktop-secret'));
    await assert.rejects(owner.configure(catalogEntry('google-drive'), { clientId: 'replacement' }), /managed by the distributor/);
    assert.equal(await owner.connected('same-connection-id'), false);
  }
  assert.equal(data.size, 0, 'Reading a shared application registration must not create account tokens');
  await assert.rejects(owners[0].begin(catalogEntry('slack'), 'missing-registration'), /application developer/);
  await fs.writeFile(file, JSON.stringify({ unknown: { clientId: 'invalid' } }));
  await assert.rejects(loadOAuthClientRegistrations(file), /Unknown OAuth/);
  await fs.writeFile(file, JSON.stringify({ github: { clientId: '', callbackPort: 80 } }));
  await assert.rejects(loadOAuthClientRegistrations(file));
});

test("Google desktop sign-in uses the distributor registration with PKCE and keeps returned tokens owner-local", async t => {
  const free = http.createServer(); await new Promise<void>(resolve => free.listen(0, '127.0.0.1', resolve));
  const port = (free.address() as { port: number }).port; await new Promise<void>(resolve => free.close(() => resolve()));
  const { vault, data } = memoryVault();
  const oauth = new OAuthConnections(vault, 'local:google-owner', { 'google-drive': { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-desktop-secret', callbackPort: port } });
  t.after(() => oauth.dispose());
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith('http://127.0.0.1')) return original(input, init);
    assert.equal(String(input), 'https://oauth2.googleapis.com/token');
    const body = init!.body as URLSearchParams;
    assert.equal(body.get('client_id'), 'fixture.apps.googleusercontent.com');
    assert.equal(body.get('client_secret'), 'fixture-desktop-secret');
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.ok(body.get('code_verifier')); assert.equal(init!.redirect, 'error');
    return Response.json({ access_token: 'fixture-google-access', refresh_token: 'fixture-google-refresh', token_type: 'Bearer', expires_in: 3600 });
  });
  const id = randomUUID(), attempt = await oauth.begin(catalogEntry('google-drive'), id);
  const url = new URL(attempt.authorizationUrl);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('client_id'), 'fixture.apps.googleusercontent.com');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.ok(!attempt.authorizationUrl.includes('fixture-desktop-secret'));
  const callback = new URL(url.searchParams.get('redirect_uri')!);
  callback.searchParams.set('state', url.searchParams.get('state')!); callback.searchParams.set('code', 'fixture-code');
  assert.equal((await original(callback)).status, 200);
  assert.equal(await oauth.connected(id), true);
  assert.ok([...data.keys()].every(key => key.startsWith('owners/local:google-owner/')));
  assert.ok(!JSON.stringify(await oauth.configuration(catalogEntry('google-drive'))).includes('fixture-google-access'));
});

test("encrypted vault writes only ciphertext with private permissions and refuses unavailable storage", async t => {
  const root = await temporary(t); let available = true;
  const vault = new EncryptedCredentialVault(root, { available: () => available, encrypt: value => Buffer.from(value.split('').reverse().join('')), decrypt: value => value.toString().split('').reverse().join('') });
  await vault.write("owner/account", "access-secret"); const [file] = await fs.readdir(root);
  assert.ok(!(await fs.readFile(path.join(root, file), "utf8")).includes("access-secret"));
  assert.equal((await fs.stat(path.join(root, file))).mode & 0o777, 0o600); assert.equal(await vault.read("owner/account"), "access-secret");
  available = false; await assert.rejects(vault.write("other", "secret"), /unavailable/); available = true;
  await vault.remove("owner/account"); assert.equal(await vault.read("owner/account"), undefined);
});

test("direct service tools validate schemas and send bounded requests to fixed provider endpoints without retries", async t => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => { calls.push({ url: String(input), init }); return Response.json({ ok: true, fixture: true }); });
  const examples: Record<string, Record<string, unknown>> = { list_repositories: {}, search_issues: { query: "repo:a/b" }, get_issue: { owner: "a", repo: "b", number: 1 }, create_issue: { owner: "a", repo: "b", title: "t", body: "b" },
    search_messages: { query: "q" }, list_channels: { teamId: "team" }, channel_history: { channel: "c" }, send_message: { channel: "c", text: "t", teamId: "team", channelId: "chan" },
    search_files: {}, read_text_file: { fileId: "id", path: "/file.txt" }, create_text_file: { name: "t.txt", content: "text" }, list_messages: { teamId: "team", channelId: "chan" },
    read_message: { messageId: "mail" }, create_draft: { to: ["test@example.com"], subject: "s", body: "b" }, send_draft: { messageId: "draft" }, list_events: { start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" },
    create_event: { subject: "s", start: "2026-01-01T00:00:00", end: "2026-01-01T01:00:00", timeZone: "UTC" }, list_teams: {}, list_folder: {}, upload_text_file: { path: "/new.txt", content: "text" } };
  for (const [pluginId, operations] of Object.entries(nativeTools)) for (const operation of operations) {
    const args = Object.fromEntries(Object.entries(examples[operation.definition.name]).filter(([key]) => Object.hasOwn(operation.definition.inputSchema.properties!, key)));
    assert.equal(compileToolArguments(operation.definition.inputSchema)(args), true, `${pluginId}:${operation.definition.name}`);
    await callNative(pluginId, operation.definition.name, args, "fixture-access", new AbortController().signal);
    assert.equal(calls.at(-1)?.init?.redirect, "error"); assert.ok(calls.at(-1)?.url.startsWith("https://"));
    assert.ok(!calls.at(-1)?.url.includes("fixture-access"));
  }
  assert.equal(calls.length, Object.values(nativeTools).flat().length);
});

test("integration API rejects cross-origin/remote-host mutations and settings migration retires legacy plugins recoverably", async t => {
  const root = await temporary(t), app = express(); app.use(integrationOriginGuard); app.all("/", (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(base, { method: "POST", headers: { Origin: "https://evil.example", "X-Local-Cognitive": "1", "Content-Type": "application/json" }, body: '{}' })).status, 403);
  assert.equal((await fetch(base, { method: "POST" })).status, 403);
  const reboundStatus = await new Promise<number | undefined>((resolve, reject) => {
    const request = http.get(base, { headers: { Host: `evil.example:${(server.address() as { port: number }).port}` } }, response => {
      response.resume(); response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await fetch(base, { method: "POST", headers: { Origin: base, "X-Local-Cognitive": "1", "Content-Type": "application/json" }, body: '{}' })).status, 200);
  const localOnly = express(); localOnly.use(localApiOriginGuard); localOnly.delete("/model", (_req, res) => res.json({ ok: true }));
  const localServer = localOnly.listen(0, "127.0.0.1"); await new Promise<void>(resolve => localServer.once("listening", resolve));
  t.after(() => { localServer.closeAllConnections(); return new Promise<void>(resolve => localServer.close(() => resolve())); });
  const localBase = `http://127.0.0.1:${(localServer.address() as { port: number }).port}`;
  assert.equal((await fetch(`${localBase}/model`, { method: "DELETE" })).status, 403);
  assert.equal((await fetch(`${localBase}/model`, { method: "DELETE", headers: { "X-Local-Cognitive": "1" } })).status, 200);
  const store = new AppSettingsStore(root, config), settings = await store.get();
  delete settings.filesystem; settings.schemaVersion = 1;
  settings.plugins = { file: { enabled: false, values: { outputDir: path.join(root, "saved-output"), accessMode: "restricted", allowedDirectories: root } }, notion: { enabled: true, values: { apiKey: "old-private-key" } }, vscode: { enabled: false, values: {} } };
  await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(settings));
  const migrated = await store.get(); assert.deepEqual(migrated.plugins, {}); assert.equal(migrated.filesystem?.outputDir, path.join(root, "saved-output"));
  assert.ok(!(await fs.readFile(path.join(root, "settings.json"), "utf8")).includes("old-private-key"));
  assert.match(await fs.readFile(path.join(root, "settings.pre-integrations.json"), "utf8"), /old-private-key/);
  assert.equal((await fs.stat(path.join(root, "settings.pre-integrations.json"))).mode & 0o777, 0o600);
});

test("disconnect and overlapping policy changes fence a stale refresh before durable writes finish", async t => {
  const f = await fixture(t);
  let finishInspect!: () => void, enteredInspect!: () => void;
  const entered = new Promise<void>(resolve => { enteredInspect = resolve; });
  const release = new Promise<void>(resolve => { finishInspect = resolve; });
  f.adapter.inspect = async () => { enteredInspect(); await release; return { state: "connected", tools: [read, write] }; };
  const refreshing = f.manager.refresh(f.connectionId); await entered;
  const update = f.manager.store.update.bind(f.manager.store);
  let releaseWrite!: () => void;
  const writeWait = new Promise<void>(resolve => { releaseWrite = resolve; });
  t.mock.method(f.manager.store, "update", async (fn: never) => { await writeWait; return update(fn); });
  const disconnect = f.manager.disconnect(f.connectionId);
  finishInspect(); await refreshing;
  assert.deepEqual(await f.manager.search(""), []);
  const operation = f.operation(); operation.approval = { id: operation.id, approved: true };
  assert.equal((await f.manager.execute(operation)).result?.ok, false); assert.equal(f.effects.length, 0);
  releaseWrite(); await disconnect;
});

test("definitive service rejection is a completed error, while authorization loss removes available tools", async t => {
  const f = await fixture(t);
  f.adapter.call = async () => { throw new PluginInvocationError("Invalid query", 422); };
  const operation = f.operation("search", { query: "bad" });
  const result = await f.manager.execute(operation);
  assert.equal(result.result?.ok, false); assert.equal(result.result?.metadata?.unknown, undefined); assert.match(result.result!.output, /Invalid query/);
  f.adapter.call = async () => { throw new PluginInvocationError("Reconnect the account", 401); };
  await f.manager.execute(f.operation("search", { query: "good" }));
  assert.equal((await f.manager.snapshot()).connections[0].state, "authentication-required"); assert.deepEqual(await f.manager.search(""), []);
});

test("official SDK OAuth discovery/DCR/PKCE and real Streamable HTTP discovery execute under the correct account", async t => {
  const root = await temporary(t), { vault } = memoryVault();
  const remote = await createMcpHttpFixture({ accounts: { "Bearer fixture-oauth-token": "connected-account" } });
  let adapter!: DirectIntegrationAdapter;
  const mcp = new McpClientManager({ credentialProvider: { resolve: context => adapter.resolve(context) } });
  adapter = new DirectIntegrationAdapter(vault, "local:sdk-test", mcp);
  const manager = new PluginManager(root, "local:sdk-test", [adapter]);
  t.after(async () => { await manager.dispose(); await mcp.dispose(); await remote.close(); });
  const original = globalThis.fetch; let registered = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const address = String(input);
    if (address.startsWith("http://127.0.0.1")) return original(input, init);
    if (address.includes("/.well-known/oauth-protected-resource")) return Response.json({ resource: "https://mcp.notion.com/mcp", authorization_servers: ["https://mcp.notion.com"] });
    if (address.includes("/.well-known/")) return Response.json({ issuer: "https://mcp.notion.com", authorization_endpoint: "https://mcp.notion.com/authorize", token_endpoint: "https://mcp.notion.com/token", registration_endpoint: "https://mcp.notion.com/register", response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    if (address.endsWith("/register")) { registered++; return Response.json({ ...JSON.parse(String(init!.body)), client_id: "fixture-dynamic-client" }, { status: 201 }); }
    if (address.endsWith("/token")) return Response.json({ access_token: "fixture-oauth-token", token_type: "Bearer", refresh_token: "fixture-refresh", expires_in: 3600 });
    if (address === "https://mcp.notion.com/mcp") return original(remote.endpoint, init);
    throw new Error(`Unexpected fixture endpoint: ${address}`);
  });
  await manager.install("notion"); const attempt = await manager.connect("notion"); const authorization = new URL(attempt.authorizationUrl);
  assert.equal(registered, 1); assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  const callback = new URL(authorization.searchParams.get("redirect_uri")!); callback.searchParams.set("state", authorization.searchParams.get("state")!); callback.searchParams.set("code", "fixture-code");
  assert.equal((await original(callback)).status, 200);
  await manager.refresh(attempt.connectionId);
  assert.equal((await manager.snapshot()).connections[0].state, "connected");
  await manager.configure("notion", { enabled: true, permission: "read-write" });
  const [echo] = await manager.search("echo"); assert.ok(echo);
  const id = randomUUID(); const result = await manager.execute({ id, agentRunId: "mcp-agent", tool: "plugins.call", accessMode: "full",
    arguments: { toolId: echo.id, argumentsJson: '{"text":"real SDK result"}' }, approval: { id, approved: true },
    workspace: { version: 1, kind: "project", rootPath: root, outputDir: root, allowedDirectories: [root], memoryScope: "fixture" } });
  assert.equal(result.result?.ok, true); assert.match(result.result!.output, /connected-account/);
  const binding = { id: `plugin-${attempt.connectionId}`, serverId: `plugin-${attempt.connectionId}`, enabled: true, accountId: attempt.connectionId, credentialRef: `plugin:${attempt.connectionId}` };
  assert.equal(await adapter.resolve({ binding, signal: new AbortController().signal,
    server: { id: binding.serverId, enabled: true, transport: "streamable-http", endpoint: "https://untrusted.example.test/mcp" } }), undefined);
  await assert.rejects(mcp.reconcile({ servers: { [binding.serverId]: { id: binding.serverId, enabled: false, transport: "streamable-http", endpoint: "https://untrusted.example.test/mcp" } }, bindings: { [binding.id]: binding } }), /Invalid/);
});
