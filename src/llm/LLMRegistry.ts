import { ProviderDescriptor, ProviderModel } from "../types";
import { LLMProvider } from "./LLMProvider";

export class LLMRegistry {
  private readonly providers = new Map<string, LLMProvider>();

  register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): LLMProvider {
    const provider = this.providers.get(id);

    if (!provider) {
      throw new Error(`LLM provider "${id}" is not registered`);
    }

    return provider;
  }

  list(): ProviderDescriptor[] {
    return Array.from(this.providers.values()).map((provider) => provider.getDescriptor());
  }

  async listModels(providerId?: string): Promise<ProviderModel[]> {
    const providers = providerId
      ? [this.get(providerId)]
      : Array.from(this.providers.values()).filter((provider) => provider.isConfigured());

    const models = await Promise.all(
      providers.map(async (provider) => {
        if (!provider.listModels) {
          return [
            {
              id: provider.defaultModel,
              providerId: provider.id,
              providerName: provider.name
            }
          ];
        }

        try {
          return await provider.listModels();
        } catch {
          return [
            {
              id: provider.defaultModel,
              providerId: provider.id,
              providerName: provider.name
            }
          ];
        }
      })
    );

    const deduped = new Map<string, ProviderModel>();

    for (const providerModels of models.flat()) {
      if (!deduped.has(providerModels.id)) {
        deduped.set(providerModels.id, providerModels);
      }
    }

    return Array.from(deduped.values()).sort((left, right) => left.id.localeCompare(right.id));
  }
}
