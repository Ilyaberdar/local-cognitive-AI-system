import assert from "node:assert/strict";
import test from "node:test";
import { RemoteClient } from "../src/remote/client/RemoteClient";
import { RemoteRuntime } from "../src/remote/client/RemoteRuntime";
import { memoryVault, remoteStackSkip, startCloud, startDaemon, startStubModel, until } from "./fixtures/remoteStack";

const KEY = "sk-e2e-provider-key-0123456789";

test("a provider key is set on the server from a device, used there, kept across a restart, cleared, and never sent back",
  { skip: remoteStackSkip, timeout: 180_000 }, async t => {
    const cloud = await startCloud(t);
    const model = await startStubModel(t, "ok");
    const server = await startDaemon(t, cloud.origin, { OPENAI_BASE_URL: model.url, OPENAI_MODEL: "fixture" });
    const alice = await cloud.account("auth0|alice");
    const mac = new RemoteClient({ cloudUrl: cloud.origin, vault: memoryVault(), account: async () => alice, deviceName: "Mac", platform: "macos", backoff: { baseMs: 50, maxMs: 300 } });
    t.after(() => mac.dispose());
    const paired = await mac.pair(server.connectKey());
    assert.equal(paired.state, "online", JSON.stringify(paired));
    const hostId = paired.hostId!;
    const runtime = new RemoteRuntime(mac);
    t.after(() => runtime.dispose());
    const received: unknown[] = [];
    const call = async <T = any>(op: string, payload?: unknown): Promise<T> => { const value = await runtime.request<T>(op, payload, { hostId }); received.push(value); return value; };

    const initial = await call("settings.get");
    assert.equal(initial.settings.providers.openai.apiKeyState, "unset");
    assert.equal(initial.settings.providers.openai.baseUrl, new URL(model.url).origin, "the address as an origin only");

    const saved = await call("settings.update", { providers: { openai: { apiKey: { set: KEY }, enabled: true, model: "fixture" } } });
    assert.equal(saved.settings.providers.openai.apiKeyState, "set");
    const tested = await call("providers.test", { providerId: "openai" });
    assert.equal(tested.ok, true, JSON.stringify(tested));
    assert.equal(model.state.authorizations.at(-1), `Bearer ${KEY}`, "the server used the key it was given");

    await server.restart("SIGTERM");
    await until(() => mac.status().state, state => state === "online", 30_000);
    assert.equal((await call("settings.get")).settings.providers.openai.apiKeyState, "set", "the key survives a restart");

    for (const [patch, expected] of [[{ filesystem: { accessMode: "full" } }, "host_only"], [{ providers: { openai: { baseUrl: "http://127.0.0.1:1/v1" } } }, "host_only"],
      [{ ui: { theme: "light" } }, "client_setting"]] as const) {
      await assert.rejects(call("settings.update", patch), (error: { code?: string }) => error.code === expected, JSON.stringify(patch));
    }

    const cleared = await call("settings.update", { providers: { openai: { apiKey: { clear: true } } } });
    assert.equal(cleared.settings.providers.openai.apiKeyState, "unset");
    const requestsBefore = model.state.requests;
    assert.equal((await call("providers.test", { providerId: "openai" })).ok, false, "no key, no answer");
    assert.equal(model.state.authorizations.slice(requestsBefore).some(value => value.includes(KEY)), false, "the cleared key is not used again");

    const exposed = JSON.stringify(received);
    for (const secret of [KEY, server.root]) assert.equal(exposed.includes(secret), false, `${secret} reached the device`);
    assert.equal(server.log().includes(KEY), false, "the key is not written to the server's log");
  });
