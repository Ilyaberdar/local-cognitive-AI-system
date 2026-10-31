import { LLMRequest, LLMResponse, ProviderDescriptor, ProviderModel } from "../types";

export interface LLMProvider {
  readonly id: string;
  readonly name: string;
  readonly defaultModel: string;
  isConfigured(): boolean;
  /** Why the provider cannot answer now, when it can say: what a chat shows instead of "disabled or not configured". */
  unavailableReason?(): string | undefined;
  getDescriptor(): ProviderDescriptor;
  listModels?(): Promise<ProviderModel[]>;
  getContextWindow?(modelId?: string): number;
  /** A model that refused function tools in this session: its agents act in JSON instead. */
  toolsRefused?(model?: string): boolean;
  generateText(request: LLMRequest): Promise<LLMResponse>;
}
