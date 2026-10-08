import fs from "fs";

/** Credentials accepted from the environment. They configure this process only and
 * are never inherited by commands, model runtimes or other child processes. */
export const SECRET_ENV_KEYS = [
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "LMSTUDIO_API_KEY",
  "TELEGRAM_BOT_TOKEN", "BRAVE_SEARCH_API_KEY", "NOTION_API_KEY"
] as const;

const secretName = /(?:^|[_.-])(?:tokens?|secrets?|password|passwd|authorization|credentials?|api[_.-]?key|private[_.-]?key|access[_.-]?key|session[_.-]?key)(?:$|[_.-])/i;

/** True for names that conventionally hold credentials, in snake, kebab or camel case. */
export const hasSecretName = (value: string): boolean => secretName.test(value.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));

/** Copy of an environment without the application's credentials. Windows variable
 * names are case-insensitive, so matching ignores case. */
export const childProcessEnv = (base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const secret = new Set<string>(SECRET_ENV_KEYS);
  return Object.fromEntries(Object.entries(base).filter(([key]) => !secret.has(key.toUpperCase())));
};

/** True when a POSIX env file is readable or writable by the group or other users. */
export const isSharedEnvFile = (file: string, platform: NodeJS.Platform = process.platform): boolean =>
  platform !== "win32" && (fs.statSync(file).mode & 0o077) !== 0;
