// A GGUF file's quantization, read from its name, and how much of the model's quality it keeps.
// No imports, so any bundle can use this same file.

/** The whole quantization word: a fork's PQ2_0 or PTQ1_0 must not read as llama.cpp's own Q2_0 or Q1_0. */
export const parseQuantization = (file: string): string =>
  (file.split(/[\\/]/).pop() ?? file).match(/(?<![A-Z0-9])([A-Z]*Q\d(?:_[A-Z0-9]+)*|MXFP4|NVFP4|BF16|F16|F32)(?![A-Z0-9])/i)?.[1]?.toUpperCase() || "GGUF";

export interface QuantQuality {
  /** Higher keeps more of the model's quality; 50 is a quantization this table does not know. */
  rank: number;
  /** About how many bits one weight takes. */
  bits?: number;
  tier: "full" | "high" | "good" | "reduced" | "low" | "unknown";
  /** About 3 bits a weight or less: the model loses much of its quality. */
  lowBit: boolean;
  /** Stored at this width by design (ternary and 1-bit models): there is no better file of it. */
  native?: boolean;
  /** A low-bit file's warning, as the Models window and a Synthesis run show it. */
  note?: string;
}

/** In order: the first pattern that matches gives the rank. Q4_K_M is the usual balance. */
const TABLE: Array<[RegExp, number, number, QuantQuality["tier"]]> = [
  [/^F32$/, 100, 32, "full"], [/^(?:BF16|F16)$/, 95, 16, "full"],
  [/^Q8_/, 90, 8.5, "high"],
  [/^Q6_K_(?:L|XL)$/, 81, 6.6, "high"], [/^Q6_/, 80, 6.6, "high"],
  [/^Q5_K_(?:L|XL)$/, 73, 5.7, "good"], [/^Q5_K_M$/, 72, 5.7, "good"], [/^Q5_K(?:_S)?$/, 70, 5.5, "good"], [/^Q5_/, 66, 5.5, "good"],
  [/^Q4_K_(?:L|XL)$/, 62, 4.9, "good"], [/^Q4_K_M$/, 60, 4.8, "good"], [/^(?:Q4_K(?:_S)?|IQ4_NL)$/, 57, 4.6, "good"],
  [/^(?:MXFP4|NVFP4)$/, 56, 4.25, "good"], [/^IQ4_/, 55, 4.3, "good"], [/^Q4_/, 52, 4.5, "good"],
  [/^Q3_K_(?:L|XL)$/, 45, 4, "reduced"], [/^(?:Q3_K_M|IQ3_M)$/, 42, 3.9, "reduced"], [/^(?:Q3_K(?:_S)?|IQ3_S|IQ3_XS)$/, 38, 3.5, "reduced"], [/^(?:IQ3_XXS|Q3_)/, 35, 3.1, "reduced"],
  [/^Q2_K_(?:L|XL)$/, 25, 3, "low"], [/^Q2_/, 22, 2.9, "low"], [/^IQ2_M$/, 20, 2.7, "low"], [/^IQ2_(?:S|XS)$/, 17, 2.4, "low"], [/^(?:IQ2_|TQ2_)/, 15, 2.1, "low"],
  [/^IQ1_M$/, 10, 1.75, "low"], [/^(?:IQ1_|TQ1_)/, 8, 1.6, "low"], [/^(?:PT?Q\d|Q[01]_)/, 5, 1.2, "low"]
];
/** Ternary (BitNet-style) and 1-bit model formats: the model was made for them. */
const NATIVE = /^(?:TQ\d|PT?Q\d|Q1_)/;

/** `file` (optional) also tells an unsloth dynamic file (UD-…), which keeps a little more of the model. */
export function quantQuality(quantization: string | undefined, file = ""): QuantQuality {
  const name = (quantization && quantization !== "GGUF" ? quantization : parseQuantization(file)).toUpperCase();
  const row = TABLE.find(([pattern]) => pattern.test(name));
  if (!row) return { rank: 50, tier: "unknown", lowBit: false };
  const [, rank, bits, tier] = row;
  const quality: QuantQuality = { rank: rank + (/(?:^|[\\/_.-])UD-/i.test(file) ? 1 : 0), bits, tier, lowBit: tier === "low", ...(NATIVE.test(name) ? { native: true } : {}) };
  const note = lowQualityNote(name, quality);
  return note ? { ...quality, note } : quality;
}

/** Why a low-bit file is a poor choice, for the Models window and a Synthesis run's log. */
export function lowQualityNote(quantization: string, quality = quantQuality(quantization)): string | undefined {
  if (!quality.lowBit) return undefined;
  const bits = quality.bits ? ` (about ${quality.bits} bits a weight)` : "";
  return quality.native
    ? `${quantization}${bits} is how this model is stored by design; it is weaker than a model of its size at 4 bits.`
    : `${quantization}${bits} keeps little of the model's quality: expect much weaker answers and code. Q4_K_M or higher is the usual choice.`;
}

interface Choice {
  id: string;
  quantization: string;
  compatibility?: { canLoad: boolean; canDownload: boolean; estimatedMemoryBytes: number; memoryWarningBytes: number; totalMemoryBytes: number };
}

/** The file to offer first: Q4_K_M when it fits with room, else the smallest file at least as good that
 * fits with room, else the best one that fits. A low-bit file only when no other fits. Free
 * memory is left out on purpose, so the choice stays the same from one look to the next. */
export function recommendVariant<T extends Choice>(variants: T[]): T | undefined {
  const quality = (variant: T) => quantQuality(variant.quantization, variant.id).rank;
  const best = (list: T[]) => [...list].sort((left, right) => quality(right) - quality(left))[0];
  const usable = variants.filter(variant => variant.compatibility?.canDownload !== false && variant.compatibility?.canLoad !== false);
  const roomy = (variant: T) => !variant.compatibility || variant.compatibility.estimatedMemoryBytes <= variant.compatibility.memoryWarningBytes;
  const fits = (variant: T) => !variant.compatibility || variant.compatibility.estimatedMemoryBytes <= variant.compatibility.totalMemoryBytes;
  const sound = usable.filter(variant => !quantQuality(variant.quantization, variant.id).lowBit);
  const good = sound.filter(variant => roomy(variant) && quality(variant) >= 60);
  return best(sound.filter(variant => roomy(variant) && variant.quantization === "Q4_K_M"))
    ?? [...good].sort((left, right) => quality(left) - quality(right))[0]
    ?? best(sound.filter(roomy))
    ?? best(sound.filter(fits))
    ?? best(usable.filter(fits))
    ?? best(usable);
}
