import fs from "fs/promises";
import path from "path";
import { AttackAgent } from "../agents/AttackAgent";
import { selectConfiguredSubagents } from "../agents/code/codeAgentRouting";
import { HypothesisAgent } from "../agents/HypothesisAgent";
import { HypothesisAdvisorAgent } from "../agents/HypothesisAdvisorAgent";
import { SupportAgent } from "../agents/SupportAgent";
import { AppConfig } from "../config/config";
import { AgentProgressReporter } from "../core/AgentProgressReporter";
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
import { WorldPartitionMemoryAdapter } from "../memory/WorldPartitionMemoryAdapter";
import { PluginLoader } from "../plugins/PluginLoader";
import { LoadedPlugin } from "../plugins/types";
import { SessionSettingsStore } from "../session/SessionSettingsStore";
import { FileTool } from "../tools/FileTool";
import { ToolRegistry } from "../tools/ToolRegistry";
import { TaskService } from "../tasks/TaskService";
import { TaskStore } from "../tasks/TaskStore";
import { ScheduleService } from "../schedules/ScheduleService";
import { ScheduleStore } from "../schedules/ScheduleStore";
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
import { CommandNodeExecutor } from "../workflows/nodes/CommandNodeExecutor";
import { DecisionNodeExecutor } from "../workflows/nodes/DecisionNodeExecutor";
import { FileSearchNodeExecutor } from "../workflows/nodes/FileSearchNodeExecutor";
import { NodeExecutorRegistry } from "../workflows/nodes/NodeExecutor";
import { SaveFileNodeExecutor } from "../workflows/nodes/SaveFileNodeExecutor";
import { TerminalNodeExecutor } from "../workflows/nodes/TerminalNodeExecutor";
import { WebSearchNodeExecutor } from "../workflows/nodes/WebSearchNodeExecutor";
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
  scheduleStore: ScheduleStore;
  scheduleService: ScheduleService;
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
  Boolean(response.error) || !response.text.trim() || /^Mock response from /i.test(response.text.trim());

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
    signal?.throwIfAborted();
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

    const degraded = isDegradedResponse(response);
    const normalized = degraded
      ? `Provider request failed for @${agent.name}: ${response.error || "The model returned no usable output."}`
      : /<<<|```/.test(response.text)
        ? response.text
        : await languageEnforcer.normalizeText(response.text, language, {
            providerId: agent.providerId,
            model: agent.model
          }, signal);
    signal?.throwIfAborted();

    return {
      agent,
      response,
      normalized,
      degraded
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

  const progress = new AgentProgressReporter(
    [mainAgent, ...reviewAgents].map((agent) => ({
      id: agent.id, name: agent.name, role: agent === mainAgent ? "main" : "advisor",
      provider: agent.providerId, model: agent.model, status: "queued", phase: "Waiting"
    })), context.onProgress
  );
  progress.update(mainAgent.id, "running", "Planning");

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

    progress.update(mainAgent.id, mainRun.degraded ? "degraded" : "completed", mainRun.degraded ? "Failed" : "Complete", mainRun.response.error);
    return {
      error: mainRun.degraded ? mainRun.response.error || "The model returned no usable output." : undefined,
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
  const delegationPlan = parseMainDelegationPlan(draftRun.degraded ? "" : draftRun.normalized, reviewAgents);
  progress.update(mainAgent.id, "queued", "Waiting for agents");
  const reviewRuns = await Promise.all(
    reviewAgents.map(async (agent) => {
      const assignment = delegationPlan.assignments.get(agent.id);

      if (!assignment) {
        const error = "The main model did not produce a valid assignment for this agent.";

        progress.update(agent.id, "degraded", "No assignment", error);
        return {
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
        };
      }

      progress.update(agent.id, "running", "Working");
      const run = await runCodeAgent(
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
      progress.update(agent.id, run.degraded ? "degraded" : "completed", run.degraded ? "Failed" : "Complete", run.response.error);
      return run;
    })
  );
  context.signal?.throwIfAborted();
  progress.update(mainAgent.id, "running", "Synthesizing");
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
  if (finalRun.degraded) {
    const error = finalRun.response.error || "The main model returned no usable final output.";
    progress.update(mainAgent.id, "degraded", "Failed", error);
    return {
      error,
      response: [finalRun.normalized, ...(!draftRun.degraded ? ["Available draft (final synthesis failed):", delegationPlan.draft] : [])].join("\n\n"),
      provider: finalRun.response.provider,
      model: finalRun.response.model,
      subagents: reviewRuns.map((item) => summarizeSubagentRun(item, "advisor"))
    };
  }
  const executionOutput = extractMainExecutionOutput(finalRun.normalized, delegationPlan.draft);
  const hasFilePayload = /<<<FILE:[^>]+>>>[\s\S]*?<<<END FILE>>>/.test(executionOutput);
  let summaryRun: Awaited<ReturnType<typeof runCodeAgent>> | undefined;
  let userResponse = executionOutput;
  if (hasFilePayload) {
    progress.update(mainAgent.id, "running", "Preparing summary");
    summaryRun = await runCodeAgent(
      mainAgent,
      buildMainSummaryPrompt(taskInput, executionOutput,
        reviewRuns.map((item) => ({ agent: item.agent, degraded: item.degraded })),
        context.sessionSettings.language),
      llmService, languageEnforcer, "auto", buildMainSummarySystemPrompt(), context.signal
    );
    const fallback = /[А-Яа-яЁё]/.test(taskInput)
      ? "Модель подготовила изменения файлов. Результат применения или запрос подтверждения показан в блоке файловой операции."
      : "The model prepared file changes. The file operation reports whether they were applied or need approval.";
    userResponse = !summaryRun.degraded ? parseMainUserSummary(summaryRun.normalized) || fallback : fallback;
  }
  progress.update(mainAgent.id, "completed", "Complete");

  return {
    response: userResponse,
    toolPayload: hasFilePayload ? executionOutput : undefined,
    provider: finalRun.response.provider,
    model: finalRun.response.model,
    subagents: reviewRuns.map((item) => summarizeSubagentRun(item, "advisor")),
    metrics: {
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(0).toISOString(),
      durationMs: 0,
      usage: sumUsage([
        draftRun.response.usage,
        finalRun.response.usage,
        summaryRun?.response.usage,
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
  await fs.mkdir(path.join(config.appDataDir, "schedules"), { recursive: true });
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
  const scheduleStore = new ScheduleStore(path.join(config.appDataDir, "schedules"));
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
      context.signal,
      context.onProgress
    );
  });

  router.register("code", async (input, context) => {
    return runCodeSwarm(input, context, llmService, languageEnforcer);
  });

  router.register("general", async (input, context) => {
    context.onProgress?.({ phase: "generating", label: "Generating", detail: "Main model is preparing a response", at: new Date().toISOString() });
    const progress = new AgentProgressReporter([{
      id: "main-model", name: "Main model", role: "main", provider: context.providerId,
      model: context.activeTarget.model, status: "queued", phase: "Waiting"
    }], context.onProgress);
    progress.update("main-model", "running", "Generating");
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
    const normalized = isDegradedResponse(response) ? response.text : await languageEnforcer.normalizeText(
      response.text,
      context.sessionSettings.language,
      context.activeTarget,
      context.signal
    );
    const error = isDegradedResponse(response) ? response.error || "The model returned no usable output." : undefined;
    progress.update("main-model", error ? "degraded" : "completed", error ? "Failed" : "Complete", error);

    return {
      error,
      response: error ? `Provider request failed: ${error}` : normalized,
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
      new FileSearchNodeExecutor({
        accessMode: config.filesystem.accessMode,
        allowedDirectories: config.filesystem.allowedDirectories,
        workspaceDir: process.cwd()
      }),
      new WebSearchNodeExecutor({
        braveApiKey: process.env.BRAVE_SEARCH_API_KEY,
        searxngUrl: process.env.SEARXNG_URL
      }),
      new SaveFileNodeExecutor({
        accessMode: config.filesystem.accessMode,
        allowedDirectories: config.filesystem.allowedDirectories,
        outputDir: config.outputDir
      }),
      new CommandNodeExecutor({
        accessMode: config.filesystem.accessMode,
        allowedDirectories: config.filesystem.allowedDirectories,
        workspaceDir: process.cwd()
      }),
      new DecisionNodeExecutor(),
      new HumanReviewNodeExecutor(),
      new TerminalNodeExecutor()
    ])
  );
  const taskService = new TaskService(taskStore, workflowRunStore, workflowRunner);
  const scheduleService = new ScheduleService(scheduleStore, taskService);

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
    scheduleStore,
    scheduleService,
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

  if (config.memory.adapter === "world-partition") {
    const adapter = new WorldPartitionMemoryAdapter(
      {
        baseDir: config.memory.baseDir,
        topK: config.memory.topK,
        ...config.memory.worldPartition
      },
      vectorStore,
      logger
    );
    await adapter.initialize();
    return adapter;
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
