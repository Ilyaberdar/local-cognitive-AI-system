---
title: Updates
description: How the app and the server learn about new versions and install them.
---

Releases are published on [GitHub](https://github.com/Ilyaberdar/local-cognitive-AI-system/releases). The [release notes](/reference/release-notes/) say what each one brings.

## The app

The app checks for a new version 10–30 seconds after it starts, then every 6 hours, and soon after the computer wakes if a check is due. It only checks; nothing downloads or installs without you.

When a new version is out:

- a button **Update to X** appears in the title bar, and one system notification is shown per version;
- **Settings → About** shows what's new, and lets you check, download and **Restart and update**.

### macOS

The update downloads in the background and installs when you restart. macOS accepts it only with the same Developer ID signature as the installed app, so a tampered update is refused. The app must run from Applications, not from the dmg.

### Windows

Until the installer is code-signed, the app announces new versions and links to the release page instead of installing them: Windows could not verify an unsigned update's publisher. Download the new installer and run it; it installs over the old version and keeps your data, models and CUDA.

## The server

Once a day the server checks for a new release and shows it in **Remote** with its notes and the command to install it. It installs nothing on its own.

```bash
sudo local-cognitive-server update
```

What happens:

1. **Check:** the release manifest's Ed25519 signature, the version, the download's size and SHA-256, and the archive's contents.
2. **Prepare:** the new release is unpacked next to the running one, starts once as a self-check, and takes over the CUDA runtime.
3. **Wait:** if computers have work running, the update refuses; `--wait` waits for it to finish instead.
4. **Back up:** the service stops after finishing accepted work, and the data is backed up (models and outputs excepted; the last three backups are kept).
5. **Switch and check:** `current` points at the new release, the service starts, and the update waits until it reports the new version and is running.
6. **Roll back on failure:** if anything fails, the previous release and the backed-up data come back by themselves.

`sudo local-cognitive-server rollback` goes back by hand. The previous two releases stay on disk.

## Versions that talk to each other

The app and the server agree on a protocol version when they connect. If one of them is too old, the app says which one to update instead of failing later.
