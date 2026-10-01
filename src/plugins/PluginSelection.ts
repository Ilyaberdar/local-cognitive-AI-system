import { pluginCatalog } from "./catalog";
import { PluginError } from "./contracts";

const ids = new Set(pluginCatalog.map(plugin => plugin.id));
// A service mention must be a whole token, not an email address or @agent:name.
const mentionPattern = () => /(^|[\s(])@([a-z0-9-]+)(?![\p{L}\p{N}_:-])/giu;

export function parsePluginSelection(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > pluginCatalog.length ||
      value.some(id => typeof id !== "string" || !ids.has(id))) {
    throw new PluginError("Choose plugins from the connected plugin list.");
  }
  return [...new Set(value as string[])].sort();
}

export function mentionedPluginIds(input: string): string[] | undefined {
  const selected = [...input.matchAll(mentionPattern())].map(match => match[2].toLowerCase()).filter(id => ids.has(id));
  return selected.length ? [...new Set(selected)].sort() : undefined;
}

/** Plugin tags are not subagent requests. Explicit @agent:name remains unambiguous. */
export function withoutPluginMentions(input: string): string {
  return input.replace(mentionPattern(), (match, prefix: string, id: string) => ids.has(id.toLowerCase()) ? prefix : match);
}
