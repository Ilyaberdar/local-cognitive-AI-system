import fs from "fs/promises";
import path from "path";
import { AttackAgent } from "../agents/AttackAgent";
import {
  hasSubagentTrigger,
  parseMentionedSubagentNames,
  selectConfiguredSubagents
} from "../agents/code/codeAgentRouting";
import { HypothesisAgent } from "../agents/HypothesisAgent";
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
  buildCodeWriterPrompt,
  buildCollectorSystemPrompt,
  buildFallbackCollectorSystemPrompt,
  buildFallbackSingleAgentSystemPrompt,
  buildIndependentAgentPrompt,
  buildIndependentAgentSystemPrompt,
  buildSingleAgentSystemPrompt,
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
) => {
  try {
    const response = await llmService.generateText(
      {
        model: agent.model,
        systemPrompt,
        prompt,
        timeoutMs: agentRequestTimeoutMs(agent.providerId)
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
  const fallbackAgent = {
    id: "default-agent",
    name: "Default",
    providerId: context.activeTarget.providerId,
    model: context.activeTarget.model,
    accessMode: context.sessionSettings.defaultAccessMode
  } satisfies CodeAgentTarget;
  const configuredAgents =
    context.sessionSettings.codeAgents.length > 0
      ? selectConfiguredSubagents(input, context.sessionSettings.codeAgents.slice(0, 4))
      : hasSubagentTrigger(input) || parseMentionedSubagentNames(input).length > 0
        ? [fallbackAgent]
        : [];
  const activeAgents = configuredAgents.length > 0 ? configuredAgents : [fallbackAgent];

  if (activeAgents.length === 1) {
    const writerRun = await runCodeAgent(
      activeAgents[0],
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
        activeAgents[0],
        input,
        taskInput,
        context.sessionSettings.outputStyle
      )
    );
    const finalRun =
      writerRun.degraded && activeAgents[0].id !== fallbackAgent.id
        ? await runCodeAgent(
            fallbackAgent,
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
            buildFallbackSingleAgentSystemPrompt(
              fallbackAgent,
              input,
              taskInput,
              context.sessionSettings.outputStyle
            )
          )
        : writerRun;
    const fallbackUsed = finalRun !== writerRun;

    return {
      response: finalRun.normalized,
      provider: finalRun.response.provider,
      model: finalRun.response.model,
      subagents: fallbackUsed
        ? [
            summarizeSubagentRun(finalRun, "writer"),
            summarizeSubagentRun(writerRun, "advisor")
          ]
        : [summarizeSubagentRun(writerRun, "writer")],
      metrics: {
        startedAt: new Date(0).toISOString(),
        completedAt: new Date(0).toISOString(),
        durationMs: 0,
        usage: sumUsage([writerRun.response.usage, fallbackUsed ? finalRun.response.usage : undefined])
      }
    };
  }

  const collectorAgent = activeAgents[0];
  const independentRuns = await Promise.all(
    activeAgents.map((agent) =>
      runCodeAgent(
        agent,
        buildIndependentAgentPrompt(
          input,
          taskInput,
          memorySummary,
          context.sessionSettings.language,
          context.sessionSettings.outputStyle,
          attachmentContext,
          activeAgents
        ),
        llmService,
        languageEnforcer,
        context.sessionSettings.language,
        buildIndependentAgentSystemPrompt(
          agent,
          activeAgents,
          context.sessionSettings.outputStyle
        )
      )
    )
  );
  const writerRun = await runCodeAgent(
    collectorAgent,
    buildCodeWriterPrompt(
      input,
      taskInput,
      memorySummary,
      context.sessionSettings.language,
      context.sessionSettings.outputStyle,
      attachmentContext,
      independentRuns.map((item) => ({
        agent: item.agent,
        normalized: item.normalized,
        degraded: item.degraded
      }))
    ),
    llmService,
    languageEnforcer,
    context.sessionSettings.language,
    buildCollectorSystemPrompt(
      collectorAgent,
      activeAgents,
      context.sessionSettings.outputStyle
    )
  );
  const firstHealthyAdvisor = independentRuns.find((item) => !item.degraded);
  const fallbackWriterRun =
    writerRun.degraded && !firstHealthyAdvisor && collectorAgent.id !== fallbackAgent.id
      ? await runCodeAgent(
          fallbackAgent,
          buildCodeWriterPrompt(
            input,
            taskInput,
            memorySummary,
            context.sessionSettings.language,
            context.sessionSettings.outputStyle,
            attachmentContext,
            independentRuns.map((item) => ({
              agent: item.agent,
              normalized: item.normalized,
              degraded: item.degraded
            }))
          ),
          llmService,
          languageEnforcer,
          context.sessionSettings.language,
          buildFallbackCollectorSystemPrompt(
            fallbackAgent,
            activeAgents,
            context.sessionSettings.outputStyle
          )
        )
      : undefined;
  const chosenRun = fallbackWriterRun ?? (!writerRun.degraded || !firstHealthyAdvisor ? writerRun : firstHealthyAdvisor);
  const writerSummary = {
    ...summarizeSubagentRun(writerRun, "writer" as const),
    output: undefined
  };

  return {
    response: chosenRun.normalized,
    provider: chosenRun.response.provider,
    model: chosenRun.response.model,
    subagents: [
      ...(fallbackWriterRun ? [summarizeSubagentRun(fallbackWriterRun, "writer")] : [writerSummary]),
      ...(fallbackWriterRun ? [writerSummary] : []),
      ...independentRuns.map((item) => summarizeSubagentRun(item, "advisor"))
    ],
    metrics: {
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(0).toISOString(),
      durationMs: 0,
      usage: sumUsage([
        writerRun.response.usage,
        fallbackWriterRun?.response.usage,
        ...independentRuns.map((item) => item.response.usage)
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
  const hypothesisAgent = new HypothesisAgent(supportAgent, attackAgent, judge);
  const router = new Router();

  router.register("hypothesis", async (input, context) => {
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
      renderAttachmentContext(readAttachments(context.requestMetadata))
    );
  });

  router.register("code", async (input, context) => {
    return runCodeSwarm(input, context, llmService, languageEnforcer);
  });

  router.register("general", async (input, context) => {
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
        )
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
