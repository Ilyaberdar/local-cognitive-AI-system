import fs from "fs/promises";
import path from "path";
import { AttackAgent } from "../agents/AttackAgent";
import { selectConfiguredSubagents } from "../agents/code/codeAgentRouting";
import { HypothesisAgent } from "../agents/HypothesisAgent";
import { HypothesisAdvisorAgent } from "../agents/HypothesisAdvisorAgent";
import { SupportAgent } from "../agents/SupportAgent";
import { AppConfig } from "../config/config";
import { CognitiveEngine } from "../core/CognitiveEngine";
import { ModeDetector } from "../core/ModeDetector";
import { ResponseFormatter } from "../core/ResponseFormatter";
import { Router } from "../core/Router";
import { ToolRequestBuilder } from "../core/ToolRequestBuilder";
import { Judge } from "../judge/Judge";
import { AnthropicProvider } from "../llm/AnthropicProvider";
import { GeminiProvider } from "../llm/GeminiProvider";
import { LLMRegistry } from "../llm/LLMRegistry";
import { LocalModelManagerRegistry } from "../llm/LocalModelManager";
import { LMStudioManager } from "../llm/LMStudioManager";
import { LanguageEnforcer } from "../llm/LanguageEnforcer";
import { LLMService } from "../llm/LLMService";
import { OllamaModelManager } from "../llm/OllamaModelManager";
import { OllamaProvider } from "../llm/OllamaProvider";
import { OutputSanitizer } from "../llm/OutputSanitizer";
import { OpenAICompatibleProvider } from "../llm/OpenAICompatibleProvider";
import { LocalJsonMemoryAdapter } from "../memory/LocalJsonMemoryAdapter";
import { MemoryAdapter } from "../memory/MemoryAdapter";
import { MemoryService } from "../memory/MemoryService";
import { OpenMemoryAdapter } from "../memory/OpenMemoryAdapter";
import { VectorStore } from "../memory/VectorStore";
import { PluginLoader } from "../plugins/PluginLoader";
import { LoadedPlugin } from "../plugins/types";
import { SessionSettingsStore } from "../session/SessionSettingsStore";
import { FileTool } from "../tools/FileTool";
import { ToolRegistry } from "../tools/ToolRegistry";
import { TaskService } from "../tasks/TaskService";
import { TaskStore } from "../tasks/TaskStore";
import {
  CodeAgentTarget,
  ExecutionContext,
  LLMResponse,
  ProviderDescriptor,
  SubagentRunSummary,
  ToolDescriptor
} from "../types";
import { Logger } from "../utils/Logger";
import { ModelCatalogService } from "../llm/ModelCatalogService";
import { readAttachments, renderAttachmentContext } from "../utils/attachments";
import {
  buildFinalMainPrompt,
  buildFinalMainSystemPrompt,
  buildMainDraftPrompt,
  buildMainDraftSystemPrompt,
  buildMainSummaryPrompt,
  buildMainSummarySystemPrompt,
  buildReviewAgentPrompt,
  buildReviewAgentSystemPrompt,
  extractMainExecutionOutput,
  parseMainUserSummary,
  buildSingleAgentSystemPrompt,
  parseMainDelegationPlan,
  stripSubagentRoutingSyntax
} from "../prompts/codeAgentPrompts";
import { buildTextPrompt } from "../prompts/common";
import { FsmEngine } from "../workflows/FsmEngine";
import { AgentNodeExecutor } from "../workflows/nodes/AgentNodeExecutor";
import { EntryNodeExecutor } from "../workflows/nodes/EntryNodeExecutor";
import { HumanReviewNodeExecutor } from "../workflows/nodes/HumanReviewNodeExecutor";
import { NodeExecutorRegistry } from "../workflows/nodes/NodeExecutor";
import { TerminalNodeExecutor } from "../workflows/nodes/TerminalNodeExecutor";
import { WorkflowRunner } from "../workflows/WorkflowRunner";
import { WorkflowRunStore } from "../workflows/WorkflowRunStore";
import { WorkflowStore } from "../workflows/WorkflowStore";

export interface AppRuntime {
  engine: CognitiveEngine;
  providerDescriptors: ProviderDescriptor[];
  tools: ToolDescriptor[];
  plugins: LoadedPlugin[];
  formatter: ResponseFormatter;
  sessionSettingsStore: SessionSettingsStore;
  modelCatalog: ModelCatalogService;
  llmService: LLMService;
  lmStudioManager: LMStudioManager;
  ollamaManager: OllamaModelManager;
  localModelManager: LocalModelManagerRegistry;
  taskStore: TaskStore;
  taskService: TaskService;
  workflowStore: WorkflowStore;
  workflowRunStore: WorkflowRunStore;
  workflowRunner: WorkflowRunner;
  memoryService: MemoryService;
  config: AppConfig;
}

const sumUsage = (
  usages: Array<{
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } | undefined>
) => ({
  inputTokens: usages.reduce((sum, usage) => sum + (usage?.inputTokens ?? 0), 0) || undefined,
  outputTokens: usages.reduce((sum, usage) => sum + (usage?.outputTokens ?? 0), 0) || undefined,
  totalTokens: usages.reduce((sum, usage) => sum + (usage?.totalTokens ?? 0), 0) || undefined
});

const isDegradedResponse = (response: LLMResponse): boolean =>
  Boolean(response.error) || /^Mock response from /i.test(response.text.trim());

const AGENT_LOCAL_TIMEOUT_MS = 300000;
const AGENT_REMOTE_TIMEOUT_MS = 180000;

const agentRequestTimeoutMs = (providerId: string): number =>
  ["lmstudio", "ollama"].includes(providerId) ? AGENT_LOCAL_TIMEOUT_MS : AGENT_REMOTE_TIMEOUT_MS;

const summarizeSubagentRun = (
  run: Awaited<ReturnType<typeof runCodeAgent>>,
  role: "writer" | "advisor"
): SubagentRunSummary => ({
  id: run.agent.id,
  name: run.agent.name,
  role,
  provider: run.response.provider,
  model: run.response.model,
  accessMode: run.agent.accessMode,
  status: run.degraded ? "degraded" : "ok",
  error: run.response.error,
  output: run.degraded ? undefined : run.normalized
});

const runCodeAgent = async (
  agent: CodeAgentTarget,
  prompt: string,
  llmService: LLMService,
  languageEnforcer: LanguageEnforcer,
  language: "auto" | "ru" | "en",
  systemPrompt: string,
  signal?: AbortSignal
) => {
  try {
    const response = await llmService.generateText(
      {
        model: agent.model,
        systemPrompt,
        prompt,
        timeoutMs: agentRequestTimeoutMs(agent.providerId),
        signal
      },
      agent.providerId
    );

    const normalized = await languageEnforcer.normalizeText(response.text, language, {
      providerId: agent.providerId,
      model: agent.model
    });

    return {
      agent,
      response,
      normalized,
      degraded: isDegradedResponse(response)
    };
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "unknown_error";

    return {
      agent,
      response: {
        provider: agent.providerId,
        model: agent.model ?? "default",
        text: `Provider request failed or timed out for @${agent.name}.`,
        error: message
      } satisfies LLMResponse,
      normalized: `Provider request failed or timed out for @${agent.name}: ${message}`,
      degraded: true
    };
  }
};

const runCodeSwarm = async (
  input: string,
  context: ExecutionContext,
  llmService: LLMService,
  languageEnforcer: LanguageEnforcer
) => {
  const memorySummary =
    context.memory.map((entry) => `- ${entry.input.slice(0, 120)}`).join("\n") ||
    "- No relevant memory found.";
  const attachmentContext = renderAttachmentContext(readAttachments(context.requestMetadata));
  const taskInput = stripSubagentRoutingSyntax(input);
  const mainAgent = {
    id: "main-model",
    name: "Main model",
    providerId: context.activeTarget.providerId,
    model: context.activeTarget.model,
    accessMode: context.sessionSettings.defaultAccessMode
  } satisfies CodeAgentTarget;
  const reviewAgents =
    context.sessionSettings.codeAgents.length > 0
      ? selectConfiguredSubagents(input, context.sessionSettings.codeAgents.slice(0, 4))
      : [];

  context.onProgress?.({
    phase: "planning",
    label: "Planning",
    detail: reviewAgents.length ? `Preparing work for ${reviewAgents.length} delegated agent${reviewAgents.length === 1 ? "" : "s"}` : "Preparing main-model response",
    at: new Date().toISOString()
  });

  if (reviewAgents.length === 0) {
    const mainRun = await runCodeAgent(
      mainAgent,
      buildTextPrompt(
        "code",
        taskInput,
        memorySummary,
        context.sessionSettings.language,
        context.sessionSettings.outputStyle,
        attachmentContext
      ),
      llmService,
      languageEnforcer,
      context.sessionSettings.language,
      buildSingleAgentSystemPrompt(
        mainAgent,
        input,
        taskInput,
        context.sessionSettings.outputStyle
      ),
      context.signal
    );

    return {
      response: mainRun.normalized,
      provider: mainRun.response.provider,
      model: mainRun.response.model,
      metrics: {
        startedAt: new Date(0).toISOString(),
        completedAt: new Date(0).toISOString(),
        durationMs: 0,
        usage: sumUsage([mainRun.response.usage])
      }
    };
  }

  const draftRun = await runCodeAgent(
    mainAgent,
    buildMainDraftPrompt(
      taskInput,
      memorySummary,
      context.sessionSettings.language,
      context.sessionSettings.outputStyle,
      attachmentContext,
      reviewAgents
    ),
    llmService,
    languageEnforcer,
    context.sessionSettings.language,
    buildMainDraftSystemPrompt(
      mainAgent,
      reviewAgents,
      context.sessionSettings.outputStyle
    ),
    context.signal
  );
  context.onProgress?.({
    phase: "delegation",
    label: "Delegating",
    detail: `Main draft ready; assigning ${reviewAgents.length} agent task${reviewAgents.length === 1 ? "" : "s"}`,
    at: new Date().toISOString()
  });
  const delegationPlan = parseMainDelegationPlan(draftRun.normalized, reviewAgents);
  context.onProgress?.({
    phase: "agents",
    label: "Running agents",
    detail: `Waiting for ${reviewAgents.map((agent) => `@${agent.name}`).join(", ")}`,
    completed: 0,
    total: reviewAgents.length,
    at: new Date().toISOString()
  });
  const reviewRuns = await Promise.all(
    reviewAgents.map((agent) => {
      const assignment = delegationPlan.assignments.get(agent.id);

      if (!assignment) {
        const error = "The main model did not produce a valid assignment for this agent.";

        return Promise.resolve({
          agent,
          response: {
            provider: agent.providerId,
            model: agent.model ?? "default",
            text: error,
            error,
            usage: undefined
          } satisfies LLMResponse,
          normalized: error,
          degraded: true
        });
      }

      return runCodeAgent(
        agent,
        buildReviewAgentPrompt(
          input,
          taskInput,
          assignment,
          delegationPlan.draft,
          memorySummary,
          context.sessionSettings.language,
          context.sessionSettings.outputStyle,
          attachmentContext,
          reviewAgents
        ),
        llmService,
        languageEnforcer,
        context.sessionSettings.language,
        buildReviewAgentSystemPrompt(
          agent,
          reviewAgents,
          context.sessionSettings.outputStyle
        ),
        context.signal
      );
    })
  );
  context.onProgress?.({
    phase: "agents-complete",
    label: "Agents complete",
    detail: `${reviewRuns.filter((item) => !item.degraded).length}/${reviewRuns.length} delegated results available`,
    completed: reviewRuns.filter((item) => !item.degraded).length,
    total: reviewRuns.length,
    at: new Date().toISOString()
  });
  context.onProgress?.({
    phase: "synthesis",
    label: "Synthesizing",
    detail: "Main model is validating agent results and preparing the final implementation",
    at: new Date().toISOString()
  });
  const finalRun = await runCodeAgent(
    mainAgent,
    buildFinalMainPrompt(
      input,
      taskInput,
      delegationPlan.draft,
      memorySummary,
      context.sessionSettings.language,
      context.sessionSettings.outputStyle,
      attachmentContext,
      reviewRuns.map((item) => ({
        agent: item.agent,
        normalized: item.normalized,
        degraded: item.degraded
      }))
    ),
    llmService,
    languageEnforcer,
    context.sessionSettings.language,
    buildFinalMainSystemPrompt(
      mainAgent,
      reviewAgents,
      context.sessionSettings.outputStyle
    ),
    context.signal
  );
  const executionRun = !finalRun.degraded || draftRun.degraded ? finalRun : draftRun;
  const executionOutput = extractMainExecutionOutput(
    executionRun.normalized,
    delegationPlan.draft
  );
  const summaryRun = await runCodeAgent(
    mainAgent,
    buildMainSummaryPrompt(
      taskInput,
      executionOutput,
      reviewRuns.map((item) => ({ agent: item.agent, degraded: item.degraded })),
      context.sessionSettings.language
    ),
    llmService,
    languageEnforcer,
    "auto",
    buildMainSummarySystemPrompt(),
    context.signal
  );
  context.onProgress?.({
    phase: "finalizing",
    label: "Finalizing",
    detail: "Preparing the user-facing summary and file actions",
    at: new Date().toISOString()
  });
  const fallbackSummary = /[А-Яа-яЁё]/.test(taskInput)
    ? "Основная модель завершила задачу и обработала результаты делегированных проверок. Детали изменений показаны в блоке файловой операции выше."
    : "The main model completed the task and processed the delegated results. Review the file operation above for the concrete changes.";
  const userSummary = parseMainUserSummary(summaryRun.normalized) ?? fallbackSummary;

  return {
    response: userSummary,
    toolPayload: executionOutput,
    provider: summaryRun.response.provider,
    model: summaryRun.response.model,
    subagents: reviewRuns.map((item) => summarizeSubagentRun(item, "advisor")),
    metrics: {
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(0).toISOString(),
      durationMs: 0,
      usage: sumUsage([
        draftRun.response.usage,
        finalRun.response.usage,
        summaryRun.response.usage,
        ...reviewRuns.map((item) => item.response.usage)
      ])
    }
  };
};

export const buildRuntime = async (
  config: AppConfig,
  logger: Logger
): Promise<AppRuntime> => {
  await fs.mkdir(config.memory.baseDir, { recursive: true });
  await fs.mkdir(config.sessions.baseDir, { recursive: true });
  await fs.mkdir(config.outputDir, { recursive: true });
  await fs.mkdir(path.join(config.appDataDir, "tasks"), { recursive: true });
  await fs.mkdir(path.join(config.appDataDir, "workflows"), { recursive: true });

  const providerRegistry = new LLMRegistry();
  providerRegistry.register(new OllamaProvider(config.providers.ollama, logger));
  providerRegistry.register(
    new OpenAICompatibleProvider(
      {
        id: "lmstudio",
        name: "LM Studio",
        ...config.providers.lmstudio
      },
      logger
    )
  );
  providerRegistry.register(
    new OpenAICompatibleProvider(
      {
        id: "openai",
        name: "OpenAI",
        ...config.providers.openai
      },
      logger
    )
  );
  providerRegistry.register(new AnthropicProvider(config.providers.anthropic, logger));
  providerRegistry.register(new GeminiProvider(config.providers.gemini, logger));

  const llmService = new LLMService(
    providerRegistry,
    config.llm.defaultProvider,
    logger,
    new OutputSanitizer()
  );
  const languageEnforcer = new LanguageEnforcer(llmService);
  const modelCatalog = new ModelCatalogService(providerRegistry);
  const lmStudioManager = new LMStudioManager({
    baseUrl: config.providers.lmstudio.baseUrl,
    apiKey: config.providers.lmstudio.apiKey,
    timeoutMs: config.providers.lmstudio.timeoutMs
  });
  const ollamaManager = new OllamaModelManager({
    baseUrl: config.providers.ollama.baseUrl,
    timeoutMs: config.providers.ollama.timeoutMs
  });
  const localModelManager = new LocalModelManagerRegistry([
    lmStudioManager,
    ollamaManager
  ]);
  const memoryAdapter = await createMemoryAdapter(config, logger);
  const memoryService = new MemoryService(memoryAdapter);
  const taskStore = new TaskStore(path.join(config.appDataDir, "tasks"));
  const workflowStore = new WorkflowStore(path.join(config.appDataDir, "workflows"));
  const workflowRunStore = new WorkflowRunStore(path.join(config.appDataDir, "workflows"));
  const sessionSettingsStore = new SessionSettingsStore(config.sessions, {
    providerId: config.llm.defaultProvider,
    model: resolveDefaultModel(config, config.llm.defaultProvider)
  }, {
    ollama: config.providers.ollama.model,
    lmstudio: config.providers.lmstudio.model,
    openai: config.providers.openai.model,
    anthropic: config.providers.anthropic.model,
    gemini: config.providers.gemini.model
  });
  const modeDetector = new ModeDetector();
  const judge = new Judge(llmService, languageEnforcer);
  const supportAgent = new SupportAgent(llmService, languageEnforcer);
  const attackAgent = new AttackAgent(llmService, languageEnforcer);
  const hypothesisAdvisorAgent = new HypothesisAdvisorAgent(llmService, languageEnforcer);
  const hypothesisAgent = new HypothesisAgent(
    supportAgent,
    attackAgent,
    hypothesisAdvisorAgent,
    judge
  );
  const router = new Router();

  router.register("hypothesis", async (input, context) => {
    context.onProgress?.({ phase: "debate", label: "Debating", detail: "Running hypothesis participants", at: new Date().toISOString() });
    const debateConfig = context.sessionSettings.debate.enabled
      ? context.sessionSettings.debate
      : {
          enabled: false,
          profile: "general" as const,
          support: { ...context.activeTarget },
          attack: { ...context.activeTarget },
          judge: { providerId: "local" }
        };

    return hypothesisAgent.runDebate(
      input,
      debateConfig,
      context.sessionSettings.language,
      context.sessionSettings.outputStyle,
      renderAttachmentContext(readAttachments(context.requestMetadata)),
      context.sessionSettings.hypothesisAgents.filter((agent) => agent.role === "advisor"),
      context.signal
    );
  });

  router.register("code", async (input, context) => {
    return runCodeSwarm(input, context, llmService, languageEnforcer);
  });

  router.register("general", async (input, context) => {
    context.onProgress?.({ phase: "generating", label: "Generating", detail: "Main model is preparing a response", at: new Date().toISOString() });
    const response = await llmService.generateText(
      {
        model: context.activeTarget.model,
        prompt: buildTextPrompt(
          "general",
          input,
          context.memory.map((entry) => `- ${entry.input.slice(0, 120)}`).join("\n") ||
            "- No relevant memory found.",
          context.sessionSettings.language,
          context.sessionSettings.outputStyle,
          renderAttachmentContext(readAttachments(context.requestMetadata))
        ),
        signal: context.signal
      },
      context.providerId
    );
    const normalized = await languageEnforcer.normalizeText(
      response.text,
      context.sessionSettings.language,
      context.activeTarget
    );

    return {
      response: normalized,
      provider: response.provider,
      model: response.model,
      metrics: {
        startedAt: new Date(0).toISOString(),
        completedAt: new Date(0).toISOString(),
        durationMs: 0,
        usage: response.usage
      }
    };
  });

  const toolRegistry = new ToolRegistry();
  toolRegistry.register(
    new FileTool({
      outputDir: config.outputDir,
      accessMode: config.filesystem.accessMode,
      allowedDirectories: config.filesystem.allowedDirectories
    })
  );

  const pluginLoader = new PluginLoader(
    config.plugins.dir,
    {
      config,
      logger,
      toolRegistry
    },
    logger
  );
  const plugins = await pluginLoader.loadAll();

  const engine = new CognitiveEngine(
    modeDetector,
    router,
    memoryService,
    sessionSettingsStore,
    toolRegistry,
    new ToolRequestBuilder(),
    logger,
    config.llm.defaultProvider
  );
  const workflowRunner = new WorkflowRunner(
    taskStore,
    workflowStore,
    workflowRunStore,
    new FsmEngine(),
    new NodeExecutorRegistry([
      new EntryNodeExecutor(),
      new AgentNodeExecutor(engine, {
        ollama: config.providers.ollama.model,
        lmstudio: config.providers.lmstudio.model,
        openai: config.providers.openai.model,
        anthropic: config.providers.anthropic.model,
        gemini: config.providers.gemini.model
      }),
      new HumanReviewNodeExecutor(),
      new TerminalNodeExecutor()
    ])
  );
  const taskService = new TaskService(taskStore, workflowRunStore, workflowRunner);

  return {
    engine,
    providerDescriptors: providerRegistry.list(),
    tools: toolRegistry.list(),
    plugins,
    formatter: new ResponseFormatter(),
    sessionSettingsStore,
    modelCatalog,
    llmService,
    lmStudioManager,
    ollamaManager,
    localModelManager,
    taskStore,
    taskService,
    workflowStore,
    workflowRunStore,
    workflowRunner,
    memoryService,
    config
  };
};

const resolveDefaultModel = (config: AppConfig, providerId: string): string | undefined => {
  switch (providerId) {
    case "ollama":
      return config.providers.ollama.model;
    case "lmstudio":
      return config.providers.lmstudio.model;
    case "openai":
      return config.providers.openai.model;
    case "anthropic":
      return config.providers.anthropic.model;
    case "gemini":
      return config.providers.gemini.model;
    default:
      return undefined;
  }
};

const createMemoryAdapter = async (
  config: AppConfig,
  logger: Logger
): Promise<MemoryAdapter> => {
  const vectorStore = new VectorStore();

  if (config.memory.adapter === "openmemory" || config.memory.openMemory.enabled) {
    return new OpenMemoryAdapter(
      {
        dbPath: config.memory.openMemory.dbPath
      },
      logger
    );
  }

  return new LocalJsonMemoryAdapter(
    {
      baseDir: config.memory.baseDir,
      topK: config.memory.topK
    },
    vectorStore,
    logger
  );
};
