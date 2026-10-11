---
title: Install on macOS
description: Install Local Cognitive on a Mac with Apple silicon.
---

Local Cognitive for macOS runs on Apple silicon (M1 and later) with macOS 13.3 or later. Models use the GPU through Metal and share the Mac's unified memory.

## Install

1. Open the [latest release](https://github.com/Ilyaberdar/local-cognitive-AI-system/releases/latest) and download `Local-Cognitive-<version>-arm64-mac.dmg`.
2. Open the dmg and drag **Local Cognitive** to **Applications**.
3. Start it from Applications.

The app is signed with a Developer ID and notarized by Apple, so macOS opens it without warnings.

:::caution
Run the app from Applications, not from the dmg. Updates can't install into an app that runs from the disk image.
:::

## Microphone

Voice input asks for microphone access the first time you dictate. If you denied it, open voice settings (the arrow beside the microphone) and choose **Microphone permissions**, then allow Local Cognitive in System Settings → Privacy & Security → Microphone and restart the app.

## Updates

New versions show a button in the title bar and one notification. Choose **Update** and the app restarts into the new version. See [Updates](/reference/updates/).

## Uninstall

Quit the app and move it to the Trash. Your chats, models and settings stay in `~/Library/Application Support/Local Cognitive`; delete that folder to remove them too.
