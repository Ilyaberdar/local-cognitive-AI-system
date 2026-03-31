export type Mode = "hypothesis" | "code" | "general";
export type SessionMode = Mode | "auto";
export type Channel = "http" | "telegram" | "system";
export type LanguagePreference = "auto" | "ru" | "en";
export type DebateProfile =
  | "general"
  | "technical"
  | "product"
  | "research"
  | "security";

export interface ActorContext {
  sessionId: string;
  userId?: string;
  channel: Channel;
}

export interface ProviderTarget {
  providerId: string;
  model?: string;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface GenerationMetrics {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  usage?: TokenUsage;
}

export interface DebateSettings {
  enabled: boolean;
  profile: DebateProfile;
  support: ProviderTarget;
  attack: ProviderTarget;
  judge: ProviderTarget;
}

export interface ProviderRuntimeSettings {
  enabled: boolean;
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  version?: string;
  maxTokens?: number;
}

export interface PluginRuntimeSettings {
  enabled: boolean;
  values: Record<string, string | number | boolean | undefined>;
}

export interface AppSettings {
  llm: {
    defaultProvider: string;
  };
  telegram: {
    enabled: boolean;
    botToken?: string;
    pollTimeoutSec: number;
  };
  memory: {
    adapter: "local-json" | "openmemory";
    baseDir: string;
    topK: number;
    openMemory: {
      enabled: boolean;
      dbPath: string;
    };
  };
  providers: Record<string, ProviderRuntimeSettings>;
  plugins: Record<string, PluginRuntimeSettings>;
}

export interface AppSettingsPatch {
  llm?: {
    defaultProvider?: string;
  };
  telegram?: {
    enabled?: boolean;
    botToken?: string;
    pollTimeoutSec?: number;
  };
  memory?: {
    adapter?: "local-json" | "openmemory";
    baseDir?: string;
    topK?: number;
    openMemory?: {
      enabled?: boolean;
      dbPath?: string;
    };
  };
  providers?: Record<string, Partial<ProviderRuntimeSettings>>;
  plugins?: Record<
    string,
    {
      enabled?: boolean;
      values?: Record<string, string | number | boolean | undefined>;
    }
  >;
}

export interface SessionSettings {
  mode: SessionMode;
  language: LanguagePreference;
  defaultTarget: ProviderTarget;
  debate: DebateSettings;
}

export interface SessionSettingsPatch {
  mode?: SessionMode;
  language?: LanguagePreference;
  defaultTarget?: Partial<ProviderTarget>;
  debate?: {
    enabled?: boolean;
    profile?: DebateProfile;
    support?: Partial<ProviderTarget>;
    attack?: Partial<ProviderTarget>;
    judge?: Partial<ProviderTarget>;
  };
}

export interface MemoryEntry {
  id: string;
  input: string;
  mode: Mode;
  output: unknown;
  scope: string;
  tags: string[];
  embedding: number[];
  createdAt: string;
  actor: ActorContext;
  metadata?: Record<string, unknown>;
}

export interface MemoryReference {
  id: string;
  input: string;
  mode: Mode;
  scope: string;
  createdAt: string;
  actor: ActorContext;
}

export interface ToolExecutionResult {
  tool: string;
  ok: boolean;
  output: string;
  metadata?: Record<string, unknown>;
}

export interface AgentDebateResponse {
  agent: string;
  stance: "pro" | "contra";
  provider: string;
  model: string;
  summary: string;
  arguments: string[];
  raw: string;
  usage?: TokenUsage;
}

export interface HypothesisResult {
  verdict: string;
  confidence: number;
  reasoning: string;
  participants: {
    support: string;
    attack: string;
    judge: string;
  };
  configuredParticipants?: {
    judge?: string;
  };
  fallback?: {
    used: boolean;
    reason: string;
  };
  diagnostics?: {
    judge: {
      requestedTarget: string;
      responseTarget?: string;
      providerCall: "ok" | "failed" | "local";
      structuredOutput: "accepted" | "rejected" | "n/a";
      fallbackUsed: boolean;
      fallbackReason?: string;
      providerError?: string;
    };
  };
  metrics?: GenerationMetrics;
  arguments: {
    pro: string[];
    contra: string[];
  };
}

export interface TextModeResult {
  response: string;
  provider: string;
  model: string;
  metrics?: GenerationMetrics;
}

export type ModeResult = HypothesisResult | TextModeResult;

export interface ProcessResult {
  input: string;
  mode: Mode;
  providerId: string;
  result: ModeResult;
  tools: ToolExecutionResult[];
  memory: MemoryReference[];
  conversationSize: number;
  sessionSettings: SessionSettings;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  channel: Channel;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  metrics?: GenerationMetrics;
}

export interface LLMRequest {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  previousResponseId?: string;
  responseFormat?: {
    type: "json_object";
  };
}

export interface LLMResponse {
  provider: string;
  model: string;
  text: string;
  raw?: unknown;
  responseId?: string;
  usage?: TokenUsage;
  error?: string;
}

export interface ExecutionContext {
  actor: ActorContext;
  memory: MemoryReference[];
  conversation: MemoryEntry[];
  providerId: string;
  activeTarget: ProviderTarget;
  sessionSettings: SessionSettings;
}

export interface ProcessInput {
  input: string;
  actor?: Partial<ActorContext>;
  providerId?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface MemorySaveInput {
  input: string;
  mode: Mode;
  output: unknown;
  actor: ActorContext;
  scope?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface MemoryQueryOptions {
  actor?: Partial<ActorContext>;
  topK?: number;
}

export interface MemoryRecentOptions {
  actor?: Partial<ActorContext>;
  limit?: number;
}

export interface ToolExecutionRequest {
  rawInput: string;
  title: string;
  content: string;
  context: ExecutionContext;
  result: ModeResult;
  metadata?: Record<string, unknown>;
}

export interface ToolDescriptor {
  name: string;
  description: string;
}

export interface ProviderDescriptor {
  id: string;
  name: string;
  configured: boolean;
  defaultModel: string;
}

export interface ProviderModel {
  id: string;
  providerId: string;
  providerName: string;
}

export interface ManagedModel {
  id: string;
  displayName: string;
  loaded: boolean;
  loadedInstanceIds: string[];
}
