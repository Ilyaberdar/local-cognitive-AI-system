import { LocalGenerationSettings, ManagedModel } from "../types";

export interface LocalModelOptions {
  enabled: boolean;
  dataDir: string;
  modelsDir: string;
  runtimeDir: string;
  executablePath?: string;
  contextSize: number;
  gpuLayers: number | "auto";
  loadTimeoutMs: number;
  generationTimeoutMs: number;
  memoryLimitPercent: number;
  /** Undefined keeps llama.cpp's own defaults (legacy/test compatible). */
  generation?: LocalGenerationSettings;
  /** Backend chosen by the headless server (`start --inference`); absent on the desktop. */
  inference?: { preference: "auto" | "cuda" | "cpu"; fallbackReason?: string };
}

export interface ModelArtifact {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface ModelCompatibility {
  status: "compatible" | "warning" | "incompatible";
  canLoad: boolean;
  canDownload: boolean;
  blockingIssues: Array<{ code: "model_type" | "model_memory" | "disk_space"; message: string }>;
  estimatedMemoryBytes: number;
  kvCacheBytes: number;
  recurrentStateBytes: number;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  memoryWarningBytes: number;
  requiredDiskBytes: number;
  freeDiskBytes?: number;
  warnings: string[];
  reasons: string[];
}

export interface CatalogVariant {
  id: string;
  name: string;
  quantization: string;
  sizeBytes: number;
  files: ModelArtifact[];
  compatibility?: ModelCompatibility;
}

export interface CatalogModel {
  id: string;
  repoId: string;
  name: string;
  author: string;
  revision: string;
  license: string;
  description?: string;
  gated: boolean;
  tags?: string[];
  variants: CatalogVariant[];
  projectors?: ModelArtifact[];
  recommended?: boolean;
  verified?: boolean;
  cached?: boolean;
}

export interface CatalogPage {
  items: CatalogModel[];
  nextCursor?: string;
  cached?: boolean;
  warning?: string;
}

export interface GGUFMetadata {
  inspectionVersion?: number;
  version: number;
  architecture: string;
  generalType?: string;
  name?: string;
  chatTemplate?: boolean;
  contextLength?: number;
  embeddingLength?: number;
  blockCount?: number;
  headCount?: number;
  headCountKv?: number;
  attentionKeyLength?: number;
  attentionValueLength?: number;
  fullAttentionInterval?: number;
  recurrentLayers?: boolean[] | boolean;
  nextnPredictLayers?: number;
  ssmConvKernel?: number;
  ssmInnerSize?: number;
  ssmStateSize?: number;
  ssmGroupCount?: number;
  hasVisionEncoder?: boolean;
}

export interface LibraryModel extends ManagedModel {
  filesAvailable?: boolean;
  providerId: "llamacpp";
  libraryId: string;
  repoId?: string;
  revision?: string;
  variantId: string;
  quantization: string;
  license: string;
  installedAt: string;
  owned: boolean;
  files: ModelArtifact[];
  projector?: ModelArtifact;
  metadata?: GGUFMetadata;
  state: "unloaded" | "loading" | "ready" | "unloading" | "error";
  busy?: boolean;
  compatibility?: ModelCompatibility;
  error?: string;
}

export interface DownloadTarget {
  repoId: string;
  revision: string;
  variantId: string;
  projectorPath?: string;
}

export interface DownloadJob extends DownloadTarget {
  id: string;
  libraryId: string;
  name: string;
  quantization: string;
  license: string;
  files: ModelArtifact[];
  projector?: ModelArtifact;
  state: "queued" | "downloading" | "paused" | "verifying" | "completed" | "failed" | "cancelled";
  downloadedBytes: number;
  totalBytes: number;
  speedBytesPerSecond: number;
  progress: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface LocalRuntimeSnapshot {
  status: "unavailable" | "stopped" | "loading" | "ready" | "stopping" | "error";
  version: string;
  backend: string;
  platform: string;
  architecture: string;
  modelId?: string;
  loadedModelIds?: string[];
  instances?: LocalRuntimeSnapshot[];
  error?: string;
  queueLength: number;
  busy: boolean;
  contextSize: number;
  /** Context reported by the running native server; absent while unloaded or unverified. */
  effectiveContextSize?: number;
  memoryLimitPercent: number;
  modelsDir: string;
  /** Where the loaded model runs; absent while unloaded and on runtimes without placement. */
  placement?: LocalPlacementSnapshot;
  /** Prepared runtime directory id (linux-x64, linux-x64-cuda12, ...). */
  runtimeId?: string;
  /** Why models run on the CPU although a GPU runtime was wanted. */
  fallbackReason?: string;
}

export interface LocalModelStorageSnapshot {
  managedBytes: number;
  partialBytes: number;
  untrackedBytes: number;
  freeDiskBytes?: number;
  externalLibraries: Array<{
    providerId: string;
    name: string;
    path: string;
    sizeBytes: number;
    models: Array<{ name: string; path: string; sizeBytes: number; format: "GGUF" | "MLX" | "Mixed" | "Other" }>;
  }>;
  warnings: string[];
}

export interface LocalModelSnapshot {
  models: LibraryModel[];
  downloads: DownloadJob[];
  runtime: LocalRuntimeSnapshot;
  sequence: number;
  storage?: LocalModelStorageSnapshot;
}

export interface LocalModelEvent {
  type: "snapshot";
  sequence: number;
  at: string;
  snapshot: LocalModelSnapshot;
}

export interface LocalPlacementSnapshot {
  kind: "unified" | "single-gpu" | "multi-gpu" | "partial" | "cpu";
  label: string;
  backend: string;
  devices: Array<{ id: string; index: number; name: string; estimatedBytes: number }>;
  gpuLayers: number | "all";
  tensorSplit?: number[];
  hostEstimatedBytes: number;
  warnings: string[];
  retried?: boolean;
}

export class LocalModelError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = "local_model_error", readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "LocalModelError";
  }
}
