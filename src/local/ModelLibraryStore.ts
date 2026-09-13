import fs from "fs/promises";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { LibraryModel, DownloadJob, LocalModelError } from "./types";
import { writeJsonAtomically } from "../utils/fileStore";

export const validateArtifactPath = (filePath: string): string => {
  if (!filePath || filePath.length > 1000 || /[\\\x00-\x1f:*?"<>|]/.test(filePath) || path.posix.isAbsolute(filePath) ||
      filePath.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part))) {
    throw new LocalModelError("The model contains an unsafe file path.");
  }
  return filePath;
};

export const modelLibraryId = (repoId: string, revision: string, variantId: string): string =>
  `gguf-${createHash("sha256").update(JSON.stringify([repoId, revision, variantId])).digest("hex").slice(0, 24)}`;

export class ModelLibraryStore {
  private models = new Map<string, LibraryModel>();
  private jobs = new Map<string, DownloadJob>();
  private lockToken?: string;
  private writes: Promise<unknown> = Promise.resolve();
  readonly modelsDir: string;
  readonly dataDir: string;

  constructor(dataDir: string, modelsDir: string) { this.dataDir = path.resolve(dataDir); this.modelsDir = path.resolve(modelsDir); }

  async init(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.mkdir(this.modelsDir, { recursive: true });
    await this.acquireOwnership();
    try {
      const read = async (name: string) => {
        try { return JSON.parse(await fs.readFile(path.join(this.dataDir, name), "utf8")) as { version: number; items: unknown[] }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, items: [] }; throw new LocalModelError(`The local model ${name} manifest is damaged. Restore a backup before changing the library.`, 503); }
      };
      const [library, downloads] = await Promise.all([read("library.json"), read("downloads.json")]);
      if (library.version !== 1 || downloads.version !== 1 || !Array.isArray(library.items) || !Array.isArray(downloads.items)) throw new LocalModelError("Unsupported local library manifest version.");
      for (const item of library.items as LibraryModel[]) {
        this.validateRecord(item);
        this.models.set(item.id, { ...item, loaded: false, loadedInstanceIds: [], state: "unloaded", busy: false });
      }
      for (const item of downloads.items as DownloadJob[]) {
        this.validateId(item.id); this.validateId(item.libraryId);
        if (!Array.isArray(item.files)) throw new LocalModelError("Invalid download manifest.");
        item.files.forEach((file) => validateArtifactPath(file.path));
        const interrupted = ["queued", "downloading", "verifying"].includes(item.state);
        this.jobs.set(item.id, { ...item, state: interrupted ? "paused" : item.state, speedBytesPerSecond: 0,
          error: interrupted ? "Download paused after the application restarted. Resume to continue from the saved bytes." : item.error });
      }
      await this.saveJobs();
    } catch (error) { await this.dispose(); throw error; }
  }

  listModels(): LibraryModel[] { return structuredClone([...this.models.values()]); }
  listJobs(): DownloadJob[] { return structuredClone([...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))); }
  getModel(id: string): LibraryModel {
    const model = this.models.get(id);
    if (!model) throw new LocalModelError("This model is not installed. Download or import a GGUF model from Models first.", 404, "model_not_installed");
    return structuredClone(model);
  }
  getJob(id: string): DownloadJob {
    const job = this.jobs.get(id);
    if (!job) throw new LocalModelError("Download not found.", 404);
    return structuredClone(job);
  }
  async putModel(model: LibraryModel): Promise<void> {
    this.assertOwned(); this.validateRecord(model); this.models.set(model.id, structuredClone(model));
    await this.persist("library.json", [...this.models.values()]);
  }
  async putJob(job: DownloadJob, persist = true): Promise<void> {
    this.assertOwned(); this.validateId(job.id); this.jobs.set(job.id, structuredClone(job));
    if (persist) await this.saveJobs();
  }
  async saveJobs(): Promise<void> { this.assertOwned(); await this.persist("downloads.json", [...this.jobs.values()]); }
  modelDirectory(id: string): string { this.validateId(id); return path.join(this.modelsDir, id); }
  stagingDirectory(id: string): string { this.validateId(id); return path.join(this.modelsDir, ".downloads", id); }

  async verifiedModelPath(model: LibraryModel): Promise<string> {
    const relative = model.files[0]?.path;
    if (!relative) throw new LocalModelError("The installed model has no files.");
    const folder = this.modelDirectory(model.id);
    for (const file of model.files) {
      const candidate = await this.safePath(folder, file.path);
      const stat = await fs.stat(candidate);
      if (!stat.isFile() || stat.size !== file.sizeBytes) throw new LocalModelError("An installed model file is missing or changed. Re-download the model.", 409);
    }
    return this.safePath(folder, relative);
  }

  async safePath(folder: string, relative: string, createParent = false): Promise<string> {
    validateArtifactPath(relative);
    const root = await fs.realpath(this.modelsDir);
    const candidate = path.resolve(folder, relative);
    if (!candidate.startsWith(`${this.modelsDir}${path.sep}`)) throw new LocalModelError("Model path is outside the managed library.");
    if (createParent) await fs.mkdir(path.dirname(candidate), { recursive: true });
    const parent = await fs.realpath(path.dirname(candidate));
    if (!parent.startsWith(`${root}${path.sep}`)) throw new LocalModelError("Model path resolves outside the managed library.");
    try { const stat = await fs.lstat(candidate); if (stat.isSymbolicLink()) throw new LocalModelError("Symbolic links are not accepted as managed model files."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return candidate;
  }

  async removeModel(id: string): Promise<void> {
    this.assertOwned(); const model = this.getModel(id);
    if (!model.owned) throw new LocalModelError("This model is not owned by the application and cannot be deleted.");
    const folder = this.modelDirectory(id);
    const stat = await fs.lstat(folder).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
    if (stat?.isSymbolicLink()) throw new LocalModelError("The model folder has been replaced with a symbolic link.");
    if (stat) await fs.rm(folder, { recursive: true, force: true });
    this.models.delete(id); await this.persist("library.json", [...this.models.values()]);
  }

  async dispose(): Promise<void> {
    await this.writes.catch(() => {});
    if (!this.lockToken) return;
    const lock = path.join(this.modelsDir, ".owner.json");
    try { const current = JSON.parse(await fs.readFile(lock, "utf8")); if (current.token === this.lockToken) await fs.unlink(lock); } catch {}
    this.lockToken = undefined;
  }

  private validateId(id: string): void { if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,95}$/i.test(id)) throw new LocalModelError("Invalid local model identifier."); }
  private validateRecord(model: LibraryModel): void {
    this.validateId(model.id);
    if (model.providerId !== "llamacpp" || !Array.isArray(model.files) || !model.files.length || !model.owned) throw new LocalModelError("Invalid installed model manifest.");
    for (const file of model.files) { validateArtifactPath(file.path); if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 24 || !/^[a-f0-9]{64}$/i.test(file.sha256)) throw new LocalModelError("Invalid model artifact manifest."); }
  }
  private assertOwned(): void { if (!this.lockToken) throw new LocalModelError("Another application process owns this local model library. Close it before loading or changing models.", 409, "library_owned"); }
  private persist(name: string, items: unknown[]): Promise<void> {
    const snapshot = structuredClone(items);
    const write = this.writes.then(() => writeJsonAtomically(path.join(this.dataDir, name), { version: 1, items: snapshot }));
    this.writes = write.catch(() => {}); return write;
  }
  private async acquireOwnership(): Promise<void> {
    const lock = path.join(this.modelsDir, ".owner.json");
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = randomUUID();
      try {
        const handle = await fs.open(lock, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })); } finally { await handle.close(); }
        this.lockToken = token; return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let existing: { pid?: number; token?: string };
        try { existing = JSON.parse(await fs.readFile(lock, "utf8")); } catch { throw new LocalModelError("The library ownership file cannot be read. Another process may be starting.", 409, "library_owned"); }
        if (!Number.isInteger(existing.pid) || !existing.token) throw new LocalModelError("The model library ownership file is invalid.", 409, "library_owned");
        try { process.kill(existing.pid!, 0); throw new LocalModelError("Another application process owns this local model library. Close it before loading or changing models.", 409, "library_owned"); }
        catch (check) { if ((check as NodeJS.ErrnoException).code !== "ESRCH") throw check; }
        const current = JSON.parse(await fs.readFile(lock, "utf8"));
        if (current.token !== existing.token) continue;
        await fs.unlink(lock).catch((remove: NodeJS.ErrnoException) => { if (remove.code !== "ENOENT") throw remove; });
      }
    }
    throw new LocalModelError("The model library is already owned by another process.", 409, "library_owned");
  }
}
