import { ProviderModel } from "../types";
import { LLMRegistry } from "./LLMRegistry";

export class ModelCatalogService {
  constructor(private readonly registry: LLMRegistry) {}

  async listAll(providerId?: string): Promise<ProviderModel[]> {
    return this.registry.listModels(providerId);
  }

  /** One provider's own model list, its errors kept (listAll falls back to the default model). */
  async probe(providerId: string): Promise<ProviderModel[]> {
    const provider = this.registry.get(providerId);
    if (!provider.listModels) return [{ id: provider.defaultModel, providerId: provider.id, providerName: provider.name }];
    return provider.listModels();
  }
}
