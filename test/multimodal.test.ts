import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleProvider } from "../src/llm/OpenAICompatibleProvider";
import { AnthropicProvider } from "../src/llm/AnthropicProvider";
import { GeminiProvider } from "../src/llm/GeminiProvider";
import { OllamaProvider } from "../src/llm/OllamaProvider";
import { LLMRegistry } from "../src/llm/LLMRegistry";
import { LLMService } from "../src/llm/LLMService";
import { OutputSanitizer } from "../src/llm/OutputSanitizer";
import { withInferenceImages } from "../src/llm/InferenceImages";
import { Logger } from "../src/utils/Logger";
import { conversationAttachments, renderAttachmentContext, validateAttachments } from "../src/utils/attachments";
import { ChatAttachment, MemoryEntry } from "../src/types";

export const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVRsAAAAASUVORK5CYII=";
const dataUrl = `data:image/png;base64,${png}`;
const image = { name: "sample.png", dataUrl };
const attachment: ChatAttachment = { ...image, id: "image-1", kind: "image", mimeType: "image/png", sizeBytes: 68 };
const options = { baseUrl: "http://127.0.0.1:9999", model: "vision-fixture", timeoutMs: 1000, apiKey: "test" };
const logger = new Logger();

test("all provider transports carry the actual image bytes", async (t) => {
  let url = "", body: any;
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    url = input; body = JSON.parse(String(init.body));
    return Response.json({ output_text: "observed", choices: [{ message: { content: "observed" } }], response: "observed", content: [{ type: "text", text: "observed" }], candidates: [{ content: { parts: [{ text: "observed" }] } }] });
  });
  for (const id of ["openai", "llamacpp", "lmstudio"]) {
    const provider = new OpenAICompatibleProvider({ ...options, id, name: id }, logger);
    const result = await provider.generateText({ prompt: "Describe", systemPrompt: "Inspect pixels", images: [image], maxTokens: 99 });
    assert.equal(result.text, "observed");
    assert.equal(result.error, undefined);
    if (id === "openai") {
      assert.match(url, /\/responses$/);
      assert.equal(body.input[0].content[1].image_url, dataUrl);
      assert.equal(body.instructions, "Inspect pixels");
    } else {
      assert.match(url, /\/chat\/completions$/);
      assert.equal(body.messages[0].content, "Inspect pixels");
      assert.equal(body.messages[1].content[1].image_url.url, dataUrl);
      assert.equal(body.max_tokens, 99);
    }
    await provider.generateText({ prompt: "text only" });
    assert.match(url, /\/responses$/);
    assert.equal(body.input, "text only");
  }
  await new AnthropicProvider({ ...options, version: "2023-06-01", maxTokens: 100 }, logger).generateText({ prompt: "Describe", images: [image] });
  assert.deepEqual(body.messages[0].content[0].source, { type: "base64", media_type: "image/png", data: png });
  await new GeminiProvider(options, logger).generateText({ prompt: "Describe", images: [image] });
  assert.deepEqual(body.contents[0].parts[1].inline_data, { mime_type: "image/png", data: png });
  await new OllamaProvider(options, logger).generateText({ prompt: "Describe", images: [image] });
  assert.deepEqual(body.images, [png]);
});

test("unsupported vision errors remain errors without a silent text-only retry", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({ error: { message: "model does not support images" } }, { status: 400 }));
  const result = await new OpenAICompatibleProvider({ ...options, id: "llamacpp", name: "Local" }, logger).generateText({ prompt: "Describe", images: [image] });
  assert.equal(result.text, "");
  assert.match(result.error!, /does not support images/);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("parallel inference scopes cannot mix images and explicit empty images suppress inheritance", async () => {
  const registry = new LLMRegistry();
  const received = new Map<string, unknown>();
  registry.register({ id: "fixture", name: "fixture", defaultModel: "fixture", isConfigured: () => true,
    getDescriptor: () => ({ id: "fixture", name: "fixture", defaultModel: "fixture", configured: true }),
    generateText: async (request) => { await new Promise(resolve => setTimeout(resolve, request.prompt === "first" ? 20 : 2)); received.set(request.prompt, request.images); return { provider: "fixture", model: "fixture", text: "ok" }; }
  });
  const llm = new LLMService(registry, "fixture", logger, new OutputSanitizer());
  const second = { ...image, name: "second.png" };
  await Promise.all([
    withInferenceImages([image], () => llm.generateText({ prompt: "first" })),
    withInferenceImages([second], async () => { await llm.generateText({ prompt: "second" }); await llm.generateText({ prompt: "translation", images: [] }); }),
    llm.generateText({ prompt: "unrelated" })
  ]);
  assert.deepEqual(received.get("first"), [image]);
  assert.deepEqual(received.get("second"), [second]);
  assert.deepEqual(received.get("translation"), []);
  assert.deepEqual(received.get("unrelated"), []);
});

test("attachments reject missing pixels, arbitrary binary data and oversized payloads", () => {
  assert.deepEqual(validateAttachments([attachment]), [{ ...attachment, textContent: undefined, truncated: undefined, warning: undefined }]);
  assert.throws(() => validateAttachments([{ ...attachment, dataUrl: undefined }]), /Reattach/);
  assert.throws(() => validateAttachments([{ ...attachment, dataUrl: "data:image/png;base64,aGVsbG8=" }]), /file type/);
  assert.throws(() => validateAttachments(Array(6).fill(attachment)), /five/);
  assert.throws(() => validateAttachments([{ ...attachment, kind: "binary" }]), /not a supported/);
  assert.throws(() => validateAttachments([{ ...attachment, sizeBytes: 6 * 1024 ** 2 }]), /5 MB/);
  assert.match(renderAttachmentContext([{ ...attachment, kind: "text", textContent: "x".repeat(15000) }]), /truncated/);
});

test("follow-up context prioritizes current attachments, deduplicates history and skips legacy images", () => {
  const entry = (files: ChatAttachment[], date: string) => ({ createdAt: date, metadata: { requestMetadata: { attachments: files } } } as unknown as MemoryEntry);
  const legacy = { ...attachment, id: "old", dataUrl: undefined };
  const newer = { ...attachment, id: "newer" };
  const files = conversationAttachments([newer], [entry([attachment, legacy], "2026-09-01"), entry([newer], "2026-09-02")]);
  assert.deepEqual(files.map(file => file.id), ["newer", "image-1"]);
  const barrier = entry([], "2026-09-03");
  barrier.metadata = { requestMetadata: { includePreviousAttachments: false } };
  assert.deepEqual(conversationAttachments([], [entry([attachment], "2026-09-01"), barrier]), []);
});
