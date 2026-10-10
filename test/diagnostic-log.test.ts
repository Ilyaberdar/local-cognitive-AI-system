import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { DiagnosticLog } from "../src/diagnostics/DiagnosticLog";
import { errorCategory } from "../src/diagnostics/errorCategory";
import { McpClientError } from "../src/mcp/client/errors";
import { LocalModelError } from "../src/local/types";

const directory = (t: TestContext) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "diagnostics");
};

test("the technical log keeps catalog events with code-like fields only, whatever a caller passes", (t) => {
  const now = Date.parse("2026-10-10T10:00:00Z");
  const log = new DiagnosticLog(directory(t), { now: () => now });
  log.record("provider.call_failed", { provider: "anthropic", outcome: "rejected", httpStatus: 401,
    // Not in the catalog or not a code: dropped.
    ...({ message: "Invalid x-api-key sk-ant-SECRET", body: "prompt text" } as object) });
  log.record("mcp.connection_failed", { transport: "stdio", code: "/Users/someone/bin/blender-mcp failed" as never });
  log.record("not.an.event" as never, { category: "x" } as never);
  const entries = log.tail();
  assert.deepEqual(entries.map(entry => [entry.event, entry.fields]), [
    ["provider.call_failed", { provider: "anthropic", outcome: "rejected", httpStatus: 401 }],
    ["mcp.connection_failed", { transport: "stdio" }]]);
  assert.equal(fs.readFileSync(log.file, "utf8").includes("SECRET"), false);
  if (process.platform !== "win32") assert.equal(fs.statSync(log.file).mode & 0o777, 0o600);
});

test("repeats within a minute are one line with a count; the files are bounded and read back checked", (t) => {
  let now = Date.parse("2026-10-10T10:00:00Z");
  const dir = directory(t);
  const log = new DiagnosticLog(dir, { now: () => now, maxBytes: 600 });
  for (let i = 0; i < 5; i++) { log.record("chat_run.failed", { category: "http_429" }); now += 1000; }
  now += 60_000;
  log.record("chat_run.failed", { category: "http_429" });
  const counts = log.tail().map(entry => entry.n);
  assert.deepEqual(counts, [1, 4, 1], "the first, the four repeats, then a new minute");
  for (let i = 0; i < 40; i++) { log.record("workflow.failed", { nodeType: "agent", category: `c${i}` }); now += 61_000; }
  const sizes = ["events.jsonl", "events.1.jsonl"].map(name => fs.statSync(path.join(dir, name)).size);
  assert.ok(sizes.every(size => size <= 600), `bounded: ${sizes}`);
  assert.equal(log.tail().at(-1)?.fields.category, "c39");
  // A line written by anything else is checked again: unknown events and fields do not come back.
  fs.appendFileSync(log.file, `${JSON.stringify({ at: new Date(now).toISOString(), event: "schedule.failed", fields: { category: "timeout", note: "C:\\\\Users\\\\x" }, n: 2 })}\n`
    + `${JSON.stringify({ at: new Date(now).toISOString(), event: "evil", fields: {} })}\nnot json\n`);
  assert.deepEqual(log.tail().at(-1), { at: new Date(now).toISOString(), event: "schedule.failed", fields: { category: "timeout" }, n: 2 });
  now += 30 * 86_400_000;
  assert.deepEqual(log.tail({ days: 14 }), [], "older than the window");
});

test("an error's category comes from its code, class or status, never from its message", () => {
  const secret = "sk-SECRET /Users/someone/project prompt";
  assert.equal(errorCategory(Object.assign(new Error(secret), { code: "ENOSPC" })), "disk_full");
  assert.equal(errorCategory(new McpClientError("command_not_found", secret)), "command_not_found");
  assert.equal(errorCategory(new LocalModelError(secret, 503, "vision_unavailable")), "vision_unavailable");
  assert.equal(errorCategory(Object.assign(new Error(secret), { name: "AbortError" })), "cancelled");
  assert.equal(errorCategory(Object.assign(new Error(secret), { statusCode: 413 })), "http_413");
  assert.equal(errorCategory(new TypeError("fetch failed", { cause: Object.assign(new Error(secret), { code: "ECONNREFUSED" }) })), "connection_refused");
  assert.equal(errorCategory(new TypeError(secret)), "js_typeerror");
  assert.equal(errorCategory(new Error(secret)), "unknown");
  assert.equal(errorCategory(Object.assign(new Error(secret), { code: "Has Spaces And /path" })), "unknown");
  assert.equal(errorCategory("a string"), "unknown");
});
