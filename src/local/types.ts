import { ManagedModel } from "../types";

export interface LocalModelOptions {
  enabled: boolean;
  dataDir: string;
  modelsDir: string;
  runtimeDir: string;
  executablePath?: string;
  contextSize: number;
  gpuLayers: number;
  loadTimeoutMs: number;
  generationTimeoutMs: number;
  memoryLimitPercent: number;
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
}

export interface LibraryModel extends ManagedModel {
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
}

export interface DownloadJob extends DownloadTarget {
  id: string;
  libraryId: string;
  name: string;
  quantization: string;
  license: string;
  files: ModelArtifact[];
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
  error?: string;
  queueLength: number;
  busy: boolean;
  contextSize: number;
  memoryLimitPercent: number;
  modelsDir: string;
}

export interface LocalModelSnapshot {
  models: LibraryModel[];
  downloads: DownloadJob[];
  runtime: LocalRuntimeSnapshot;
  sequence: number;
}

export interface LocalModelEvent {
  type: "snapshot";
  sequence: number;
  at: string;
  snapshot: LocalModelSnapshot;
}

export class LocalModelError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = "local_model_error") {
    super(message);
    this.name = "LocalModelError";
  }
}
