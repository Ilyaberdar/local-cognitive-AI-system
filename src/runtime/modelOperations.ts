import { randomUUID } from "crypto";
import { z } from "zod";
import type { RuntimeManager } from "../app/RuntimeManager";
import { SettingsValidationError } from "../app/settingsValidation";
import { systemMetricsSnapshot } from "../local/systemMetrics";
import { LocalModelError, type LocalModelEvent } from "../local/types";
import { RemoteOperationError, type OperationContext, type RemoteOperation } from "../remote/host/RemoteHost";
import { boundedCatalogPage, safeDownload, safeModelSnapshot } from "./modelDto";
import { publicError } from "./publicError";

const MAX_WATCH_MS = 20_000;
/** The host's runtime settings a device may change: never the models directory or the backend.
 * Shared with the Settings screen's operations (settingsOperations.ts). */
export const localModelSettingsSchema = z.object({
  contextSize: z.number().int().optional(), gpuLayers: z.union([z.number().int(), z.literal("auto")]).optional(), memoryLimitPercent: z.number().optional(),
  loadTimeoutMs: z.number().int().optional(), generationTimeoutMs: z.number().int().optional(), generation: z.record(z.string(), z.unknown()).optional()
}).strict();
const id = z.string().min(1).max(300);
const schemas = {
  search: z.object({ query: z.string().max(200).optional(), cursor: z.string().max(2000).optional(), source: z.enum(["recommended", "search"]).optional() }).strict().optional(),
  model: z.object({ repoId: id, revision: z.string().max(100).optional() }).strict(),
  download: z.object({ repoId: id, revision: z.string().min(1).max(100), variantId: id, projectorPath: z.string().max(300).optional(), commandId: z.string().max(100).optional() }).strict(),
  job: z.object({ downloadId: id }).strict(),
  libraryModel: z.object({ modelId: id }).strict(),
  settings: z.object({ localModels: localModelSettingsSchema }).strict(),
  watch: z.object({ epoch: z.string().max(100).optional(), after: z.number().int().nonnegative().optional(), waitMs: z.number().int().min(0).max(MAX_WATCH_MS).optional() }).strict().optional()
};

const parse = <T>(schema: z.ZodType<T>, payload: unknown): T => {
  const result = schema.safeParse(payload);
  if (!result.success) throw new RemoteOperationError("The request is not valid.", "invalid_request");
  return result.data;
};
/** Model errors are expected answers (not found, busy, incompatible): devices get their code and a short text. */
const known = async <T>(task: () => Promise<T>): Promise<T> => {
  try { return await task(); }
  catch (error) {
    if (error instanceof LocalModelError) throw new RemoteOperationError(publicError(error.message), error.code ?? (error.statusCode === 409 ? "conflict" : "model_error"));
    if (error instanceof SettingsValidationError) throw new RemoteOperationError(error.message, "invalid_request");
    throw error;
  }
};

/** The Models tab on a paired device (R5): catalog, downloads, load/unload, delete, runtime
 * settings and metrics of this host. Calls the services directly, never the HTTP API. */
export const createModelOperations = (deps: { runtimeManager: RuntimeManager; loadWaitMs?: number; coalesceMs?: number }): Record<string, RemoteOperation> => {
  const service = () => deps.runtimeManager.getRuntime().localModelService;
  // Sequences restart with the process; a device that saw another epoch takes the next state whole.
  const epoch = randomUUID();
  const settingsView = async () => {
    const settings = await deps.runtimeManager.getSettings();
    const { modelsDir: _modelsDir, ...localModels } = settings.localModels ?? ({} as NonNullable<typeof settings.localModels>);
    return { llm: { defaultProvider: settings.llm.defaultProvider }, providers: { llamacpp: { model: settings.providers.llamacpp?.model ?? "" } }, localModels };
  };

  return {
    "models.catalog.search": payload => known(async () => {
      const { query, cursor, source } = parse(schemas.search, payload) ?? {};
      return boundedCatalogPage(await service().listCatalog(query, cursor, source));
    }),
    "models.catalog.get": payload => known(async () => {
      const { repoId, revision } = parse(schemas.model, payload);
      return service().getCatalogModel(repoId, revision);
    }),
    "models.local.snapshot": () => known(async () => safeModelSnapshot(await service().refreshSnapshot())),
    "models.downloads.list": () => known(async () => service().listDownloads().map(safeDownload)),
    // Starting a download is idempotent per model on the host, so a resent command is harmless.
    "models.downloads.start": payload => known(async () => {
      const { commandId: _commandId, ...target } = parse(schemas.download, payload);
      return safeDownload(await service().startDownload(target));
    }),
    "models.downloads.pause": payload => known(async () => safeDownload(await service().pauseDownload(parse(schemas.job, payload).downloadId))),
    "models.downloads.resume": payload => known(async () => safeDownload(await service().resumeDownload(parse(schemas.job, payload).downloadId))),
    "models.downloads.cancel": payload => known(async () => safeDownload(await service().cancelDownload(parse(schemas.job, payload).downloadId))),

    /** Answers once the model is ready or after a short wait; a longer load continues on the host
     * (a disconnect does not cancel it) and its outcome arrives with the model state. */
    "models.load": payload => known(async () => {
      const { modelId } = parse(schemas.libraryModel, payload);
      const load = deps.runtimeManager.getRuntime().localModelManager.loadModel("llamacpp", modelId);
      load.catch(() => undefined);
      const wait = new Promise<"loading">(resolve => setTimeout(() => resolve("loading"), deps.loadWaitMs ?? 25_000).unref?.());
      const status = await Promise.race([load.then(() => "ready" as const), wait]);
      return { modelId, status };
    }),
    "models.unload": payload => known(async () => {
      const { modelId } = parse(schemas.libraryModel, payload);
      await deps.runtimeManager.getRuntime().localModelManager.unloadModel("llamacpp", modelId);
      return { modelId, status: "unloaded" };
    }),
    "models.local.delete": payload => known(async () => {
      const { modelId } = parse(schemas.libraryModel, payload);
      await service().deleteModel(modelId);
      return { modelId, deleted: true };
    }),

    "models.settings.get": () => settingsView(),
    /** Host-wide: a change other than generation settings unloads this host's models for every device. */
    "models.settings.update": payload => known(async () => {
      const { localModels } = parse(schemas.settings, payload);
      await deps.runtimeManager.updateSettings({ localModels } as Parameters<RuntimeManager["updateSettings"]>[0]);
      return settingsView();
    }),
    "models.setDefault": payload => known(async () => {
      const { modelId } = parse(schemas.libraryModel, payload);
      await deps.runtimeManager.updateSettings({ llm: { defaultProvider: "llamacpp" }, providers: { llamacpp: { model: modelId, enabled: true } } } as Parameters<RuntimeManager["updateSettings"]>[0]);
      return settingsView();
    }),

    "system.metrics": () => {
      let gpus;
      try { gpus = service().gpuMetrics(); } catch { gpus = undefined; }
      return systemMetricsSnapshot(gpus);
    },

    /** Long poll on the model state: the whole state at once when the device is behind, otherwise
     * after the next change (bursts of download progress are coalesced), the wait or a disconnect. */
    "models.local.watch": (payload, context: OperationContext) => known(async () => {
      const { epoch: seen, after, waitMs = MAX_WATCH_MS } = parse(schemas.watch, payload) ?? {};
      const models = service();
      const current = () => ({ epoch, sequence: models.snapshot().sequence, snapshot: safeModelSnapshot(models.snapshot()) });
      if (seen !== epoch || after === undefined || after < models.snapshot().sequence) return current();
      const changed = await new Promise<boolean>(resolve => {
        let coalesce: NodeJS.Timeout | undefined;
        const finish = (value: boolean) => { clearTimeout(timer); clearTimeout(coalesce); unsubscribe(); context.signal.removeEventListener("abort", aborted); resolve(value); };
        const unsubscribe = models.subscribe((_event: LocalModelEvent) => { coalesce ??= setTimeout(() => finish(true), deps.coalesceMs ?? 500); });
        const timer = setTimeout(() => finish(false), waitMs);
        const aborted = () => finish(false);
        context.signal.addEventListener("abort", aborted, { once: true });
      });
      return changed ? current() : { epoch, sequence: models.snapshot().sequence };
    })
  };
};
