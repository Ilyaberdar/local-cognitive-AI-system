// OpenAI-compatible services Local Cognitive knows: where each one lives, its regions, the models to
// suggest, and where its key comes from. A preset only fills in a provider's fields; the provider
// itself is data in the settings and is sent through its dialect.

export interface ProviderRegion {
  id: string;
  label: string;
  baseUrl: string;
}

export interface ProviderPreset {
  id: string;
  name: string;
  /** The dialect its requests are shaped by (see ProviderDialect). */
  dialect: string;
  baseUrl: string;
  regions?: ProviderRegion[];
  /** The default model, then the models suggested while the service's own list is unavailable. */
  model: string;
  models: string[];
  keyUrl: string;
  /** Environment variables a server reads it from (the first key name set wins). */
  env: { apiKey: string[]; baseUrl: string; model: string; timeoutMs: string };
  /** Present in every installation's settings, like OpenAI, rather than added by the user. */
  builtIn?: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [{
  id: "qwen",
  name: "Qwen (Alibaba Cloud)",
  dialect: "qwen",
  baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  // A key works only in the region it was created in; elsewhere the service answers 401.
  regions: [
    { id: "sg", label: "Singapore (international)", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
    { id: "us", label: "US (Virginia)", baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1" },
    { id: "hk", label: "Hong Kong", baseUrl: "https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1" },
    { id: "cn", label: "China (Beijing)", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }
  ],
  model: "qwen3.7-plus",
  models: ["qwen3.8-max", "qwen3.7-plus", "qwen3.8-flash", "qwen3.7-flash", "qwen3-coder-plus", "qwen3-coder-flash", "qwen3-vl-plus"],
  keyUrl: "https://home.qwencloud.com/api-keys",
  env: { apiKey: ["QWEN_API_KEY", "DASHSCOPE_API_KEY"], baseUrl: "QWEN_BASE_URL", model: "QWEN_MODEL", timeoutMs: "QWEN_TIMEOUT_MS" },
  builtIn: true
}, {
  id: "deepseek",
  name: "DeepSeek",
  dialect: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  models: ["deepseek-flash", "deepseek-v4-pro"],
  keyUrl: "https://platform.deepseek.com/api_keys",
  env: { apiKey: ["DEEPSEEK_API_KEY"], baseUrl: "DEEPSEEK_BASE_URL", model: "DEEPSEEK_MODEL", timeoutMs: "DEEPSEEK_TIMEOUT_MS" }
}, {
  id: "openrouter",
  name: "OpenRouter",
  dialect: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "openai/gpt-oss-120b",
  models: ["openai/gpt-oss-120b", "qwen/qwen3.8-flash", "deepseek/deepseek-v4.1-flash", "google/gemini-2.5-flash", "openai/gpt-5-mini"],
  keyUrl: "https://openrouter.ai/settings/keys",
  env: { apiKey: ["OPENROUTER_API_KEY"], baseUrl: "OPENROUTER_BASE_URL", model: "OPENROUTER_MODEL", timeoutMs: "OPENROUTER_TIMEOUT_MS" }
}, {
  id: "groq",
  name: "Groq",
  dialect: "groq",
  baseUrl: "https://api.groq.com/openai/v1",
  model: "openai/gpt-oss-120b",
  models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"],
  keyUrl: "https://console.groq.com/keys",
  env: { apiKey: ["GROQ_API_KEY"], baseUrl: "GROQ_BASE_URL", model: "GROQ_MODEL", timeoutMs: "GROQ_TIMEOUT_MS" }
}, {
  id: "perplexity",
  name: "Perplexity",
  dialect: "perplexity",
  baseUrl: "https://api.perplexity.ai/v1",
  model: "fast",
  models: ["fast", "low", "medium", "high", "xhigh"],
  keyUrl: "https://www.perplexity.ai/settings/api",
  env: { apiKey: ["PERPLEXITY_API_KEY"], baseUrl: "PERPLEXITY_BASE_URL", model: "PERPLEXITY_MODEL", timeoutMs: "PERPLEXITY_TIMEOUT_MS" }
}];

export const providerPreset = (id: string): ProviderPreset | undefined => PROVIDER_PRESETS.find(preset => preset.id === id);

/** Providers with their own code; never data, never a preset's id. */
export const BUILT_IN_PROVIDER_IDS = ["llamacpp", "ollama", "lmstudio", "openai", "anthropic", "gemini"];
