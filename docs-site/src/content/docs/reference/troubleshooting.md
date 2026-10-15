---
title: Troubleshooting
description: Common problems with models, GPUs, Remote, Synthesis and updates, and how to fix them.
---

## Models

**"This file stores weights in a format (tensor type N) that the local runtime cannot read"**
: The file was made for a modified llama.cpp (for example Prism ML's PQ2_0). Choose another quantization of the model. **Dismiss** clears the error.

**"The local runtime does not support the X model architecture yet"**
: The model is newer than the bundled llama.cpp. A later release will support it.

**"Not enough GPU or system memory to load this model"**
: Unload other models, lower the context size in the model settings, or choose a smaller quantization.

**A model loads slowly or answers slowly**
: Check the strip at the top of Models. If part of the model is in RAM, a smaller quantization that fits the GPU is much faster.

**"This local model has no vision adapter"**
: Images need a vision model. Download a variant with an `mmproj` file, or attach one with **Add vision adapter**.

## GPUs

**Windows uses the integrated GPU or the CPU**
: Integrated graphics are skipped on purpose. On an NVIDIA PC, install CUDA from **Settings → Local Runtime**; if it can't use the GPU, the card shows why (usually an old driver).

**The server runs models on the CPU**
: `sudo local-cognitive-server status` says why. See [NVIDIA GPUs](/server/gpus/#when-models-run-on-the-cpu).

**A new GPU in the server is not used**
: Reboot after installing it, then check `nvidia-smi` and **Models → GPUs**.

## Remote

**The server shows as offline**
: Run `sudo local-cognitive-server status` on the server. It needs outbound HTTPS to `api.local-cognitive.com`; `logs` shows connection errors.

**"Update Local Cognitive on the server to chat"**
: The server is older than the app. Run `sudo local-cognitive-server update`.

**The connection key doesn't work**
: Keys expire after 10 minutes and work once. Run `pair` again. Check that you're signed in to the account that owns the server.

## Synthesis

**"No provider X is set up here" or "X has no key or is turned off"**
: The flow names a provider this computer doesn't have ready. Add it, or enter its key and turn it on, in **Settings → Models & Providers**, then **Refresh** the module.

**"This project does not allow cloud models"**
: Switch on **Cloud models** at the bottom of the Synthesis workspace, on the computer that owns the project. For a project on a paired server, run the command the message names on the server: `sudo local-cognitive-server cloud-models allow <project>`.

**"sandbox-exec does not isolate on this Mac" or "bubblewrap does not isolate here"**
: Before running tests or an agent's terminal, the app checks that its sandbox really isolates: a process inside it tries to read a file outside its folders, write outside its work folder and reach a local port. One of these succeeded, so nothing runs: tests are Unknown, and a terminal is refused. On Linux, run `sudo local-cognitive-server sandbox` on a server, or check that bubblewrap is installed and user namespaces are allowed. On a Mac, [report it](#reporting-a-problem) with the message.

**"Agents with a terminal need a sandbox, and this computer has none that works"**
: The run stops before any agent starts, and the rest of the message says why. On Windows, which has no sandbox yet, agents can't run commands: remove `terminal(...)` from their tools, or run the flow on a Mac or a Linux server. On Linux, install bubblewrap (on a server, `sudo local-cognitive-server sandbox`).

**A terminal command is refused**
: The message says why: the command isn't in the agent's `terminal(allow = [...])`; `git` only reads history; `npm` only runs `test`, `run` and `ls`; a contract with hidden tests leaves the git history out of the copy; or the files the agent may read are over 512 MB, so narrow its `files.read` patterns.

**An agent's npm test says "Cannot find module"**
: The project's dependencies are not installed, and agents never install them (their terminal has no network). Run `npm install` in the project on your computer, or on a server `sudo local-cognitive-server deps <project>` once (again after the lock file changes).

**"npm is not installed on this computer"**
: The terminal uses the Node.js and npm installed on your computer: install Node.js 22.18 or later (from nodejs.org, Homebrew or nvm). A server brings its own.

**An agent fails with a timeout**
: A request to its model took longer than 10 minutes, the most an agent's request may take. Some models hosted by Perplexity (Kimi, GLM) are this slow on big tasks: give agents smaller tasks or a faster model.

**An agent fails because its model doesn't answer with an action**
: Agents on an added provider choose each action in JSON, and some models don't keep to it: in our tests, Perplexity's presets (`fast` to `xhigh`) and `openai/gpt-5.4-nano` through Perplexity. Name a hosted model such as `openai/gpt-5-mini` or `anthropic/claude-haiku-4-5`, or use DeepSeek.

**Agents slow down, or the provider answers 429**
: The provider limits how many requests it takes. The run sends it fewer at once and repeats a refused request after the pause the provider asks for, without spending the agent's turns. If it stays slow, lower `concurrency` in `parallel_map`.

**A report fails `Grounded`**
: The report cites a file or line that doesn't exist. Feed the failures back with `synthesize(..., feedback = verdict.violations)` in a loop (the **Repository review** template does), and allow enough `iterations` for it.

## Updates

**The Mac says it can't install the update**
: Move the app to Applications and start it from there; updates can't replace an app running from the dmg.

**Windows doesn't install updates itself**
: Expected for now: download the new installer from the release page. See [Updates](/reference/updates/#windows).

## Reporting a problem

Use **Report a bug** (the bug button in the title bar, or **Settings → Report a bug**). With error reports turned on in **Settings → Data & Privacy**, the report carries the diagnostics that help find the cause. You can also [open an issue on GitHub](https://github.com/Ilyaberdar/local-cognitive-AI-system/issues).
