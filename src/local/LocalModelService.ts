import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { LLMRequest, LLMResponse } from "../types";
import { Logger } from "../utils/Logger";
import { LocalModelManager } from "../llm/LocalModelManager";
import { HuggingFaceCatalog, groupVariants } from "./HuggingFaceCatalog";
import { ModelDownloadService, sha256File } from "./ModelDownloadService";
import { ModelLibraryStore, modelLibraryId } from "./ModelLibraryStore";
import { evaluateCompatibility, getFreeDiskBytes, GGUF_INSPECTION_VERSION, readGGUFMetadata } from "./ModelCompatibility";
import { LocalInferenceScheduler } from "./LocalInferenceScheduler";
import { LlamaCppRuntime } from "./LlamaCppRuntime";
import { allModelArtifacts, assertStandaloneModel, assertVisionProjector, isProjectorMetadata, modelDiskBytes } from "./ModelArtifacts";
import { CatalogModel, CatalogPage, DownloadJob, DownloadTarget, LibraryModel, LocalModelError, LocalModelEvent, LocalModelOptions, LocalModelSnapshot, ModelArtifact } from "./types";

export class LocalModelService implements LocalModelManager {
  readonly providerId = "llamacpp";
  readonly providerName = "Local models";
  private readonly events = new EventEmitter();
  private store: ModelLibraryStore;
  private readonly catalog: HuggingFaceCatalog;
  private downloads: ModelDownloadService;
  private readonly runtime: LlamaCppRuntime;
  private readonly scheduler: LocalInferenceScheduler;
  private readonly lifetime = new AbortController();
  private sequence = 0;
  private initPromise?: Promise<void>;
  private disposePromise?: Promise<void>;
  private initializationError?: string;
  private freeDiskBytes?: number;
  private switchingStorage = false;

  constructor(private options: LocalModelOptions, private readonly logger: Logger) {
    this.store = new ModelLibraryStore(options.dataDir, options.modelsDir);
    this.catalog = new HuggingFaceCatalog(options.dataDir);
    this.downloads = new ModelDownloadService(this.store, () => this.emit());
    this.runtime = new LlamaCppRuntime(options, logger, () => this.emit());
    this.scheduler = new LocalInferenceScheduler(() => this.emit());
    this.events.setMaxListeners(30);
  }
  get enabled(): boolean { return this.options.enabled; }
  get available(): boolean { return this.options.enabled && !this.initializationError && this.runtime.status !== "unavailable"; }

  init(): Promise<void> {
    this.initPromise ??= (async () => {
      try { await this.store.init(); } catch (error) {
        this.initializationError = error instanceof Error ? error.message : "The model library could not be opened.";
        this.logger.warn("Local model library is unavailable", { error: this.initializationError });
      }
      if (!this.initializationError) {
        for (const model of this.store.listModels()) {
          if (model.metadata?.inspectionVersion === GGUF_INSPECTION_VERSION) continue;
          try {
            const metadata = await readGGUFMetadata(await this.store.verifiedModelPath(model));
            await this.store.putModel({ ...model, metadata });
          } catch (error) {
            this.logger.warn("Could not refresh installed GGUF metadata", { modelId: model.id, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      await this.catalog.init();
      await this.runtime.init();
      this.freeDiskBytes = await getFreeDiskBytes(this.options.modelsDir);
      this.emit();
    })();
    return this.initPromise;
  }

  async reconfigure(options: LocalModelOptions): Promise<void> {
    await this.init();
    if (path.resolve(options.dataDir) !== path.resolve(this.options.dataDir)) throw new LocalModelError("The metadata directory is managed by the application and cannot be changed while it is running.", 409);
    if (JSON.stringify(options) === JSON.stringify(this.options)) return;
    await this.scheduler.run("__settings", async () => {
      if (path.resolve(options.modelsDir) !== path.resolve(this.options.modelsDir)) await this.moveStorage(options);
      else { await this.runtime.reconfigure(options); this.options = options; }
      this.emit();
    }, this.lifetime.signal);
  }

  snapshot(): LocalModelSnapshot {
    const runtime = this.runtime.snapshot();
    runtime.queueLength = this.scheduler.queueLength; runtime.busy = this.scheduler.busy;
    if (this.initializationError) { runtime.status = "unavailable"; runtime.error = this.initializationError; }
    const models = this.store.listModels().map((model): LibraryModel => {
      const current = runtime.modelId === model.id;
      const state = current ? ({ ready: "ready", loading: "loading", stopping: "unloading", error: "error" } as const)[runtime.status as "ready" | "loading" | "stopping" | "error"] ?? "unloaded" : "unloaded";
      return { ...model, sizeBytes: modelDiskBytes(model), vision: Boolean(model.projector), state, loaded: state === "ready", loadedInstanceIds: state === "ready" ? [model.id] : [],
        busy: this.scheduler.isModelBusy(model.id), compatibility: evaluateCompatibility(modelDiskBytes(model), this.options, model.metadata, this.freeDiskBytes, true, undefined, model.files.map(file => file.path)),
        error: state === "error" ? runtime.error : undefined };
    });
    return { models, downloads: this.downloads.list(), runtime, sequence: this.sequence };
  }
  subscribe(listener: (event: LocalModelEvent) => void): () => void { this.events.on("event", listener); return () => this.events.off("event", listener); }
  async listAllModels(): Promise<LibraryModel[]> { await this.init(); return this.snapshot().models; }
  async listLoadedModels(): Promise<LibraryModel[]> { return (await this.listAllModels()).filter((model) => model.loaded); }
  async listCatalog(query?: string, cursor?: string, source?: string): Promise<CatalogPage> {
    await this.init(); this.freeDiskBytes = await getFreeDiskBytes(this.options.modelsDir);
    const page = await this.catalog.list(query, cursor, source);
    return { ...page, items: page.items.map((model) => this.decorateCatalog(model)) };
  }
  async getCatalogModel(repoId: string, revision?: string): Promise<CatalogModel> {
    await this.init(); this.freeDiskBytes = await getFreeDiskBytes(this.options.modelsDir);
    return this.decorateCatalog(await this.catalog.getModel(repoId, revision));
  }
  listDownloads(): DownloadJob[] { return this.downloads.list(); }
  async startDownload(target: DownloadTarget): Promise<DownloadJob> {
    await this.init(); this.assertLibrary();
    const model = await this.catalog.getModel(target.repoId, target.revision);
    const variant = model.variants.find((item) => item.id === target.variantId);
    if (!variant) throw new LocalModelError("This quantization is not in the pinned model revision. Refresh model details.", 404);
    // Download eligibility depends on storage; memory warnings apply to inference.
    return this.downloads.start(model, variant, target.projectorPath);
  }
  async pauseDownload(id: string): Promise<DownloadJob> { this.assertLibrary(); return this.downloads.pause(id); }
  async resumeDownload(id: string): Promise<DownloadJob> { this.assertLibrary(); return this.downloads.resume(id); }
  async cancelDownload(id: string): Promise<DownloadJob> { this.assertLibrary(); return this.downloads.cancel(id); }

  async loadModel(modelId: string, callerSignal?: AbortSignal): Promise<void> {
    await this.init(); this.assertLibrary();
    const signal = AbortSignal.any([this.lifetime.signal, ...(callerSignal ? [callerSignal] : [])]);
    await this.scheduler.run(modelId, async () => {
      try {
        await this.ensureLoaded(modelId, signal);
        signal.throwIfAborted();
      } finally {
        if (signal.aborted) await this.runtime.stop();
      }
    }, signal);
  }
  async unloadModel(identifier: string, callerSignal?: AbortSignal): Promise<void> {
    await this.init(); this.assertLibrary(); this.store.getModel(identifier);
    const signal = AbortSignal.any([this.lifetime.signal, ...(callerSignal ? [callerSignal] : [])]);
    if (this.scheduler.isModelBusy(identifier)) throw new LocalModelError("This model is in use or waiting in the inference queue. Interrupt its requests before unloading it.", 409, "model_busy");
    await this.scheduler.run("__unload", async () => { if (this.runtime.currentModelId === identifier) await this.runtime.stop(); }, signal);
  }
  async deleteModel(id: string): Promise<void> {
    await this.init(); this.assertLibrary();
    if (this.scheduler.isModelBusy(id)) throw new LocalModelError("This model is in use or queued. Interrupt its requests before deleting it.", 409, "model_busy");
    await this.scheduler.run("__delete", async () => {
      if (this.scheduler.isModelBusy(id)) throw new LocalModelError("The model was queued for inference. Wait before deleting it.", 409, "model_busy");
      if (this.runtime.currentModelId === id) await this.runtime.stop();
      await this.store.removeModel(id); this.emit();
    }, this.lifetime.signal);
  }

  async generateText(request: LLMRequest): Promise<LLMResponse> {
    await this.init(); this.assertLibrary();
    const modelId = request.model?.trim();
    if (!modelId) throw new LocalModelError("Choose an installed model in Models before starting a local chat or workflow.", 400, "model_not_selected");
    const model = this.store.getModel(modelId);
    if (request.images?.length && !model.projector) throw new LocalModelError("This local model has no vision adapter. Attach its matching mmproj GGUF in Models, or choose a vision-capable model before sending images.", 400, "vision_unavailable");
    const signal = AbortSignal.any([this.lifetime.signal, ...(request.signal ? [request.signal] : [])]);
    return this.scheduler.run(modelId, async () => {
      try {
        if (this.runtime.currentModelId !== modelId || this.runtime.status !== "ready") request.onProgress?.({ phase: "loading", model: modelId });
        await this.ensureLoaded(modelId, signal);
        signal.throwIfAborted(); request.onProgress?.({ phase: "generating", model: modelId });
        return await this.runtime.generateText({ ...request, model: modelId, signal });
      } finally {
        // Ensure cancelled decoding is stopped before the next queued agent acquires the slot.
        if (signal.aborted) await this.runtime.stop();
      }
    }, signal, (queuePosition) => request.onProgress?.({ phase: "queued", model: modelId, queuePosition }));
  }

  async importModel(paths: string[]): Promise<LibraryModel> {
    await this.init(); this.assertLibrary();
    return this.scheduler.run("__import", () => this.importFiles(paths), this.lifetime.signal);
  }
  async attachProjector(modelId: string, filePath: string): Promise<LibraryModel> {
    await this.init(); this.assertLibrary(); this.store.getModel(modelId);
    if (this.scheduler.isModelBusy(modelId)) throw new LocalModelError("This model is in use or queued. Interrupt its requests before changing the vision adapter.", 409, "model_busy");
    return this.scheduler.run("__projector", () => this.installProjector(modelId, filePath), this.lifetime.signal);
  }

  private async importFiles(paths: string[]): Promise<LibraryModel> {
    if (!Array.isArray(paths) || !paths.length || paths.length > 101 || paths.some((file) => typeof file !== "string" || !path.isAbsolute(file) || !/\.gguf$/i.test(file))) throw new LocalModelError("Select one main GGUF model (all its shards) and, optionally, one matching vision mmproj GGUF.");
    if (new Set(paths.map(file => path.basename(file))).size !== paths.length) throw new LocalModelError("The selected model files must have distinct filenames.");
    const sources = [];
    for (const file of paths) {
      const stat = await fs.stat(file);
      if (!stat.isFile()) throw new LocalModelError("The import path is not a regular file.");
      const metadata = await readGGUFMetadata(file);
      if (!isProjectorMetadata(metadata)) assertStandaloneModel(metadata, [path.basename(file)]);
      sources.push({ source: file, metadata, artifact: { path: path.basename(file), sizeBytes: stat.size, sha256: await sha256File(file, this.lifetime.signal) } });
    }
    const projectors = sources.filter(file => isProjectorMetadata(file.metadata));
    const mainFiles = sources.filter(file => !isProjectorMetadata(file.metadata));
    if (projectors.length > 1 || !mainFiles.length) throw new LocalModelError("Import one main GGUF model and at most one matching vision adapter. To attach an adapter to an installed model, use Attach vision adapter.");
    if (projectors[0]) assertVisionProjector(projectors[0].metadata);
    const projector = projectors[0]?.artifact;
    const variants = groupVariants(mainFiles.map(({ artifact: file }) => ({ rfilename: file.path, size: file.sizeBytes, lfs: { sha256: file.sha256, size: file.sizeBytes } })));
    if (variants.length !== 1 || variants[0].files.length !== mainFiles.length) throw new LocalModelError("Import exactly one GGUF model with all its shards. Choose quantizations separately.");
    const variant = variants[0];
    const id = modelLibraryId("import", variant.files.map((file) => file.sha256).join(":"), variant.id);
    const existing = this.store.listModels().find((model) => model.id === id);
    if (existing) return projector ? this.installProjector(id, projectors[0].source) : this.snapshot().models.find(model => model.id === id)!;
    const totalBytes = variant.sizeBytes + (projector?.sizeBytes ?? 0);
    const free = await getFreeDiskBytes(this.store.modelsDir);
    if (free !== undefined && free < totalBytes + 64 * 1024 ** 2) throw new LocalModelError("Not enough disk space to copy the selected model and vision adapter into the library.", 409);
    const staging = this.store.stagingDirectory(`import-${randomUUID()}`);
    await fs.mkdir(staging, { recursive: true });
    try {
      for (const artifact of allModelArtifacts({ files: variant.files, projector })) {
        const source = paths.find((file) => path.basename(file) === artifact.path)!;
        const target = await this.store.safePath(staging, artifact.path, true);
        await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
        if ((await fs.stat(target)).size !== artifact.sizeBytes || await sha256File(target, this.lifetime.signal) !== artifact.sha256) throw new LocalModelError("A model file changed during import. Try again.", 409);
      }
      const metadata = await readGGUFMetadata(await this.store.safePath(staging, variant.files[0].path));
      const model: LibraryModel = { id, libraryId: id, displayName: metadata.name || path.basename(variant.id, ".gguf"), providerId: "llamacpp", providerName: "Local models",
        variantId: variant.id, quantization: variant.quantization, license: "imported — see original model license", installedAt: new Date().toISOString(), owned: true,
        sizeBytes: totalBytes, files: variant.files, projector, vision: Boolean(projector), metadata, loaded: false, loadedInstanceIds: [], state: "unloaded" };
      await fs.rename(staging, this.store.modelDirectory(id)); await this.store.putModel(model); this.emit(); return this.snapshot().models.find((item) => item.id === id)!;
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }

  private async installProjector(modelId: string, filePath: string): Promise<LibraryModel> {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath) || !/\.gguf$/i.test(filePath)) throw new LocalModelError("Select an absolute path to a vision mmproj GGUF.");
    if (this.scheduler.isModelBusy(modelId)) throw new LocalModelError("This model was queued for inference. Wait before changing its vision adapter.", 409, "model_busy");
    const model = this.store.getModel(modelId);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new LocalModelError("The vision adapter path is not a regular file.");
    assertVisionProjector(await readGGUFMetadata(filePath));
    const sha256 = await sha256File(filePath, this.lifetime.signal);
    if (model.projector?.sha256 === sha256) {
      const existing = await this.store.verifiedProjectorPath(model).catch(() => undefined);
      if (existing && await sha256File(existing, this.lifetime.signal) === sha256) return this.snapshot().models.find(item => item.id === modelId)!;
    }
    const free = await getFreeDiskBytes(this.store.modelsDir);
    if (free !== undefined && free < stat.size + 64 * 1024 ** 2) throw new LocalModelError("Not enough disk space to copy the vision adapter. The current adapter was preserved.", 409, "disk_full");
    const basename = path.basename(filePath).replace(/[\\\x00-\x1f:*?"<>|]/g, "_").slice(-160);
    const projector: ModelArtifact = { path: `projectors/${sha256.slice(0, 24)}-${randomUUID().slice(0, 8)}-${basename}`, sizeBytes: stat.size, sha256 };
    const staging = this.store.stagingDirectory(`projector-${randomUUID()}`);
    let copiedPath: string | undefined;
    let committed = false;
    await fs.mkdir(staging, { recursive: true });
    try {
      const staged = await this.store.safePath(staging, "adapter.gguf", true);
      await fs.copyFile(filePath, staged, fs.constants.COPYFILE_EXCL);
      if ((await fs.stat(staged)).size !== stat.size || await sha256File(staged, this.lifetime.signal) !== sha256) throw new LocalModelError("The vision adapter changed during import. The current adapter was preserved.", 409);
      this.lifetime.signal.throwIfAborted();
      const destination = await this.store.safePath(this.store.modelDirectory(modelId), projector.path, true);
      await fs.rename(staged, destination); copiedPath = destination;
      if (this.runtime.currentModelId === modelId) await this.runtime.stop();
      this.lifetime.signal.throwIfAborted();
      try { await this.store.putModel({ ...model, projector, vision: true, sizeBytes: modelDiskBytes({ files: model.files, projector }) }); }
      catch (error) { await this.store.putModel(model).catch(() => {}); throw error; }
      committed = true;
      if (model.projector) {
        try { await fs.unlink(await this.store.safePath(this.store.modelDirectory(modelId), model.projector.path)); }
        catch (error) { this.logger.warn("Could not remove the replaced vision adapter", { modelId, error: error instanceof Error ? error.message : String(error) }); }
      }
      this.emit(); return this.snapshot().models.find(item => item.id === modelId)!;
    } finally {
      if (copiedPath && !committed) await fs.unlink(copiedPath).catch(() => {});
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  dispose(): Promise<void> {
    this.disposePromise ??= (async () => {
      this.lifetime.abort(); await this.runtime.dispose(); await this.scheduler.dispose();
      if (!this.initializationError) await this.downloads.dispose();
      await this.store.dispose(); this.events.removeAllListeners();
    })();
    return this.disposePromise;
  }
  private async ensureLoaded(id: string, signal: AbortSignal): Promise<void> {
    this.assertLibrary();
    if (!this.options.enabled) throw new LocalModelError("Local models are disabled in Settings.", 503);
    const model = this.store.getModel(id);
    const compatibility = evaluateCompatibility(modelDiskBytes(model), this.options, model.metadata, undefined, true, undefined, model.files.map(file => file.path));
    if (!compatibility.canLoad) throw new LocalModelError(compatibility.reasons.join(" "), 409, "model_incompatible");
    await this.runtime.load(id, await this.store.verifiedModelPath(model), signal, await this.store.verifiedProjectorPath(model));
  }
  private decorateCatalog(model: CatalogModel): CatalogModel {
    return { ...model, variants: model.variants.map((variant) => ({ ...variant, compatibility: evaluateCompatibility(variant.sizeBytes, this.options, undefined, this.freeDiskBytes) })) };
  }
  private async moveStorage(options: LocalModelOptions): Promise<void> {
    if (this.downloads.list().some((job) => ["queued", "downloading", "verifying"].includes(job.state))) throw new LocalModelError("Pause downloads before moving the model library to another folder.", 409, "downloads_busy");
    const oldStore = this.store;
    const oldDirectory = path.resolve(oldStore.modelsDir);
    const nextDirectory = path.resolve(options.modelsDir);
    if (nextDirectory.startsWith(`${oldDirectory}${path.sep}`) || oldDirectory.startsWith(`${nextDirectory}${path.sep}`)) throw new LocalModelError("Choose a separate model folder, outside the current library.", 409);
    this.switchingStorage = true;
    const nextStore = new ModelLibraryStore(options.dataDir, nextDirectory);
    const created: string[] = [];
    try {
      await this.runtime.stop();
      await this.downloads.dispose();
      await nextStore.init();
      const models = oldStore.listModels();
      const pendingJobs = oldStore.listJobs().filter((job) => ["paused", "failed"].includes(job.state));
      const free = await getFreeDiskBytes(nextDirectory);
      let required = 0;
      const exists = (folder: string) => fs.lstat(folder).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
      for (const model of models) if (!await exists(nextStore.modelDirectory(model.id))) required += model.sizeBytes ?? 0;
      for (const job of pendingJobs) if (!await exists(nextStore.stagingDirectory(job.id))) required += job.downloadedBytes;
      if (free !== undefined && free < required + 64 * 1024 ** 2) throw new LocalModelError("The destination disk has insufficient space for the installed models and partial downloads.", 409, "disk_full");
      const copyOwnedFolder = async (source: string, destination: string, files: Array<{ path: string; sizeBytes: number; sha256: string }>, partial: boolean) => {
        const sourceStat = await fs.lstat(source).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
        if (!sourceStat && partial) return;
        if (!sourceStat || sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new LocalModelError("A managed model folder is missing or has been replaced with a symbolic link.", 409);
        const destinationStat = await fs.lstat(destination).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
        if (destinationStat && (!destinationStat.isDirectory() || destinationStat.isSymbolicLink())) throw new LocalModelError("The destination already contains conflicting files for this model.", 409);
        const expected: Array<{ relative: string; sourceFile: string; expectedHash: string }> = [];
        for (const file of files) {
          for (const suffix of partial ? ["", ".part"] : [""]) {
            const relative = file.path + suffix;
            let sourceFile: string;
            try { sourceFile = await oldStore.safePath(source, relative); await fs.access(sourceFile); }
            catch (error) { if (partial && (error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
            const expectedHash = suffix ? await sha256File(sourceFile, this.lifetime.signal) : file.sha256;
            expected.push({ relative, sourceFile, expectedHash });
          }
        }
        if (destinationStat) {
          const actual: string[] = [];
          const collect = async (directory: string, prefix = "") => {
            for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
              if (actual.length > 1000 || entry.isSymbolicLink()) throw new LocalModelError("The destination already contains conflicting files for this model.", 409);
              const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
              if (entry.isDirectory()) await collect(path.join(directory, entry.name), relative);
              else if (entry.isFile()) actual.push(relative);
              else throw new LocalModelError("The destination already contains conflicting files for this model.", 409);
            }
          };
          await collect(destination);
          if (actual.length !== expected.length || actual.some((file) => !expected.some((item) => item.relative === file))) throw new LocalModelError("The destination already contains files that differ from the saved model backup.", 409);
          for (const file of expected) {
            if (await sha256File(await nextStore.safePath(destination, file.relative), this.lifetime.signal) !== file.expectedHash) throw new LocalModelError("The destination already contains a model backup with different file hashes.", 409);
          }
          return; // An exact verified backup can be selected again, including settings rollback.
        }
        await fs.mkdir(destination, { recursive: true }); created.push(destination);
        for (const file of expected) {
          const target = await nextStore.safePath(destination, file.relative, true);
          await fs.copyFile(file.sourceFile, target, fs.constants.COPYFILE_EXCL);
          if (await sha256File(target, this.lifetime.signal) !== file.expectedHash) throw new LocalModelError("A model file changed or failed integrity checking during the move. The original library was preserved.", 409);
        }
      };
      for (const model of models) await copyOwnedFolder(oldStore.modelDirectory(model.id), nextStore.modelDirectory(model.id), allModelArtifacts(model), false);
      for (const job of pendingJobs) await copyOwnedFolder(oldStore.stagingDirectory(job.id), nextStore.stagingDirectory(job.id), allModelArtifacts(job), true);
      this.lifetime.signal.throwIfAborted();
      await this.runtime.reconfigure(options);
      this.store = nextStore; this.options = options;
      this.downloads = new ModelDownloadService(nextStore, () => this.emit());
      // Keep original owned files as a backup. RuntimeManager commits the new settings only
      // after this copy succeeds, so a crash on either side of that commit leaves a usable library.
      await oldStore.dispose();
      this.freeDiskBytes = await getFreeDiskBytes(nextDirectory);
    } catch (error) {
      if (this.store === oldStore) {
        for (const folder of created.reverse()) await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
        await nextStore.dispose();
        this.downloads = new ModelDownloadService(oldStore, () => this.emit());
        await this.runtime.reconfigure(this.options);
      }
      throw error;
    } finally { this.switchingStorage = false; }
  }
  private assertLibrary(): void { if (this.initializationError) throw new LocalModelError(this.initializationError, 503, "library_unavailable"); if (this.switchingStorage) throw new LocalModelError("The model library is being moved. Wait for the storage change to finish.", 409, "storage_moving"); if (this.lifetime.signal.aborted) throw new LocalModelError("The local model service is shutting down.", 503); }
  private emit(): void {
    if (!this.scheduler || !this.runtime) return;
    this.sequence++;
    if (!this.events.listenerCount("event")) return;
    this.events.emit("event", { type: "snapshot", sequence: this.sequence, at: new Date().toISOString(), snapshot: this.snapshot() } satisfies LocalModelEvent);
  }
}
