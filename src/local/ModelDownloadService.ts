import fs from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import path from "path";
import { randomUUID, createHash } from "crypto";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { setTimeout as delay } from "timers/promises";
import { ModelLibraryStore, modelLibraryId } from "./ModelLibraryStore";
import { artifactDownloadUrl, validateRevision } from "./HuggingFaceCatalog";
import { getFreeDiskBytes, readGGUFMetadata } from "./ModelCompatibility";
import { CatalogModel, CatalogVariant, DownloadJob, LibraryModel, LocalModelError, ModelArtifact } from "./types";
import { allModelArtifacts, assertVisionProjector } from "./ModelArtifacts";

export const sha256File = async (filePath: string, signal?: AbortSignal): Promise<string> => {
  const hash = createHash("sha256");
  const input = createReadStream(filePath);
  const abort = () => input.destroy(new LocalModelError("Operation cancelled.", 499));
  signal?.throwIfAborted(); signal?.addEventListener("abort", abort, { once: true });
  try { for await (const chunk of input) { signal?.throwIfAborted(); hash.update(chunk); } return hash.digest("hex"); }
  finally { signal?.removeEventListener("abort", abort); input.destroy(); }
};

export class ModelDownloadService {
  private active?: { id: string; controller: AbortController; promise: Promise<void>; committing: boolean };
  private readonly pendingStarts = new Map<string, Promise<DownloadJob>>();
  private disposed = false;
  constructor(private readonly store: ModelLibraryStore, private readonly changed: () => void = () => {}, private readonly fetcher: typeof fetch = fetch) {}
  list(): DownloadJob[] { return this.store.listJobs(); }

  async start(model: CatalogModel, variant: CatalogVariant, projectorPath?: string): Promise<DownloadJob> {
    if (this.disposed) throw new LocalModelError("Downloads are shutting down.", 503);
    if (model.gated) throw new LocalModelError("This model requires access from Hugging Face. Gated downloads are not supported in this release.", 403);
    validateRevision(model.revision);
    if (!variant.files.length) throw new LocalModelError("This variant has no complete verified GGUF artifact set.");
    const projector = projectorPath ? model.projectors?.find(file => file.path === projectorPath) : undefined;
    if (projectorPath && !projector) throw new LocalModelError("Select a vision adapter from this pinned repository revision.", 400, "invalid_projector");
    if (projector && variant.files.some(file => file.path === projector.path)) throw new LocalModelError("The vision adapter must be separate from the main model weights.");
    const libraryId = modelLibraryId(model.repoId, model.revision, variant.id);
    const pending = this.pendingStarts.get(libraryId);
    if (pending) {
      const job = await pending;
      this.assertSameProjector(job.projector, projector);
      return job;
    }
    const starting = this.createJob(model, variant, libraryId, projector).finally(() => { this.pendingStarts.delete(libraryId); });
    this.pendingStarts.set(libraryId, starting);
    return starting;
  }

  private assertSameProjector(existing: ModelArtifact | undefined, requested: ModelArtifact | undefined): void {
    if (existing?.sha256 !== requested?.sha256 || existing?.path !== requested?.path) throw new LocalModelError("This model already has a download or installed copy with a different vision adapter selection. Finish or cancel the download, or use Attach vision adapter on the installed model.", 409, "projector_conflict");
  }

  private async createJob(model: CatalogModel, variant: CatalogVariant, libraryId: string, projector?: ModelArtifact): Promise<DownloadJob> {
    const installed = this.store.listModels().find(item => item.id === libraryId);
    if (installed) this.assertSameProjector(installed.projector, projector);
    const existing = this.store.listJobs().find((job) => job.libraryId === libraryId && !["cancelled", "failed"].includes(job.state));
    if (existing && (existing.state !== "completed" || installed)) { this.assertSameProjector(existing.projector, projector); return existing; }
    const totalBytes = variant.sizeBytes + (projector?.sizeBytes ?? 0);
    const freeBytes = await getFreeDiskBytes(this.store.modelsDir);
    if (this.disposed) throw new LocalModelError("Downloads are shutting down.", 503);
    if (freeBytes !== undefined && freeBytes < totalBytes + 64 * 1024 ** 2) throw new LocalModelError("There is not enough free disk space for this model and its selected vision adapter.", 409, "disk_full");
    const now = new Date().toISOString();
    const job: DownloadJob = { id: `download-${randomUUID()}`, libraryId, repoId: model.repoId, revision: model.revision, variantId: variant.id,
      name: model.name, quantization: variant.quantization, license: model.license, files: structuredClone(variant.files), projector: projector ? structuredClone(projector) : undefined,
      projectorPath: projector?.path, state: "queued", downloadedBytes: 0, totalBytes, speedBytesPerSecond: 0, progress: 0, createdAt: now, updatedAt: now };
    await this.store.putJob(job); this.changed(); this.pump(); return job;
  }

  async pause(id: string): Promise<DownloadJob> { return this.control(id, "paused"); }
  async cancel(id: string): Promise<DownloadJob> { return this.control(id, "cancelled"); }
  async resume(id: string): Promise<DownloadJob> {
    if (this.disposed) throw new LocalModelError("Downloads are shutting down.", 503);
    const job = this.store.getJob(id);
    if (["completed", "downloading", "verifying", "queued"].includes(job.state)) return job;
    const installed = this.store.listModels().find(model => model.id === job.libraryId);
    if (installed) this.assertSameProjector(installed.projector, job.projector);
    if (this.store.listJobs().some(other => other.id !== job.id && other.libraryId === job.libraryId && ["queued", "downloading", "verifying", "paused"].includes(other.state))) throw new LocalModelError("Another download for this model already exists. Resume or cancel that download first.", 409, "download_conflict");
    job.state = "queued"; job.error = undefined; job.updatedAt = new Date().toISOString();
    await this.store.putJob(job); this.changed(); this.pump(); return job;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.pendingStarts.values()]);
    for (const job of this.store.listJobs()) if (job.state === "queued") { job.state = "paused"; await this.store.putJob(job); }
    if (this.active) await this.pause(this.active.id);
    await this.store.saveJobs();
  }

  private async control(id: string, state: "paused" | "cancelled"): Promise<DownloadJob> {
    let job = this.store.getJob(id);
    if (["completed", "cancelled"].includes(job.state)) return job;
    if (this.active?.id === id && this.active.committing) { await this.active.promise; return this.store.getJob(id); }
    job.state = state; job.speedBytesPerSecond = 0; job.updatedAt = new Date().toISOString();
    const saving = this.store.putJob(job);
    const running = this.active?.id === id ? this.active : undefined;
    running?.controller.abort();
    await saving;
    if (running) await running.promise;
    if (state === "cancelled") await fs.rm(this.store.stagingDirectory(id), { recursive: true, force: true });
    job = this.store.getJob(id);
    if (state === "paused") {
      let persistedBytes = 0;
      for (const file of allModelArtifacts(job)) {
        const target = path.join(this.store.stagingDirectory(id), file.path);
        const complete = await fs.stat(target).catch(() => undefined);
        const partial = complete ? undefined : await fs.stat(`${target}.part`).catch(() => undefined);
        persistedBytes += Math.min(file.sizeBytes, complete?.size ?? partial?.size ?? 0);
      }
      job.downloadedBytes = persistedBytes; job.progress = job.totalBytes ? persistedBytes / job.totalBytes * 100 : 0;
      await this.store.putJob(job);
    }
    this.changed(); this.pump(); return job;
  }

  private pump(): void {
    if (this.active || this.disposed) return;
    const job = this.store.listJobs().filter((item) => item.state === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!job) return;
    const active = { id: job.id, controller: new AbortController(), promise: Promise.resolve(), committing: false };
    this.active = active;
    active.promise = this.run(job, active.controller.signal).catch(async (error) => {
      const latest = this.store.getJob(job.id);
      if (!["paused", "cancelled", "completed"].includes(latest.state)) {
        latest.state = "failed"; latest.error = (error as NodeJS.ErrnoException).code === "ENOSPC" ? "The disk is full. Free space and resume the download." : error instanceof Error ? error.message : "Download failed.";
      }
      latest.speedBytesPerSecond = 0; latest.updatedAt = new Date().toISOString();
      await this.store.putJob(latest); this.changed();
    }).finally(() => { if (this.active === active) this.active = undefined; this.pump(); });
    // Persist failures are surfaced by subsequent API calls without an unhandled promise rejection.
    void active.promise.catch(() => {});
  }

  private async run(job: DownloadJob, signal: AbortSignal): Promise<void> {
    job.state = "downloading"; job.error = undefined; await this.store.putJob(job); this.changed();
    const folder = this.store.stagingDirectory(job.id);
    await fs.mkdir(folder, { recursive: true });
    let lastSave = 0; let lastProgress = 0; let lastBytes = job.downloadedBytes;
    const update = async (force = false) => {
      signal.throwIfAborted();
      const now = Date.now();
      if (!force && now - lastProgress < 250) return;
      if (lastProgress) job.speedBytesPerSecond = Math.max(0, (job.downloadedBytes - lastBytes) / ((now - lastProgress) / 1000));
      lastProgress = now; lastBytes = job.downloadedBytes;
      job.progress = Math.min(100, job.totalBytes ? job.downloadedBytes / job.totalBytes * 100 : 0); job.updatedAt = new Date().toISOString();
      const persist = force || now - lastSave > 1500;
      if (persist) lastSave = now;
      await this.store.putJob(job, persist); this.changed();
    };
    let completedBytes = 0;
    for (const file of allModelArtifacts(job)) {
      signal.throwIfAborted();
      const target = await this.store.safePath(folder, file.path, true);
      const part = `${target}.part`;
      const completed = await fs.stat(target).catch(() => undefined);
      if (completed?.size === file.sizeBytes && await sha256File(target, signal) === file.sha256) { completedBytes += file.sizeBytes; job.downloadedBytes = completedBytes; continue; }
      if (completed) await fs.unlink(target);
      for (let attempt = 0; ; attempt++) {
        try {
          await this.downloadFile(job, file, part, signal, async (bytes) => { job.downloadedBytes = completedBytes + bytes; await update(); });
          break;
        } catch (error) {
          if (signal.aborted || attempt >= 2 || error instanceof LocalModelError || (error as NodeJS.ErrnoException).code === "ENOSPC") throw error;
          await delay(500 * 2 ** attempt, undefined, { signal });
        }
      }
      job.state = "verifying"; job.downloadedBytes = completedBytes + file.sizeBytes; await update(true);
      if (await sha256File(part, signal) !== file.sha256) {
        await fs.unlink(part);
        throw new LocalModelError("The downloaded model failed SHA-256 verification. Resume to download this file again.", 409, "checksum_mismatch");
      }
      await readGGUFMetadata(part); signal.throwIfAborted();
      await fs.rename(part, target); completedBytes += file.sizeBytes;
      job.state = "downloading"; await update(true);
    }
    signal.throwIfAborted();
    const metadata = await readGGUFMetadata(await this.store.safePath(folder, job.files[0].path));
    if (job.projector) assertVisionProjector(await readGGUFMetadata(await this.store.safePath(folder, job.projector.path)));
    signal.throwIfAborted();
    if (this.active?.id === job.id) this.active.committing = true;
    const destination = this.store.modelDirectory(job.libraryId);
    const installed = this.store.listModels().find((model) => model.id === job.libraryId);
    if (installed) { this.assertSameProjector(installed.projector, job.projector); await fs.rm(folder, { recursive: true, force: true }); }
    else {
      // A crash after rename but before manifest persistence leaves a complete, re-verifiable directory.
      const existing = await fs.lstat(destination).catch(() => undefined);
      if (existing) {
        if (existing.isSymbolicLink()) throw new LocalModelError("The model destination has been replaced with a symbolic link.");
        await fs.rm(destination, { recursive: true });
      }
      await fs.rename(folder, destination);
      const model: LibraryModel = { id: job.libraryId, libraryId: job.libraryId, displayName: job.name, providerId: "llamacpp", providerName: "Local models",
        repoId: job.repoId, revision: job.revision, variantId: job.variantId, quantization: job.quantization, license: job.license,
        sizeBytes: job.totalBytes, installedAt: new Date().toISOString(), owned: true, files: job.files, projector: job.projector, vision: Boolean(job.projector), metadata,
        loaded: false, loadedInstanceIds: [], state: "unloaded" };
      await this.store.putModel(model);
    }
    job.state = "completed"; job.downloadedBytes = job.totalBytes; job.progress = 100; job.speedBytesPerSecond = 0; job.error = undefined;
    await this.store.putJob(job); this.changed();
  }

  private async downloadFile(job: DownloadJob, file: ModelArtifact, part: string, signal: AbortSignal, progress: (bytes: number) => Promise<void>): Promise<void> {
    const partStat = await fs.lstat(part).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
    if (partStat?.isSymbolicLink()) throw new LocalModelError("The partial download has been replaced with a symbolic link.");
    let offset = partStat?.size ?? 0;
    if (offset > file.sizeBytes) { await fs.unlink(part); offset = 0; }
    if (offset === file.sizeBytes) { await progress(offset); return; }
    const free = await getFreeDiskBytes(path.dirname(part));
    if (free !== undefined && free < file.sizeBytes - offset + 16 * 1024 ** 2) throw new LocalModelError("Not enough disk space to continue. Free space and resume.", 409, "disk_full");
    const stalled = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => { clearTimeout(timer); timer = setTimeout(() => stalled.abort(new Error("The download made no progress for 60 seconds.")), 60000); timer.unref(); };
    reset();
    const requestSignal = AbortSignal.any([signal, stalled.signal]);
    try {
      const response = await this.fetcher(artifactDownloadUrl(job.repoId, job.revision, file.path), {
        headers: { "Accept-Encoding": "identity", ...(offset ? { Range: `bytes=${offset}-` } : {}) }, signal: requestSignal
      });
      if (!response.ok || !response.body) throw new LocalModelError(`Model download returned HTTP ${response.status}. Check access and try Resume.`, response.status === 403 ? 403 : 502);
      if (response.status === 206) {
        const range = response.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
        if (!range || Number(range[1]) !== offset || Number(range[3]) !== file.sizeBytes || Number(range[2]) !== file.sizeBytes - 1) {
          await response.body.cancel(); throw new LocalModelError("The server returned an inconsistent byte range. The partial file was not appended.", 409);
        }
      } else if (response.status === 200) offset = 0; // Server ignores Range: truncate and restart, never append.
      else { await response.body.cancel(); throw new LocalModelError("Unexpected model download response.", 502); }
      const length = response.headers.get("content-length");
      if (length && Number(length) !== file.sizeBytes - offset) { await response.body.cancel(); throw new LocalModelError("The download size differs from the pinned model metadata.", 409); }
      let bytes = offset;
      const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length; reset();
        if (bytes > file.sizeBytes) { callback(new LocalModelError("The download exceeds its expected size.", 409)); return; }
        progress(bytes).then(() => callback(null, chunk), (error) => callback(error));
      } });
      await pipeline(Readable.fromWeb(response.body as any), meter, createWriteStream(part, { flags: offset ? "a" : "w", mode: 0o600 }), { signal: requestSignal });
      if (bytes !== file.sizeBytes) throw new Error("The download ended before the complete file arrived.");
      await progress(bytes);
    } finally { clearTimeout(timer!); }
  }
}
