// Voice-over for one video: each line of voice/<video>.json is spoken by the chosen voice
// (voice.json) and saved as public/audio/<video>/<line>.mp3, with ElevenLabs' character timings
// as <line>.json, so captions match the speech exactly. Lines whose text has not changed are kept.
// mp3_44100_128 is the best format the Starter plan allows (192 kbps needs Creator).
//   node --env-file=.env scripts/voice/generate.mjs D3Workflow
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const video = process.argv[2];
if (!video) { console.error("usage: generate.mjs <video>"); process.exit(1); }
const voice = JSON.parse(fs.readFileSync(path.join(project, "voice.json"), "utf8"));
const { lines } = JSON.parse(fs.readFileSync(path.join(project, "voice", `${video}.json`), "utf8"));
const out = path.join(project, "public", "audio", video);
fs.mkdirSync(out, { recursive: true });

for (const line of lines) {
  const audioFile = path.join(out, `${line.id}.mp3`);
  const timingFile = path.join(out, `${line.id}.json`);
  const existing = fs.existsSync(timingFile) ? JSON.parse(fs.readFileSync(timingFile, "utf8")) : null;
  if (existing?.text === line.text && existing?.voiceId === voice.voiceId && fs.existsSync(audioFile)) {
    console.log(`${line.id}: unchanged, ${existing.durationSeconds.toFixed(2)} s`);
    continue;
  }
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice.voiceId}/with-timestamps?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ text: line.text, model_id: voice.modelId, voice_settings: voice.voiceSettings }),
  });
  if (!response.ok) throw new Error(`${line.id}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  const result = await response.json();
  fs.writeFileSync(audioFile, Buffer.from(result.audio_base64, "base64"));
  const alignment = result.alignment;
  const durationSeconds = alignment.character_end_times_seconds.at(-1);
  fs.writeFileSync(timingFile, `${JSON.stringify({ text: line.text, voiceId: voice.voiceId, durationSeconds, alignment }, null, 1)}\n`);
  console.log(`${line.id}: ${durationSeconds.toFixed(2)} s`);
}
