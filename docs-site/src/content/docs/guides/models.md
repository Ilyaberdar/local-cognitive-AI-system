---
title: Models
description: The catalog, the library on your disk, GPU acceleration, memory and file formats.
---

Local models run with a built-in **llama.cpp** (build b10809, the same on every platform). No other program is needed.

<video controls playsinline preload="none" poster="https://local-cognitive.com/media/docs/models-v1.jpg" aria-label="Models: a catalog model's memory estimate, then the installed Qwen3.8 27B checked against this Mac and opened in a chat"><source src="https://local-cognitive.com/media/docs/models-720-v1.mp4" type="video/mp4" media="(max-width: 900px), (pointer: coarse)" /><source src="https://local-cognitive.com/media/docs/models-v1.mp4" type="video/mp4" /></video>

*A real recording on an M4 Pro Mac, in real time. Nothing is downloaded in it.*

## Catalog

**Models → Catalog** has two sources:

- **Recommended:** a short list of small models to start with.
- **Hugging Face:** every public GGUF model. Open one to see its quantizations.

For each quantization, the app estimates the memory it needs (weights, context, the model's recurrent state and working space) and the disk space, and says whether it fits this computer, or the selected server.

Downloads can be paused and resumed and are checked by SHA-256. Models split into several GGUF files download and install as one. A vision model can come with a **vision adapter** (an `mmproj` file) for images.

## Library

**Models → On device** lists the downloaded models:

- **Load model** loads it into memory ahead of time; otherwise it loads on first use.
- **Unload** frees the memory and keeps the files.
- **Use in chat** selects it for the current chat; **Set default** for new chats.
- **Import GGUF** adds a model you already have, with all its parts.
- **Add vision adapter** attaches an `mmproj` file you downloaded yourself.

Installed models are also available to agents, workflow steps and Synthesis flows; a model that isn't loaded loads when a request needs it.

## Acceleration

| Platform | How models run |
| --- | --- |
| macOS, Apple silicon | Metal, sharing the Mac's unified memory |
| Windows | Vulkan on any GPU; CUDA 13.3 or 12.4 on NVIDIA, [installed from the app](/start/windows/#gpu-acceleration) |
| Linux server | CUDA 12.8 on NVIDIA; otherwise the CPU |

The strip at the top of Models shows the backend, the free memory (RAM and each GPU's VRAM) and the free disk space.

## Memory and placement

Each loaded model runs in its own process. Loading a model never unloads another one. The app places a model:

1. on one GPU if it fits, preferring an idle one;
2. across several GPUs if needed (see [NVIDIA GPUs](/server/gpus/#several-gpus));
3. partly on the GPU and partly in RAM;
4. on the CPU.

If nothing fits, the error says what would help: unloading models, a smaller context or a smaller quantization.

The gear in Models opens the model settings: context size, GPU layers, memory warnings, load and response timeouts, generation settings and GPUs. Saving reconfigures the runtime and unloads the loaded models; they use the new values when they load again. **Settings → Local Runtime** has the same settings and the folder where models are stored.

## Slots for parallel agents

A loaded model answers one request at a time. Synthesis agents running in parallel can share it through **slots**: in a flow, `models.load(selected, slots = 6, context = 16384)` loads the model to answer six requests at once, each with its own 16,384-token context.

- **Memory** is the model's weights once, plus one context for each slot. The memory check plans for all of them, and if they don't fit, the load is refused with the reason: choose fewer slots, a smaller context or a smaller quantization.
- **Up to 16 slots,** each with at least 512 tokens and all of them together at most 262,144. A loaded model keeps its slots: a flow that asks for no more than it has uses it as it is, and one that asks for more loads it again once the requests in progress finish.
- **Stopping one agent** frees only its own slot; the others keep working.

*Checked live: six agents on one Qwen3.5 4B (a 2.3 GB file) with six slots finished their reviews together in 78 s on an M4 Pro Mac.* See [Synthesis](/guides/synthesis/#agents-in-parallel).

## File formats

Standard llama.cpp quantizations work: F32, F16, BF16, the Q4 to Q8 families, the K-quants, the IQ quants, TQ1_0 and TQ2_0, MXFP4 and others.

Some repositories publish files made for a modified llama.cpp, for example Prism ML's `PQ2_0` and `PTQ1_0`. These can't load; the app shows which tensor type it can't read. Choose another quantization of the model.

Projector and encoder-only files (such as `mmproj` or embedding models) aren't chat models and can't be used on their own.
