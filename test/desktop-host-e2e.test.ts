import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { RemoteClient } from "../src/remote/client/RemoteClient";
import { memoryVault, remoteStackSkip, startCloud, until } from "./fixtures/remoteStack";
import { startTestBackend } from "./fixtures/testBackend";

const { registerHost, readSettings } = require(path.resolve("electron/host.cjs"));

type Account = { accountId: string; accessToken: string };
/** The account service as the main process sees it: who is signed in, and a change event. */
class FakeAccount extends EventEmitter {
  constructor(private current?: Account) { super(); }
  status() { return this.current ? { state: "signed-in", profile: { accountId: this.current.accountId } } : { state: "signed-out" }; }
  set(next?: Account) { this.current = next; this.emit("change", this.status()); }
}
const fakeIpc = () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<{ ok: boolean; value?: any; error?: { code: string; message: string } }>>();
  return { handle: (name: string, action: never) => { handlers.set(name, action); }, invoke: (name: string, ...args: unknown[]) => handlers.get(`remote-host:${name}`)!({ sender: {} }, ...args) };
};
const fakeBlocker = () => {
  const active = new Set<number>();
  let next = 0;
  return { active, start: (type: string) => { assert.equal(type, "prevent-app-suspension"); active.add(++next); return next; }, stop: (id: number) => { active.delete(id); } };
};

test("this computer hosts paired devices for the account signed in on it", { skip: remoteStackSkip, timeout: 180_000 }, async t => {
  const cloud = await startCloud(t);
  const { backend, root } = await startTestBackend(t, "desktop");
  const owner = await cloud.account("owner"), other = await cloud.account("other");
  const account = new FakeAccount(owner), ipc = fakeIpc(), blocker = fakeBlocker(), sent: Array<[string, any]> = [];
  const window = { isDestroyed: () => false, webContents: { send: (channel: string, value: unknown) => sent.push([channel, value]) } };
  const host = registerHost({ app: { isPackaged: false }, ipcMain: ipc, vault: memoryVault(), accountService: account, backend, dataRoot: root, assertSender: () => undefined,
    getWindow: () => window, powerSaveBlocker: blocker, cloudUrl: cloud.origin, hostName: "MacBook" });
  t.after(() => host.dispose());
  const call = async (name: string, ...args: unknown[]) => {
    const result = await ipc.invoke(name, ...args);
    if (!result.ok) throw Object.assign(new Error(result.error!.message), { code: result.error!.code });
    return result.value;
  };
  const state = () => host.status().state;
  const device = (who: Account, name: string) => {
    const client = new RemoteClient({ cloudUrl: cloud.origin, vault: memoryVault(), account: async () => who, deviceName: name, platform: "macos", backoff: { baseMs: 100, maxMs: 400 } });
    t.after(() => client.dispose());
    return client;
  };

  await host.init();
  assert.equal(state(), "off", "hosting is off until its owner turns it on");
  assert.deepEqual(await call("set", { enabled: true, ignored: "x" }).then(status => [status.enabled, status.keepAwake, status.allowDeviceCommands]), [true, true, false]);
  await until(state, value => value === "online");
  assert.equal(blocker.active.size, 1, "the computer is kept from sleeping while it hosts");
  assert.deepEqual(readSettings(path.join(root, "remote-host.json")), { enabled: true, keepAwake: true, openAtLogin: false, allowDeviceCommands: false });
  assert.ok(sent.some(([channel, status]) => channel === "remote-host:changed" && status.state === "online"), "the window hears of it");

  // A key in another account's hands pairs nothing; the same key still pairs the owner's phone.
  const { key, invitationId } = await call("connect-key");
  const stranger = device(other, "Stranger");
  assert.equal((await stranger.pair(key)).error?.code, "owner_mismatch");
  assert.equal((await call("invitation", invitationId)).consumed, false);
  const phone = device(owner, "iPhone");
  assert.equal((await phone.pair(key)).state, "online");
  assert.deepEqual(await phone.request("host.info").then((info: any) => [info.name, info.kind]), ["MacBook", "desktop"]);
  assert.equal((await phone.request("host.status") as any).kind, "desktop");
  assert.deepEqual(host.status().devices.map((entry: any) => [entry.name, entry.connected]), [["iPhone", true]]);
  assert.equal((await call("invitation", invitationId)).consumed, true);

  // Signing out pauses hosting; signing in again resumes it, and the phone comes back by itself.
  account.set(undefined);
  await until(() => host.status(), status => status.state === "paused" && status.reason === "signed_out");
  assert.equal(blocker.active.size, 0);
  await until(() => phone.status().state, value => value !== "online");
  account.set(owner);
  await until(state, value => value === "online");
  assert.equal(await phone.waitOnline(20_000), true);

  // Another account signed in here: hosting waits until this computer is unlinked from the first.
  account.set(other);
  await until(() => host.status(), status => status.state === "paused" && status.reason === "other_account");
  await assert.rejects(call("connect-key"), (error: any) => error.code === "off");
  await call("unlink");
  await until(state, value => value === "online");
  await until(() => phone.status().state, value => value === "revoked");
  assert.deepEqual(host.status().devices, [], "the first account's devices lost access");
  const laptop = device(other, "Laptop");
  assert.equal((await laptop.pair((await call("connect-key")).key)).state, "online");

  // Removing a device's access here closes its session at once.
  const laptopId = host.status().devices[0].deviceId;
  assert.deepEqual(await call("revoke-device", laptopId), { revoked: true });
  await until(() => laptop.status().state, value => value === "revoked");

  await call("set", { enabled: false });
  assert.equal(state(), "off");
  assert.equal(blocker.active.size, 0);
  assert.equal(readSettings(path.join(root, "remote-host.json")).enabled, false);
  assert.ok(fs.existsSync(path.join(root, "projects")), "the Projects folder devices use was made");
});

test("hosting stays off and says why where this computer cannot host", async t => {
  const { backend, root } = await startTestBackend(t, "test");
  const ipc = fakeIpc();
  const host = registerHost({ app: { isPackaged: false }, ipcMain: ipc, vault: memoryVault(), accountService: new FakeAccount(), backend, dataRoot: root, assertSender: () => undefined,
    getWindow: () => undefined, powerSaveBlocker: fakeBlocker(), cloudUrl: "http://127.0.0.1:9", hostName: "PC" });
  t.after(() => host.dispose());
  assert.equal(host.status().available, false);
  const refused = await ipc.invoke("set", { enabled: true });
  assert.deepEqual([refused.ok, refused.error?.code], [false, "unavailable"]);
  assert.equal((await ipc.invoke("set", "nonsense")).error?.code, "invalid_request");
  assert.equal((await ipc.invoke("revoke-device", "../etc")).error?.code, "invalid_request");
});
