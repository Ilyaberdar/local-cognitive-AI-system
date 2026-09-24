import { GGUFMetadata, LocalModelError, ModelArtifact } from "./types";

export const allModelArtifacts = (model: { files: ModelArtifact[]; projector?: ModelArtifact }): ModelArtifact[] =>
  [...model.files, ...(model.projector ? [model.projector] : [])];

export const modelDiskBytes = (model: { files: ModelArtifact[]; projector?: ModelArtifact }): number =>
  allModelArtifacts(model).reduce((sum, file) => sum + file.sizeBytes, 0);

export const isProjectorPath = (file: string): boolean =>
  /(?:^|\/)(?:mmproj|projector)(?:[-_.\/]|$)/i.test(file);

const isDSparkPath = (file: string): boolean => /(?:^|[-_.\/])dspark(?:[-_.\/]|$)/i.test(file);

// A repository can ship adapters/drafters beside the actual decoder weights.
// DSpark is Bonsai's optional speculative drafter, not another quantization.
export const isAuxiliaryModelPath = (file: string): boolean =>
  isProjectorPath(file) || /(?:^|\/)adapter[-_.]/i.test(file) || isDSparkPath(file);

// Keep this a list of non-standalone architectures, not an allowlist of decoders:
// new text architectures may already work in the bundled native loader.
const nonTextArchitectures = new Set([
  "clip", "bert", "modern-bert", "nomic-bert", "nomic-bert-moe", "neo-bert",
  "jina-bert-v2", "jina-bert-v3", "eurobert", "t5encoder", "gemma-embedding",
  "llama-embed", "pangu-embedded", "wavtokenizer-dec", "qwen3tts", "pockettts"
]);

export const standaloneModelIssue = (metadata?: GGUFMetadata, files: readonly string[] = []): string | undefined => {
  const architecture = metadata?.architecture.toLowerCase();
  const type = metadata?.generalType?.toLowerCase();
  if (architecture === "dspark" || files.some(isDSparkPath)) {
    return "DSpark is an auxiliary speculative-decoding drafter, not a standalone chat model. Choose the repository's main GGUF weights instead.";
  }
  if ((architecture && nonTextArchitectures.has(architecture)) || (type && ["adapter", "projector", "mmproj"].includes(type)) || files.some(isAuxiliaryModelPath)) {
    return `This ${type || architecture || "auxiliary"} GGUF is not a standalone text-generation model. Select the model's main GGUF weights.`;
  }
  return undefined;
};

export const assertStandaloneModel = (metadata?: GGUFMetadata, files: readonly string[] = []): void => {
  const issue = standaloneModelIssue(metadata, files);
  if (issue) throw new LocalModelError(issue, 400, "model_type");
};

export const isProjectorMetadata = (metadata: GGUFMetadata): boolean =>
  metadata.architecture === "clip" || ["projector", "mmproj"].includes(metadata.generalType ?? "");

export const assertVisionProjector = (metadata: GGUFMetadata): void => {
  // The pinned mtmd loader also requires clip.has_vision_encoder=true.
  if (!isProjectorMetadata(metadata) || metadata.hasVisionEncoder !== true) {
    throw new LocalModelError("Select a vision mmproj GGUF with an image encoder. Main model weights and audio-only adapters cannot be used as a vision adapter.", 400, "invalid_projector");
  }
};
