import { LLMRequest, LLMResponse, ProviderDescriptor, ProviderModel } from "../types";

export interface LLMProvider {
  readonly id: string;
  readonly name: string;
  readonly defaultModel: string;
  isConfigured(): boolean;
  getDescriptor(): ProviderDescriptor;
  listModels?(): Promise<ProviderModel[]>;
  generateText(request: LLMRequest): Promise<LLMResponse>;
}
