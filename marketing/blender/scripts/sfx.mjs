// Accent sounds for the Blender film, made with the ElevenLabs Sound Effects API. Each cue is written
// to audio/sfx/<name>-<take>.mp3 and kept: a cue that already has its files is not generated again.
//   node --env-file=../video/.env scripts/sfx.mjs [cue …]
import fs from "node:fs/promises";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const dir = path.join(here, "..", "audio", "sfx");
const TAKES = 2;

// Sequence 01, Awakening (0–6 s): the spark, the wave of light, the pull inward, the core igniting.
const CUES = {
  "01-spark": [2.5, "A single delicate crystalline ping in total silence, a tiny spark of light igniting, clean and high, soft airy reverb tail. No music."],
  "01-wave": [3.0, "Soft shimmering granular swell spreading outward, thousands of tiny glass particles lighting up one after another, airy, delicate, cinematic. No music."],
  "01-riser": [3.5, "Deep cinematic riser: swirling particles pulled into a vortex, pitch rising, tension building, filtered noise and a sub bass swell, ending abruptly. No music."],
  "01-impact": [3.5, "Deep soft cinematic sub bass impact with a glassy metallic resonance, a powerful machine core powering on, clean, short shimmering tail. No music."],
  "bed": [12.0, "Dark minimal cinematic ambience: a deep low hum, faint airy texture, very quiet distant shimmer, futuristic, calm, no melody, no rhythm."],
};

const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error("ELEVENLABS_API_KEY is not set (run with --env-file=../video/.env)");
await fs.mkdir(dir, { recursive: true });
const wanted = process.argv.slice(2);
for (const [name, [seconds, text]] of Object.entries(CUES)) {
  if (wanted.length && !wanted.includes(name)) continue;
  for (let take = 1; take <= TAKES; take++) {
    const file = path.join(dir, `${name}-${take}.mp3`);
    if (await fs.stat(file).then(() => true, () => false)) continue;
    const response = await fetch("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128", {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, duration_seconds: seconds, prompt_influence: 0.55, model_id: "eleven_text_to_sound_v2", loop: name === "bed" }),
    });
    if (!response.ok) throw new Error(`${name}: ${response.status} ${await response.text()}`);
    await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
    console.log("wrote", path.relative(process.cwd(), file));
  }
}
