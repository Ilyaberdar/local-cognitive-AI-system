import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { RemoteClient } from "../src/remote/client/RemoteClient";
import { memoryVault, remoteStackSkip, startCloud, until } from "./fixtures/remoteStack";
import { startTestBackend } from "./fixtures/testBackend";

const { registerHost } = require(path.resolve("electron/host.cjs"));
const { readSettings, startsInBackground } = require(path.resolve("electron/host-settings.cjs"));

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
  assert.deepEqual(readSettings(path.join(root, "remote-host.json")), { enabled: true, keepAwake: true, openAtLogin: false, allowDeviceCommands: false, backgroundNoticeShown: false });
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
  await assert.rejects(phone.request("chat.runs.get", { runId: "4f1c1b0e-8d5a-4b8e-9c55-0a6b2f1e9d11" }), /The run does not exist on MacBook\./, "a desktop names itself, not the server");
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

  // This computer as a client of the same account lists itself, refuses its own key, and can remove itself.
  const self = new RemoteClient({ cloudUrl: cloud.origin, vault: memoryVault(), account: async () => other, deviceName: "MacBook", platform: "macos", selfHostId: () => host.hostId() });
  t.after(() => self.dispose());
  assert.deepEqual((await self.hosts()).map(entry => [entry.name, entry.self]), [["MacBook", true]]);
  await assert.rejects(self.pair((await call("connect-key")).key), (error: any) => error.code === "key_self");
  await self.removeHost(host.hostId());
  assert.deepEqual(await self.hosts(), []);

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

test("shared folders come from the folder dialog the main process opens, never from the window", async t => {
  const { backend, root } = await startTestBackend(t, "test");
  const ipc = fakeIpc(), opened: string[] = [];
  const documents = fs.realpathSync(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "lc-documents-")));
  t.after(() => fs.rmSync(documents, { recursive: true, force: true }));
  let chosen: string | undefined = documents;
  const dialog = { showOpenDialog: async () => chosen ? { canceled: false, filePaths: [chosen] } : { canceled: true, filePaths: [] } };
  const host = registerHost({ app: { isPackaged: false }, ipcMain: ipc, dialog, shell: { openPath: async (location: string) => { opened.push(location); return ""; } }, vault: memoryVault(),
    accountService: new FakeAccount(), backend, dataRoot: root, assertSender: () => undefined, getWindow: () => undefined, powerSaveBlocker: fakeBlocker(), cloudUrl: "http://127.0.0.1:9", hostName: "PC" });
  t.after(() => host.dispose());
  const value = async (name: string, ...args: unknown[]) => { const result = await ipc.invoke(name, ...args); assert.ok(result.ok, JSON.stringify(result.error)); return result.value; };
  assert.deepEqual((await value("folders")).map((folder: any) => [folder.id, folder.managed]), [["projects", true]]);
  const added = await value("add-folder", "/etc", { path: "/etc" });
  assert.deepEqual(added.map((folder: any) => folder.label), ["Projects", path.basename(documents)], "the window's arguments are ignored");
  const id = added[1].id;
  assert.equal((await value("set-folder", id, { allowCreate: true }))[1].allowCreate, true);
  await value("open-folder", id);
  await value("open-folder", "projects");
  assert.deepEqual(opened, [documents, path.join(root, "projects")]);
  chosen = root;
  assert.match((await ipc.invoke("add-folder")).error!.message, /data folder, or a folder holding it, cannot be shared/);
  chosen = undefined;
  assert.equal((await value("add-folder")).length, 2, "a cancelled dialog changes nothing");
  assert.equal((await ipc.invoke("remove-folder", "../x")).error!.code, "invalid_request");
  assert.equal((await ipc.invoke("open-folder", "../x")).error!.code, "invalid_request");
  assert.deepEqual((await value("remove-folder", id)).map((folder: any) => folder.id), ["projects"]);
});

/** Electron's tray and menu as the host module uses them: the icon made, its menu's items, destroyed or not. */
const fakeTray = () => {
  const trays: Array<{ image: unknown; tooltip?: string; items: any[]; destroyed: boolean; listeners: Record<string, () => void> }> = [];
  class Tray {
    state: { image: unknown; tooltip?: string; items: any[]; destroyed: boolean; listeners: Record<string, () => void> };
    constructor(image: unknown) { this.state = { image, items: [], destroyed: false, listeners: {} }; trays.push(this.state); }
    setToolTip(text: string) { this.state.tooltip = text; }
    setContextMenu(menu: { items: any[] }) { this.state.items = menu.items; }
    on(name: string, listener: () => void) { this.state.listeners[name] = listener; }
    destroy() { this.state.destroyed = true; }
  }
  return { Tray, Menu: { buildFromTemplate: (items: any[]) => ({ items }) }, trays };
};

test("while hosting is on: a tray or menu bar icon with the state, open at login in the installed app, a check on waking, and what quitting would stop", async t => {
  const { backend, root } = await startTestBackend(t, "desktop");
  const ipc = fakeIpc(), tray = fakeTray(), power = new EventEmitter(), opened: unknown[] = [], logins: unknown[] = [], notices: unknown[] = [];
  class Notice { static isSupported() { return true; } constructor(readonly options: unknown) {} show() { notices.push(this.options); } }
  const app = { isPackaged: true, setLoginItemSettings: (value: unknown) => { logins.push(value); }, getLoginItemSettings: () => ({ status: "requires-approval" }), quit: () => opened.push("quit") };
  const host = registerHost({ app, ipcMain: ipc, vault: memoryVault(), accountService: new FakeAccount({ accountId: "a", accessToken: "t" }), backend, dataRoot: root,
    assertSender: () => undefined, getWindow: () => undefined, powerSaveBlocker: fakeBlocker(), cloudUrl: "http://127.0.0.1:9", hostName: "MacBook",
    powerMonitor: power, Tray: tray.Tray, Menu: tray.Menu, Notification: Notice, openWindow: (target?: string) => opened.push(target ?? "app"), platform: "darwin" });
  t.after(() => host.dispose());
  await host.init();
  assert.equal(tray.trays.length, 0, "no icon while hosting is off");
  assert.equal(host.keepsRunning(), false);
  await ipc.invoke("set", { enabled: true, openAtLogin: true });
  assert.equal(tray.trays.length, 1);
  assert.match(String(tray.trays[0]!.image), /trayTemplate\.png$/, "a template image for the menu bar");
  const labels = () => tray.trays[0]!.items.map(item => item.label ?? "—");
  assert.match(labels()[0], /^Remote: (connecting…|offline, retrying)$/);
  assert.deepEqual(labels().slice(1), ["—", "Open Local Cognitive", "Connect a device…", "Turn off remote connections", "—", "Quit Local Cognitive"]);
  assert.equal(tray.trays[0]!.items[3].enabled, false, "no key to show while offline");
  tray.trays[0]!.items[2].click();
  assert.deepEqual(opened, ["app"]);
  assert.deepEqual(logins.at(-1), { openAtLogin: true, type: "mainAppService" });
  const status = (await ipc.invoke("status")).value;
  assert.deepEqual([status.openAtLoginAvailable, status.openAtLoginNeedsApproval, "backgroundNoticeShown" in status], [true, true, false]);
  assert.equal(host.keepsRunning(), true);
  assert.deepEqual(host.busy(), { connected: 0, turns: 0 });

  let checked = 0;
  host.agent().reconnectNow = () => { checked++; };
  power.emit("resume");
  assert.equal(checked, 1);

  host.noteBackground(); host.noteBackground();
  assert.equal(notices.length, 1, "said once");
  assert.equal(readSettings(path.join(root, "remote-host.json")).backgroundNoticeShown, true);
  assert.equal(startsInBackground({ app, argv: ["--background"], platform: "win32", dataRoot: root }), true);
  assert.equal(startsInBackground({ app, argv: [], platform: "win32", dataRoot: root }), false);

  await ipc.invoke("set", { enabled: false });
  assert.equal(tray.trays[0]!.destroyed, true);
  assert.deepEqual(logins.at(-1), { openAtLogin: false, type: "mainAppService" }, "hosting off: no start at login");
  assert.equal(startsInBackground({ app, argv: ["--background"], platform: "win32", dataRoot: root }), false, "nothing to wait for in the background");
});

test("main reads whether to start in the background without loading the backend, whose configuration is set after", () => {
  const { execFileSync } = require("node:child_process");
  const loaded = execFileSync(process.execPath, ["-e", `require(${JSON.stringify(path.resolve("electron/host-settings.cjs"))}); console.log(JSON.stringify(Object.keys(require.cache)))`], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(loaded).filter((file: string) => !file.endsWith("host-settings.cjs")), [], "an early backend module would read its configuration before main sets it");
});

test("letting devices approve commands is confirmed by the system's dialog, not by the window alone", async t => {
  const { backend, root } = await startTestBackend(t, "desktop");
  const ipc = fakeIpc(), asked: string[] = [];
  let answer = 1;
  const dialog = { showMessageBox: async (_window: unknown, options: { message: string }) => { asked.push(options.message); return { response: answer }; } };
  const host = registerHost({ app: { isPackaged: false }, ipcMain: ipc, dialog, vault: memoryVault(), accountService: new FakeAccount(), backend, dataRoot: root,
    assertSender: () => undefined, getWindow: () => undefined, powerSaveBlocker: fakeBlocker(), cloudUrl: "http://127.0.0.1:9", hostName: "MacBook" });
  t.after(() => host.dispose());
  assert.equal((await ipc.invoke("set", { allowDeviceCommands: true })).value.allowDeviceCommands, false, "Cancel keeps it off");
  answer = 0;
  assert.equal((await ipc.invoke("set", { allowDeviceCommands: true })).value.allowDeviceCommands, true);
  assert.equal((await ipc.invoke("set", { allowDeviceCommands: true })).value.allowDeviceCommands, true);
  assert.deepEqual(asked, ["Let your devices approve commands and files on this computer?", "Let your devices approve commands and files on this computer?"], "asked when turning it on, not again");
  assert.equal((await ipc.invoke("set", { allowDeviceCommands: false })).value.allowDeviceCommands, false, "turning it off needs no question");
  assert.equal(asked.length, 2);
});
