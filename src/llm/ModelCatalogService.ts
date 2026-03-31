import { ProviderModel } from "../types";
import { LLMRegistry } from "./LLMRegistry";

export class ModelCatalogService {
  constructor(private readonly registry: LLMRegistry) {}

  async listAll(providerId?: string): Promise<ProviderModel[]> {
    return this.registry.listModels(providerId);
  }
}
