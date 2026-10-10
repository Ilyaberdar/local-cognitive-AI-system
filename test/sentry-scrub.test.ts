import assert from "node:assert/strict";
import test from "node:test";
import { maskText, scrubSentryBreadcrumb, scrubSentryEvent } from "../src/diagnostics/sentryScrub";

const errorEvent = () => ({
  level: "error", server_name: "Gamzatels-MacBook-Pro.local", user: { ip_address: "1.2.3.4", id: "u" }, request: { url: "http://127.0.0.1:5000/#/sessions/abc", data: "prompt" },
  extra: { prompt: "my diary" }, modules: { left: "1" },
  breadcrumbs: [{ category: "console", message: "[INFO] Chat run failed {\"error\":\"secret answer\"}" }, { category: "lc", message: "provider.call_failed", data: { httpStatus: 401 } },
    { category: "electron", message: "browser-window-focus", data: { title: "My private chat" } }],
  contexts: { os: { name: "macOS" }, device: { arch: "arm64", name: "Gamzatels-MacBook-Pro", memory_size: 1 }, app: { app_name: "Local Cognitive", app_version: "0.1.0", app_start_time: "x" },
    electron: { crashed_url: "http://127.0.0.1:5000/#/sessions/abc", details: { reason: "crashed" }, "crashpad.foo": "bar" }, profile: { email: "a@b.c" } },
  exception: { values: [{ type: "Error", value: "Request to https://api.openai.com/v1/responses?key=sk-proj-ABCDEFGHIJKLMNOP failed for /Users/someone/project/notes.md (user@example.com)",
    stacktrace: { frames: [{ filename: "app:///dist/src/llm/LLMService.js", lineno: 3, context_line: "x()", vars: { prompt: "my diary" } },
      { filename: "/Users/someone/.mcp/server.js", abs_path: "/Users/someone/.mcp/server.js", context_line: "secret", vars: { a: 1 } }] } }] }
});

test("an error report leaves with allowlisted contexts, the log's breadcrumbs and masked text, only with consent", () => {
  assert.equal(scrubSentryEvent(errorEvent(), false), null, "no consent, no automatic report");
  const event = scrubSentryEvent(errorEvent(), true) as any;
  for (const key of ["server_name", "user", "request", "extra", "modules"]) assert.equal(key in event, false, key);
  assert.deepEqual(event.breadcrumbs, [{ category: "lc", message: "provider.call_failed", data: { httpStatus: 401 } }]);
  assert.deepEqual(Object.keys(event.contexts).sort(), ["app", "device", "electron", "os"]);
  assert.deepEqual(event.contexts.device, { arch: "arm64", memory_size: 1 });
  assert.deepEqual(event.contexts.electron, { crashed_url: "app", details: { reason: "crashed" } });
  const value = event.exception.values[0].value as string;
  assert.equal(value, "Request to https://<host> failed for <path>/notes.md (<email>)");
  const [ours, theirs] = event.exception.values[0].stacktrace.frames;
  assert.deepEqual(ours, { filename: "app:///dist/src/llm/LLMService.js", lineno: 3, context_line: "x()" });
  assert.deepEqual(theirs, { filename: "<path>/server.js" });
  assert.equal(JSON.stringify(event).match(/diary|someone|Gamzatel|example\.com|sk-proj|1\.2\.3\.4|sessions\/abc|private chat/), null);
});

test("a bug report is sent because the user pressed Send: without breadcrumbs, user or page address", () => {
  const feedback = scrubSentryEvent({ type: "feedback", user: { ip_address: "1.2.3.4" }, breadcrumbs: [{ category: "lc", message: "x" }],
    contexts: { feedback: { message: "The model hangs", contact_email: "me@example.com", url: "http://127.0.0.1:5000/#/sessions/abc" }, lc: { mode: "local" } } }, false) as any;
  assert.ok(feedback, "no automatic consent needed");
  assert.deepEqual(feedback.breadcrumbs, []);
  assert.equal("user" in feedback, false);
  assert.deepEqual(feedback.contexts, { feedback: { message: "The model hangs", contact_email: "me@example.com" }, lc: { mode: "local" } }, "the user's own text and contact stay");
});

test("masking: tokens, keys, JWTs, credentials, paths on every system, and a length bound", () => {
  assert.equal(maskText("Authorization: Bearer abc.def.ghi"), "Authorization: <credential>");
  assert.equal(maskText("key sk-ant-api03-AbCdEfGhIjKlMnOp"), "key <secret>");
  assert.equal(maskText("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"), "jwt <token>");
  assert.equal(maskText("C:\\Users\\Ilya\\Documents\\secret.txt missing"), "<path>/secret.txt missing");
  assert.equal(maskText("/home/ilya/.config/app.json"), "<path>/app.json");
  assert.equal(maskText("hash 3f786850e387550fdab836ed7e6dc881de23001b"), "hash <secret>");
  assert.equal(maskText("x".repeat(1000)).length <= 300, true);
  assert.equal(maskText("Cannot read properties of undefined (reading 'model')"), "Cannot read properties of undefined (reading 'model')", "ordinary messages stay readable");
});

test("breadcrumbs: only the technical log's", () => {
  assert.equal(scrubSentryBreadcrumb({ category: "console", message: "x" }), null);
  assert.equal(scrubSentryBreadcrumb({ category: "electron", message: "x" }), null);
  assert.deepEqual(scrubSentryBreadcrumb({ category: "lc", message: "mcp.connection_failed" }), { category: "lc", message: "mcp.connection_failed" });
});
