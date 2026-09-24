import { LLMProvider } from "./LLMProvider";
import { LLMRequest, LLMResponse, ProviderDescriptor, ProviderModel } from "../types";
import { LocalModelService } from "../local/LocalModelService";

export class LlamaCppProvider implements LLMProvider {
  readonly id = "llamacpp";
  readonly name = "Local models";
  readonly defaultModel: string;
  constructor(private readonly service: LocalModelService, private readonly options: { model: string; enabled?: boolean }) { this.defaultModel = options.model; }
  isConfigured(): boolean { return this.options.enabled !== false && this.service.available; }
  getDescriptor(): ProviderDescriptor { return { id: this.id, name: this.name, defaultModel: this.defaultModel, configured: this.isConfigured(),
    capabilities: { local: true, managed: true, jsonMode: true, reasoning: false, vision: true } }; }
  async listModels(): Promise<ProviderModel[]> {
    if (this.options.enabled === false) return [];
    return (await this.service.listAllModels()).filter(model => model.compatibility?.canLoad !== false).map((model) => ({ id: model.id, providerId: this.id, providerName: this.name, displayName: model.displayName, vision: Boolean(model.projector) }));
  }
  async generateText(request: LLMRequest): Promise<LLMResponse> {
    if (this.options.enabled === false) return { provider: this.id, model: request.model ?? this.defaultModel, text: "", error: "Local models are disabled in Settings." };
    try { return await this.service.generateText({ ...request, model: request.model || this.defaultModel }); }
    catch (error) {
      if (request.signal?.aborted) throw error;
      return { provider: this.id, model: request.model || this.defaultModel, text: "", error: error instanceof Error ? error.message : "Local inference failed." };
    }
  }
}
