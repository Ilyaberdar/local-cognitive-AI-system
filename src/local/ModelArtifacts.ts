import { GGUFMetadata, LocalModelError, ModelArtifact } from "./types";

export const allModelArtifacts = (model: { files: ModelArtifact[]; projector?: ModelArtifact }): ModelArtifact[] =>
  [...model.files, ...(model.projector ? [model.projector] : [])];

export const modelDiskBytes = (model: { files: ModelArtifact[]; projector?: ModelArtifact }): number =>
  allModelArtifacts(model).reduce((sum, file) => sum + file.sizeBytes, 0);

export const isProjectorPath = (file: string): boolean =>
  /(?:^|\/)(?:mmproj|projector)(?:[-_.\/]|$)/i.test(file);

export const isProjectorMetadata = (metadata: GGUFMetadata): boolean =>
  metadata.architecture === "clip" || ["projector", "mmproj"].includes(metadata.generalType ?? "");

export const assertVisionProjector = (metadata: GGUFMetadata): void => {
  // The pinned mtmd loader also requires clip.has_vision_encoder=true.
  if (!isProjectorMetadata(metadata) || metadata.hasVisionEncoder !== true) {
    throw new LocalModelError("Select a vision mmproj GGUF with an image encoder. Main model weights and audio-only adapters cannot be used as a vision adapter.", 400, "invalid_projector");
  }
};
