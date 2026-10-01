import assert from "node:assert/strict";
import test from "node:test";
import { buildSync } from "esbuild";
import { pluginCatalog } from "../src/plugins/catalog";
import { mentionedPluginIds, parsePluginSelection, withoutPluginMentions } from "../src/plugins/PluginSelection";
import { parseMentionedSubagentNames } from "../src/agents/code/codeAgentRouting";
import { WorkflowStore } from "../src/workflows/WorkflowStore";
import { defaultTaskWorkflow } from "../src/workflows/defaultWorkflows";

const { JSDOM } = require("jsdom");
const bundle = buildSync({ entryPoints: ["public/assets/mentions.js"], bundle: true, write: false, format: "iife", globalName: "Mentions" }).outputFiles[0].text;
function harness() {
  const dom = new JSDOM('<textarea></textarea><div id="menu"></div><div id="selected"></div>', { url: 'http://localhost/', runScripts: "outside-only" });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.eval(`${bundle}\nwindow.Mentions = Mentions;`);
  const api = dom.window.Mentions, document = dom.window.document;
  const textarea = document.querySelector('textarea'), menu = document.getElementById('menu'), selected = document.getElementById('selected');
  const plugins = pluginCatalog.filter(p => ['notion', 'google-drive'].includes(p.id));
  const agents = [{ name: 'Reviewer', model: 'Local Qwen' }, { name: 'Notion', model: 'Local Qwen' }];
  let available = [...plugins], value = '', error = '';
  const picker = api.bindMentionPicker({ textarea, menu, selected, getPlugins: () => available, getCatalog: () => pluginCatalog,
    getAgents: () => agents, refresh: async () => {}, getError: () => error, onChange: (next: string) => { value = next; } });
  const type = (text: string, cursor = text.length) => {
    textarea.value = text; textarea.setSelectionRange(cursor, cursor); textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  const key = (key: string) => textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return { dom, api, textarea, menu, selected, plugins, agents, picker, type, key, value: () => value,
    unavailable: (message = '') => { available = []; error = message; picker.update(); }, close: () => { picker.dispose(); dom.window.close(); } };
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("canonical mentions agree in frontend/backend, exclude emails and distinguish colliding subagents", t => {
  const h = harness(); t.after(h.close);
  const text = 'Read (@Google-Drive) @notion and @agent:Notion with @Reviewer; x@notion.com @notion-other @notion_suffix @notion:other';
  assert.deepEqual(mentionedPluginIds(text), ['google-drive', 'notion']);
  assert.deepEqual(plain(h.api.pluginMentionIds(text, pluginCatalog)), ['google-drive', 'notion']);
  assert.deepEqual(plain(h.api.mentionedAgentNames(text, pluginCatalog, h.agents)), ['Reviewer', 'Notion']);
  assert.deepEqual(parseMentionedSubagentNames('@google-drive @notion @agent:Notion @Reviewer'), ['notion', 'reviewer']);
  assert.equal(withoutPluginMentions('@notion x@notion.com @agent:Notion'), ' x@notion.com @agent:Notion');
  assert.equal(mentionedPluginIds('normal text'), undefined);
  assert.equal(parsePluginSelection(undefined), undefined);
  assert.deepEqual(parsePluginSelection([]), []);
  assert.deepEqual(parsePluginSelection(['notion', 'notion']), ['notion']);
  for (const value of [null, 'notion', ['file'], [1], {}]) assert.throws(() => parsePluginSelection(value));
});

test("@ picker shows only available plugins alongside subagents, with icons, descriptions and keyboard selection", t => {
  const h = harness(); t.after(h.close); h.type('@');
  assert.equal(h.menu.hidden, false);
  assert.equal(h.menu.querySelectorAll('[role=option]').length, 4);
  assert.equal(h.menu.querySelectorAll('img').length, 2);
  assert.equal(h.menu.querySelectorAll('[role=group]').length, 2);
  assert.ok(!h.menu.textContent.includes('GitHub'));
  h.key('ArrowDown'); h.key('Enter');
  assert.equal(h.value(), '@google-drive '); assert.equal(h.menu.hidden, true);
  assert.equal(h.selected.querySelector('img').getAttribute('src'), '/assets/plugin-icons/google-drive.svg');
  assert.equal(h.selected.querySelector('button').getAttribute('aria-label'), 'Remove Google Drive');
  h.selected.querySelector('button').click(); assert.equal(h.value().trim(), ''); assert.equal(h.selected.hidden, true);
});

test("picker searches names, keeps text after the cursor, closes on Escape and disposes listeners", t => {
  const h = harness(); t.after(h.close);
  h.type('Please @dri inspect files', 11);
  assert.equal(h.menu.querySelectorAll('[role=option]').length, 1);
  h.key('Tab'); assert.equal(h.value(), 'Please @google-drive  inspect files');
  h.type('@Review'); h.key('Enter'); assert.equal(h.value(), '@Reviewer ');
  h.type('@agent:Not'); h.key('Enter'); assert.equal(h.value(), '@agent:Notion ');
  h.type('@'); let escaped = false;
  h.textarea.ownerDocument.addEventListener('keydown', () => { escaped = true; });
  h.key('Escape'); assert.equal(h.menu.hidden, true); assert.equal(escaped, false);
  h.picker.dispose(); const before = h.value(); h.type('@new'); assert.equal(h.value(), before);
});

test("connection loss removes candidates without discarding draft selection and mention rendering escapes data", t => {
  const h = harness(); t.after(h.close);
  h.type('@google-drive search'); h.unavailable('Could not load connected plugins.');
  assert.ok(h.selected.querySelector('.is-unavailable'));
  h.type('@Drive'); assert.equal(h.menu.querySelectorAll('[role=option]').length, 0);
  assert.match(h.menu.textContent, /Could not load/);
  const html = h.api.renderMentionText('<img src=x onerror=alert(1)> @google-drive @Reviewer', pluginCatalog, h.agents);
  h.selected.innerHTML = html;
  assert.equal(h.selected.querySelectorAll('img').length, 1);
  assert.equal(h.selected.querySelector('[onerror]'), null);
  assert.equal(h.selected.querySelectorAll('.entity-mention').length, 2);
});

test("workflow definitions validate explicit plugin IDs while retaining automatic and no-plugin modes", () => {
  const workflow = defaultTaskWorkflow(), node = workflow.nodes.find(node => node.type === 'agent')!;
  const store = new WorkflowStore('/unused-validation-only');
  for (const ids of [undefined, [], ['google-drive', 'notion']]) {
    node.config.pluginIds = ids; assert.equal(store.validate(workflow).ok, true);
  }
  for (const ids of ['notion', ['unknown-service'], null]) {
    node.config.pluginIds = ids; assert.match(store.validate(workflow).errors.join(' '), /pluginIds/);
  }
});

test("workflow plugin list switches selection modes and retains removable disconnected selections", async t => {
  const code = buildSync({ entryPoints: ['frontend/workflow/NodeConfigFields.tsx'], bundle: true, write: false,
    format: 'iife', globalName: 'Fields', jsx: 'automatic' }).outputFiles[0].text;
  const renderer = buildSync({ stdin: { contents: 'export { createRoot } from "react-dom/client";', resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', globalName: 'Renderer' }).outputFiles[0].text;
  const h = harness(); const w = h.dom.window;
  w.eval(`${code}\n${renderer}\nwindow.Fields = Fields; window.Renderer = Renderer;`);
  const root = w.Renderer.createRoot(h.selected);
  t.after(() => { root.unmount(); h.close(); });
  let selected: string[] | undefined = ['google-drive', 'slack'];
  const render = () => root.render(w.Fields.PluginFields({ value: selected, plugins: h.plugins.map(p => ({ ...p, icon: h.api.pluginIconPath(p.id) })), onChange: (value: string[] | undefined) => { selected = value; render(); } }));
  const tick = () => new Promise(resolve => setTimeout(resolve, 20));
  render(); await tick();
  assert.equal(h.selected.querySelector('[aria-label="Google Drive"]').checked, true);
  assert.match(h.selected.textContent, /slack.*Unavailable/s);
  h.selected.querySelector('[aria-label="Remove unavailable slack"]').click(); await tick();
  assert.deepEqual(plain(selected), ['google-drive']);
  h.selected.querySelector('[aria-label="Notion"]').click(); await tick();
  assert.deepEqual(plain(selected), ['google-drive', 'notion']);
  const mode = h.selected.querySelector('select'); mode.value = 'automatic'; mode.dispatchEvent(new w.Event('change', { bubbles: true })); await tick();
  assert.equal(selected, undefined);
  mode.value = 'selected'; mode.dispatchEvent(new w.Event('change', { bubbles: true })); await tick();
  assert.deepEqual(plain(selected), []); assert.match(h.selected.textContent, /No plugins allowed/);
});
