import { tryParseJson } from "../utils/Json";

interface DebatePayload {
  summary?: string;
  arguments?: string[];
}

const extractStringField = (raw: string, field: string): string | undefined => {
  const match = raw.match(new RegExp(`"${field}"\\s*:\\s*"([\\s\\S]*?)"`, "i"));
  return match?.[1]?.replace(/\\"/g, '"').trim() || undefined;
};

const extractArrayField = (raw: string, field: string): string[] => {
  const match = raw.match(new RegExp(`"${field}"\\s*:\\s*\\[([\\s\\S]*?)\\]`, "i"));

  if (!match?.[1]) {
    return [];
  }

  return Array.from(match[1].matchAll(/"((?:\\"|[^"])*)"/g))
    .map((item) => item[1]?.replace(/\\"/g, '"').trim())
    .filter((item): item is string => Boolean(item));
};

const extractBulletLines = (raw: string): string[] =>
  raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(
      (line) =>
        !line.startsWith("{") &&
        !line.startsWith("}") &&
        !line.startsWith('"summary"') &&
        !line.startsWith('"arguments"') &&
        !line.startsWith("[") &&
        !line.startsWith("]")
    );

export const normalizeDebatePayload = (
  data: DebatePayload | null,
  raw: string,
  fallbackSummary: string
): { summary: string; arguments: string[] } => {
  const parsed = data ?? tryParseJson<DebatePayload>(raw);
  const parsedArguments = parsed?.arguments?.map((item) => item?.trim()).filter(Boolean) ?? [];
  const extractedArguments = extractArrayField(raw, "arguments");
  const fallbackArguments = extractBulletLines(raw);

  const argumentsList = [...parsedArguments, ...extractedArguments, ...fallbackArguments]
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !item.startsWith('{"summary"'))
    .slice(0, 4);

  const summary =
    parsed?.summary?.trim() ||
    extractStringField(raw, "summary") ||
    argumentsList[0] ||
    fallbackSummary;

  return {
    summary,
    arguments: argumentsList.length ? argumentsList : [summary]
  };
};
