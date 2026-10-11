// Exports one composition the same way every time:
//   out/docs/<id>-master-4k60.mp4  3840×2160 (scale 2 of the 1920×1080 layout), PNG frames, x264 CRF 14
//   out/docs/<id>-1440p60.mp4      2560×1440 for the web: lanczos downscale, CRF 16, voice at -16 LUFS
//   out/docs/<id>-720p30.mp4       1280×720, 30 fps, H.264 level 3.1, for phones (many cannot decode
//                                  the 1440p60 file, level 5.1): pages pick it with <source media>
//   out/docs/<id>-poster.jpg       2560×1440, from --poster seconds
// 1080p softened small interface text; at 4K the app window is drawn near its recorded 3200×2000.
//   node scripts/export/video.mjs D3Workflow --poster 17.5
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { values, positionals } = parseArgs({ allowPositionals: true, options: { poster: { type: "string", default: "1" }, out: { type: "string", default: "out/docs" } } });
const id = positionals[0];
if (!id) { console.error("usage: video.mjs <composition> [--poster seconds] [--out dir]"); process.exit(1); }
const dir = path.join(project, values.out);
fs.mkdirSync(dir, { recursive: true });
const master = path.join(dir, `${id}-master-4k60.mp4`);
const web = path.join(dir, `${id}-1440p60.mp4`);
const phone = path.join(dir, `${id}-720p30.mp4`);
const poster = path.join(dir, `${id}-poster.jpg`);
const run = (args) => execFileSync("npx", args, { cwd: project, stdio: "inherit" });

run(["remotion", "render", id, master, "--scale=2", "--codec=h264", "--crf=14", "--x264-preset=slow", "--audio-bitrate=192k", "--concurrency=8", "--log=error"]);
run(["remotion", "ffmpeg", "-v", "error", "-y", "-i", master,
  "-vf", "scale=2560:1440:flags=lanczos", "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-tune", "animation", "-pix_fmt", "yuv420p",
  "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", web]);
run(["remotion", "ffmpeg", "-v", "error", "-y", "-i", master,
  "-vf", "scale=1280:720:flags=lanczos", "-r", "30", "-c:v", "libx264", "-preset", "slow", "-crf", "21", "-profile:v", "high", "-level:v", "3.1", "-pix_fmt", "yuv420p",
  "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", phone]);
run(["remotion", "ffmpeg", "-v", "error", "-y", "-ss", values.poster, "-i", master, "-frames:v", "1", "-vf", "scale=2560:1440:flags=lanczos", "-q:v", "3", poster]);
for (const file of [master, web, phone, poster]) console.log(`${path.relative(project, file)}  ${(fs.statSync(file).size / 1048576).toFixed(1)} MB`);
