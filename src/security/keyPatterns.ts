/** Credentials by the shapes their services publish, in one list for every place that masks or
 * recognises one: error reports (diagnostics/sentryScrub.ts), what a paired device is told
 * (runtime/settingsDto.ts) and MCP configurations imported from other apps (mcp/client/importConfig.ts).
 * Each is a regular expression source without flags or anchors. scripts/verify-package-secrets.mjs
 * keeps a stricter list of its own (it scans whole files, where a loose shape finds false positives). */
export const KEY_PATTERNS: ReadonlyArray<{ name: string; source: string }> = [
  // OpenAI (sk-, sk-proj-), Anthropic (sk-ant-), OpenRouter (sk-or-v1-), DeepSeek and Stripe-style (sk_live_);
  // "*" for a key shown masked in part.
  { name: "sk- key", source: String.raw`sk[-_][A-Za-z0-9_*-]{8,}` },
  { name: "Publishable or restricted key", source: String.raw`(?:pk|rk)[-_][A-Za-z0-9_-]{12,}` },
  { name: "Google API key", source: String.raw`AIza[0-9A-Za-z_-]{20,}` },
  { name: "Google OAuth client secret", source: String.raw`GOCSPX-[A-Za-z0-9_-]{20,}` },
  { name: "Groq key", source: String.raw`gsk_[A-Za-z0-9]{20,}` },
  { name: "Perplexity key", source: String.raw`pplx-[A-Za-z0-9]{20,}` },
  { name: "xAI key", source: String.raw`xai-[A-Za-z0-9]{20,}` },
  { name: "Hugging Face token", source: String.raw`hf_[A-Za-z0-9]{20,}` },
  { name: "GitHub token", source: String.raw`(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})` },
  { name: "Slack token", source: String.raw`xox[abprs]-[A-Za-z0-9-]{10,}` },
  { name: "AWS access key", source: String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}` },
  { name: "Sentry auth token", source: String.raw`sntry[su]_[A-Za-z0-9_=+/-]{20,}` },
  { name: "Notion token", source: String.raw`(?:ntn|secret)_[A-Za-z0-9]{40,}` },
  { name: "Telegram bot token", source: String.raw`\d{6,12}:[A-Za-z0-9_-]{30,}` }
];

const alternatives = KEY_PATTERNS.map(pattern => pattern.source).join("|");

/** Every key-shaped run in a text (global; a fresh expression each call, so lastIndex is never shared). */
export const keyShapes = (): RegExp => new RegExp(String.raw`\b(?:${alternatives})`, "g");

/** Whether a whole value starts as a key does (an environment variable's value, a header's). */
export const looksLikeKey = (value: string): boolean => new RegExp(String.raw`^(?:${alternatives})`).test(value.trim());

/** A text with every key-shaped run replaced. */
export const maskKeyShapes = (text: string, replacement = "<key>"): string => text.replace(keyShapes(), replacement);
