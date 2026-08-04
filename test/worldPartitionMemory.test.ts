import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import test from "node:test";
import { Logger } from "../src/utils/Logger";
import { VectorStore } from "../src/memory/VectorStore";
import { WorldPartitionMemoryAdapter } from "../src/memory/WorldPartitionMemoryAdapter";
import { WorldPartitionStore } from "../src/memory/WorldPartitionStore";
import { MemoryWorldPartitionSettings } from "../src/types";

const createAdapter = (baseDir: string, overrides: Partial<MemoryWorldPartitionSettings> = {}) =>
  new WorldPartitionMemoryAdapter(
    {
      baseDir,
      topK: 5,
      crossSessionRecall: true,
      strategy: "auto",
      activationThreshold: 2,
      chunkCapacity: 2,
      initialRadius: 1,
      maxRadius: 3,
      fallbackToGlobalSearch: true,
      migrateLegacyOnStart: true,
      ...overrides
    },
    new VectorStore(),
    new Logger()
  );

test("world partition recalls durable memory across sessions and keeps session timelines isolated", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcai-world-memory-"));
  const adapter = createAdapter(root);
  const firstActor = { sessionId: "session-one", userId: "user-one", channel: "http" as const };

  await adapter.save({
    input: "I prefer local-first tooling.",
    mode: "general",
    output: { response: "Preference stored." },
    actor: firstActor
  });
  await adapter.save({
    input: "My current project uses TypeScript.",
    mode: "code",
    output: { response: "Project fact stored." },
    actor: firstActor
  });

  const nextActor = { sessionId: "session-two", userId: "user-one", channel: "http" as const };
  const recalled = await adapter.query("What tooling do I prefer?", { actor: nextActor });

  assert.ok(recalled.some((entry) => entry.input.includes("local-first")));
  assert.equal((await adapter.recent({ actor: nextActor })).length, 0);
  assert.equal((await adapter.recent({ actor: firstActor })).length, 2);

  await adapter.deleteSession(firstActor.sessionId);

  assert.equal((await adapter.recent({ actor: firstActor })).length, 0);
  assert.ok((await adapter.query("What project language do I use?", { actor: nextActor })).length >= 1);
});

test("world partition migrates local JSON memory without crossing user boundaries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcai-world-migration-"));
  const scopeDir = path.join(root, "agent_general");
  await fs.mkdir(scopeDir, { recursive: true });
  await fs.writeFile(
    path.join(scopeDir, "legacy.json"),
    JSON.stringify({
      id: "legacy-entry",
      input: "My editor preference is Vim keybindings.",
      mode: "general",
      output: { response: "Stored." },
      scope: "agent_general",
      tags: ["general"],
      embedding: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      actor: { sessionId: "legacy-session", userId: "user-one", channel: "http" }
    }),
    "utf8"
  );

  const adapter = createAdapter(root);
  const sameUser = await adapter.query("Which editor preference did I store?", {
    actor: { sessionId: "new-session", userId: "user-one", channel: "http" }
  });
  const otherUser = await adapter.query("Which editor preference did I store?", {
    actor: { sessionId: "other-session", userId: "user-two", channel: "http" }
  });

  assert.equal(sameUser[0]?.id, "legacy-entry");
  assert.equal(otherUser.length, 0);
});

test("legacy entries without a profile remain available to their original session after migration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcai-world-legacy-session-"));
  const scopeDir = path.join(root, "agent_general");
  await fs.mkdir(scopeDir, { recursive: true });
  await fs.writeFile(
    path.join(scopeDir, "legacy.json"),
    JSON.stringify({
      id: "legacy-session-entry",
      input: "This belongs to the original browser session.",
      mode: "general",
      output: { response: "Stored." },
      scope: "agent_general",
      tags: ["general"],
      embedding: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      actor: { sessionId: "legacy-session", channel: "http" }
    }),
    "utf8"
  );

  const adapter = createAdapter(root);
  const originalSession = { sessionId: "legacy-session", userId: "server-profile", channel: "http" as const };
  const nextSession = { sessionId: "next-session", userId: "server-profile", channel: "http" as const };

  assert.equal((await adapter.query("What belongs to this browser session?", { actor: originalSession }))[0]?.id, "legacy-session-entry");
  assert.equal((await adapter.recent({ actor: originalSession })).length, 1);
  assert.equal((await adapter.query("What belongs to this browser session?", { actor: nextSession })).length, 0);
});

test("session-scoped memory is removed with its session and channels have isolated user identities", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcai-world-isolation-"));
  const sessionAdapter = createAdapter(root, { crossSessionRecall: false });
  const sessionActor = { sessionId: "temporary-session", userId: "same-user", channel: "http" as const };
  await sessionAdapter.save({
    input: "Delete this session-scoped memory.",
    mode: "general",
    output: { response: "Stored." },
    actor: sessionActor
  });
  await sessionAdapter.deleteSession(sessionActor.sessionId);
  assert.equal((await sessionAdapter.query("Delete this session-scoped memory.", { actor: sessionActor })).length, 0);

  const channelAdapter = createAdapter(path.join(root, "channel"));
  await channelAdapter.save({
    input: "Telegram-only memory.",
    mode: "general",
    output: { response: "Stored." },
    actor: { sessionId: "telegram-chat", userId: "42", channel: "telegram" }
  });
  const httpResults = await channelAdapter.query("Telegram-only memory.", {
    actor: { sessionId: "http-chat", userId: "42", channel: "http" }
  });
  assert.equal(httpResults.length, 0);

  const sharedSession = "mcp-default";
  await channelAdapter.save({
    input: "Secret for Alice.",
    mode: "general",
    output: { response: "Stored." },
    actor: { sessionId: sharedSession, userId: "alice", channel: "mcp" }
  });
  await channelAdapter.save({
    input: "Secret for Bob.",
    mode: "general",
    output: { response: "Stored." },
    actor: { sessionId: sharedSession, userId: "bob", channel: "mcp" }
  });
  await channelAdapter.save({
    input: "Anonymous legacy MCP memory.",
    mode: "general",
    output: { response: "Stored." },
    actor: { sessionId: sharedSession, channel: "mcp" }
  });
  const aliceTimeline = await channelAdapter.recent({
    actor: { sessionId: sharedSession, userId: "alice", channel: "mcp" }
  });
  assert.deepEqual(aliceTimeline.map((entry) => entry.input), ["Secret for Alice."]);
  const aliceRetrieval = await channelAdapter.query("Anonymous legacy MCP memory.", {
    actor: { sessionId: sharedSession, userId: "alice", channel: "mcp" }
  });
  assert.ok(!aliceRetrieval.some((entry) => entry.input === "Anonymous legacy MCP memory."));
});

test("migration retry recovers an orphaned chunk without duplicating its entry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcai-world-recovery-"));
  const store = new WorldPartitionStore({ baseDir: root, chunkCapacity: 1 });
  const actorKey = store.actorKey("user:http:recovery");
  const first = {
    id: "first",
    input: "First entry",
    mode: "general" as const,
    output: { response: "First" },
    scope: "general",
    tags: [],
    embedding: [1],
    createdAt: "2026-01-01T00:00:00.000Z",
    actor: { sessionId: "recovery-session", userId: "recovery", channel: "http" as const }
  };
  const orphan = { ...first, id: "orphan", input: "Orphan entry" };

  await store.append(actorKey, first.actor.sessionId, "cell", first);
  const orphanPath = path.join(store.worldDir, "actors", actorKey, "cells", "cell", "chunk-000002.jsonl");
  await fs.writeFile(orphanPath, `${JSON.stringify(orphan)}\n`, "utf8");

  const restartedStore = new WorldPartitionStore({ baseDir: root, chunkCapacity: 1 });
  assert.equal(await restartedStore.getEntryCount(actorKey), 2);
  assert.deepEqual((await restartedStore.readEntries(actorKey)).map((entry) => entry.id), ["first", "orphan"]);
  assert.equal(await restartedStore.append(actorKey, orphan.actor.sessionId, "cell", orphan, true), false);
});
