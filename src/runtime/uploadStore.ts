import { createHash } from "node:crypto";
import { RemoteOperationError } from "../remote/host/RemoteHost";
import type { ChatAttachment } from "../types";
import { AttachmentError, validateAttachments } from "../utils/attachments";

/** Characters per chunk: a chunk's request stays well under the 256 KiB a window may send. */
export const CHUNK_CHARS = 128 * 1024;
/** An image as a data URL (at most 1 MiB once prepared on the device) or extracted text. */
export const MAX_CONTENT_CHARS = 2 * 1024 * 1024;
/** Per kind, as the attachment validator takes them: text is never split into chunks. */
const MAX_CHARS = { image: MAX_CONTENT_CHARS, text: 20_000 };
const MAX_UPLOADS_PER_DEVICE = 20;
const MAX_CHARS_PER_DEVICE = 32 * 1024 * 1024;
const MAX_CHARS_IN_ALL = 128 * 1024 * 1024;
const TTL_MS = 24 * 60 * 60 * 1000;

export interface UploadMeta {
  name: string; mimeType: string; kind: "image" | "text"; sizeBytes: number;
  /** Characters of the content: the image's data URL, or the text. */
  length: number;
  /** SHA-256 (hex) of the content as UTF-8. */
  sha256: string;
  truncated?: boolean; warning?: string;
}

interface Upload { owner: string; sessionId: string; meta: UploadMeta; signature: string; chunks: Array<string | undefined>; attachment?: ChatAttachment; at: number }

const refuse = (message: string, code = "invalid_request") => new RemoteOperationError(message, code);

/** Attachments a paired device sends for its next chat turn (R5-4d), held in memory until the turn
 * takes them or they expire: they are what the device prepared (an image's data URL, a document's
 * text), sent in chunks, checked against their hash and validated as on this computer. An upload
 * belongs to the device and chat that began it; nothing about it names a file of the host. */
export class UploadStore {
  private readonly uploads = new Map<string, Upload>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Starts an upload, or answers which chunks arrived for the same one begun before (resume). */
  begin(owner: string, uploadId: string, sessionId: string, meta: UploadMeta): { uploadId: string; chunkChars: number; received: number[] } {
    this.sweep();
    if (meta.length < 1 || meta.length > MAX_CHARS[meta.kind]) throw refuse("The attachment is too large to send.");
    const signature = JSON.stringify([sessionId, meta.name, meta.mimeType, meta.kind, meta.sizeBytes, meta.length, meta.sha256, meta.truncated ?? false, meta.warning ?? ""]);
    const existing = this.uploads.get(uploadId);
    if (existing) {
      if (existing.owner !== owner || existing.signature !== signature) throw refuse("This upload id was already used for another file.", "idempotency_conflict");
      // A finished upload has every chunk: a device resending its message just commits it again.
      const received = existing.attachment ? Array.from({ length: Math.ceil(meta.length / CHUNK_CHARS) }, (_, index) => index)
        : existing.chunks.flatMap((chunk, index) => chunk === undefined ? [] : [index]);
      return { uploadId, chunkChars: CHUNK_CHARS, received };
    }
    // A device's oldest waiting uploads make room (a send that failed and was never retried), so
    // a device is never locked out; all devices together are capped too.
    const total = () => [...this.uploads.values()].reduce((sum, upload) => sum + upload.meta.length, 0);
    for (;;) {
      const mine = [...this.uploads.entries()].filter(([, upload]) => upload.owner === owner).sort((a, b) => a[1].at - b[1].at);
      const used = mine.reduce((sum, [, upload]) => sum + upload.meta.length, 0);
      if (mine.length < MAX_UPLOADS_PER_DEVICE && used + meta.length <= MAX_CHARS_PER_DEVICE) break;
      this.uploads.delete(mine[0]![0]);
    }
    if (total() + meta.length > MAX_CHARS_IN_ALL) throw refuse("The server has too many attachments waiting. Try again later.", "quota_exceeded");
    this.uploads.set(uploadId, { owner, sessionId, meta, signature, chunks: new Array(Math.ceil(meta.length / CHUNK_CHARS)).fill(undefined), at: this.now() });
    return { uploadId, chunkChars: CHUNK_CHARS, received: [] };
  }

  /** Stores one chunk; the same chunk again is accepted, different text for it is refused. */
  chunk(owner: string, uploadId: string, index: number, data: string): { received: number } {
    const upload = this.own(owner, uploadId);
    if (upload.attachment) throw refuse("The upload is already complete.");
    if (!Number.isInteger(index) || index < 0 || index >= upload.chunks.length) throw refuse("The chunk is outside the upload.");
    const expected = index === upload.chunks.length - 1 ? upload.meta.length - index * CHUNK_CHARS : CHUNK_CHARS;
    if (data.length !== expected) throw refuse("The chunk has the wrong size.");
    const previous = upload.chunks[index];
    if (previous !== undefined && previous !== data) throw refuse("This chunk was already sent with different contents.", "idempotency_conflict");
    upload.chunks[index] = data;
    return { received: upload.chunks.filter(chunk => chunk !== undefined).length };
  }

  /** Checks the whole content against its hash and validates it as an attachment; answers what
   * the chat may show of it (never its contents). The same commit again gives the same answer. */
  commit(owner: string, uploadId: string): Omit<ChatAttachment, "textContent" | "dataUrl"> {
    const upload = this.own(owner, uploadId);
    if (!upload.attachment) {
      if (upload.chunks.some(chunk => chunk === undefined)) throw refuse("Some of the attachment has not arrived yet.", "upload_incomplete");
      const content = upload.chunks.join("");
      if (content.length !== upload.meta.length || createHash("sha256").update(content, "utf8").digest("hex") !== upload.meta.sha256.toLowerCase()) {
        this.uploads.delete(uploadId);
        throw refuse("The attachment arrived damaged. Attach it again.", "upload_corrupt");
      }
      const { name, mimeType, kind, sizeBytes, truncated, warning } = upload.meta;
      const attachment: ChatAttachment = { id: uploadId, name, mimeType, sizeBytes, kind, ...(kind === "image" ? { dataUrl: content } : { textContent: content }),
        ...(truncated ? { truncated } : {}), ...(warning ? { warning } : {}) };
      try { validateAttachments([attachment]); }
      catch (error) {
        this.uploads.delete(uploadId);
        throw refuse(error instanceof AttachmentError ? error.message : "The attachment is not valid.", "invalid_attachment");
      }
      upload.attachment = attachment;
      upload.chunks = [];
    }
    const { textContent: _text, dataUrl: _data, ...summary } = upload.attachment;
    return summary;
  }

  cancel(owner: string, uploadId: string): { cancelled: boolean } {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.owner !== owner) return { cancelled: false };
    this.uploads.delete(uploadId);
    return { cancelled: true };
  }

  /** The committed attachments of this device for one chat, in the order asked. */
  attachments(owner: string, sessionId: string, ids: string[]): ChatAttachment[] {
    this.sweep();
    if (new Set(ids).size !== ids.length) throw refuse("An attachment is listed twice.");
    return ids.map(id => {
      const upload = this.uploads.get(id);
      if (!upload || upload.owner !== owner || upload.sessionId !== sessionId || !upload.attachment) {
        throw refuse("An attachment is no longer on the server. Attach it again.", "attachment_unknown");
      }
      return upload.attachment;
    });
  }

  /** A turn took these attachments: from now on they live in the chat's history. */
  remove(ids: string[]): void { for (const id of ids) this.uploads.delete(id); }

  /** A deleted chat's waiting attachments go with it. */
  dropSession(sessionId: string): void {
    for (const [id, upload] of this.uploads) if (upload.sessionId === sessionId) this.uploads.delete(id);
  }

  private own(owner: string, uploadId: string): Upload {
    this.sweep();
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.owner !== owner) throw refuse("The upload is not on the server. Attach the file again.", "upload_unknown");
    return upload;
  }

  /** Expired uploads go (also run on a timer, so memory is freed without new uploads). */
  sweep(): void {
    const oldest = this.now() - TTL_MS;
    for (const [id, upload] of this.uploads) if (upload.at < oldest) this.uploads.delete(id);
  }
}
