import { ManagedModel } from "../../types";

const COMMON_ALIASES: Array<{ pattern: RegExp; alias: string }> = [
  { pattern: /qwen/i, alias: "qwen" },
  { pattern: /glm/i, alias: "glm" },
  { pattern: /nemotron/i, alias: "nemotron" },
  { pattern: /magistral|mistral/i, alias: "mistral" },
  { pattern: /lfm2|liquid/i, alias: "liquid" },
  { pattern: /gpt-oss/i, alias: "gptoss" }
];

const normalizeAlias = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

export const buildAliasMap = (models: ManagedModel[]): Map<string, string> => {
  const candidates = new Map<string, string[]>();

  for (const model of models) {
    const parts = model.id.split("/");
    const lastSegment = parts[parts.length - 1];
    const aliases = new Set<string>();

    aliases.add(normalizeAlias(lastSegment));

    for (const item of COMMON_ALIASES) {
      if (item.pattern.test(model.id)) {
        aliases.add(item.alias);
      }
    }

    for (const alias of aliases) {
      if (!alias) {
        continue;
      }

      const existing = candidates.get(alias) ?? [];
      existing.push(model.id);
      candidates.set(alias, existing);
    }
  }

  const resolved = new Map<string, string>();

  for (const [alias, modelIds] of candidates.entries()) {
    if (modelIds.length === 1) {
      resolved.set(alias, modelIds[0]);
    }
  }

  return resolved;
};

export const aliasesForModel = (modelId: string, aliasMap: Map<string, string>): string[] =>
  Array.from(aliasMap.entries())
    .filter(([, value]) => value === modelId)
    .map(([alias]) => alias);
