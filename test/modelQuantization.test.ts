import assert from "node:assert/strict";
import test from "node:test";
import { parseQuantization, quantQuality, recommendVariant } from "../src/local/quantization";

const GiB = 1024 ** 3;
/** A catalog variant as the service decorates it: memory estimate against a machine's memory. */
const variant = (id: string, gib: number, totalGiB: number) => {
  const total = totalGiB * GiB;
  return { id, quantization: parseQuantization(id), compatibility: { canLoad: gib * GiB <= total, canDownload: true,
    estimatedMemoryBytes: Math.round(gib * 1.1 * GiB), memoryWarningBytes: total * 0.75, totalMemoryBytes: total } };
};
// unsloth/Qwen3.8-27B-GGUF, smallest first as the catalog lists it.
const qwen27b = (totalGiB: number) => [
  ["Qwen3.8-27B-UD-IQ1_S.gguf", 5.8], ["Qwen3.8-27B-UD-IQ1_M.gguf", 6.4], ["Qwen3.8-27B-UD-IQ2_XXS.gguf", 7.2], ["Qwen3.8-27B-UD-Q2_K_XL.gguf", 9.9],
  ["Qwen3.8-27B-UD-IQ3_XXS.gguf", 10.4], ["Qwen3.8-27B-UD-Q3_K_XL.gguf", 12.5], ["Qwen3.8-27B-UD-Q4_K_XL.gguf", 15.9], ["Qwen3.8-27B-UD-Q4_K_M.gguf", 15.3],
  ["Qwen3.8-27B-Q5_K_M.gguf", 18], ["Qwen3.8-27B-Q6_K.gguf", 20.9], ["Qwen3.8-27B-Q8_0.gguf", 27], ["Qwen3.8-27B-BF16.gguf", 50.1]
].map(([id, gib]) => variant(id as string, gib as number, totalGiB));

test("a GGUF file name gives its quantization; an unsloth dynamic file keeps a little more", () => {
  assert.equal(parseQuantization("Qwen3.8-27B-UD-IQ1_S.gguf"), "IQ1_S");
  assert.equal(parseQuantization("models/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf"), "Q4_K_M");
  assert.equal(parseQuantization("gpt-oss-20b-MXFP4.gguf"), "MXFP4");
  assert.equal(parseQuantization("Bonsai-27B-PQ2_0.gguf"), "PQ2_0", "a fork's PQ2_0 is not llama.cpp's Q2_0");
  assert.equal(parseQuantization("weights.gguf"), "GGUF");
  assert.equal(quantQuality("Q4_K_M", "Qwen3.8-27B-UD-Q4_K_M.gguf").rank, quantQuality("Q4_K_M").rank + 1);
});

test("quantizations rank by how much of the model they keep, and only ~3 bits a weight or less is low", () => {
  const order = ["IQ1_S", "IQ1_M", "IQ2_XXS", "IQ2_M", "Q2_K", "Q2_K_XL", "IQ3_XXS", "Q3_K_M", "IQ4_XS", "Q4_K_M", "Q4_K_XL", "Q5_K_M", "Q6_K", "Q8_0", "BF16", "F32"];
  for (let index = 1; index < order.length; index++) {
    assert.ok(quantQuality(order[index]).rank > quantQuality(order[index - 1]).rank, `${order[index]} ranks above ${order[index - 1]}`);
  }
  for (const low of ["IQ1_S", "IQ1_M", "IQ2_XXS", "IQ2_M", "Q2_K", "Q2_K_XL", "TQ1_0", "Q1_0", "PQ2_0"]) assert.equal(quantQuality(low).lowBit, true, low);
  for (const sound of ["IQ3_XXS", "Q3_K_M", "Q4_0", "MXFP4", "Q4_K_M", "Q8_0", "GGUF"]) assert.equal(quantQuality(sound).lowBit, false, sound);
  assert.match(quantQuality("IQ1_S").note ?? "", /keeps little of the model's quality/);
  assert.equal(quantQuality("Q4_K_M").note, undefined);
  assert.equal(quantQuality("Q1_0").native, true, "a 1-bit model has no better file");
  assert.match(quantQuality("Q1_0").note ?? "", /by design/);
  assert.equal(quantQuality("GGUF").tier, "unknown");
});

test("the file offered first is Q4_K_M when it fits with room, never the smallest one", () => {
  assert.equal(recommendVariant(qwen27b(48))?.id, "Qwen3.8-27B-UD-Q4_K_M.gguf", "48 GiB: the user's M4 Pro");
  assert.equal(recommendVariant(qwen27b(16))?.id, "Qwen3.8-27B-UD-IQ3_XXS.gguf", "16 GiB: the best file that fits with room");
  assert.equal(recommendVariant(qwen27b(14))?.id, "Qwen3.8-27B-UD-Q3_K_XL.gguf", "14 GiB: none fits with room, so the best file that fits at all");
  assert.equal(recommendVariant(qwen27b(11))?.id, "Qwen3.8-27B-UD-Q2_K_XL.gguf", "only low-bit files fit: the best of them, not IQ1_S");
  // A repository without Q4_K_M: the smallest file at least as good, not the 16-bit one.
  const noQ4 = qwen27b(64).filter(item => !/Q4_K_M|Q4_K_XL/.test(item.id));
  assert.equal(recommendVariant(noQ4)?.id, "Qwen3.8-27B-Q5_K_M.gguf");
  assert.equal(recommendVariant(qwen27b(4)), undefined, "nothing can run");
  assert.equal(recommendVariant([{ id: "weights.gguf", quantization: "GGUF" }])?.id, "weights.gguf", "no compatibility known: any file");
});

test("a Synthesis load's context: the wish, cut to the trained context and to memory, never below the app's setting", async () => {
  const { fittingContext } = await import("../src/local/ModelCompatibility");
  assert.equal(fittingContext(16384, 4096, 262144, () => true), 16384);
  assert.equal(fittingContext(16384, 4096, 8192, () => true), 8192, "no more than the model was trained for");
  assert.equal(fittingContext(16384, 4096, undefined, context => context <= 9000), 8192, "steps down until it fits with room");
  assert.equal(fittingContext(16384, 4096, undefined, () => false), 4096, "the app's own setting at least");
  assert.equal(fittingContext(2048, 4096, undefined, () => true), 4096, "a smaller wish does not shrink the app's setting");
});

test("an imported model is named after its file, without the quantization shown beside it", async () => {
  const { importedName } = await import("../src/local/LocalModelService");
  assert.equal(importedName("/Users/me/.lmstudio/models/x/NVIDIA-Nemotron-3-Nano-4B-Q8_0.gguf"), "NVIDIA-Nemotron-3-Nano-4B");
  assert.equal(importedName("Qwen3.5-9B-Q8_0.gguf"), "Qwen3.5-9B");
  assert.equal(importedName("Qwen3.8-27B-UD-Q4_K_M.gguf"), "Qwen3.8-27B");
  assert.equal(importedName("weights.gguf"), "weights");
  assert.equal(importedName("Q4_K_M.gguf"), "Q4_K_M", "nothing but the quantization: kept whole");
});
