import assert from "node:assert/strict";
import test from "node:test";
import { buildSync } from "esbuild";
import { pluginCatalog } from "../src/plugins/catalog";

const { JSDOM } = require("jsdom");
const bundle = buildSync({ entryPoints: ["public/assets/plugins-ui.js"], bundle: true, write: false, format: "iife", globalName: "PluginsUI" }).outputFiles[0].text;
const shellBundle = buildSync({ entryPoints: ["public/assets/settings-shell.js"], bundle: true, write: false, format: "iife", globalName: "SettingsShell" }).outputFiles[0].text;
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail("Plugin UI did not reach the expected state");
}
function harness(connected = false, pluginId?: string, pending = false) {
  const dom = new JSDOM('<main><h1>Plugins</h1><div id="root"></div></main>', { url: "http://localhost/#/settings/plugins", runScripts: "outside-only" });
  const data = { catalog: pluginCatalog.map(item => ({ ...item, installation: item.id === "notion" ? { enabled: true, permission: "read-write", connectionId: "account-1" } : item.id === "github" ? { enabled: false, permission: "none" } : undefined })),
    connections: [{ id: "account-1", pluginId: "notion", state: pending ? "connecting" : connected ? "connected" : "authentication-required", label: "Test account", tools: [] }],
    providers: [{ ready: true }], setup: Object.fromEntries(pluginCatalog.map(item => [item.id, { required: !item.mcpEndpoint, configured: !!item.mcpEndpoint, callbackUrl: "http://localhost:17849/oauth/callback", message: "Configure OAuth client", scopes: "read write" }])) };
  const requests: Array<{ path: string; method: string; body: any }> = [];
  dom.window.AbortController = AbortController; dom.window.AbortSignal = AbortSignal;
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  let poll: (() => Promise<void>) | undefined;
  dom.window.setTimeout = (callback: () => Promise<void>) => { poll = callback; return 1; };
  dom.window.fetch = async (path: string, options: RequestInit) => {
    if (options.method !== "GET") {
      assert.equal((options.headers as Record<string, string>)["X-Local-Cognitive"], "1");
      const body = JSON.parse(String(options.body)); requests.push({ path, method: options.method!, body });
      if (options.method === "PATCH") Object.assign(data.catalog.find(item => path.endsWith(item.id))!.installation!, body);
      const plugin = data.catalog.find(item => path.startsWith(`/integrations/${item.id}/`));
      if (path.endsWith('/install')) plugin!.installation = { enabled: false, permission: 'none', connectionId: undefined };
      if (path.endsWith('/connect')) {
        data.connections.push({ id: 'account-2', pluginId: plugin!.id, state: 'connecting', label: 'New account', tools: [] });
        return { ok: true, json: async () => ({ connectionId: 'account-2', authorizationUrl: 'https://github.com/login/device', userCode: 'TEST-CODE' }) };
      }
    }
    return { ok: true, json: async () => structuredClone(data) };
  };
  dom.window.eval(`${bundle}\nwindow.PluginsUI = PluginsUI;`);
  const root = dom.window.document.getElementById("root");
  let dispose = dom.window.PluginsUI.mountIntegrationPage(root, { pluginId });
  return { dom, root, data, requests, poll: () => poll?.(), remount: (id: string) => { dispose(); dispose = dom.window.PluginsUI.mountIntegrationPage(root, { pluginId: id }); }, close: () => { dispose(); dom.window.close(); } };
}

test("plugin catalog uses real local icons and honest switches; search and setup navigation never grant access", async t => {
  const ui = harness(); t.after(ui.close);
  await until(() => ui.root.querySelectorAll('[role="switch"]').length === 10);
  assert.equal(ui.root.querySelectorAll('[aria-checked="true"]').length, 0, "Enabled without a live account is not connected");
  assert.equal(ui.root.querySelectorAll('img[src^="/assets/plugin-icons/"]').length, 10);
  assert.equal(ui.root.querySelectorAll('[data-plugin-action^="install:"]').length, 0, "Install controls live in the directory/details, not management rows");
  const input = ui.root.querySelector('[data-plugin-search]'); input.value = "github"; input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  assert.equal(ui.root.querySelectorAll('.plugin-catalog-row').length, 1);
  ui.root.querySelector('[role="switch"]').click();
  assert.equal(ui.dom.window.location.hash, "#/settings/plugins/github"); assert.equal(ui.requests.length, 0);
  ui.root.querySelector('[data-plugin-action="directory"]').click();
  assert.equal(ui.root.querySelector('a.ghost-button').textContent, "Manage");
});

test("connected toggle changes only enabled state, and missing OAuth setup disables account login", async t => {
  const ui = harness(true); t.after(ui.close);
  await until(() => !!ui.root.querySelector('[aria-checked="true"]'));
  ui.root.querySelector('[aria-checked="true"]').click();
  await until(() => ui.requests.length === 1 && !ui.root.querySelector('[aria-checked="true"]'));
  assert.deepEqual(ui.requests[0], { path: "/integrations/notion", method: "PATCH", body: { enabled: false } });
  assert.equal(ui.data.connections[0].state, "connected", "Disable does not erase a saved account");
  const setup = harness(false, "github"); t.after(setup.close);
  await until(() => !!setup.root.querySelector('[data-plugin-action="connect:github"]'));
  assert.equal(setup.root.querySelector('[data-plugin-action="connect:github"]').disabled, true);
  assert.equal(setup.root.querySelector('[data-plugin-action="enable:true"]').disabled, true);
  assert.match(setup.root.textContent, /application developer/);
  assert.equal(setup.root.querySelector('[name="clientId"]'), null, 'Developer registration must not be required of end users');
  assert.doesNotMatch(setup.root.textContent, /Register|redirect|localhost|Configure OAuth/);
});

test("install and an unconnected switch launch sign-in directly, retaining the login handoff without granting access", async t => {
  for (const directory of [true, false]) {
    const ui = harness(); t.after(ui.close);
    await until(() => ui.root.querySelectorAll('[role="switch"]').length === 10);
    if (directory) ui.root.querySelector('[data-plugin-action="directory"]').click();
    ui.root.querySelector(`[data-plugin-action="${directory ? 'install' : 'toggle'}:linear"]`).click();
    await until(() => ui.dom.window.location.hash === '#/settings/plugins/linear');
    assert.deepEqual(ui.requests.map(item => [item.path, item.method]), [['/integrations/linear/install', 'POST'], ['/integrations/linear/connect', 'POST']]);
    assert.equal(ui.data.catalog.find(item => item.id === 'linear')!.installation!.permission, 'none');
    ui.remount('linear');
    await until(() => !!ui.root.querySelector('.plugin-device-code'));
    assert.equal(ui.root.querySelector('.plugin-device-code').textContent, 'TEST-CODE');
    assert.equal(ui.root.querySelector('[data-plugin-action="enable:true"]').disabled, true);
    ui.data.connections.find(item => item.id === 'account-2')!.state = 'connected';
    await ui.poll();
    assert.equal(ui.root.querySelector('.plugin-login'), null, 'Completed login instructions must disappear');
  }
});

test("OAuth status polling preserves search focus and expanded menus", async t => {
  const catalog = harness(false, undefined, true); t.after(catalog.close);
  await until(() => !!catalog.root.querySelector('[data-plugin-search]'));
  catalog.root.querySelector('.plugin-add').open = true;
  const search = catalog.root.querySelector('[data-plugin-search]'); search.value = "github";
  search.dispatchEvent(new catalog.dom.window.Event("input", { bubbles: true })); search.focus();
  await catalog.poll();
  assert.equal(catalog.root.querySelectorAll('.plugin-catalog-row').length, 1);
  assert.equal(catalog.dom.window.document.activeElement, catalog.root.querySelector('[data-plugin-search]'));
  assert.equal(catalog.root.querySelector('.plugin-add').open, true);
});

test("Accounts and MCP settings have parent arrows and count exactly the configured server entries", async t => {
  const ui = harness(true); t.after(ui.close);
  await until(() => !!ui.root.querySelector('[data-plugin-search]'));
  ui.dom.window.eval(`${shellBundle}\nwindow.SettingsShell = SettingsShell;`);
  const appSettings = { mcp: { server: { enabled: false }, client: { servers: { fixture: { name: 'Fixture MCP', transport: 'stdio', enabled: true } } } } };
  const shell = ui.dom.window.SettingsShell.createSettingsShell({ app: ui.root, getContext: () => ({ appSettings }), data: { integrations: [] }, captureScroll: () => ({}), restoreScroll() {}, onReturn() {} });
  shell.route('#/settings/connections');
  let content = ui.dom.window.document.querySelector('#settings-root');
  await until(() => content.textContent.includes('not a second app store'));
  assert.equal(content.querySelector('.settings-parent').getAttribute('href'), '#/settings/plugins');
  assert.doesNotMatch(content.textContent, /Browse plugins/);
  shell.route('#/settings/mcp');
  assert.equal(content.querySelector('.settings-parent').getAttribute('href'), '#/settings/plugins');
  assert.match(content.textContent, /2 configured servers/);
  assert.match(content.textContent, /Local Cognitive MCP server/);
  assert.match(content.textContent, /Fixture MCP/);
  shell.route('#/settings/mcp/local-cognitive');
  assert.equal(content.querySelector('.settings-parent').getAttribute('href'), '#/settings/mcp');
  shell.route('#/settings/plugins');
  await until(() => content.textContent.includes('MCP servers'));
  assert.match(content.querySelector('.plugin-tabs').textContent, /MCP servers 2/);
  shell.route('#/chat');
});

test("MCP settings add a Streamable HTTP server with a binding and show discovered-tool status", async t => {
  const ui = harness(true); t.after(ui.close);
  await until(() => !!ui.root.querySelector('[data-plugin-search]'));
  ui.dom.window.eval(`${shellBundle}\nwindow.SettingsShell = SettingsShell;`);
  const appSettings: any = { mcp: { server: { enabled: true }, client: { servers: {}, bindings: {} } } };
  const saved: any[] = [];
  const data: any = {
    integrations: [],
    loadMcp: async () => ({ connections: [{ bindingId: 'unreal', serverId: 'unreal', enabled: true, state: 'connected', reconnectAttempt: 0 }],
      tools: [{ id: 'mcp:unreal:spawn_actor', bindingId: 'unreal', serverId: 'unreal', name: 'spawn_actor' }] }),
    save: async (patch: any) => { saved.push(patch); return appSettings; }, connectMcp: async () => ({}), disconnectMcp: async () => ({})
  };
  const shell = ui.dom.window.SettingsShell.createSettingsShell({ app: ui.root, getContext: () => ({ appSettings }), data, captureScroll: () => ({}), restoreScroll() {}, onReturn() {} });
  shell.route('#/settings/mcp');
  let content = ui.dom.window.document.querySelector('#settings-root');
  await until(() => content.textContent.includes('Add MCP server'));
  assert.match(content.querySelector('#mcp-external-title').textContent, /External MCP servers 0/);
  shell.route('#/settings/mcp/new');
  content = ui.dom.window.document.querySelector('#settings-root');
  const name = content.querySelector('[data-mcp-field="name"]'); name.value = 'Unreal Engine';
  content.querySelector('[data-mcp-field="endpoint"]').value = 'http://127.0.0.1:8000/mcp';
  content.querySelector('#external-mcp-form').dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => saved.length === 1);
  assert.deepEqual(JSON.parse(JSON.stringify(saved[0])), { mcp: { client: { servers: {
    'unreal-engine': { id: 'unreal-engine', name: 'Unreal Engine', enabled: true, transport: 'streamable-http', endpoint: 'http://127.0.0.1:8000/mcp' }
  }, bindings: { 'unreal-engine': { id: 'unreal-engine', serverId: 'unreal-engine', enabled: true } } } } });
});

test("MCP settings set timeouts in seconds and choose which tools agents get, without touching other fields", async t => {
  const ui = harness(true); t.after(ui.close);
  await until(() => !!ui.root.querySelector('[data-plugin-search]'));
  ui.dom.window.eval(`${shellBundle}\nwindow.SettingsShell = SettingsShell;`);
  const appSettings: any = { mcp: { server: { enabled: true }, client: {
    servers: { blender: { id: 'blender', name: 'Blender', enabled: true, transport: 'stdio', command: 'uvx', args: ['blender-mcp'], requestTimeoutMs: 120000 } },
    bindings: { blender: { id: 'blender', serverId: 'blender', enabled: true } } } } };
  const saved: any[] = [];
  const data: any = {
    integrations: [],
    loadMcp: async () => ({ connections: [{ bindingId: 'blender', serverId: 'blender', enabled: true, state: 'connected', reconnectAttempt: 0 }],
      tools: ['look', 'execute_blender_code'].map(name => ({ id: `mcp:blender:${name}`, bindingId: 'blender', serverId: 'blender', name })) }),
    save: async (patch: any) => { saved.push(patch); return appSettings; }, connectMcp: async () => ({}), disconnectMcp: async () => ({})
  };
  const shell = ui.dom.window.SettingsShell.createSettingsShell({ app: ui.root, getContext: () => ({ appSettings }), data, captureScroll: () => ({}), restoreScroll() {}, onReturn() {} });
  shell.route('#/settings/mcp/blender');
  const content = ui.dom.window.document.querySelector('#settings-root');
  await until(() => !!content.querySelector('[data-mcp-tool="execute_blender_code"]'));
  assert.equal(content.querySelector('[data-mcp-field="toolSeconds"]').value, '120');
  content.querySelector('[data-mcp-field="startupSeconds"]').value = '90';
  content.querySelector('[data-mcp-field="toolSeconds"]').value = '';
  content.querySelector('[data-mcp-tool="execute_blender_code"]').checked = false;
  content.querySelector('#external-mcp-form').dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => saved.length === 1);
  const server = JSON.parse(JSON.stringify(saved[0])).mcp.client.servers.blender;
  assert.equal(server.connectTimeoutMs, 90000);
  assert.equal(server.requestTimeoutMs, null, "a cleared field is removed");
  assert.deepEqual(server.disabledTools, ['execute_blender_code']);
  assert.equal('approval' in server, false, "an untouched default is not sent");
});

test("MCP settings set a server's secret without ever showing its value", async t => {
  const ui = harness(true); t.after(ui.close);
  await until(() => !!ui.root.querySelector('[data-plugin-search]'));
  ui.dom.window.eval(`${shellBundle}\nwindow.SettingsShell = SettingsShell;`);
  const appSettings: any = { mcp: { server: { enabled: true }, client: {
    servers: { blender: { id: 'blender', name: 'Blender', enabled: true, transport: 'stdio', command: 'uvx' } },
    bindings: { blender: { id: 'blender', serverId: 'blender', enabled: true } } } } };
  const sent: any[] = [];
  let view: any = { available: true, secrets: [] };
  const data: any = {
    integrations: [], loadMcp: async () => ({ connections: [], tools: [] }), save: async () => appSettings, connectMcp: async () => ({}), disconnectMcp: async () => ({}),
    mcpSecrets: async () => view,
    setMcpSecret: async (id: string, secret: any) => { sent.push([id, secret]); view = { available: true, secrets: [{ kind: 'env', name: secret.name, set: true }] }; return view; },
    removeMcpSecret: async () => view
  };
  const shell = ui.dom.window.SettingsShell.createSettingsShell({ app: ui.root, getContext: () => ({ appSettings }), data, captureScroll: () => ({}), restoreScroll() {}, onReturn() {} });
  shell.route('#/settings/mcp/blender');
  const content = ui.dom.window.document.querySelector('#settings-root');
  await until(() => !!content.querySelector('[data-mcp-secret-save]'));
  content.querySelector('[data-mcp-secret-name]').value = 'BLENDERMCP_SKETCHFAB_API_KEY';
  content.querySelector('[data-mcp-secret-value]').value = 'sk-very-secret-value';
  content.querySelector('[data-mcp-secret-save]').click();
  await until(() => /Set/.test(content.querySelector('.mcp-secret-list')?.textContent ?? ''));
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [['blender', { kind: 'env', name: 'BLENDERMCP_SKETCHFAB_API_KEY', value: 'sk-very-secret-value' }]]);
  assert.equal(content.innerHTML.includes('sk-very-secret-value'), false, "the value is not on the page");
  assert.equal(content.querySelector('[data-mcp-secret-value]').value, '');
});
