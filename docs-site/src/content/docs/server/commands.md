---
title: Server commands
description: Everything local-cognitive-server can do, from the console to updates and rollback.
---

All commands run with `sudo`. In a terminal, `sudo local-cognitive-server` on its own opens the **console**: the server's status, a live view of its work, and these commands in a menu.

![The console of a server with a GTX 1070 Ti: its commands, and status with a model loaded on the GPU](../../../assets/screens/server-console.png)

## Everyday

| Command | What it does |
| --- | --- |
| `sudo local-cognitive-server` | The console |
| `sudo local-cognitive-server pair` | A one-time key for another computer of your account |
| `sudo local-cognitive-server status` | Running? Reachable? How many computers? CUDA or CPU, and why |
| `sudo local-cognitive-server devices` | The computers that can connect |
| `sudo local-cognitive-server revoke-device <id>` | Remove a computer's access |
| `sudo local-cognitive-server logs` | Follow the service log (`journalctl`) |
| `sudo local-cognitive-server restart` | Restart the service; `stop` and `start` too |

## Updates

| Command | What it does |
| --- | --- |
| `sudo local-cognitive-server update` | Install the newest signed release, with a backup and an automatic rollback if it fails |
| `sudo local-cognitive-server rollback` | Go back to the previous release and the data from before the update |
| `sudo local-cognitive-server version` | The installed version |

`update` asks before it starts; add `--yes` to skip the question, or `--wait` to wait for running work to finish instead of refusing. See [Updates](/reference/updates/) for what happens step by step.

## Data

| Command | What it does |
| --- | --- |
| `sudo local-cognitive-server backup` | Back up the data now |
| `sudo local-cognitive-server backups` | List the backups |
| `sudo local-cognitive-server restore <backup>` | Restore one |
| `sudo local-cognitive-server folders` | Folders on the server that connected computers may use for projects |

## GPUs and removal

| Command | What it does |
| --- | --- |
| `sudo local-cognitive-server cuda` | Install the CUDA runtime later (NVIDIA driver 570+) |
| `sudo local-cognitive-server sandbox` | Set up bubblewrap for Synthesis contract tests on a server installed before 0.1.3 (0.1.3 or later) |
| `sudo local-cognitive-server error-reports on` | Send the server's error reports to the developers; `off` stops it |
| `sudo local-cognitive-server uninstall` | Remove the server; its data and secrets key stay |

`uninstall` prints the commands that also delete the data, the key and the service user, if you want that.
