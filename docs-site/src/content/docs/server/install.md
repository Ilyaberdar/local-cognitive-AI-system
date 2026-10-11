---
title: Install the server
description: Run Local Cognitive on a Linux machine with NVIDIA GPUs and use it from your computer.
---

The server is Local Cognitive without a window: the same chats, models, tasks and workflows, running as a service on a Linux machine. You use it from the app on your Mac or PC, from anywhere.

## Requirements

- **Linux x64 with systemd:** Ubuntu 22.04+, Debian 12+, Fedora 36+ or Amazon Linux 2023. That means glibc 2.34+, libstdc++ from GCC 12+ and OpenSSL 3.
- **Network:** outbound HTTPS only. You don't open ports or need a domain, a static address or a certificate; the server works behind NAT.
- **NVIDIA GPU, optional:** driver 570 or newer. Without one, models run on the CPU.
- **Disk:** about 1.5 GB for the server with the CUDA runtime, plus your models.

## Install

```bash
curl -fsSL https://github.com/Ilyaberdar/local-cognitive-AI-system/releases/latest/download/install.sh | sudo bash
```

The installer:

1. Downloads the newest release and checks its Ed25519 signature and checksums.
2. Installs it into `/opt/local-cognitive/releases/<version>` with its own Node runtime, and points `/opt/local-cognitive/current` at it.
3. Creates the service user `local-cognitive`, the data folder `/srv/local-cognitive` and the key that encrypts the server's secrets.
4. If it finds an NVIDIA GPU with driver 570+, it shows NVIDIA's license and installs the CUDA runtime (see [NVIDIA GPUs](/server/gpus/)).
5. Installs [bubblewrap](https://github.com/containers/bubblewrap), the sandbox [Synthesis](/guides/synthesis/) runs contract tests in (0.1.3 or later).
6. Starts the `local-cognitive` systemd service.
7. Prints a one-time key to [connect your computer](/server/connect/).

### Options

Pass them after `bash -s --`:

```bash
curl -fsSL https://github.com/Ilyaberdar/local-cognitive-AI-system/releases/latest/download/install.sh | sudo bash -s -- --cpu
```

| Option | What it does |
| --- | --- |
| `--cpu` | Skip the CUDA runtime; models run on the CPU. Add it later with `sudo local-cognitive-server cuda`. |
| `--data-dir <dir>` | Keep the server's data somewhere else than `/srv/local-cognitive`. |
| `--no-pair` | Don't print a connection key at the end. |
| `--yes` | Answer every question with yes, including NVIDIA's license. |

## What runs where

| Path | What it is |
| --- | --- |
| `/opt/local-cognitive/current` | The running release; `previous` is kept for a rollback |
| `/usr/local/bin/local-cognitive-server` | The [server command](/server/commands/) |
| `/etc/systemd/system/local-cognitive.service` | The service, run as `local-cognitive` with a locked-down sandbox |
| `/srv/local-cognitive` | Chats, models, settings and the work in progress (mode 700) |
| `/etc/local-cognitive/vault.key` | The key for the server's encrypted secrets, outside the data folder |

## Next

[Connect your computer](/server/connect/) with the key the installer printed.
