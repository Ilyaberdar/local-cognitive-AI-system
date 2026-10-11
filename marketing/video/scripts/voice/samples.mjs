// The same two promo lines in a few candidate voices, so the owner can choose by ear.
//   node --env-file=.env scripts/voice/samples.mjs
// Writes public/audio/samples/<voice>.mp3 (git ignores public/audio).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.join(project, "public", "audio", "samples");
fs.mkdirSync(out, { recursive: true });

const text = "Chat with models that run on your own computer. Prompts and answers stay there. Pick any model from Hugging Face. Memory is checked before the download.";
const voices = {
  eric: "cjVigY5qzO86Huf0OWal",
  matilda: "XrExE9yKIg1WjnnlVkGX",
  river: "SAz9YHcvj6GT2YYXdXww",
  alice: "Xb7hH8MSUJpSbSDYk0k2",
};

for (const [name, id] of Object.entries(voices)) {
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${id}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2 } }),
  });
  if (!response.ok) { console.error(`${name}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`); continue; }
  const file = path.join(out, `${name}.mp3`);
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  console.log(path.relative(project, file));
}
