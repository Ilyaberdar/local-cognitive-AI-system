# Status: Local Cognitive videos

Read this first after a context switch. Then read `brief.md` (rules and style), `shot-list.md` (what to record and how) and `assets.json` (every file in use, with its source).

Last updated: 2026-10-11, at app commit 4f390c2 (v0.1.4).

## Goal

1. Short demos of single features for the docs (docs-site, Astro Starlight).
2. A 40-second promo with an English voice-over and subtitles.
3. Both placed in the docs and on the landing page.

## Stage 1: foundation (done, except the recording-permission check)

- [x] Read the repos: the app README, the docs-site pages and config, and the landing (`index.html`, `site.css`, `_headers`, `server.mjs`, `functions/`). The findings are in `brief.md`.
- [x] Checked the tools (table below).
- [x] Created the Remotion project in `marketing/video`.
  - Remotion 4.0.534, React 19, its own `package.json` and `package-lock.json`.
  - Packages: `@remotion/media`, `@remotion/transitions`, `@remotion/captions` and `@remotion/fonts`. `playwright-core` is a dev dependency.
  - Nothing was added to the app's own `package.json`.
- [x] Folders:
  - `public/captures` (raw recordings) and `public/audio` (voice-over): ignored by git.
  - `out` (renders): ignored by git.
  - `handoff`.
  - `public/brand`: the logo from `icon.png` and the landing's og image.
  - `public/fonts`: Geist and Geist Mono from the landing, with `OFL.txt`.
  - `public/stills`: real screenshots for the style frames.
  - `.profiles`: the isolated app data folders. Ignored by git.
- [x] Visual style, built as code in `src/`:
  - Stills `StyleTitle`, `StyleShot` and `StyleEnd`, and the `StyleMotion` composition. Rendered PNGs are in `out/style/`.
  - The `Promo` timeline is 40 s long. Every window in it shows a "Capture pending" placeholder.
- [x] Remotion Studio starts: `npm run dev -- --port 3123` opens <http://localhost:3123>.
- [x] Scripted control of the app works:
  - `scripts/capture/app.mjs` and `still.mjs` start the development build through Playwright's `_electron`.
  - Each run gets its own data folder, a 1600×1000 window (Retina ×2, so 3200×2000 frames), the light theme and 115% text.
- [ ] **macOS screen recording (`screencapture -v`): blocked until the terminal is restarted.** macOS asked for the Screen Recording permission. It takes effect only after the terminal app restarts.

## Tools

| Tool | State | Notes |
|---|---|---|
| Remotion | ✅ works | Studio works. Renders use Playwright's headless Chromium: Remotion's own headless shell crashes on this Mac ("icudtl.dat not found in bundle" in the GPU process). The fix is in `remotion.config.ts`. |
| FFmpeg | ✅ works | Remotion bundles n7.1: `npx remotion ffmpeg` and `npx remotion ffprobe`. It has libx264, h264/hevc_videotoolbox, VP9, AV1, ProRes, AAC and Opus. There is no system ffmpeg, and none is needed. |
| Playwright → app | ✅ works | Only the development build. The packaged app refuses `--remote-debugging-*` (`electron/launch-guard.cjs`) and its fuses turn off `--inspect`. |
| Chromium screencast (CDP) | ✅ works | Frames come only when the page changes. There is no system cursor in them. |
| macOS screen recording | ⏳ after terminal restart | `screencapture -v -k -R x,y,w,h` records the real cursor and shows clicks. Run `node scripts/capture/screen-test.mjs` to check it. |
| Recordly | ❌ not installed | It is not in /Applications or ~/Applications and not on PATH. Not needed if `screencapture` works. |
| Claude in Chrome | ❌ not connected | No `mcp__claude-in-chrome__*` tools in this session. Enable it with `/chrome` in Claude Code if it is ever needed. It is not needed for the app. |
| Computer Use | ❌ not available | Only exists in the Claude desktop app. |
| Playwright MCP | ❌ not connected | `playwright-core` is used directly instead. |
| ElevenLabs | ❌ needs the owner | There is no key and no MCP. Needed: `ELEVENLABS_API_KEY` in `marketing/video/.env` (git ignores it) and a choice of voice (`ELEVENLABS_VOICE_ID`). |

## Blockers and owner decisions

1. **Restart the terminal** so screen recording is allowed. Then continue the session with `claude --continue` in the app repo.
2. **ElevenLabs key and voice.** The voice-over is generated per scene. The character timestamps from `/v1/text-to-speech/{voice}/with-timestamps` give exact subtitles without transcribing.
3. **Remote shot (D5/P6):**
   - The owner signs in to the account in the development profile; I never type the password.
   - The owner allows pairing this computer with fedora (`sudo local-cognitive-server pair` on the server over SSH).
   - Decide which server name and account e-mail may appear on screen.
4. **Model for Chat/Synthesis:**
   - Options on this Mac are Qwen3.8-27B UD-Q4_K_M (15 GB) or a fresh small download.
   - There is only 39 GB of free disk. Use an APFS clone (`cp -c`, takes no space) instead of a copy into the isolated profile, if import allows it. Check this before recording.
   - The installed app's "Uncensored" models must never appear on screen. Recording profiles hold only the models a shot needs.
5. **App theme in the recordings:** the light theme was chosen to match the landing. The README and docs screenshots are dark. The owner confirms or picks dark.

## Commands

```bash
cd marketing/video
npm ci                                   # dependencies
npm run dev -- --port 3123               # Remotion Studio → http://localhost:3123
npx tsc --noEmit && npx eslint src       # checks
npx remotion still StyleShot out/style/StyleShot.png     # one style frame
npx remotion render Promo out/promo-draft.mp4            # draft promo (placeholders)
node scripts/capture/still.mjs --profile style --theme light --font-scale 115 --route "#/models" --out out/stills/models.png
node scripts/capture/screen-test.mjs     # check macOS screen recording after the restart
npx playwright-core install --only-shell chromium        # if renders cannot find a browser
```

Before recording, the development build must match HEAD. Run `npm run build` in the app repo if `dist/` is older than the last commit. It rewrites `dist/`, so do not run app tests at the same time.

## Next step

1. After the restart, run `node scripts/capture/screen-test.mjs` and look at `out/screen-test.mov`.
2. Choose the capture method. Prefer `screencapture` (real cursor); CDP frames are the fallback. Then write `scripts/capture/record.mjs`: the scripted actions of one shot plus recording, with an action log of timestamps per step written to `public/captures/<shot>.json`.
3. First shot: **D3 Workflow console demo**. It needs no model and no network, so it tests the whole pipeline: recording → `public/captures` → `DocDemo` composition → render → size check.
4. After that: D1 (download a model), then D2, D7 and D8, then the shots that depend on decisions (D4, D5, D6).
