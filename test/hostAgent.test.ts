import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HostAgent } from "../src/remote/host/HostAgent";
import { RemoteHostStore } from "../src/remote/host/RemoteHostStore";
import { HostDatabase } from "../src/runtime/db/HostDatabase";
import { hostMigrations } from "../src/runtime/db/hostSchema";
import type { Logger } from "../src/utils/Logger";
import { memoryVault } from "./fixtures/remoteStack";

const quiet = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

test("a host offline with a long backoff tries again at once when the computer wakes", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lc-host-agent-"));
  const database = HostDatabase.open(path.join(directory, "host.db"), hostMigrations);
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let attempts = 0;
  const agent = new HostAgent({ cloudUrl: "http://127.0.0.1:9", store: new RemoteHostStore(database), vault: memoryVault(), hostName: "MacBook", serverVersion: "0.1.12",
    operations: {}, logger: quiet, backoff: { baseMs: 60_000, maxMs: 60_000 }, fetchImpl: (async () => { attempts++; throw new Error("offline"); }) as unknown as typeof fetch });
  t.after(() => agent.stop());
  await agent.start();
  for (let i = 0; i < 50 && agent.status().state !== "offline"; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual([agent.status().state, attempts], ["offline", 1], "the next try waits 30–60 s");
  agent.reconnectNow();
  for (let i = 0; i < 50 && attempts < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(attempts, 2, "woken, it tries now");
  agent.stop();
  agent.reconnectNow();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(attempts, 2, "a stopped host stays stopped");
});
