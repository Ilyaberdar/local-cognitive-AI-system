import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import mammoth from "mammoth";
import { inflateRawSync } from "zlib";

export interface ExtractedDocument { textContent: string; truncated: boolean; warning?: string }
const MAX_BYTES = 5 * 1024 ** 2;
const MAX_TEXT = 12000;
let active = 0;

export async function extractDocument(name: string, dataUrl: string, signal?: AbortSignal): Promise<ExtractedDocument> {
  if (typeof name !== "string" || name.length > 255 || !/\.(pdf|docx)$/i.test(name)) throw new Error("Use PDF or DOCX. Legacy .doc files must be converted to DOCX first.");
  const match = typeof dataUrl === "string" && /^data:[^;,]{1,150};base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[1].length > Math.ceil(MAX_BYTES / 3) * 4) throw new Error("Document attachments must be no larger than 5 MB.");
  const buffer = Buffer.from(match[1], "base64");
  if (!buffer.length || buffer.length > MAX_BYTES || buffer.toString("base64") !== match[1]) throw new Error("Invalid document data.");
  const pdf = /\.pdf$/i.test(name);
  if (pdf ? !buffer.subarray(0, 1024).includes(Buffer.from("%PDF-")) : buffer.subarray(0,4).toString("hex") !== "504b0304") throw new Error("The document contents do not match its file extension.");
  signal?.throwIfAborted();
  if (active >= 2) throw new Error("Two documents are already being read. Try again when they finish.");
  active++;
  try {
    return await new Promise<ExtractedDocument>((resolve, reject) => {
      const ts = __filename.endsWith(".ts");
      const worker = new Worker(ts ? `require('tsx/cjs');require(${JSON.stringify(__filename)})` : __filename, {
        eval: ts, workerData: { bytes: buffer, pdf }, resourceLimits: { maxOldGenerationSizeMb: 128 }
      });
      let settled = false;
      const finish = (error?: Error, result?: ExtractedDocument) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener("abort", cancel);
        void worker.terminate();
        if (error) reject(error); else resolve(result!);
      };
      const cancel = () => finish(new Error("Document reading cancelled."));
      const timer = setTimeout(() => finish(new Error("Document reading timed out. Try a smaller or simpler document.")), 15000);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      worker.once("message", (message) => message.error ? finish(new Error(message.error)) : finish(undefined, message.result));
      worker.once("error", () => finish(new Error("Could not read the document within the memory limit.")));
      worker.once("exit", () => { if (!settled) finish(new Error("Document reader stopped before completing.")); });
    });
  } finally { active--; }
}

function validateDocxArchive(bytes: Buffer): void {
  // Bound ZIP expansion before Mammoth inflates it. No archive is written to disk.
  let count = 0, total = 0;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50) continue;
    if (offset + 22 + bytes.readUInt16LE(offset + 20) !== bytes.length) throw new Error("Invalid DOCX archive trailer.");
    const entries = bytes.readUInt16LE(offset + 10);
    let cursor = bytes.readUInt32LE(offset + 16);
    const centralEnd = cursor + bytes.readUInt32LE(offset + 12);
    if (entries > 2048 || bytes.readUInt16LE(offset + 4) !== 0 || bytes.readUInt16LE(offset + 6) !== 0
      || bytes.readUInt16LE(offset + 8) !== entries || centralEnd !== offset) break;
    for (; count < entries; count++) {
      if (cursor + 46 > centralEnd || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid DOCX archive.");
      const compressedSize = bytes.readUInt32LE(cursor + 20);
      const uncompressedSize = bytes.readUInt32LE(cursor + 24);
      total += uncompressedSize;
      if (total > 40 * 1024 ** 2) throw new Error("The expanded DOCX is too large to read safely.");
      const local = bytes.readUInt32LE(cursor + 42);
      if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50 || (bytes.readUInt16LE(cursor + 8) & 1)) throw new Error("Invalid or encrypted DOCX archive.");
      const method = bytes.readUInt16LE(cursor + 10);
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      if (start + compressedSize > bytes.length || ![0, 8].includes(method)) throw new Error("Invalid DOCX archive compression.");
      const compressed = bytes.subarray(start, start + compressedSize);
      // Do not trust the ZIP directory's advertised expansion size. Enforce it
      // while inflating, before the document library gets these archive bytes.
      const actualSize = method === 0 ? compressed.length : inflateRawSync(compressed, { maxOutputLength: Math.max(1, uncompressedSize) }).length;
      if (actualSize !== uncompressedSize) throw new Error("Invalid DOCX archive size.");
      cursor += 46 + bytes.readUInt16LE(cursor + 28) + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    }
    if (entries && count === entries && cursor === centralEnd) return;
    break;
  }
  throw new Error("Invalid or unsupported DOCX archive.");
}

async function readDocument(bytes: Buffer, pdf: boolean): Promise<ExtractedDocument> {
  let text = "", truncated = false;
  if (pdf) {
    // Keep native ESM import under the project's CommonJS compilation target.
    const pdfjs = await (new Function("return import('pdfjs-dist/legacy/build/pdf.mjs')")() as Promise<typeof import("pdfjs-dist/types/src/pdf")>);
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false });
    try {
      const document = await task.promise;
      for (let page = 1; page <= Math.min(document.numPages, 50); page++) {
        const content = await (await document.getPage(page)).getTextContent();
        text += content.items.map(item => "str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "").join("") + "\n";
        if (text.length > MAX_TEXT) { truncated = true; break; }
      }
      truncated ||= document.numPages > 50;
    } finally { await task.destroy(); }
  } else {
    validateDocxArchive(bytes);
    text = (await mammoth.extractRawText({ buffer: bytes })).value;
  }
  text = text.trim();
  if (!text) throw new Error("No readable text was found. This may be a scanned document: attach page images to an image-capable model.");
  truncated ||= text.length > MAX_TEXT;
  return { textContent: text.slice(0, MAX_TEXT), truncated,
    ...(truncated ? { warning: "Only the first 12,000 characters (up to 50 PDF pages) are included. Split the document to analyse the rest." } : {}) };
}

if (!isMainThread && workerData?.bytes) {
  void readDocument(Buffer.from(workerData.bytes), workerData.pdf).then(
    result => parentPort?.postMessage({ result }),
    error => parentPort?.postMessage({ error: error instanceof Error ? error.message : "Document reading failed." })
  );
}
