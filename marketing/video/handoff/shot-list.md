# Shot list

## Common setup for every capture

- **Build:** the development build at HEAD. Run `npm run build` in the app repo first if `dist/` is older than the last commit.
- **Launch:** `scripts/capture/app.mjs` with a fresh profile: `.profiles/<shot id>`.
- **Window:** content area 1600×1000 points, Retina ×2.
- **Appearance:** light theme, Text size 115%.
- **Profile:** "Local profile", with no name and no avatar.
- **Recording:**
  - Primary: `screencapture -v -k` of the window rectangle, with the real cursor and clicks.
  - Fallback: Chromium screencast frames turned into constant 30 fps.
  - Raw files go to `public/captures/<shot id>.mov` with an action log in `<shot id>.json`, which holds the timestamp of each scripted step.
- **Input:** Playwright drives the real UI. It types with a 35–60 ms delay per key, moves the pointer in 25–40 steps and pauses 600–900 ms before each click, so viewers can follow.
- **Cuts:** wherever waiting is cut, the edit adds `<SpeedBadge>` for that stretch (see `brief.md`, rule 2).

## Docs demos

| Id | Page | Needs | Length |
|---|---|---|---|
| D1 | `start/first-steps.md`, `guides/models.md` | Network (Hugging Face) | ~30 s |
| D2 | `start/first-steps.md`, `guides/chats.md` | The model from D1 | ~25 s |
| D3 | `guides/workflows.md` | Nothing (no model, no network) | ~35 s |
| D4 | `guides/synthesis.md` | A 7B+ model (Qwen3.8-27B Q4); macOS sandbox; Node 22.18+ | ~40 s |
| D5 | `server/connect.md`, `guides/remote.md` | Account sign-in by the owner, fedora, owner OK to pair | ~40 s |
| D6 | `guides/chats.md` (access and approvals) | A 7B+ model with tool use; a demo project folder | ~35 s |
| D7 | `guides/mcp-and-plugins.md` | Nothing | ~25 s |
| D8 | release notes 0.1.4 / a future shortcuts section | Nothing | ~20 s |

### D1: Find and download a model

1. **Models.**
   - Label: "Models from Hugging Face".
2. **Catalog → search "Qwen2.5 1.5B Instruct"** and open the result.
   - Zoom 1.4× on the fit estimate (memory and disk for this Mac).
   - Label: "Checked against this Mac before downloading".
3. **Pick Q4_K_M → Download.**
   - The progress card shows size, %, speed, Pause and Resume.
   - Press Pause, then Resume. This proves the controls work.
4. **Wait to the end.**
   - Cut: badge "Download shortened: <real> → <shown>".
5. **"Checking file integrity" (SHA-256) → On device.**
   - The model appears in the list.
   - End on the model card.

The recording ends with a model on disk. D2 reuses this profile.

### D2: First chat with a local model

1. **On device → model → Use in chat.**
2. **Type:** "Explain what a GGUF file is in two sentences." Press **Enter** to send.
3. **Streaming answer.**
   - Zoom 1.3× on the answer while it streams.
   - Real time if it is under 8 s; otherwise "Sped up N×".
4. **End on the finished answer and the model label in the composer.**
   - Label: "Runs on this Mac".

### D3: Workflow with live console and approval (first shot to make)

**Setup (disclosed):** seed `examples/workflow-console-demo` into the profile through the app API: `POST /projects`, `POST /workflows`, then `POST /tasks`, as in the example README. The project folder is a copy under the profile, `~/…/.profiles/D3/demo-project`, so `demo-output.txt` is written there.

1. **Workflow → Tasks → "Workflow Console Demo".**
   - The task card is visible.
   - Label: "A task runs a workflow".
2. **Open the workflow → ▶ Run.**
   - The nodes light up one by one.
   - Zoom 1.5× on the Console as stdout lines arrive every 2 s, including the stderr line.
3. **The run stops at the Review step**, which shows "Approve & continue".
   - Label: "Waits for you".
4. **Click Approve & continue.**
   - The run reaches the terminal node: Done.
5. **End on the finished graph and the last console lines.**
   - Optionally show `demo-output.txt` with `WORKFLOW-CONSOLE-DEMO-OK` in the Review panel, if the app can open it there.

**Real duration** is about 20 s plus the approval, so no cuts are needed.

### D4: Synthesis until the checks pass

**Setup (disclosed):** a demo project with the `examples/synthesis-calculator` contract (`Calculator7B`) or the "Rate limiter (TypeScript, with tests)" template. Qwen3.8-27B Q4 is imported into the profile.

1. **Synthesis → module → Contract tab.**
   - Zoom on the contract.
   - Label: "The contract and its checks".
2. **Run synthesis.**
   - Agent activity starts.
   - Cut with the badge "Sped up N×" or "<real> → <shown>".
3. **The gates panel shows failures from an early iteration**, if the real run produced any; never staged. Then all checks pass and the run shows **Accepted**.
4. **Changes → Apply verified patch.**
5. **End on the applied patch.**

**Risk:** a run takes minutes and may fail. Re-take until a real run passes, and keep the failed takes out of the edit unless they serve as "failed checks go back to the agents".

### D5: Connect your GPU server

**Owner first:** sign in to the account in the D5 profile and approve pairing.

1. **Terminal**, recorded separately in the same style: SSH to the server, then `sudo local-cognitive-server pair` prints the one-time `LCR1-…` key.
   - The key is blurred or stays on screen only until it is used. It is single-use.
2. **App: Remote → Connect a server → paste the key → Connect.**
   - The server appears under "Your servers" with its state, backend (CUDA) and models.
3. **Top-right switch: "This computer" → the server's name.**
   - Send a chat message; the answer comes from the server.
   - Label: "Running on your GPU server".
4. **End on the answer with the server name visible.**

### D6: Approval before a file change

**Setup (disclosed):** project folder `~/Demo/notes-app`, a tiny JS project; Code mode; access set to "Ask for approval".

1. **Ask:** "Add a function `slugify(title)` to `src/text.js` with a test."
2. **An approval card appears** with the exact path and contents.
   - Zoom on it.
   - Label: "You approve every write".
3. **Approve → Review tab shows the changed file.**
4. **End on the diff.**

### D7: Import MCP servers

1. **Settings (⌘,) → MCP Servers → Import.**
2. **"Or paste a snippet"** with a JSON block for one MCP server (e.g. the filesystem server over `~/Demo`) → **Preview → "Servers found"**.
3. **Import selected → "Imported 1 server."**
   - The server appears with its approval setting.

### D8: Keyboard shortcuts

1. **Settings → Keyboard Shortcuts.**
2. **Change "New chat" to a new key.**
   - Press ⌘Q.
   - A refusal appears with the reason. Zoom on it.
3. **Pick a free key → saved.**
4. **Press it → a new chat opens.**
5. **Reset.**

## Promo (40 s, 1200 frames at 30 fps)

Draft voice-over: 84 words, about 34 s of speech at 150 wpm. The rest is breathing room on the open and end cards. The voice is decided with the owner (ElevenLabs).

| # | Time | Frames | Picture | Voice-over / subtitle |
|---|---|---|---|---|
| P1 | 0.0–3.5 | 105 | Title card: logo, "Local Cognitive", "Private AI on your own machines." | "This is Local Cognitive: private AI on your own machines." |
| P2 | 3.5–11.0 | 225 | D2 take with Qwen3.8-27B: the typed question, then the streaming answer. Zoom on the answer. | "Chat with models that run on your own computer. Prompts and answers stay there." |
| P3 | 11.0–17.0 | 180 | D1: the fit estimate, then the download card. Badge on the shortened download. | "Pick any model from Hugging Face. Memory is checked before the download." |
| P4 | 17.0–24.0 | 210 | D3: nodes lighting up, console lines, Approve & continue, Done | "Chain agents, files and commands, and watch every step run." |
| P5 | 24.0–31.0 | 210 | D4: failing checks, then Accepted. Badge "Sped up N×". | "Synthesis sends failed checks back to the agents until the code passes its contract." |
| P6 | 31.0–36.5 | 165 | D5: switch to the server, answer streaming "on <server>" | "Connect your own GPU server with one key, end-to-end encrypted." |
| P7 | 36.5–40.0 | 105 | End card: logo, "macOS · Windows · Linux GPU server", "local-cognitive.com" | "Get it at local-cognitive.com." |

**Subtitles**
- They come from the ElevenLabs character timestamps (the `with-timestamps` endpoint), turned into `Caption[]` for `@remotion/captions`.
- One line at a time, in the band under the window.
- A `.vtt` file is exported for the `<video>` track.

**Claims check:** every line matches the docs or landing copy.
- "end-to-end encrypted": landing `#server` and `guides/remote.md`.
- "Memory is checked": `guides/models.md`.
- "Prompts and answers stay there": landing `#privacy`. True for local models.
