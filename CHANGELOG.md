# Changelog

## 0.1.7 — 2026-10-21

Synthesis with cloud models and agents in parallel: tens of agents on one task, with file rights set in the flow, checkouts as in Perforce, and a terminal in a sandbox.

### Synthesis

- **Cloud models in flows.** With `policy = "cloud-files-v1"`, a flow uses any provider from Settings → Models & Providers next to your local models, for example `model("deepseek-flash", provider = "deepseek")`. A project sends nothing to the cloud until you switch on **Cloud models** for it, on the computer that owns it; hidden tests never leave. The module lists what Run would refuse, and the run checks the key and the switch again before every call. The Models panel shows each model's provider and the run's tokens.
- **Agents in parallel.** With `policy = "agents-v1"`, `agent(...)` makes an agent with file rights set by path (`files.read("src/**")`, `files.write("notes/**")`, `files.delete(...)`), and `parallel_map` runs up to 64 at once and 1,000 tasks a run. `split` has a model divide a goal into tasks, and `synthesize` writes one file from their results. Agents write only into the run: your project changes on **Apply verified patch**, which now also deletes the files the run deleted.
- **Agents that don't overwrite each other.** `own = true` gives each file to the agent that first writes it. Checkouts, as in Perforce (`file.checkout`, `file.submit`, `file.revert`, and `checkout = "required"`), keep an agent's changes its own until it submits. An agent waits for a held file only while it holds nothing, so two agents never wait on each other. Every agent reads the same version of a project file for the whole run.
- **A web request for agents (for authorized testing of your own services).** `http(allow = ["https://staging.example.com"])` gives an agent `http.request`, which the engine makes only to the allowed origins — the address is resolved and pinned, this machine and private, link-local and cloud-metadata addresses are refused, redirects stay within the allowlist, the body is capped, and the run has a request budget. No app credential rides along, and a secret header is recorded as `set`. The project must allow the targets: on the computer that owns the project, set them in the Synthesis footer (**Web targets**); on a server, `sudo local-cognitive-server web-targets allow <project> <url>…`. A paired device sees the list but cannot change it. An agent that also has a terminal may reach those same targets with a real tool from its sandbox (on macOS), through a loopback proxy that enforces the same allowlist, consent and budget; everything else on the network stays denied.
- **A terminal for agents.** `terminal(allow = ["node", "npm"])` lets an agent build and run tests as it works, in a sandbox and in a copy of what it may read: no network, at most 120 s a command, and `git` only reads. Before anything runs in it, contract tests included, the sandbox shows it isolates.
- **`Grounded`**, a gate that checks that every file and line a report cites exists. `synthesize(..., feedback = verdict.violations)` writes the report again until it holds.
- **Answers as notes:** `parallel_map(..., answer_file = "review/notes/agent-{n}.md")` saves the answer of an agent that wrote no file itself (small local models answer in text instead of writing their note) as that file, within the agent's own rights and never over another agent's file; the agent is told so before it answers, and the Agents tab marks the file "its answer".
- **Local agents share a model** through slots: `models.load(selected, slots = 6, context = 16384)` answers six agents at once, and the memory check plans for every slot.
- **The Agents tab** lists a run's agents with their model, steps, tokens, time and files, and shows the chosen agent's steps beside the list.
- **Changes shows each file the way it reads best.** The changed files are listed on the left, marked Added, Modified or Deleted; the chosen one shows its diff, its source with line numbers, or, for Markdown and JSON, the file formatted. In a report, every `path:line` it cites opens that place (a file of the run at the line, or the project's file, read-only, on the computer that owns the project), and the places `Grounded` found missing are marked. The HTML **Preview** is gone: nothing a model wrote runs in the app.
- **New module → Repository review (parallel agents):** four agents on one local model review `src/`, and the report is accepted when every file and line it cites exists.
- **Providers that limit requests:** when one answers 429, the run sends it fewer requests at once and repeats the refused one after the pause it asks for, without spending agents' turns. An agent's request may take up to 10 minutes.
- **The flow language** has lists and `for (item in list)`, `range(n)`, `list[i]`, `append(list, item)`, and `limit steps N` for long loops.
- **Fixes:** an agent with a terminal but no write rights (a reviewer that only reads and runs the tests) can run its commands; `npm test` in an agent's terminal works on a Mac; a contract test that times out no longer fails now and then when its processes have already ended; a report the model's output limit cut off is asked for again, half as long, instead of stopping the run after its agents' work (and a report is kept under 2,500 words also when the flow gives its own instruction); on Windows, a module whose agents have a terminal says so before Run.
- **Agents lose fewer turns to their reply's form**, from live runs of twenty DeepSeek agents. Several actions at once (a file.write and its final answer together): the first runs and the agent is told to send one at a time. An action without its `type` that names a tool is that tool call. Reasoning DeepSeek puts before its end-of-thinking marker is not taken for the answer. A refused reply is told what to send instead ("Your reply went on after its JSON object, so nothing ran…"; a call that names no tool hears which tools its arguments fit, "file.write or file.append") rather than a JSON or schema error; text before or after an action still never runs. An answer the connection cuts off midway ("terminated") is asked for again, as a refused connection is.
- **The Agents tab names a local model** as Models does (Qwen2.5-0.5B-Instruct-GGUF, not its file id), and with two models the run's tokens are marked as all models' total. Choosing a row below the list's fold, in Agents or Changes, scrolls that list only, not the whole screen.
- **Local models write whole files.** A model a flow loads without a context of its own gets 16,384 tokens, as much as memory allows, instead of the app's 4,096, so the contract, its tests and the other files fit beside the answer. An answer the model's token limit cut off is a failed attempt, never a candidate, and the next attempt is told to write a shorter file. An empty answer (a thinking model that stopped before writing) is asked for once more with room to think. When the model wrote none of the declared files, the run says so once instead of failing every gate on files that are not there, and the flow goes on to its next attempt.
- **`models.select` takes the most capable model the limit allows:** a preferred name first, then a file of more than about 3 bits a weight, then the larger file. It took the smallest one before. Choosing a 1–2-bit file shows a warning in the run's log.
- **A run waiting for a local model says so:** "Waiting for Qwen3.8-27B: in use by Synthesis · RateLimiter", and its badge reads Waiting for model; two runs on one model take turns. A running step shows its time so far, and a local model's tokens as it writes them.

### Models

- **The quantization offered first is Q4_K_M when it fits with room**, never just the smallest file. The Models window preselected a repository's smallest file, such as a 27B model's 1-bit IQ1_S on a 48 GB Mac. Files of about 3 bits a weight or less are marked "low quality", with what they cost, and the recommended file is marked.
- **Import GGUF** names a model after its file (NVIDIA-Nemotron-3-Nano-4B, not "Lmstudio Community_Nn"), and on APFS and btrfs it clones the file instead of copying it: an import takes no second copy's space.

### Server

- **Every cloud provider on a server.** From your computer, with the server selected, Settings → Models & Providers → Add provider adds DeepSeek, OpenRouter, Groq or Perplexity to the server: you enter the key, the server uses its own address for the service and tests it, and no device can read the key back. They can also be set in the server's environment file (`DEEPSEEK_API_KEY` and the others), with any other OpenAI-compatible service as `LOCAL_COGNITIVE_PROVIDER_<ID>_BASE_URL`. Chats, agents and Synthesis on the server use them like any provider.
- **npm in agents' terminals.** The server brings npm with its Node, so agents can run `npm test` and `npm run` there.
- **`sudo local-cognitive-server deps <project>`** installs a project's npm dependencies once from its lock file, for agents' npm test (agents never install). Only packages from the registry, no install scripts unless `--scripts`, and the project's own `.npmrc` is never read.

### Remote

- A paired computer sees the agents of a run on the server, and each agent's steps.
- **A server's Synthesis screen fits the window** as this computer's does: its lists, reports and code scroll inside their panes. It grew with its content before, so a long report's end or the last agents could not be reached.
- **Cloud models for a project on the server** are its owner's choice, made on the server: `sudo local-cognitive-server cloud-models` lists the projects, `allow <project>` and `deny <project>` change one (by its id, name or folder; also in the console). A computer shows **Cloud models: on** or **off** and can't change it, and Run says which command allows them.

### Known limits

- Windows has no sandbox yet: agents there can't use a terminal, and contract tests don't run.
- A flow's `cost` limit is recorded, not enforced: watch your spending in the provider's dashboard.
- Agents on an added provider choose actions in JSON, and some models don't keep to it, such as Perplexity's presets and `openai/gpt-5.4-nano`.

### Docs

- The Synthesis, Synthesis language, Models, Remote and Troubleshooting pages cover cloud models, agents, slots and the terminal.

## 0.1.6 — 2026-10-13

More cloud models, added in Settings, and code highlighted in more languages.

### Models & Providers

- **Qwen is built in** (Alibaba Cloud Model Studio, also called QwenCloud): Settings → Models & Providers → Qwen. Enter a key from QwenCloud and choose the region it was created in: Singapore by default, or the US, Hong Kong or China. A key works only in its own region.
- **Add provider.** DeepSeek, OpenRouter, Groq, Perplexity or any other service that speaks the OpenAI API. Its address and key are checked first by reading the models it offers; then the provider is added and tested, and you choose its model from that list. An added provider can be renamed or removed.
- **Perplexity** answers with web search through its new Agent API: its presets (fast to xhigh) and the OpenAI, Anthropic and Google models it hosts, all paid from your Perplexity balance.
- Replies name their provider as Settings does.

### Chat

- Code in C, C++, C#, Java, Kotlin, Swift, Go, Rust, PHP, Ruby, Lua, GLSL, INI and TOML, Dockerfile, PowerShell, CMake and Make is highlighted.

### Server

- Qwen is there too: set `QWEN_API_KEY` in the server's environment file, or set its key from your computer through Remote. Other providers are added on each computer for now.

### Known limits

- Agents on an added provider choose their actions in JSON rather than through the service's own tool calls, and only Qwen's answers appear as they are written.

## 0.1.5 — 2026-10-12

Answers you can watch being written, and GPU servers that keep their CUDA runtime.

### Desktop and server

- **Answers appear as the model writes them** in project chats, in Code mode, after subagents and in chats with a plugin or MCP server, as they already did in an ordinary chat. Only the answer is shown while it is written: never a tool call, its arguments, reasoning, a draft or a subagent's review. When the answer is done, it is shown fully formatted. This works for models that run in the app's own llama.cpp, on this computer or on your GPU server.

### Server

- **The CUDA runtime keeps working after updates.** An update copied the CUDA runtime from the previous release in a way that tied it to the release it was first installed into; once that old release was removed, every chat on the server failed with "Local runtime exited (127)". Updates now copy it intact, the service repairs such a runtime before it starts, and if it still cannot be used the server runs on the CPU and says why. Updating to this release repairs an affected server.

### Docs

- Short videos of the real app on the Models, Chats, Workflows, Synthesis and Remote pages, and a 40-second overview on the home page.
- Review steps in workflows are approved with **Approve** (the docs and examples said Approve & continue).

## 0.1.4 — 2026-10-11

Keys that do what Settings says, and Settings pages that look like one app.

### Desktop

- **Enter sends a message**, as Settings → Keyboard Shortcuts always said; Shift+Enter adds a new line. To keep Enter for new lines, choose **Send messages with → ⌘Enter** (Ctrl+Enter on Windows). Nothing is sent while an input method is composing a word, and Enter still picks an @mention.
- **Your own shortcuts.** Settings → Keyboard Shortcuts lets you change the keys for a new chat (⌘N), stopping a reply (Esc), dictation, Settings (⌘,), the sidebar (⌘\\), and Chat, Workflow, Synthesis, Models and Remote (⌘1–⌘5). Shortcuts work with any keyboard layout. Keys that menus, text editing or the system use are refused with the reason, and keys that belong to another action are moved only if you agree. Shortcuts are kept on each device.
- **Settings look the same everywhere.** An MCP server's Secrets is a card with the usual fields, and the Import box, the Voice page and plugin permissions match the other pages. Disabled controls look disabled.

## 0.1.3 — 2026-10-11

Synthesis tests on your own GPU server, and Local Cognitive's license.

### Synthesis

- **Contract tests run on a Linux server.** The server installer sets up bubblewrap, and the service may now create the namespaces its sandbox needs. Inside the sandbox, the code under test can no longer create user namespaces of its own (bubblewrap 0.8 or later).
- **A server installed before 0.1.3:** after updating, run `sudo local-cognitive-server sandbox` once. It installs bubblewrap and the service's new settings, then restarts the server; accepted work finishes first. On Ubuntu 24.04 and later it also turns on the distribution's AppArmor profile for bubblewrap.
- C++ tests on a server need a compiler: `sudo dnf install gcc-c++` or `sudo apt install g++`.

### Server

- `update` and `rollback` now run each release with its own service settings, so later changes arrive with updates. Settings you add with `systemctl edit` are kept.

### Desktop

- Light theme: the arrow next to the microphone no longer sits in an oval.

### License

- Local Cognitive is source available under the Elastic License 2.0. You may use, copy, change and share it; you may not offer it as a hosted or managed service or get around its license-key features. See [License](https://docs.local-cognitive.com/reference/license/).

### Known limits

- Tests don't run on Windows yet, which has no sandbox. The architecture gates work everywhere.

## 0.1.2 — 2026-10-11

Synthesis for real modules: a contract keeps a small local model on the architecture the engineer designed.

### Synthesis

- **Your tests decide.** `Tests(...)` runs the engineer's own tests, kept next to the contract, against every candidate in a sandbox: TypeScript and JavaScript (Node.js 22.18 or newer), Python 3, and C++20 built with AddressSanitizer and UndefinedBehaviorSanitizer. Each failure goes back to the model as an exact item: the test, the expected and actual values, and its file and line. `hidden = true` keeps a holdout set sealed.
- **Frozen interfaces.** `frozen "include/AbilitySystem.h"` marks a file the engineer wrote: the model reads it in every revision and cannot change it.
- **Architecture gates.** `Exports` checks the public shape, `Imports` what may depend on what (no `<thread>` in a game core, no `node:fs` in a domain layer), and `Forbid` what the code may not use, outside comments and strings.
- **More languages.** A module may be TypeScript, Python, C or C++, besides HTML, CSS and JavaScript. Replies in a code block labelled `c++` are no longer dropped.
- **A sandbox for every test run:** no network, writes only to its own folder, nothing read from your folders, and no other program to act for it: `sandbox-exec` on macOS, bubblewrap on Linux. The module's code may not reach into the test harness, and each result line is signed for its run.
- **To start:** New module → **Rate limiter (TypeScript, with tests)**. For C++, the [ability system example](https://github.com/Ilyaberdar/local-cognitive-AI-system/tree/main/examples/synthesis-ability-system) builds an engine-agnostic core in the spirit of Unreal's Gameplay Ability System against a frozen header.
- The gates panel lists every test with its result.

### Desktop

- **macOS 13.3 or later**, which the bundled model and speech runtimes need.

### Known limits

- Tests don't run on Windows yet, which has no sandbox, or on a Linux server, whose service may not create the namespaces bubblewrap needs. The architecture gates work everywhere.

## 0.1.1 — 2026-10-11

The first public release of Local Cognitive: private chats, agents and workflows with models on your own computer, or on your own GPU server through Remote.

### Desktop

- **macOS (Apple silicon).** Signed and notarized. New versions install from the app: the update button in the title bar, or Settings → About.
- **Windows (x64), new.**
  - Models run on any GPU through Vulkan. On a PC with an NVIDIA GPU, the app offers the CUDA build: about 515 MB, after NVIDIA's license.
  - The installer is not signed yet. Windows asks once (More info → Run anyway), and the app announces new versions with a link to this page.
- **Clearer model errors.** A model file that the bundled runtime cannot read now says why, for example a format made for a modified llama.cpp. The error can be dismissed.
- **Split models.** Models made of several GGUF files install and import.
- **GPU memory.** Models shows the GPU's memory beside RAM.
- **Server models in answers.** Answers from a server name the server's model.
- **Menus.** A click anywhere closes an open menu, the title bar included.

### Server (Linux)

- **Several NVIDIA GPUs.** The service sees every NVIDIA GPU: each one gets its device file when the service starts.
- **Install:**

  ```
  curl -fsSL https://github.com/Ilyaberdar/local-cognitive-AI-system/releases/latest/download/install.sh | sudo bash
  ```

- **Update:**

  ```
  sudo local-cognitive-server update
  ```
