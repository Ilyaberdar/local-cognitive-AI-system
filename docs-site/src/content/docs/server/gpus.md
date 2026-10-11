---
title: NVIDIA GPUs
description: The CUDA runtime on the server, several GPUs, and what to check when models run on the CPU.
---

## The CUDA runtime

The server runs models with llama.cpp. On a machine with an NVIDIA GPU it uses a CUDA build:

- built for every architecture from Maxwell to Blackwell (compute capability 5.0 to 12.0), so any card from a GTX 900 to an RTX 50 works;
- shipped with NVIDIA's CUDA runtime and cuBLAS libraries (CUDA 12.8), installed by the installer or by `sudo local-cognitive-server cuda` after you accept NVIDIA's license;
- needs NVIDIA driver 570 or newer; the CUDA toolkit is not needed.

Updates carry the CUDA runtime over to the new release.

## Several GPUs

Every GPU gets its device file when the service starts, so the server sees all of them. In the app, **Models → GPUs** (with the server selected) sets how they are used:

- **Different models on different GPUs.** Each loaded model runs in its own process and sees only its own GPUs.
- **One model across several GPUs.** A model too large for one GPU is split over the smallest set of GPUs it fits on, two to eight:
  - **by layers** (any GPUs): each GPU holds whole layers, in proportion to its free memory;
  - **by rows** (CUDA): every layer is divided, which can be faster with a fast link between the cards (NVLink); the main GPU also keeps the context.
- **Split a model across GPUs:** only when it doesn't fit one GPU, always, or never.
- **GPUs models may use:** leave some GPUs to other programs.
- **A model's own GPUs:** pin a model to chosen GPUs.
- **Rebalance:** load the loaded models again by these settings, the largest first, once their running requests finish. Nothing is moved or unloaded on its own.

If a load runs out of memory, the server tries once more with the next layout and a larger margin.

:::caution
Splitting across GPUs has not been validated on multi-GPU hardware yet. If something looks wrong, [report it](/reference/troubleshooting/#reporting-a-problem).
:::

On cards connected by PCIe x1 risers, keep the split **by layers**: splitting by rows sends much more data between the cards.

## When models run on the CPU

`sudo local-cognitive-server status` shows the backend and, if it is the CPU, why:

| Reason | What to do |
| --- | --- |
| No CUDA runtime installed | `sudo local-cognitive-server cuda` |
| Driver older than 570 | Update the NVIDIA driver, reboot, then `cuda` |
| The driver does not answer | Reboot after a driver update; check `nvidia-smi` |
| An NVIDIA GPU was found, but CUDA cannot use it | Update the driver; check `nvidia-smi` lists the GPU |
