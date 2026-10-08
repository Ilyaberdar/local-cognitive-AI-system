import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { TestContext } from "node:test";

/** A valid little GGUF (architecture, name, chat template) padded to `padding` bytes. */
export const tinyGguf = (padding = 256 * 1024): Buffer => {
  const u32 = (value: number) => { const result = Buffer.alloc(4); result.writeUInt32LE(value); return result; };
  const u64 = (value: number) => { const result = Buffer.alloc(8); result.writeBigUInt64LE(BigInt(value)); return result; };
  const text = (value: string) => Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)]);
  return Buffer.concat([Buffer.from("GGUF"), u32(3), u64(0), u64(3), text("general.architecture"), u32(8), text("llama"),
    text("general.name"), u32(8), text("Tiny fixture"), text("tokenizer.chat_template"), u32(8), text("{{messages}}"), Buffer.alloc(padding, 42)]);
};

/** Hugging Face's catalog, model card and file endpoints for one tiny model, on loopback.
 * `state.chunkDelayMs` slows the file so progress, pause and resume can be observed. */
export async function startStubHuggingFace(t: TestContext, options: { padding?: number; chunkBytes?: number } = {}) {
  const bytes = tinyGguf(options.padding);
  const repoId = "author/tiny-GGUF", revision = "c".repeat(40), file = "tiny-Q4_K_M.gguf";
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const record = { id: repoId, sha: revision, tags: ["gguf", "license:mit"], pipeline_tag: "text-generation",
    siblings: [{ rfilename: file, size: bytes.length, lfs: { size: bytes.length, sha256 } }] };
  const state = { chunkDelayMs: 0, fileRequests: 0, ranges: [] as string[] };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://stub");
    const json = (value: unknown) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); };
    if (url.pathname === "/api/models") return json([record]);
    if (url.pathname === `/api/models/${repoId}` || url.pathname === `/api/models/${repoId}/revision/${revision}`) return json(record);
    if (url.pathname === `/${repoId}/resolve/${revision}/${file}`) {
      state.fileRequests++;
      const range = String(request.headers.range ?? "");
      state.ranges.push(range);
      const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
      response.writeHead(start ? 206 : 200, { "content-length": String(bytes.length - start),
        ...(start ? { "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}) });
      const chunk = options.chunkBytes ?? 16 * 1024;
      for (let position = start; position < bytes.length && !response.destroyed; position += chunk) {
        if (state.chunkDelayMs) await new Promise(resolve => setTimeout(resolve, state.chunkDelayMs));
        if (!response.write(bytes.subarray(position, Math.min(bytes.length, position + chunk)))) await new Promise(resolve => response.once("drain", resolve));
      }
      response.end();
      return;
    }
    response.statusCode = 404;
    json({ error: "not found" });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, repoId, revision, file, bytes, sha256, state };
}

/** A llama-server that answers health, props and completions: enough to load and unload a model. */
export async function writeFakeLlamaServer(directory: string): Promise<string> {
  const executable = path.join(directory, "llama-server");
  await fs.writeFile(executable, `#!/usr/bin/env node
const http = require("http");
const args = process.argv.slice(2), arg = name => args[args.indexOf(name) + 1];
http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") return res.end(JSON.stringify({ status: "ok" }));
  if (req.headers.authorization !== "Bearer " + process.env.LLAMA_API_KEY) { res.statusCode = 401; return res.end("{}"); }
  if (req.url === "/props") return res.end(JSON.stringify({ default_generation_settings: { n_ctx: Number(arg("--ctx-size")) } }));
  if (req.url === "/slots") return res.end(JSON.stringify([{ id: 0, is_processing: false }]));
  for await (const _chunk of req) {}
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Fake answer" }, finish_reason: "stop" }], output_text: "Fake answer" }));
}).listen(Number(arg("--port")), "127.0.0.1");
`, { mode: 0o755 });
  return executable;
}
