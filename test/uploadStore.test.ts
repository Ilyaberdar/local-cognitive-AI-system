import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { RemoteOperationError } from "../src/remote/host/RemoteHost";
import { CHUNK_CHARS, UploadStore, type UploadMeta } from "../src/runtime/uploadStore";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVRsAAAAASUVORK5CYII=";
const code = (expected: string) => (error: unknown) => error instanceof RemoteOperationError && error.code === expected;
const meta = (content: string, extra: Partial<UploadMeta> = {}): UploadMeta => ({ name: "pixel.png", mimeType: "image/png", kind: "image", sizeBytes: 68,
  length: content.length, sha256: createHash("sha256").update(content, "utf8").digest("hex"), ...extra });
const chunks = (content: string) => Array.from({ length: Math.ceil(content.length / CHUNK_CHARS) }, (_, index) => content.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS));

test("an image arrives in chunks, resumes after begin, and becomes an attachment for its device and chat only", () => {
  const store = new UploadStore();
  const id = randomUUID();
  assert.deepEqual(store.begin("mac", id, "chat", meta(PNG)), { uploadId: id, chunkChars: CHUNK_CHARS, received: [] });
  assert.deepEqual(store.chunk("mac", id, 0, PNG), { received: 1 });
  assert.deepEqual(store.chunk("mac", id, 0, PNG), { received: 1 }, "the same chunk again is fine");
  assert.deepEqual(store.begin("mac", id, "chat", meta(PNG)).received, [0], "begin again says what arrived");
  assert.throws(() => store.begin("mac", id, "chat", meta(PNG, { name: "other.png" })), code("idempotency_conflict"));
  assert.throws(() => store.begin("phone", id, "chat", meta(PNG)), code("idempotency_conflict"));
  assert.throws(() => store.commit("phone", id), code("upload_unknown"), "another device cannot finish it");
  const summary = store.commit("mac", id);
  assert.deepEqual(summary, { id, name: "pixel.png", mimeType: "image/png", sizeBytes: 68, kind: "image" });
  assert.deepEqual(store.commit("mac", id), summary, "commit again gives the same answer");
  assert.throws(() => store.attachments("mac", "other-chat", [id]), code("attachment_unknown"));
  assert.throws(() => store.attachments("phone", "chat", [id]), code("attachment_unknown"));
  assert.equal(store.attachments("mac", "chat", [id])[0]!.dataUrl, PNG);
  store.remove([id]);
  assert.throws(() => store.attachments("mac", "chat", [id]), code("attachment_unknown"), "a turn takes it once");
});

test("damaged, oversized, misplaced and invalid uploads are refused", () => {
  const store = new UploadStore();
  const text = "Plan: ship it.";
  const wrong = randomUUID();
  store.begin("mac", wrong, "chat", { ...meta(text, { kind: "text", mimeType: "text/plain", name: "plan.txt" }), sha256: "0".repeat(64) });
  store.chunk("mac", wrong, 0, text);
  assert.throws(() => store.commit("mac", wrong), code("upload_corrupt"));
  const missing = randomUUID();
  store.begin("mac", missing, "chat", meta("x".repeat(CHUNK_CHARS + 5)));
  assert.throws(() => store.chunk("mac", missing, 2, "x"), code("invalid_request"), "outside the upload");
  assert.throws(() => store.chunk("mac", missing, 1, "xx"), code("invalid_request"), "the wrong size");
  store.chunk("mac", missing, 1, "xxxxx");
  assert.throws(() => store.chunk("mac", missing, 1, "yyyyy"), code("idempotency_conflict"));
  assert.throws(() => store.commit("mac", missing), code("upload_incomplete"));
  const blank = randomUUID();
  store.begin("mac", blank, "chat", meta("   ", { kind: "text", mimeType: "text/plain", name: "empty.txt" }));
  store.chunk("mac", blank, 0, "   ");
  assert.throws(() => store.commit("mac", blank), code("invalid_attachment"), "validated as on this computer");
  const fake = randomUUID(), notImage = "data:image/png;base64,AAAA";
  store.begin("mac", fake, "chat", meta(notImage));
  store.chunk("mac", fake, 0, notImage);
  assert.throws(() => store.commit("mac", fake), code("invalid_attachment"));
  assert.throws(() => store.begin("mac", randomUUID(), "chat", meta("x", { length: 3 * 1024 * 1024 })), code("invalid_request"));
  assert.ok(store.cancel("mac", missing).cancelled);
  assert.equal(store.cancel("phone", blank).cancelled, false);
});

test("a device's oldest waiting uploads make room for new ones; they expire after a day and go with their chat", () => {
  let now = 0;
  const store = new UploadStore(() => now);
  const ids = Array.from({ length: 20 }, (_, index) => { now = index; const id = randomUUID(); store.begin("mac", id, "chat", meta(PNG)); return id; });
  now = 100;
  store.begin("mac", randomUUID(), "chat", meta(PNG));
  assert.throws(() => store.chunk("mac", ids[0]!, 0, PNG), code("upload_unknown"), "the oldest went, not the device");
  store.chunk("mac", ids[1]!, 0, PNG);
  store.begin("phone", randomUUID(), "chat", meta(PNG));
  store.dropSession("chat");
  assert.throws(() => store.chunk("mac", ids[1]!, 0, PNG), code("upload_unknown"), "a deleted chat's uploads go");
  const late = randomUUID();
  store.begin("mac", late, "other", meta(PNG));
  now = 25 * 60 * 60 * 1000;
  store.sweep();
  assert.throws(() => store.chunk("mac", late, 0, PNG), code("upload_unknown"), "expired");
  assert.throws(() => store.begin("mac", randomUUID(), "chat", meta("x".repeat(20_001), { kind: "text", mimeType: "text/plain" })), code("invalid_request"),
    "text longer than an attachment may be is refused at once");
});
