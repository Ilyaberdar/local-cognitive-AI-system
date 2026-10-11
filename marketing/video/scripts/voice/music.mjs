// Background music for a video, made with Eleven Music (paid plans: cleared for online commercial use).
//   node --env-file=.env scripts/voice/music.mjs <name> <seconds> "<prompt>"
// Writes public/audio/music/<name>.mp3 (git ignores public/audio) and <name>.json with the prompt.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [name, seconds, prompt] = process.argv.slice(2);
if (!name || !seconds || !prompt) { console.error('usage: music.mjs <name> <seconds> "<prompt>"'); process.exit(1); }
const response = await fetch("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128", {
  method: "POST",
  headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ prompt, music_length_ms: Math.round(Number(seconds) * 1000), model_id: "music_v1" }),
});
if (!response.ok) { console.error(`HTTP ${response.status} ${(await response.text()).slice(0, 400)}`); process.exit(1); }
const out = path.join(project, "public", "audio", "music");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, `${name}.mp3`), Buffer.from(await response.arrayBuffer()));
fs.writeFileSync(path.join(out, `${name}.json`), `${JSON.stringify({ prompt, seconds: Number(seconds), made: new Date().toISOString() }, null, 2)}\n`);
console.log(path.relative(project, path.join(out, `${name}.mp3`)));
