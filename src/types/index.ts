import type { McpClientConfiguration, McpClientConfigurationPatch } from "../mcp/client/types";
import type { WorkspaceSnapshot } from "../workspace/types";

export type Mode = "hypothesis" | "code" | "general";
export type SessionMode = Mode | "auto";
export type Channel = "http" | "telegram" | "mcp" | "system";
export type LanguagePreference = "auto" | "ru" | "en";
export type OutputStyle = "compact" | "balanced" | "detailed" | "exhaustive";
export type SubagentAccessMode = "ask" | "default" | "full";

export interface ApprovalOperation {
  tool: string;
  operation: string;
  summary: string;
  details: string;
}

export interface PendingApproval extends ApprovalOperation {
  id: string;
  requestedAt: string;
}

export type ApprovalHandler = (operation: ApprovalOperation) => Promise<boolean>;
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
  projectId?: string;
  memoryScope?: string;
}

export interface ProviderTarget {
  providerId: string;
  model?: string;
}

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  kind: "text" | "image" | "binary";
  textContent?: string;
  dataUrl?: string;
  truncated?: boolean;
  warning?: string;
}

export interface CodeAgentTarget extends ProviderTarget {
  id: string;
  name: string;
  accessMode: SubagentAccessMode;
}

export interface HypothesisAgentTarget extends ProviderTarget {
  id: string;
  name: string;
  role: "support" | "attack" | "judge" | "advisor";
}

export interface SubagentRunSummary {
  id: string;
  name: string;
  role: "writer" | "advisor";
  provider: string;
  model?: string;
  accessMode: SubagentAccessMode;
  status: "ok" | "degraded";
  error?: string;
  output?: string;
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

export interface ProviderRateLimit {
  remainingRequests?: string;
  remainingTokens?: string;
  resetRequests?: string;
  resetTokens?: string;
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
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface LocalModelSettings {
  modelsDir: string;
  contextSize: number;
  gpuLayers: number;
  loadTimeoutMs: number;
  generationTimeoutMs: number;
  memoryLimitPercent: number;
}

export interface PluginRuntimeSettings {
  enabled: boolean;
  values: Record<string, string | number | boolean | undefined>;
}

export interface UiPreferences {
  version: 1;
  theme: "dark" | "light" | "system";
  animations: boolean;
  fontScale: number;
  language: LanguagePreference;
  outputStyle: OutputStyle;
  mode: SessionMode;
}

export interface AppSettings {
  schemaVersion?: number;
  ui?: UiPreferences;
  localModels?: LocalModelSettings;
  llm: {
    defaultProvider: string;
  };
  mcp: {
    client?: McpClientConfiguration;
    server: {
      enabled: boolean;
      transport: "stdio";
      defaultSessionId: string;
    };
  };
  telegram: {
    enabled: boolean;
    botToken?: string;
    ownerUserIds: string[];
    pollTimeoutSec: number;
  };
  memory: {
    adapter: "local-json" | "openmemory" | "world-partition";
    baseDir: string;
    topK: number;
    localProfileId: string;
    worldPartition: MemoryWorldPartitionSettings;
    openMemory: {
      enabled: boolean;
      dbPath: string;
    };
  };
  providers: Record<string, ProviderRuntimeSettings>;
  plugins: Record<string, PluginRuntimeSettings>;
}

export interface AppSettingsPatch {
  ui?: Partial<Omit<UiPreferences, "version">>;
  localModels?: Partial<LocalModelSettings>;
  llm?: {
    defaultProvider?: string;
  };
  mcp?: {
    client?: McpClientConfigurationPatch;
    server?: {
      enabled?: boolean;
      transport?: "stdio";
      defaultSessionId?: string;
    };
  };
  telegram?: {
    enabled?: boolean;
    botToken?: string;
    ownerUserIds?: string[];
    pollTimeoutSec?: number;
  };
  memory?: {
    adapter?: "local-json" | "openmemory" | "world-partition";
    baseDir?: string;
    topK?: number;
    worldPartition?: Partial<MemoryWorldPartitionSettings>;
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
  outputStyle: OutputStyle;
  defaultTarget: ProviderTarget;
  defaultAccessMode: SubagentAccessMode;
  codeAgents: CodeAgentTarget[];
  hypothesisAgents: HypothesisAgentTarget[];
  debate: DebateSettings;
}

export interface SessionSettingsPatch {
  mode?: SessionMode;
  language?: LanguagePreference;
  outputStyle?: OutputStyle;
  defaultTarget?: Partial<ProviderTarget>;
  defaultAccessMode?: SubagentAccessMode;
  codeAgents?: CodeAgentTarget[];
  subagents?: CodeAgentTarget[];
  hypothesisAgents?: HypothesisAgentTarget[];
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

export type MemoryPartitionStrategy = "auto" | "global" | "partitioned";

export interface MemoryWorldPartitionSettings {
  crossSessionRecall: boolean;
  strategy: MemoryPartitionStrategy;
  activationThreshold: number;
  chunkCapacity: number;
  initialRadius: number;
  maxRadius: number;
  fallbackToGlobalSearch: boolean;
  migrateLegacyOnStart: boolean;
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
  degraded?: boolean;
  error?: string;
}

export interface HypothesisResult {
  error?: string;
  verdict: string;
  confidence: number;
  reasoning: string;
  conclusion: string;
  participants: {
    support: string;
    attack: string;
    judge: string;
    advisors?: string[];
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
    agents?: {
      support?: {
        status: "ok" | "failed";
        providerError?: string;
      };
      attack?: {
        status: "ok" | "failed";
        providerError?: string;
      };
    };
  };
  metrics?: GenerationMetrics;
  arguments: {
    pro: string[];
    contra: string[];
  };
  subagents?: SubagentRunSummary[];
}

export interface TextModeResult {
  error?: string;
  response: string;
  toolPayload?: string;
  provider: string;
  model: string;
  subagents?: SubagentRunSummary[];
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
  pendingApproval?: PendingApproval;
  agentRunId?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  channel: Channel;
  projectId?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  metrics?: GenerationMetrics;
  attachments?: ChatAttachment[];
  includePreviousAttachments?: boolean;
  tools?: ToolExecutionResult[];
  subagents?: SubagentRunSummary[];
}

export interface LLMImage {
  name?: string;
  dataUrl: string;
}

export interface LLMRequest {
  outputPurpose?: "agent-action";
  /** Per-request thinking token budget for the bundled llama.cpp runtime. */
  localReasoningBudget?: number;
  prompt: string;
  images?: LLMImage[];
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (event: { phase: "queued" | "loading" | "generating"; model: string; queuePosition?: number }) => void;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
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
  rateLimit?: ProviderRateLimit;
  error?: string;
}

export interface ExecutionContext {
  actor: ActorContext;
  memory: MemoryReference[];
  conversation: MemoryEntry[];
  providerId: string;
  activeTarget: ProviderTarget;
  sessionSettings: SessionSettings;
  requestMetadata?: Record<string, unknown>;
  signal?: AbortSignal;
  onProgress?: (event: ProcessProgressEvent) => void;
  requestApproval?: ApprovalHandler;
  workspace?: WorkspaceSnapshot;
  execution?: InternalExecutionContext;
}

/** Server-owned execution parameters. HTTP/MCP metadata must never populate this. */
export interface InternalExecutionContext {
  /** Workflow nodes receive selected inputs, without automatic project/chat recall. */
  contextMode?: "explicit";
  localReasoningBudget?: number;
  workspace: WorkspaceSnapshot;
  accessMode: SubagentAccessMode;
  agentRunId: string;
  pauseForApproval?: boolean;
  requireApproval?: boolean;
  approval?: { id: string; approved: boolean };
  settings?: SessionSettings;
}

export interface ProcessProgressEvent {
  output?: { stream: "stdout" | "stderr"; text: string };
  agentRunId?: string;
  operationId?: string;
  phase: string;
  label: string;
  detail?: string;
  completed?: number;
  total?: number;
  at: string;
  agents?: ProcessAgentProgress[];
}

export interface ProcessAgentProgress {
  id: string;
  name: string;
  role: string;
  provider: string;
  model?: string;
  status: "queued" | "running" | "completed" | "degraded" | "cancelled";
  phase: string;
  error?: string;
}

export interface ProcessInput {
  input: string;
  actor?: Partial<ActorContext>;
  providerId?: string;
  model?: string;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
  onProgress?: (event: ProcessProgressEvent) => void;
  requestApproval?: ApprovalHandler;
  execution?: InternalExecutionContext;
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
  capabilities?: {
    local: boolean;
    managed: boolean;
    jsonMode: boolean;
    reasoning: boolean;
    vision?: boolean;
  };
}

export interface ProviderModel {
  vision?: boolean;
  id: string;
  providerId: string;
  providerName: string;
}

export interface ManagedModel {
  vision?: boolean;
  id: string;
  displayName: string;
  providerId: string;
  providerName: string;
  sizeBytes?: number;
  loaded: boolean;
  loadedInstanceIds: string[];
}

export interface SystemMetrics {
  cpuPercent: number;
  ramPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  memoryCachedBytes?: number;
  cpuCores: number;
  loadAverage1m: number;
}
