import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DownloadJob, LocalModelSnapshot } from "../src/local/types";
import { RemoteClient } from "../src/remote/client/RemoteClient";
import { RemoteRuntime, type StreamUpdate } from "../src/remote/client/RemoteRuntime";
import { memoryVault, remoteStackSkip, startCloud, startDaemon, until } from "./fixtures/remoteStack";
import { startStubHuggingFace, writeFakeLlamaServer } from "./fixtures/stubHuggingFace";

test("the Models tab manages the server's models through the relay: download across a disconnect and a restart, load, unload, delete",
  { skip: remoteStackSkip, timeout: 180_000 }, async t => {
    const cloud = await startCloud(t);
    const hub = await startStubHuggingFace(t, { padding: 3 * 1024 * 1024 });
    const tools = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lc-llama-")));
    t.after(() => fs.rm(tools, { recursive: true, force: true }));
    const server = await startDaemon(t, cloud.origin, { LOCAL_COGNITIVE_HF_ORIGIN: hub.origin, LLAMA_SERVER_PATH: await writeFakeLlamaServer(tools) });
    const alice = await cloud.account("auth0|alice");
    const mac = new RemoteClient({ cloudUrl: cloud.origin, vault: memoryVault(), account: async () => alice, deviceName: "Mac", platform: "macos", backoff: { baseMs: 50, maxMs: 300 } });
    t.after(() => mac.dispose());
    const paired = await mac.pair(server.connectKey());
    assert.equal(paired.state, "online", JSON.stringify(paired));
    const hostId = paired.hostId!;
    assert.ok(paired.capabilities?.includes("models.local.watch"), "the server offers the Models tab");
    const runtime = new RemoteRuntime(mac);
    t.after(() => runtime.dispose());

    // Everything the device receives, to check that no host directory reaches it.
    const received: unknown[] = [];
    const call = async <T = any>(op: string, payload?: unknown): Promise<T> => { const value = await runtime.request<T>(op, payload, { hostId }); received.push(value); return value; };
    const updates: StreamUpdate[] = [];
    runtime.on("update", (update: StreamUpdate) => { updates.push(update); received.push(update); });
    const latest = () => [...updates].reverse().find((update): update is { streamId: string; sequence: number; snapshot: LocalModelSnapshot } => "snapshot" in update)?.snapshot;
    const job = (): DownloadJob | undefined => latest()?.downloads[0];
    const watched = async (done: (snapshot: LocalModelSnapshot) => boolean, timeoutMs?: number) => (await until(latest, snapshot => Boolean(snapshot && done(snapshot)), timeoutMs))!;

    const page = await call<{ items: Array<{ repoId: string }> }>("models.catalog.search", { query: "tiny", source: "search" });
    assert.deepEqual(page.items.map(item => item.repoId), [hub.repoId]);
    const details = await call<{ variants: Array<{ id: string }> }>("models.catalog.get", { repoId: hub.repoId, revision: hub.revision });
    const target = { repoId: hub.repoId, revision: hub.revision, variantId: details.variants[0]!.id };

    // 1. Progress arrives through the watch; the download goes on while the Mac is away.
    runtime.watch("models.local", "models.local.watch", { hostId });
    await watched(snapshot => snapshot.downloads.length === 0);
    hub.state.chunkDelayMs = 25;
    const started = await runtime.send<DownloadJob>("models.downloads.start", target, { hostId });
    received.push(started);
    await watched(snapshot => (snapshot.downloads[0]?.downloadedBytes ?? 0) > 0);
    mac.disconnect();
    assert.deepEqual(updates.at(-1), { streamId: "models.local", resync: "host_changed" });
    const before = job()!.downloadedBytes;
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal((await mac.connect(hostId)).state, "online");
    runtime.watch("models.local", "models.local.watch", { hostId });
    await watched(snapshot => (snapshot.downloads[0]?.downloadedBytes ?? 0) > before);

    // 2. Pause and resume are the user's; a server restart leaves the download paused, and the
    // watch follows the server back without being started again.
    assert.equal((await call<DownloadJob>("models.downloads.pause", { downloadId: started.id })).state, "paused");
    await watched(snapshot => snapshot.downloads[0]?.state === "paused");
    await call("models.downloads.resume", { downloadId: started.id });
    await watched(snapshot => snapshot.downloads[0]?.state === "downloading");
    const sequenceBeforeRestart = latest()!.sequence;
    await server.restart("SIGTERM");
    await until(() => mac.status().state, state => state === "online", 30_000);
    const resumed = await watched(snapshot => snapshot.sequence !== sequenceBeforeRestart && snapshot.downloads[0]?.state === "paused", 30_000);
    assert.ok(resumed.downloads[0]!.downloadedBytes > 0, "the partial file was kept");
    const requestsBeforeResume = hub.state.ranges.length;
    await call("models.downloads.resume", { downloadId: started.id });
    await watched(snapshot => snapshot.downloads[0]?.state === "downloading");
    await until(() => hub.state.ranges.length, count => count > requestsBeforeResume);
    assert.match(hub.state.ranges.at(-1)!, /^bytes=[1-9]\d*-$/, "the download continued from the partial file");

    // 3. Cancel, then a fresh download that completes.
    assert.equal((await call<DownloadJob>("models.downloads.cancel", { downloadId: started.id })).state, "cancelled");
    hub.state.chunkDelayMs = 0;
    const second = await runtime.send<DownloadJob>("models.downloads.start", target, { hostId });
    received.push(second);
    assert.notEqual(second.id, started.id);
    await watched(snapshot => snapshot.models.length === 1 && snapshot.models[0]!.filesAvailable !== false, 30_000);
    assert.equal((await call<DownloadJob[]>("models.downloads.list")).find(entry => entry.id === second.id)?.state, "completed");

    // 4. Load on the server's CPU, unload, delete.
    const modelId = second.libraryId;
    assert.deepEqual(await call("models.load", { modelId }), { modelId, status: "ready" });
    await watched(snapshot => snapshot.models[0]?.state === "ready");
    assert.deepEqual(await call("models.unload", { modelId }), { modelId, status: "unloaded" });
    await call("models.setDefault", { modelId });
    assert.equal((await call<{ providers: { llamacpp: { model: string } } }>("models.settings.get")).providers.llamacpp.model, modelId);
    assert.deepEqual(await call("models.local.delete", { modelId }), { modelId, deleted: true });
    await watched(snapshot => snapshot.models.length === 0);
    const metrics = await call<{ memoryTotalBytes: number }>("system.metrics");
    assert.ok(metrics.memoryTotalBytes > 0);

    const exposed = JSON.stringify(received);
    for (const directory of [server.root, path.dirname(server.root), tools]) assert.equal(exposed.includes(directory), false, `${directory} reached the device`);
  });
