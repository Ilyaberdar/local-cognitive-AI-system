import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('public/assets/settings-data.js', 'utf8').replaceAll('export ', '');
const deferred = () => { let resolve!: (value: unknown) => void; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test('MCP count includes the built-in entry regardless of enabled state, plus manual servers', () => {
  const context: any = {};
  vm.runInNewContext(source, context);
  assert.equal(context.mcpServerCount({}), 1);
  assert.equal(context.mcpServerCount({ mcp: { server: { enabled: false } } }), 1);
  assert.equal(context.mcpServerCount({ mcp: { client: { servers: { a: {}, b: {} } } } }), 3);
});

test('entity patches send only edited fields and preserve explicit empty secrets', () => {
  const context: any = {};
  vm.runInNewContext(source, context);
  assert.deepEqual(plain(context.entityPatch({ 'providers.openai.model': 'chosen' })), { providers: { openai: { model: 'chosen' } } });
  assert.deepEqual(plain(context.entityPatch({ 'providers.openai.apiKey': '' })), { providers: { openai: { apiKey: '' } } });
  assert.throws(() => context.entityPatch({ '__proto__.polluted': true }), /Invalid/);
});

test('local profile presentation keeps a safe custom name and local raster avatar only', () => {
  const context: any = {};
  vm.runInNewContext(source, context);
  const avatar = 'data:image/png;base64,AA==';
  assert.deepEqual(plain(context.localProfileView({ memory: { localProfileId: 'local-1' }, profile: { displayName: '  Mira  ', avatarDataUrl: avatar } })), {
    id: 'local-1', name: 'Mira', avatarDataUrl: avatar, kind: 'local', authentication: 'unavailable'
  });
  assert.equal(context.localProfileView({ profile: { displayName: 'Mira', avatarDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' } }).avatarDataUrl, undefined);
});

test('settings saves serialize responses and recover after failure without a false saved callback', async () => {
  const first = deferred(); const writes: any[] = [], saved: any[] = [];
  let count = 0;
  const context: any = {};
  vm.runInNewContext(source, context);
  const data = context.createSettingsData({
    request: async (_url: string, options: any) => { writes.push(JSON.parse(options.body)); count++; if (count === 1) return first.promise; if (count === 2) throw new Error('Disk full'); return { settings: { ui: { theme: 'system' } } }; },
    onSaved: (response: unknown) => saved.push(response)
  });
  const a = data.save({ ui: { theme: 'light' } });
  const b = assert.rejects(data.save({ ui: { theme: 'dark' } }), /Disk full/);
  const c = data.save({ ui: { theme: 'system' } });
  await Promise.resolve(); assert.equal(writes.length, 1);
  first.resolve({ settings: { ui: { theme: 'light' } } });
  await Promise.all([a, b, c]);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved.map(value => value.settings.ui.theme), ['light', 'system']);
});
