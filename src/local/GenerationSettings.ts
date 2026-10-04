import { LocalGenerationPreset, LocalGenerationSettings, SamplingSettings } from "../types";

export const LOCAL_GENERATION_PRESETS: Record<Exclude<LocalGenerationPreset, "server" | "custom">, Required<Omit<LocalGenerationSettings, "preset" | "seed">>> = {
  precise: {
    temperature: 0.2,
    topP: 0.9,
    topK: 40,
    minP: 0.05,
    repeatPenalty: 1.05,
    maxTokens: 1024
  },
  balanced: {
    temperature: 0.7,
    topP: 0.95,
    topK: 40,
    minP: 0.05,
    repeatPenalty: 1.05,
    maxTokens: 2048
  },
  creative: {
    temperature: 1,
    topP: 0.98,
    topK: 80,
    minP: 0.02,
    repeatPenalty: 1.02,
    maxTokens: 3072
  }
};

export const defaultLocalGenerationSettings = (): LocalGenerationSettings => ({ preset: "server" });

export const isLocalGenerationPreset = (value: unknown): value is LocalGenerationPreset =>
  value === "server" || value === "precise" || value === "balanced" || value === "creative" || value === "custom";

const boundedNumber = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : undefined;

const integer = (value: unknown, min: number, max: number): number | undefined => {
  const number = boundedNumber(value, min, max);
  return number !== undefined && Number.isInteger(number) ? number : undefined;
};

/** Normalizes persisted data without turning an omitted profile into a surprise override. */
export const normalizeLocalGenerationSettings = (value: unknown): LocalGenerationSettings => {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<LocalGenerationSettings>
    : {};
  const preset = isLocalGenerationPreset(input.preset) ? input.preset : "server";
  if (preset === "server" || preset === "precise" || preset === "balanced" || preset === "creative") return { preset };
  const fallback = LOCAL_GENERATION_PRESETS.balanced;
  return {
    preset,
    temperature: boundedNumber(input.temperature, 0, 2) ?? fallback.temperature,
    topP: boundedNumber(input.topP, 0, 1) ?? fallback.topP,
    topK: integer(input.topK, 0, 200) ?? fallback.topK,
    minP: boundedNumber(input.minP, 0, 1) ?? fallback.minP,
    repeatPenalty: boundedNumber(input.repeatPenalty, 0, 2) ?? fallback.repeatPenalty,
    maxTokens: integer(input.maxTokens, 1, 32768) ?? fallback.maxTokens,
    ...(integer(input.seed, -1, 2_147_483_647) !== undefined ? { seed: integer(input.seed, -1, 2_147_483_647) } : {})
  };
};

/** Resolves a persisted profile into fields accepted by llama.cpp for one request. */
export const resolveLocalGenerationSettings = (value: LocalGenerationSettings | undefined): {
  sampling: SamplingSettings;
  maxTokens?: number;
} => {
  const settings = normalizeLocalGenerationSettings(value);
  if (settings.preset === "server") return { sampling: {} };
  const source = settings.preset === "custom" ? settings : LOCAL_GENERATION_PRESETS[settings.preset];
  const seed = settings.preset === "custom" ? settings.seed : undefined;
  return {
    sampling: {
      temperature: source.temperature,
      topP: source.topP,
      topK: source.topK,
      minP: source.minP,
      repeatPenalty: source.repeatPenalty,
      ...(seed !== undefined ? { seed } : {})
    },
    maxTokens: source.maxTokens
  };
};

/** Structured actions should stay stable even if the user chose a creative chat profile. */
export const preciseLocalGenerationSettings = (): LocalGenerationSettings => ({ preset: "precise" });
