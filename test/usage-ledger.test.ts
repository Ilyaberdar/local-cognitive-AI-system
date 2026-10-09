import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { LLMRegistry } from "../src/llm/LLMRegistry";
import { LLMService } from "../src/llm/LLMService";
import { OutputSanitizer } from "../src/llm/OutputSanitizer";
import { HostDatabase } from "../src/runtime/db/HostDatabase";
import { hostMigrations } from "../src/runtime/db/hostSchema";
import { UsageAttemptRecord } from "../src/usage/UsageCall";
import { UsageAttribution, UsageLedger } from "../src/usage/UsageLedger";
import { withUsageScope } from "../src/usage/UsageScope";
import { Logger } from "../src/utils/Logger";

const file = (t: TestContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-ledger-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "host.db");
};
const attempt = (patch: Partial<UsageAttemptRecord> = {}): UsageAttemptRecord => ({
  eventId: randomUUID(), callId: "call-1", attempt: 1, provider: "anthropic", model: "claude", scope: {},
  startedAt: "2026-10-09T10:00:00.000Z", occurredAt: "2026-10-09T10:00:02.000Z", outcome: "completed", httpStatus: 200,
  usageSource: "reported", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 80 }, ...patch
});
const rows = (host: HostDatabase) => host.db.prepare("SELECT * FROM usage_events ORDER BY rowid").all() as Array<Record<string, unknown>>;

test("a host.db of the previous version gains the ledger and keeps its device grants", (t) => {
  const target = file(t);
  const old = HostDatabase.open(target, hostMigrations.slice(0, 2));
  old.db.prepare(`INSERT INTO remote_grants(device_id, account_id, device_spki_sha256, status, receipt_id, granted_at) VALUES ('d1', 'a1', 'k1', 'active', 'r1', '2026-01-01')`).run();
  old.close();
  const host = HostDatabase.open(target, hostMigrations);
  t.after(() => host.close());
  assert.equal(host.schemaVersion(), 3);
  assert.equal(host.db.prepare("SELECT count(*) AS n FROM remote_grants").get()?.n, 1);
  assert.equal(host.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'usage_outbox'").get()?.n, 0, "the unused v1 outbox is gone");
  const ledger = new UsageLedger(host, () => ({}));
  assert.match(ledger.runtimeId, /^[0-9a-f-]{36}$/);
  assert.ok(Date.parse(ledger.startedAt));
});

test("calls for an account wait to be sent; without one they stay on this computer; ids are only references", (t) => {
  const host = HostDatabase.open(file(t), hostMigrations);
  t.after(() => host.close());
  let who: UsageAttribution = { accountId: "acct-1", hostId: "host-1" };
  const ledger = new UsageLedger(host, () => who);
  ledger.record([attempt({ attempt: 1, outcome: "rejected", httpStatus: 529, usageSource: "unknown", usage: undefined }),
    attempt({ attempt: 2, scope: { origin: "chat", purpose: "judge", runId: "run-7", sessionId: "telegram:12345" } })]);
  who = {};
  ledger.record([attempt({ callId: "call-2", usageSource: "unknown", usage: undefined, scope: { runId: "run-7" } })]);
  const broken = new UsageLedger(host, () => { throw new Error("store closed"); });
  broken.record([attempt({ callId: "call-3" })]);
  const [refused, answered, local, unattributed] = rows(host);
  assert.deepEqual([refused!.sync_state, refused!.account_id, refused!.execution_host_id, refused!.input_tokens, refused!.http_status], ["pending", "acct-1", "host-1", null, 529]);
  assert.deepEqual([answered!.input_tokens, answered!.output_tokens, answered!.total_tokens, answered!.cached_input_tokens, answered!.cache_write_tokens, answered!.reasoning_tokens],
    [100, 20, 120, 80, null, null], "unreported parts are NULL, never 0");
  assert.deepEqual([answered!.origin, answered!.purpose, answered!.usage_source], ["chat", "judge", "reported"]);
  assert.equal(local!.sync_state, "local_only");
  assert.equal(local!.account_id, null);
  assert.equal(local!.execution_host_id, ledger.runtimeId, "a runtime without a Cloud id uses its own");
  assert.equal(unattributed!.sync_state, "local_only");
  // The same run is the same reference; neither the run nor the Telegram chat id is stored.
  assert.equal(answered!.run_ref, local!.run_ref);
  assert.equal(String(answered!.run_ref).length, 32);
  const all = JSON.stringify(rows(host));
  assert.equal(all.includes("run-7") || all.includes("12345"), false);
});

test("the ledger records what LLMService sends, scope and all", async (t) => {
  const host = HostDatabase.open(file(t), hostMigrations);
  t.after(() => host.close());
  const ledger = new UsageLedger(host, () => ({ accountId: "acct-1" }));
  const registry = new LLMRegistry();
  registry.register({ id: "plain", name: "Plain", defaultModel: "/Users/someone/models/q.gguf", isConfigured: () => true,
    getDescriptor: () => ({ id: "plain", name: "Plain", defaultModel: "q", configured: true }),
    generateText: async () => ({ provider: "plain", model: "/Users/someone/models/q.gguf", text: "ok", usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 } }) });
  const llm = new LLMService(registry, "plain", new Logger(), new OutputSanitizer(), ledger);
  await withUsageScope({ origin: "workflow", runId: "wf-1" }, () => llm.generateText({ prompt: "secret prompt", usagePurpose: "agent" }));
  const [row] = rows(host);
  assert.deepEqual([row!.provider, row!.model, row!.origin, row!.purpose, row!.total_tokens, row!.sync_state], ["plain", "q.gguf", "workflow", "agent", 12, "pending"]);
  assert.equal(JSON.stringify(row).includes("secret") || JSON.stringify(row).includes("/Users/"), false);
});
