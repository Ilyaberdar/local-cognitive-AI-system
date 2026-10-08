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
    id: 'local-1', name: 'Mira', avatarDataUrl: avatar, kind: 'local'
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

test('account view passes only allowlisted profile fields and normalises invalid states', () => {
  const context: any = {};
  vm.runInNewContext(source, context);
  const view = plain(context.accountView({ state: 'signed-in', accessToken: 'SECRET', refreshToken: 'SECRET', cloudReachable: true,
    profile: { accountId: 'acc-1', email: 'a@b.test', emailVerified: true, name: 'Mira', idToken: 'SECRET', pictureUrl: 'https://x/p.png', extra: 1 } }));
  assert.deepEqual(view, { state: 'signed-in', profile: { accountId: 'acc-1', email: 'a@b.test', emailVerified: true, name: 'Mira' }, cloudReachable: true });
  assert.equal(context.accountView({ state: 'signed-in' }).state, 'error');
  assert.equal(context.accountView({ state: 'hacked' }).state, 'error');
  assert.equal(context.accountView({ state: 'error', error: { message: 'x'.repeat(400) } }).error.message.length, 300);
  assert.equal(context.accountView({ state: 'signed-in', cloudReachable: false, profile: { accountId: 'a' } }).cloudReachable, false);
});

test('account state follows bridge events and ignores stale call results', async () => {
  const context: any = {};
  vm.runInNewContext(source, context);
  assert.equal(context.createAccountState(undefined).get().state, 'unavailable');

  let emit!: (status: unknown) => void;
  const status = deferred(), signIn = deferred();
  const bridge = { status: () => status.promise, signIn: () => signIn.promise, onChange: (listener: (status: unknown) => void) => { emit = listener; } };
  const account = context.createAccountState(bridge);
  assert.equal(account.get().state, 'loading');
  emit({ state: 'signed-out' });
  status.resolve({ state: 'signed-in', profile: { accountId: 'late' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(account.get().state, 'signed-out', 'an event before status() resolves wins');

  const pending = account.signIn('google');
  emit({ state: 'signed-in', profile: { accountId: 'acc-1' } });
  signIn.resolve({ state: 'signing-in' });
  await pending;
  assert.equal(account.get().state, 'signed-in', 'a stale call result does not override a newer event');

  const failing = context.createAccountState({ status: async () => ({ state: 'signing-in' }), signIn: async () => { throw new Error('Error invoking remote method: internal detail'); }, onChange: () => {} });
  await new Promise(resolve => setImmediate(resolve));
  await failing.signIn('email');
  assert.equal(failing.get().state, 'error');
  assert.doesNotMatch(failing.get().error.message, /internal detail/);
  assert.equal((await account.signIn('unknown')).state, 'signed-in');
});
