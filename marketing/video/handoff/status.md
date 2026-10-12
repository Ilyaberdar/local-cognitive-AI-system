# Status: Local Cognitive videos

Read this first after a context switch. Then read `brief.md` (rules and style), `shot-list.md` (what to record and how) and `assets.json` (every file in use, with its source).

Last updated: 2026-10-11, at app commit 4f390c2 (v0.1.4).

## Goal

1. Short demos of single features for the docs (docs-site, Astro Starlight).
2. A 40-second promo with an English voice-over and subtitles.
3. Both placed in the docs and on the landing page.

## Stage 1: foundation (done)

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
- [x] macOS screen recording works after the terminal restart (Ghostty).
  - `screencapture -v -k -R` of the window gives H.264 at 3200×2000, about 55 fps. The real traffic lights are included.
  - Two catches turned up:
    1. macOS shows a "Ghostty is requesting to bypass the system private window picker…" dialog over the screen. The owner must press **Allow**, and macOS may ask again from time to time. Check the first frame of each take.
    2. The cursor in the recording is the **physical** mouse pointer. Playwright's clicks are synthetic events inside the page, so they move no visible pointer.
- [x] ElevenLabs key works (`scripts/voice/check-key.mjs`).
  - Plan: Starter (includes the commercial licence), 40,000 characters a month.
  - The key is in `.env`, which git ignores and which has mode 600. **Never put the key in `.env.example`, which git tracks.**
  - Voice samples are in `public/audio/samples/{eric,matilda,river,alice}.mp3` (`scripts/voice/samples.mjs`).

## Recording pipeline (works, tested with `scripts/capture/pointer-test.mjs`)

**Launch.** `app.mjs` starts the development build with `.profiles/<shot>` as its data folder and a 1600×1000 content area. Theme and text size go through `PUT /app/settings` `{ui:{theme,fontScale}}`, as Settings → Appearance does. localStorage alone is overridden at startup.

**`recorder.mjs` `startShot()`:**
- A backdrop window of one colour (`#dde4ec`) goes behind the app, because macOS translucency otherwise shows other windows through the sidebar. The app is then brought to the front.
- It starts `screencapture -v -k -x -R <content bounds>` → `public/captures/<shot>.mov`, stopped with SIGINT.
- `shot.click(locator, step)` moves the **real** pointer along an eased arc to the element's centre, waits about 0.45 s, then clicks with a real CGEvent.
- `shot.type()` types through Playwright's keyboard (35–60 ms per key).
- Each step is logged with its ms since the recording started. `videoOffsetMs` is screencapture's start delay, about 140 ms.

**Output.** 3200×2000 H.264, about 55 fps. The real traffic lights are coloured because the window is focused, the cursor is real and clicks show as rings.

**Owner:** don't touch the mouse or keyboard during a take. If "Ghostty is requesting to bypass the system private window picker" appears, press Allow.

## Stage 2: done (2026-10-12)

| Video | Take / model | Published |
|---|---|---|
| A Models | `a-models.mjs`, Qwen3.8-27B (APFS clone) | docs guides/models.md |
| B Chat | `b-chat.mjs`, release-checklist prompt, Qwen3.8-27B, streams then formats | docs guides/chats.md |
| C Subagent | `c-subagent.mjs`, Qwen3.5-9B Q8 (LM Studio file) | docs guides/chats.md § Subagents |
| D3 Workflow | `d3-workflow.mjs`, real time | docs guides/workflows.md |
| D4 Synthesis | `d4-synthesis.mjs`, Rate limiter, Accepted in 1 iteration | docs guides/synthesis.md |
| F Remote | `f-remote.mjs`, owner's installed app (allowed), sidebar collapsed, avatar blurred, Qwen2.5-14B on fedora | docs guides/remote.md |
| Promo 40 s | cut from the takes, dissolves, Eleven Music ducked under the voice | landing `#demo` (`/media/promo-v1*.mp4`) |
| Overview (3 min 21 s) | all demos + title cards, music under the demos | docs home (`overview.mp4` 1440p30 CRF 20 = 24.3 MB, under the 25 MiB asset limit; `overview-720.mp4`) |

**Exports** (`scripts/export/video.mjs <id>`):
- a 4K60 master;
- a 1440p60 web copy;
- a 720p30 phone copy, because phones could not play the level 5.1 file;
- a poster.

Pages choose the copy with `<source media="(max-width: 900px), (pointer: coarse)">`.

**The docs host needs `docs-site/worker.js`.** Workers static assets answer a byte range with the whole file, so videos could not be seeked. The Worker answers ranges for `/videos/*`.

**Size limit:** 25 MiB per file on both sites. A long video gets a 30 fps web copy.

**Shipped alongside the videos:**
- release 0.1.5 (f1054cc): the server's CUDA link repair, and streaming answers in project, Code and subagent chats;
- the Approve wording fix (31bbf52).

## Tools

| Tool | State | Notes |
|---|---|---|
| Remotion | ✅ works | Studio works. Renders use Playwright's headless Chromium: Remotion's own headless shell crashes on this Mac ("icudtl.dat not found in bundle" in the GPU process). The fix is in `remotion.config.ts`. |
| FFmpeg | ✅ works | Remotion bundles n7.1: `npx remotion ffmpeg` and `npx remotion ffprobe`. It has libx264, h264/hevc_videotoolbox, VP9, AV1, ProRes, AAC and Opus. There is no system ffmpeg, and none is needed. |
| Playwright → app | ✅ works | Only the development build. The packaged app refuses `--remote-debugging-*` (`electron/launch-guard.cjs`) and its fuses turn off `--inspect`. |
| Chromium screencast (CDP) | ✅ works | Frames come only when the page changes. There is no system cursor in them. |
| macOS screen recording | ✅ works | `screencapture -v -k -R x,y,w,h`: 3200×2000 H.264, about 55 fps. It records the physical pointer only, and the bypass dialog needs **Allow**. Check with `node scripts/capture/screen-test.mjs`. |
| Recordly | ❌ not installed | It is not in /Applications or ~/Applications and not on PATH. Not needed if `screencapture` works. |
| Claude in Chrome | ❌ not connected | No `mcp__claude-in-chrome__*` tools in this session. Enable it with `/chrome` in Claude Code if it is ever needed. It is not needed for the app. |
| Computer Use | ❌ not available | Only exists in the Claude desktop app. |
| Playwright MCP | ❌ not connected | `playwright-core` is used directly instead. |
| ElevenLabs | ✅ key works | Starter plan, 40k characters a month, `eleven_multilingual_v2`. Voice: Matilda (`voice.json`). |
| Real mouse events (CGEvent) | ✅ works | `scripts/capture/pointer.swift` is compiled to `.bin/pointer` (git ignores it) on first use. Ghostty is trusted under Accessibility. |

## Blockers and owner decisions

1. ~~Cursor~~ decided 2026-10-11: the real pointer. Ghostty is trusted under Accessibility.
2. ~~Voice~~ decided 2026-10-11: **Matilda** (`voice.json`; the owner asked for "any female voice").
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
node --env-file=.env scripts/voice/generate.mjs D3Workflow   # voice-over lines from voice/D3Workflow.json
node scripts/export/video.mjs D3Workflow --poster 17.5        # 4K60 master, 1440p60 web copy, poster
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

2. When the UI changes, re-record a demo with its script, then re-export it. The demos are real takes, so they need re-recording, not editing.
3. Streaming phase B: cloud providers (OpenAI, Anthropic, Gemini, LM Studio, Ollama) do not stream yet.
