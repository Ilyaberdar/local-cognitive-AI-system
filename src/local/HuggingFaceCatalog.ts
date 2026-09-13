import fs from "fs/promises";
import path from "path";
import { CatalogModel, CatalogPage, CatalogVariant, LocalModelError, ModelArtifact } from "./types";
import { validateArtifactPath } from "./ModelLibraryStore";
import { writeJsonAtomically } from "../utils/fileStore";

const origin = "https://huggingface.co";
const repoPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,150}$/;
export const validateRepository = (repoId: string): void => { if (!repoPattern.test(repoId) || repoId.includes("..")) throw new LocalModelError("Invalid Hugging Face repository ID."); };
export const validateRevision = (revision: string): void => { if (!/^[a-f0-9]{40}$/i.test(revision)) throw new LocalModelError("Downloads require an immutable Hugging Face revision. Refresh the model details first."); };
export const artifactDownloadUrl = (repoId: string, revision: string, file: string): string => {
  validateRepository(repoId); validateRevision(revision); validateArtifactPath(file);
  return `${origin}/${repoId}/resolve/${revision}/${file.split("/").map(encodeURIComponent).join("/")}`;
};

interface HfRecord {
  id?: string; modelId?: string; sha?: string; gated?: boolean | string; tags?: string[]; pipeline_tag?: string;
  cardData?: { license?: string }; siblings?: Array<{ rfilename?: string; size?: number; lfs?: { size?: number; sha256?: string } }>;
}

export class HuggingFaceCatalog {
  private recommended: CatalogModel[] = [];
  private cache = new Map<string, CatalogModel>();
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly dataDir: string, private readonly fetcher: typeof fetch = fetch) {}

  async init(): Promise<void> {
    const seedPath = process.env.LOCAL_MODEL_CATALOG_PATH || path.resolve(process.cwd(), "resources/models/recommended.json");
    try {
      const seed = JSON.parse(await fs.readFile(seedPath, "utf8")) as { items?: CatalogModel[] };
      this.recommended = (seed.items ?? []).filter((model) => this.isValidModel(model));
    } catch { this.recommended = []; }
    try {
      const entries = JSON.parse(await fs.readFile(path.join(this.dataDir, "catalog-cache.json"), "utf8")) as CatalogModel[];
      for (const model of entries) if (this.isValidModel(model)) this.cache.set(`${model.repoId}@${model.revision}`, model);
    } catch {}
    for (const model of this.recommended) this.cache.set(`${model.repoId}@${model.revision}`, model);
  }

  async list(query = "", cursor?: string, source?: string): Promise<CatalogPage> {
    if (!query.trim() && source !== "search") return { items: structuredClone(this.recommended), cached: true };
    if (query.length > 200 || (cursor?.length ?? 0) > 4096) throw new LocalModelError("Search query or cursor is too long.");
    const url = new URL(`${origin}/api/models`);
    url.searchParams.set("search", query.trim()); url.searchParams.set("filter", "gguf");
    url.searchParams.set("sort", "downloads"); url.searchParams.set("direction", "-1"); url.searchParams.set("limit", "12"); url.searchParams.set("full", "true");
    if (cursor) url.searchParams.set("cursor", cursor);
    try {
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Hugging Face search returned ${response.status}.`);
      const records = await response.json() as HfRecord[];
      if (!Array.isArray(records)) throw new Error("Unexpected Hugging Face search response.");
      const items = records.filter((record) => !["image-text-to-text", "text-to-image", "automatic-speech-recognition", "feature-extraction"].includes(record.pipeline_tag ?? ""))
        .map((record) => this.fromRecord(record)).filter((model) => repoPattern.test(model.repoId));
      const nextLink = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      const nextCursor = nextLink ? new URL(nextLink).searchParams.get("cursor") ?? undefined : undefined;
      return { items, nextCursor };
    } catch (error) {
      const matches = [...this.cache.values()].filter((model) => `${model.name} ${model.repoId}`.toLowerCase().includes(query.toLowerCase()));
      if (matches.length) return { items: structuredClone(matches), cached: true, warning: "Hugging Face is unavailable. Showing cached model details." };
      throw new LocalModelError(error instanceof Error ? error.message : "Hugging Face is unavailable. Your installed models still work offline.", 502, "catalog_unavailable");
    }
  }

  async getModel(repoId: string, revision?: string): Promise<CatalogModel> {
    validateRepository(repoId); if (revision) validateRevision(revision);
    const cached = revision ? this.cache.get(`${repoId}@${revision}`) : undefined;
    if (cached) return structuredClone({ ...cached, cached: true });
    const url = `${origin}/api/models/${repoId}${revision ? `/revision/${revision}` : ""}?blobs=true`;
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new LocalModelError(`Hugging Face model details returned ${response.status}. The repository may require access or be unavailable.`, 502);
    const record = await response.json() as HfRecord;
    if (["image-text-to-text", "text-to-image", "automatic-speech-recognition", "feature-extraction"].includes(record.pipeline_tag ?? "")) throw new LocalModelError("Only text-generation GGUF models are supported in this release.");
    const model = this.fromRecord(record);
    if (model.repoId !== repoId) throw new LocalModelError("The repository identity changed. Refresh the catalog before downloading.");
    validateRevision(model.revision);
    if (revision && revision !== model.revision) throw new LocalModelError("Hugging Face returned a different revision. Refresh the model details.");
    model.variants = groupVariants(record.siblings ?? []);
    this.cache.set(`${repoId}@${model.revision}`, model);
    const write = this.writes.then(() => writeJsonAtomically(path.join(this.dataDir, "catalog-cache.json"), [...this.cache.values()].slice(-100)));
    this.writes = write.catch(() => {}); await write;
    return structuredClone(model);
  }

  private fromRecord(record: HfRecord): CatalogModel {
    const repoId = record.id || record.modelId || "";
    const tags = Array.isArray(record.tags) ? record.tags.filter((tag) => typeof tag === "string") : [];
    return { id: repoId, repoId, name: repoId.split("/").pop() || repoId, author: repoId.split("/")[0], revision: record.sha ?? "",
      license: record.cardData?.license || tags.find((tag) => tag.startsWith("license:"))?.slice(8) || "not specified",
      gated: Boolean(record.gated), tags, variants: [], verified: false };
  }
  private isValidModel(model: CatalogModel): boolean {
    try {
      validateRepository(model.repoId); validateRevision(model.revision);
      if (!Array.isArray(model.variants)) return false;
      for (const variant of model.variants) for (const file of variant.files) {
        validateArtifactPath(file.path);
        if (!/^[a-f0-9]{64}$/i.test(file.sha256) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 24) return false;
      }
      return true;
    } catch { return false; }
  }
}

export const groupVariants = (siblings: NonNullable<HfRecord["siblings"]>): CatalogVariant[] => {
  const groups = new Map<string, { files: ModelArtifact[]; parts?: number; indices: Set<number> }>();
  for (const item of siblings) {
    const file = item.rfilename ?? "";
    if (!/\.gguf$/i.test(file) || /(?:^|\/)(?:mmproj|projector|adapter)[-_.]/i.test(file)) continue;
    try { validateArtifactPath(file); } catch { continue; }
    const sizeBytes = item.lfs?.size ?? item.size; const sha256 = item.lfs?.sha256;
    if (!sizeBytes || !Number.isSafeInteger(sizeBytes) || !sha256 || !/^[a-f0-9]{64}$/i.test(sha256)) continue;
    const match = file.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i);
    const id = match ? `${match[1]}.gguf` : file;
    const group = groups.get(id) ?? { files: [], parts: match ? Number(match[3]) : undefined, indices: new Set<number>() };
    if (match && group.parts !== Number(match[3])) continue;
    group.files.push({ path: file, sizeBytes, sha256: sha256.toLowerCase() });
    if (match) group.indices.add(Number(match[2]));
    groups.set(id, group);
  }
  return [...groups.entries()].filter(([, group]) => !group.parts || (group.parts === group.files.length && Array.from({ length: group.parts }, (_, index) => index + 1).every((index) => group.indices.has(index))))
    .map(([id, group]) => {
      const quantization = path.basename(id).match(/(IQ\d(?:_[A-Z0-9]+)*|Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32)/i)?.[1]?.toUpperCase() || "GGUF";
      return { id, name: quantization, quantization, sizeBytes: group.files.reduce((sum, file) => sum + file.sizeBytes, 0), files: group.files.sort((a, b) => a.path.localeCompare(b.path)) };
    }).sort((a, b) => a.sizeBytes - b.sizeBytes);
};
