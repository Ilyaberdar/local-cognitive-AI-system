import type { CatalogPage, DownloadJob, LibraryModel, LocalModelSnapshot, LocalRuntimeSnapshot } from "../local/types";
import { publicError } from "./publicError";

/** What a paired device sees of the host's models: no directories, no paths of other model
 * libraries on the host, and error texts reduced by `publicError` (runtime errors carry the
 * llama-server log with absolute paths). File names inside a model repository are kept. */
const errorOf = <T extends { error?: string }>(value: T): T => value.error ? { ...value, error: publicError(value.error) } : value;

export const safeRuntime = (runtime: LocalRuntimeSnapshot): LocalRuntimeSnapshot => {
  const { modelsDir: _modelsDir, instances, ...rest } = runtime;
  return { ...errorOf(rest), modelsDir: "", ...(rest.fallbackReason ? { fallbackReason: publicError(rest.fallbackReason) } : {}),
    ...(instances ? { instances: instances.map(safeRuntime) } : {}) } as LocalRuntimeSnapshot;
};
export const safeModel = (model: LibraryModel): LibraryModel => errorOf(model);
export const safeDownload = (job: DownloadJob): DownloadJob => errorOf(job);

export const safeModelSnapshot = (snapshot: LocalModelSnapshot): LocalModelSnapshot => ({
  ...snapshot,
  models: snapshot.models.map(safeModel),
  downloads: snapshot.downloads.map(safeDownload),
  runtime: safeRuntime(snapshot.runtime),
  // Other model folders on the host (LM Studio, Ollama) are its owner's business, not the device's.
  ...(snapshot.storage ? { storage: { ...snapshot.storage, externalLibraries: [], warnings: snapshot.storage.warnings.map(warning => publicError(warning)) } } : {})
});

/** A catalog page that fits the channel: the offline cache can return a hundred full models. */
export const boundedCatalogPage = (page: CatalogPage, maxItems = 24, maxBytes = 700 * 1024): CatalogPage => {
  let items = page.items.slice(0, maxItems);
  while (items.length > 1 && JSON.stringify(items).length > maxBytes) items = items.slice(0, -1);
  return { ...page, items };
};
