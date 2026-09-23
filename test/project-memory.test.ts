import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalJsonMemoryAdapter } from "../src/memory/LocalJsonMemoryAdapter";
import { WorldPartitionMemoryAdapter } from "../src/memory/WorldPartitionMemoryAdapter";
import { OpenMemoryAdapter } from "../src/memory/OpenMemoryAdapter";
import { VectorStore } from "../src/memory/VectorStore";
import { Logger } from "../src/utils/Logger";
import { ActorContext } from "../src/types";

const createWorld = (baseDir: string) => new WorldPartitionMemoryAdapter({ baseDir, topK: 20, crossSessionRecall: true,
  strategy: "global", activationThreshold: 2, chunkCapacity: 1, initialRadius: 1, maxRadius: 3,
  fallbackToGlobalSearch: true, migrateLegacyOnStart: true }, new VectorStore(), new Logger());

for (const kind of ["local-json", "world-partition"] as const) {
  test(`${kind} scopes recall to project/task and preserves separate session timelines`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcai-project-memory-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const adapter = kind === "local-json" ? new LocalJsonMemoryAdapter({ baseDir: root, topK: 20 }, new VectorStore(), new Logger()) : createWorld(root);
    const first: ActorContext = { sessionId: "first", userId: "user", channel: "http", memoryScope: "project:A" };
    const second = { ...first, sessionId: "second" };
    const save = (actor: ActorContext, input: string) => adapter.save({ input, mode: "general", output: { response: input }, actor });
    await save(first, "A first");
    await save(second, "A second");
    await save({ ...first, memoryScope: "project:B", sessionId: "other-project" }, "B only");
    await save({ ...first, memoryScope: "task:T", sessionId: "task" }, "Task only");
    await save({ ...first, userId: "someone-else", sessionId: "other-user" }, "Other user");
    await save({ ...first, channel: "telegram", sessionId: "other-channel" }, "Other channel");
    await save({ ...first, memoryScope: undefined, sessionId: "legacy" }, "Legacy only");
    assert.deepEqual((await adapter.query("A", { actor: second })).map(entry => entry.input).sort(), ["A first", "A second"]);
    assert.deepEqual((await adapter.recent({ actor: second })).map(entry => entry.input), ["A second"]);
    assert.ok((await adapter.query("everything", { actor: { ...first, memoryScope: undefined, sessionId: "legacy" } }))
      .every(entry => !entry.actor.memoryScope));
    assert.equal((await adapter.query("A", { actor: { ...first, memoryScope: "project:missing" } })).length, 0);
    assert.equal((await adapter.query("A", { actor: { sessionId: "unspecified-channel", userId: "user", memoryScope: "project:A" } })).length, 0);
    await adapter.deleteSession(first.sessionId);
    assert.deepEqual((await adapter.query("A", { actor: second })).map(entry => entry.input), ["A second"]);
    assert.equal((await adapter.recent({ actor: first })).length, 0);
    await save(second, "A after deletion");
    assert.deepEqual((await adapter.query("A", { actor: second })).map(entry => entry.input).sort(), ["A after deletion", "A second"]);
    if (kind === "world-partition") {
      assert.deepEqual((await createWorld(root).query("A", { actor: second })).map(entry => entry.input).sort(), ["A after deletion", "A second"]);
    }
  });
}

test("OpenMemory writes include workspace, user and channel in the storage identity", async () => {
  const adapter = new OpenMemoryAdapter({ dbPath: "/unused-test" }, new Logger());
  const writes: Array<{ userId: string }> = [];
  (adapter as any).client = { add: async (_content: string, options: { userId: string }) => { writes.push(options); } };
  const actor = { sessionId: "chat", userId: "profile", channel: "http" as const };
  for (const memoryScope of [undefined, "project:A", "project:B"]) {
    await adapter.save({ input: "fact", mode: "general", output: "saved", actor: { ...actor, memoryScope } });
  }
  assert.equal(writes[0].userId, "profile");
  assert.equal(new Set(writes.map(item => item.userId)).size, 3);
  assert.deepEqual(await adapter.query("fact", { actor }), []);
});
