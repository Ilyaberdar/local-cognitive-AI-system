---
title: Voice input
description: Dictate messages with local speech recognition; audio never leaves your computer.
---

Voice input transcribes speech on your computer with **whisper.cpp**. The audio is not sent anywhere and is deleted after recognition.

## Dictate

1. Click the microphone beside **Send** and speak.
2. Press the checkmark to finish. The text is added to your draft.
3. Read it and press **Send** when it's right.

**Esc** or the cross cancels the current dictation and keeps the rest of your draft. A recording can be up to five minutes long.

## Settings

The small arrow beside the microphone opens voice settings (also **Settings → Voice**):

- **Higher accuracy:** Whisper Large v3 Turbo, about 1.5 GB.
- **Faster:** Whisper Small, about 465 MB.
- **Language:** Auto, or a fixed language, which helps with short phrases full of technical names.
- **Choose microphone…** to pick an input device.

The model downloads once, on first use, and is checked by SHA-256.

## Microphone access

The first dictation asks for microphone access. If it was denied, choose **Microphone permissions** in voice settings, allow Local Cognitive in the system's privacy settings, and restart the app.
