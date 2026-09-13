import { LocalModelManager } from "./LocalModelManager";
import { LocalModelService } from "../local/LocalModelService";

export class LlamaCppModelManager implements LocalModelManager {
  readonly providerId = "llamacpp";
  readonly providerName = "Local models";
  constructor(private readonly service: LocalModelService) {}
  listAllModels() { return this.service.listAllModels(); }
  listLoadedModels() { return this.service.listLoadedModels(); }
  loadModel(modelId: string) { return this.service.loadModel(modelId); }
  unloadModel(identifier: string) { return this.service.unloadModel(identifier); }
}
