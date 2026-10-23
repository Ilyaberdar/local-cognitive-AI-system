import { LLMRequest, LLMResponse, ProviderDescriptor, ProviderModel } from "../types";

export interface LLMProvider {
  readonly id: string;
  readonly name: string;
  readonly defaultModel: string;
  isConfigured(): boolean;
  getDescriptor(): ProviderDescriptor;
  listModels?(): Promise<ProviderModel[]>;
  getContextWindow?(modelId?: string): number;
  /** A model that refused function tools in this session: its agents act in JSON instead. */
  toolsRefused?(model?: string): boolean;
  generateText(request: LLMRequest): Promise<LLMResponse>;
}
