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

## Stage 2: recordings (2026-10-12)

| Shot | Take | Edit / export | Docs |
|---|---|---|---|
| A Models | `scripts/capture/a-models.mjs`, real time | `AModels` → out/docs/AModels-1440p60.mp4 | guides/models.md (built locally, not pushed) |
| B Chat | `b-chat.mjs`, Qwen3.8-27B Q4; the answer lists the three notes (same at every Effort in rehearsal) | `BChat`, wait 6× with badge | guides/chats.md (not pushed) |
| C Subagent | `c-subagent.mjs`, Qwen3.5-9B Q8 from LM Studio's folder (27B too slow; 1-bit Bonsai's subagent repeated its instructions) | `CSubagent`, 3 min 36 s at 40× with badge | guides/chats.md § Subagents (not pushed) |
| D3 Workflow | `d3-workflow.mjs`, real time | `D3Workflow` | guides/workflows.md (published a084238) |
| D4 Synthesis | `d4-synthesis.mjs`, Rate limiter on Qwen3.8-27B, Accepted in 1 iteration | `D4Synthesis`, 61 s at 10× with badge | guides/synthesis.md (not pushed) |
| F Remote | `f-remote.mjs`, installed app (owner allowed); records only right of the sidebar; paste via ⌘V; stops if another app is in front | pending | guides/remote.md later |
| Overview | all demos + title cards | `Overview` (F placeholder) | — |
| Promo 40 s | cut from the takes, voice-over `voice/Promo.json` | `Promo` → out/docs/Promo-1440p60.mp4 (F placeholder) | landing later |

**Remote blocker, fixed:**
- Chats on fedora failed with "libllama-common.so.0: cannot open shared object file".
- Cause: updates copied the CUDA runtime with `fs.cpSync`, which wrote absolute links into release 0.1.0; pruning 0.1.0 broke them.
- Code fix with tests: c4c7021.
- On the server the links of 0.1.4, 0.1.3 and 0.1.2 were made relative and the service was restarted; it now reports `Inference: cuda`.
- **Release 0.1.5 is needed** so that the next update does not break it again. Publish only after the owner says "можно релизить".

**Lessons:**
- The recorder must stop screencapture on any failure. A failed take once recorded the desktop; `killRecorderSync` fixes that.
- Character-by-character key events did not reach the packaged app (Russian layout), so the request is pasted instead.
- The packaged app's chats are not counted in the server's `Work` line.
- The owner's chats were never deleted. Only the chats the takes created were removed, with the owner's OK.

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

1. The owner watches `out/docs/D3Workflow-1440p60.mp4` (with sound).
2. Once it is OK, place it in the docs:
   - copy the 1440p60 file to `docs-site/public/videos/workflow-run.mp4` with its poster;
   - add `<video controls playsinline preload="none" poster="/videos/workflow-run.jpg" src="/videos/workflow-run.mp4"></video>` to `guides/workflows.md`, under the editor section;
   - build `docs-site`.
   Pushing publishes the docs, so ask first.
3. Next shots:
   - D7 MCP import and D8 shortcuts, which need no model.
   - D1 model download (network) and D2 first chat.
   - Then D4, D5 and D6, after the decisions above.
