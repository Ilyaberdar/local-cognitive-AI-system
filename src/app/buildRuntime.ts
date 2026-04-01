import fs from "fs/promises";
import { AttackAgent } from "../agents/AttackAgent";
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
import { LMStudioManager } from "../llm/LMStudioManager";
import { LanguageEnforcer } from "../llm/LanguageEnforcer";
import { LLMService } from "../llm/LLMService";
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
import { ToolRegistry } from "../tools/ToolRegistry";
import {
  CodeAgentTarget,
  ExecutionContext,
  LLMResponse,
  ProviderDescriptor,
  ToolDescriptor
} from "../types";
import { Logger } from "../utils/Logger";
import { ModelCatalogService } from "../llm/ModelCatalogService";

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
  memoryService: MemoryService;
  config: AppConfig;
}

const buildLanguageInstruction = (language: "auto" | "ru" | "en"): string => {
  switch (language) {
    case "ru":
      return [
        "Respond only in Russian.",
        "Every sentence in the final answer must be in Russian.",
        "Do not switch to English except for product names, model ids, or technical proper nouns."
      ].join(" ");
    case "en":
      return [
        "Respond only in English.",
        "Every sentence in the final answer must be in English.",
        "Do not switch to Russian except for quoted user text or proper nouns."
      ].join(" ");
    default:
      return "Respond in the user's language unless asked otherwise.";
  }
};

const wantsFilesystemScaffold = (input: string): boolean =>
  /(?:create|build|make).*(?:project|app|api|service|bot|scaffold|files)|создай.*(?:проект|приложение|api|сервис|бот|структур)/i.test(
    input
  );

const wantsSingleFileWrite = (input: string): boolean =>
  /(?:write|save|overwrite|update|edit|rewrite|append).*(?:file)|(?:запиши|сохрани|перепиши|обнови|измени|добавь|допиши).*(?:файл)/i.test(
    input
  );

const buildFilesystemInstruction = (input: string): string =>
  wantsFilesystemScaffold(input)
    ? [
        "The user wants real files or a project scaffold.",
        "Return one or more file blocks using this exact format and nothing else outside those blocks for file contents:",
        "<<<FILE:relative/path.ext>>>",
        "file content",
        "<<<END FILE>>>",
        "Use relative paths only.",
        "Include all required files for a minimal working scaffold."
      ].join("\n")
    : wantsSingleFileWrite(input)
      ? [
          "The user wants a real file to be written or updated.",
          "Return only the exact file content that should be written.",
          "Do not add explanations, markdown fences, or commentary.",
          "Do not include file markers unless the user explicitly requests multiple files."
        ].join("\n")
    : "";

const buildTextPrompt = (
  mode: "code" | "general",
  input: string,
  memory: string,
  language: "auto" | "ru" | "en"
): string =>
  [
    `Mode: ${mode}`,
    "Relevant memory:",
    memory,
    "",
    `User input: ${input}`,
    "",
    buildLanguageInstruction(language),
    ...(buildFilesystemInstruction(input) ? ["", buildFilesystemInstruction(input)] : []),
    "",
    "Respond concisely. Prefer practical steps over theory."
  ].join("\n");

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

const buildCodeAdvisorPrompt = (
  input: string,
  memory: string,
  language: "auto" | "ru" | "en"
): string =>
  [
    "Mode: code",
    "Relevant memory:",
    memory,
    "",
    `User input: ${input}`,
    "",
    buildLanguageInstruction(language),
    "",
    "You are one of several advisor agents.",
    "Do not emit file blocks, final file contents, markdown fences, or full project scaffolds.",
    "Return only concise implementation guidance: architecture, file plan, risks, and concrete suggestions."
  ].join("\n");

const buildCodeWriterPrompt = (
  input: string,
  memory: string,
  language: "auto" | "ru" | "en",
  advisorRuns: Array<{ agent: CodeAgentTarget; normalized: string; degraded: boolean }>
): string => {
  const healthyAdvisorNotes = advisorRuns
    .filter((item) => !item.degraded)
    .map((item) => [`${item.agent.name}:`, item.normalized].join("\n"))
    .join("\n\n");
  const degradedAdvisorNames = advisorRuns
    .filter((item) => item.degraded)
    .map((item) => item.agent.name);

  return [
    buildTextPrompt("code", input, memory, language),
    "",
    "Advisor notes from other coding agents:",
    healthyAdvisorNotes || "No reliable advisor notes were available.",
    ...(degradedAdvisorNames.length
      ? [
          "",
          `Unavailable advisors: ${degradedAdvisorNames.join(", ")}. Ignore any missing advisor output and continue.`
        ]
      : []),
    "",
    "You are the final writer for this code swarm.",
    "Produce one final implementation-ready answer.",
    "If the user asked for file edits or project scaffolding, return only the final write-safe output in the requested format.",
    "Do not include per-agent headings, comparisons, or swarm commentary in the final output."
  ].join("\n");
};

const runCodeAgent = async (
  agent: CodeAgentTarget,
  prompt: string,
  llmService: LLMService,
  languageEnforcer: LanguageEnforcer,
  language: "auto" | "ru" | "en",
  systemPrompt: string
) => {
  const response = await llmService.generateText(
    {
      model: agent.model,
      systemPrompt,
      prompt
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
  const configuredAgents =
    context.sessionSettings.codeAgents.length > 0
      ? context.sessionSettings.codeAgents.slice(0, 5)
      : [
          {
            id: "agent-1",
            name: "Agent1",
            providerId: context.activeTarget.providerId,
            model: context.activeTarget.model
          } satisfies CodeAgentTarget
        ];

  if (configuredAgents.length === 1) {
    const writerRun = await runCodeAgent(
      configuredAgents[0],
      buildTextPrompt("code", input, memorySummary, context.sessionSettings.language),
      llmService,
      languageEnforcer,
      context.sessionSettings.language,
      [
        `You are ${configuredAgents[0].name}, a focused coding agent.`,
        "Provide a practical implementation-oriented answer.",
        "Be concise, concrete, and useful for project execution."
      ].join("\n")
    );

    return {
      response: writerRun.normalized,
      provider: writerRun.response.provider,
      model: writerRun.response.model,
      metrics: {
        startedAt: new Date(0).toISOString(),
        completedAt: new Date(0).toISOString(),
        durationMs: 0,
        usage: writerRun.response.usage
      }
    };
  }

  const writerAgent = configuredAgents[0];
  const advisorAgents = configuredAgents.slice(1);
  const advisorRuns = await Promise.all(
    advisorAgents.map((agent) =>
      runCodeAgent(
        agent,
        buildCodeAdvisorPrompt(input, memorySummary, context.sessionSettings.language),
        llmService,
        languageEnforcer,
        context.sessionSettings.language,
        [
          `You are ${agent.name}, an advisor in a multi-agent code swarm.`,
          "Provide concise implementation guidance only.",
          "Do not produce final deliverable files or scaffolds."
        ].join("\n")
      )
    )
  );
  const writerRun = await runCodeAgent(
    writerAgent,
    buildCodeWriterPrompt(
      input,
      memorySummary,
      context.sessionSettings.language,
      advisorRuns.map((item) => ({
        agent: item.agent,
        normalized: item.normalized,
        degraded: item.degraded
      }))
    ),
    llmService,
    languageEnforcer,
    context.sessionSettings.language,
    [
      `You are ${writerAgent.name}, the final writer in a multi-agent code swarm.`,
      "Synthesize advisor guidance into one implementation-ready answer.",
      "When file output is requested, produce only the final write-safe output."
    ].join("\n")
  );
  const firstHealthyAdvisor = advisorRuns.find((item) => !item.degraded);
  const chosenRun =
    !writerRun.degraded || !firstHealthyAdvisor ? writerRun : firstHealthyAdvisor;

  return {
    response: chosenRun.normalized,
    provider: chosenRun.response.provider,
    model: chosenRun.response.model,
    metrics: {
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(0).toISOString(),
      durationMs: 0,
      usage: sumUsage([writerRun.response.usage, ...advisorRuns.map((item) => item.response.usage)])
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
  const memoryAdapter = await createMemoryAdapter(config, logger);
  const memoryService = new MemoryService(memoryAdapter);
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

    return hypothesisAgent.runDebate(input, debateConfig, context.sessionSettings.language);
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
          context.sessionSettings.language
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
