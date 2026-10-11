---
title: Troubleshooting
description: Common problems with models, GPUs, Remote and updates, and how to fix them.
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

## Updates

**The Mac says it can't install the update**
: Move the app to Applications and start it from there; updates can't replace an app running from the dmg.

**Windows doesn't install updates itself**
: Expected for now: download the new installer from the release page. See [Updates](/reference/updates/#windows).

## Reporting a problem

Use **Report a bug** (the bug button in the title bar, or **Settings → Report a bug**). With error reports turned on in **Settings → Data & Privacy**, the report carries the diagnostics that help find the cause. You can also [open an issue on GitHub](https://github.com/Ilyaberdar/local-cognitive-AI-system/issues).
