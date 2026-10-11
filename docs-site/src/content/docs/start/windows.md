---
title: Install on Windows
description: Install Local Cognitive on Windows x64, with Vulkan on any GPU and CUDA on NVIDIA.
---

Local Cognitive for Windows runs on Windows 10 and 11, x64.

## Install

1. Open the [latest release](https://github.com/Ilyaberdar/local-cognitive-AI-system/releases/latest) and download `Local-Cognitive-Setup-<version>.exe`.
2. Run it. It installs for your user only and needs no administrator rights; you can keep the suggested folder.
3. The installer is not code-signed yet, so SmartScreen shows **Windows protected your PC** once. Choose **More info**, then **Run anyway**.

The app installs to `%LOCALAPPDATA%\Programs\Local Cognitive` and keeps your data in `%LOCALAPPDATA%\Local Cognitive`.

## GPU acceleration

Models run on any GPU through **Vulkan**, which ships with the app. Integrated graphics are skipped, since they share system memory.

On a PC with an **NVIDIA** GPU, the app offers the faster **CUDA** build at first launch:

- It downloads about 515 MB after you accept NVIDIA's license, resumes if the connection drops, and checks every file.
- The app picks the build for your card and driver: CUDA 13.3 for RTX 30, 40 and 50 series with driver 580 or newer, otherwise CUDA 12.4.
- Loaded models switch to CUDA without a restart. If the CUDA build can't see the GPU, models stay on Vulkan and the app says why.

If you skip the offer, it stays in **Settings → Local Runtime**, where you can also remove CUDA again.

## Updates

The app tells you about a new version in the title bar and with one notification. Until the installer is code-signed, it doesn't install updates itself: download the new installer from the release page and run it over the old one. Your data, models and CUDA stay where they are.

## Uninstall

Use **Settings → Apps → Installed apps → Local Cognitive → Uninstall**. Your data stays in `%LOCALAPPDATA%\Local Cognitive`; delete that folder to remove it too.
