import fs from "fs/promises";
import { getSystemMemory } from "../utils/systemMemory";
import { GGUFMetadata, LocalModelError, LocalModelOptions, ModelCompatibility } from "./types";

const GiB = 1024 ** 3;
export const GGUF_INSPECTION_VERSION = 2;
// Let the bundled loader validate decoder architectures. A hand-maintained
// allowlist must not reject newer text models already supported by llama.cpp.
const nonTextArchitectures = new Set([
  "clip", "bert", "modern-bert", "nomic-bert", "nomic-bert-moe", "neo-bert",
  "jina-bert-v2", "jina-bert-v3", "eurobert", "t5encoder", "gemma-embedding",
  "llama-embed", "pangu-embedded", "wavtokenizer-dec", "qwen3tts", "pockettts"
]);
const deltaNetArchitectures = new Set(["qwen35", "qwen35moe", "qwen3next"]);

export const evaluateCompatibility = (
  sizeBytes: number,
  options: Pick<LocalModelOptions, "contextSize" | "memoryLimitPercent">,
  metadata?: GGUFMetadata,
  freeDiskBytes?: number,
  installed = false,
  memory = getSystemMemory()
): ModelCompatibility => {
  // KV cache is shared RAM on Apple Silicon, not a second VRAM allowance.
  const layers = Math.max(0, (metadata?.blockCount ?? 0) - (metadata?.nextnPredictLayers ?? 0));
  const deltaNet = Boolean(metadata && deltaNetArchitectures.has(metadata.architecture));
  const interval = metadata?.fullAttentionInterval ?? 4;
  const recurrentLayers = deltaNet ? Array.isArray(metadata?.recurrentLayers)
    ? metadata.recurrentLayers.slice(0, layers).filter(Boolean).length
    : typeof metadata?.recurrentLayers === "boolean" ? metadata.recurrentLayers ? layers : 0
    : layers - Math.floor(layers / interval) : 0;
  const attentionLayers = layers - recurrentLayers;
  const headLength = (metadata?.embeddingLength ?? 0) / (metadata?.headCount ?? 1);
  const keyLength = metadata?.attentionKeyLength ?? headLength;
  const valueLength = metadata?.attentionValueLength ?? keyLength;
  const kvCacheBytes = layers && keyLength
    ? options.contextSize * attentionLayers * (metadata?.headCountKv ?? metadata?.headCount ?? 1) * (keyLength + valueLength) * 2
    : options.contextSize * 256 * 1024;
  // Qwen gated-delta-net state, FP32, one sequence and no speculative decoding.
  // Mirrors llama-hparams.cpp n_embd_r/n_embd_s in the pinned runtime.
  const recurrentStateBytes = deltaNet && metadata?.ssmInnerSize && metadata.ssmStateSize && metadata.ssmConvKernel && metadata.ssmGroupCount
    ? recurrentLayers * 4 * ((metadata.ssmConvKernel - 1) * (metadata.ssmInnerSize + 2 * metadata.ssmGroupCount * metadata.ssmStateSize) + metadata.ssmStateSize * metadata.ssmInnerSize)
    : recurrentLayers * 4 * 1024 ** 2;
  const estimatedMemoryBytes = Math.ceil(sizeBytes * 1.1 + kvCacheBytes + recurrentStateBytes + 384 * 1024 ** 2);
  const availableMemoryBytes = memory.total;
  const memoryWarningBytes = Math.floor(memory.total * options.memoryLimitPercent / 100);
  const warnings: string[] = [];
  const blockingIssues: ModelCompatibility["blockingIssues"] = [];
  if (metadata && (nonTextArchitectures.has(metadata.architecture) || ["adapter", "projector", "mmproj"].includes(metadata.generalType ?? ""))) {
    blockingIssues.push({ code: "model_type", message: `This ${metadata.generalType || metadata.architecture} GGUF is not a standalone text-generation model. Select the model's main GGUF weights.` });
  }
  // Estimates and the user's threshold are advisory; they must not impose an
  // artificial 75% cap. Only weights larger than all device memory are blocked.
  if (sizeBytes > memory.total) {
    blockingIssues.push({ code: "model_memory", message: `The model weights alone are too large for this device (${(sizeBytes / GiB).toFixed(1)} GB of weights, ${(memory.total / GiB).toFixed(1)} GB of memory). Choose a smaller quantization.` });
  } else if (estimatedMemoryBytes > memory.total) {
    warnings.push(`Estimated memory use (${(estimatedMemoryBytes / GiB).toFixed(1)} GB) exceeds device memory (${(memory.total / GiB).toFixed(1)} GB). Loading may fail or cause substantial swapping. Reduce context size or choose a smaller quantization.`);
  } else if (estimatedMemoryBytes > memoryWarningBytes) {
    warnings.push(`Estimated memory use (${(estimatedMemoryBytes / GiB).toFixed(1)} GB) exceeds your ${options.memoryLimitPercent}% warning threshold (${(memoryWarningBytes / GiB).toFixed(1)} GB). Close other applications to leave enough memory for inference.`);
  } else if (estimatedMemoryBytes > memory.free) {
    warnings.push("Memory is tight. Close other applications; loading this model may cause swapping or run slowly.");
  }
  const requiredDiskBytes = installed ? 0 : sizeBytes + Math.min(512 * 1024 ** 2, sizeBytes * 0.05);
  if (freeDiskBytes !== undefined && requiredDiskBytes > freeDiskBytes) blockingIssues.push({ code: "disk_space", message: "There is not enough free disk space to download and verify this model." });
  if (metadata && !metadata.chatTemplate) warnings.push("This GGUF has no embedded chat template. Chat quality and structured responses have not been verified.");
  if (metadata?.contextLength && options.contextSize > metadata.contextLength) warnings.push(`The configured context exceeds this model's trained context (${metadata.contextLength} tokens).`);
  if (!metadata) warnings.push("Memory is an estimate. GGUF metadata is checked after download and runtime support is verified when loading.");
  return { status: blockingIssues.length ? "incompatible" : warnings.length ? "warning" : "compatible", estimatedMemoryBytes, kvCacheBytes, recurrentStateBytes,
    canLoad: !blockingIssues.some(issue => issue.code !== "disk_space"), canDownload: !blockingIssues.some(issue => issue.code === "disk_space"), blockingIssues,
    totalMemoryBytes: memory.total, availableMemoryBytes, memoryWarningBytes, requiredDiskBytes, freeDiskBytes, warnings, reasons: blockingIssues.map(issue => issue.message) };
};

export const getFreeDiskBytes = async (directory: string): Promise<number | undefined> => {
  try { const stats = await fs.statfs(directory); return Number(stats.bavail) * Number(stats.bsize); } catch { return undefined; }
};

/** Inspect metadata by bounded reads; tokenizer arrays are skipped, never loaded into JS memory. */
export const readGGUFMetadata = async (filePath: string): Promise<GGUFMetadata> => {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    let offset = 0;
    let cache = Buffer.alloc(0);
    let cacheOffset = 0;
    const read = async (count: number): Promise<Buffer> => {
      if (!Number.isSafeInteger(count) || count < 0 || count > 1024 * 1024 || offset + count > stat.size || offset > 128 * 1024 ** 2) {
        throw new LocalModelError("Invalid or unsupported GGUF metadata.");
      }
      if (offset < cacheOffset || offset + count > cacheOffset + cache.length) {
        cacheOffset = offset;
        cache = Buffer.alloc(Math.min(1024 * 1024, stat.size - offset));
        const { bytesRead } = await handle.read(cache, 0, cache.length, offset);
        cache = cache.subarray(0, bytesRead);
      }
      const buffer = cache.subarray(offset - cacheOffset, offset - cacheOffset + count);
      if (buffer.length !== count) throw new LocalModelError("The GGUF file is truncated.");
      offset += count;
      return buffer;
    };
    const u32 = async () => (await read(4)).readUInt32LE();
    const u64 = async () => { const value = Number((await read(8)).readBigUInt64LE()); if (!Number.isSafeInteger(value)) throw new LocalModelError("Invalid GGUF length."); return value; };
    const string = async (keep = true): Promise<string> => {
      const length = await u64();
      if (length > 1024 * 1024 || offset + length > stat.size) throw new LocalModelError("Invalid GGUF string length.");
      if (!keep) { offset += length; return ""; }
      return (await read(length)).toString("utf8");
    };
    const value = async (type: number, keep: boolean, depth = 0): Promise<unknown> => {
      if (depth > 2) throw new LocalModelError("Unsupported nested GGUF metadata.");
      if (type === 8) return string(keep);
      if (type === 9) {
        const itemType = await u32(); const count = await u64();
        if (count > 10_000_000) throw new LocalModelError("GGUF metadata array is too large.");
        if (keep) {
          if (count > 4096) throw new LocalModelError("GGUF architecture metadata array is too large.");
          const values: unknown[] = [];
          for (let index = 0; index < count; index++) values.push(await value(itemType, true, depth + 1));
          return values;
        }
        const sizes: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
        if (sizes[itemType]) { offset += sizes[itemType] * count; if (offset > stat.size) throw new LocalModelError("The GGUF file is truncated."); }
        else for (let index = 0; index < count; index++) await value(itemType, false, depth + 1);
        return undefined;
      }
      const size = ({ 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 } as Record<number, number>)[type];
      if (!size) throw new LocalModelError("Unsupported GGUF value type.");
      const bytes = await read(size);
      if (!keep) return undefined;
      if (type === 6) return bytes.readFloatLE();
      if (type === 12) return bytes.readDoubleLE();
      if (type === 10) return Number(bytes.readBigUInt64LE());
      if (type === 11) return Number(bytes.readBigInt64LE());
      return [1, 3, 5].includes(type) ? bytes.readIntLE(0, size) : bytes.readUIntLE(0, size);
    };
    if ((await read(4)).toString("ascii") !== "GGUF") throw new LocalModelError("Only valid GGUF model files can be imported.");
    const version = await u32();
    if (![2, 3].includes(version)) throw new LocalModelError(`GGUF version ${version} is not supported.`);
    await u64(); const count = await u64();
    if (count > 10000) throw new LocalModelError("GGUF has too many metadata entries.");
    const metadata = new Map<string, unknown>();
    for (let index = 0; index < count; index++) {
      const key = await string(); const type = await u32();
      const keep = /^(general\.(architecture|name|type)|tokenizer\.chat_template|clip\.has_vision_encoder)$|\.(context_length|embedding_length|block_count|nextn_predict_layers|full_attention_interval|attention\.(head_count|head_count_kv|key_length|value_length|recurrent_layers)|ssm\.(conv_kernel|inner_size|state_size|group_count))$/.test(key);
      const item = await value(type, keep);
      if (keep) metadata.set(key, item);
    }
    const architecture = String(metadata.get("general.architecture") ?? "");
    if (!architecture) throw new LocalModelError("The GGUF file does not identify a model architecture.");
    const number = (suffix: string) => { const item = metadata.get(`${architecture}.${suffix}`); return typeof item === "number" && item > 0 ? item : undefined; };
    const recurrent = metadata.get(`${architecture}.attention.recurrent_layers`);
    return { inspectionVersion: GGUF_INSPECTION_VERSION, version, architecture, generalType: typeof metadata.get("general.type") === "string" ? metadata.get("general.type") as string : undefined,
      name: typeof metadata.get("general.name") === "string" ? metadata.get("general.name") as string : undefined,
      chatTemplate: Boolean(metadata.get("tokenizer.chat_template")), contextLength: number("context_length"),
      embeddingLength: number("embedding_length"), blockCount: number("block_count"), headCount: number("attention.head_count"), headCountKv: number("attention.head_count_kv"),
      attentionKeyLength: number("attention.key_length"), attentionValueLength: number("attention.value_length"), fullAttentionInterval: number("full_attention_interval"),
      recurrentLayers: Array.isArray(recurrent) ? recurrent.map(Boolean) : typeof recurrent === "number" ? Boolean(recurrent) : undefined,
      nextnPredictLayers: number("nextn_predict_layers"), ssmConvKernel: number("ssm.conv_kernel"), ssmInnerSize: number("ssm.inner_size"), ssmStateSize: number("ssm.state_size"), ssmGroupCount: number("ssm.group_count"),
      hasVisionEncoder: metadata.has("clip.has_vision_encoder") ? Boolean(metadata.get("clip.has_vision_encoder")) : undefined };
  } finally { await handle.close(); }
};
