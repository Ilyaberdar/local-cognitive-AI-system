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
| `sudo local-cognitive-server api-token` | The key of the server's own HTTP API on `127.0.0.1:3000` (new at every start) |

The server's HTTP API listens only on the server itself (`127.0.0.1`, port 3000 unless `--http-port` sets another) and answers only requests with its key, except `/health`. A script running on the server sends it as a header:

```bash
curl -H "Authorization: Bearer $(sudo local-cognitive-server api-token)" http://127.0.0.1:3000/sessions
```

The key changes at every start and is kept in `app/runtime/api-token` in the data folder, readable only by the server's user, until the server stops. Other users of the machine, and programs running as them, cannot use the API; a program running as the server's user can still read the key. Computers connected through Remote need no key.

## Synthesis

| Command | What it does |
| --- | --- |
| `sudo local-cognitive-server cloud-models` | The server's projects, and whether each may use cloud models in Synthesis |
| `sudo local-cognitive-server cloud-models allow <project>` | Let the project's flows send its contract and files to the cloud providers they name; hidden tests stay on the server |
| `sudo local-cognitive-server cloud-models deny <project>` | Back to the server's local models; a run in progress stops at its next cloud request |
| `sudo local-cognitive-server web-targets` | The server's projects, and the web origins each project's Synthesis agents may reach |
| `sudo local-cognitive-server web-targets allow <project> <url> [<url>…]` | Let the project's agents make web requests to these origins (replacing its list), for authorized testing of your own services |
| `sudo local-cognitive-server web-targets deny <project>` | Clear the list: the project's agents can make no web requests |
| `sudo local-cognitive-server deps <project>` | Install the project's npm dependencies once (`npm ci` with its lock file), so agents can run `npm test` in it |

Agents never install packages: their terminal has no network. `deps` does it for them, as the server's user, from the project's `package-lock.json`. It runs npm in a folder of the server's, never in the project (whose `.npmrc` is ignored), installs only packages from npm's registry (or the one set as `npm_config_registry` in the environment file), and runs no install scripts unless you add `--scripts`. Run it again after the lock file changes.

Name the project by its id, its name or its folder (an absolute path). Its name and folder were usually chosen on a computer, so the command never guesses: an id is looked up only among ids and a path only among folders; a name two projects share, even in different letter case, is refused with their ids to choose from, and so is a folder reached through a link. After a change it prints the project's id, folder and where it was made. A connected computer shows the project's choice at the bottom of its Synthesis screen but can't change it. The console has the same command.

## Cloud providers

A server's chats, agents and Synthesis can use every cloud provider the app knows:

- **From your computer:** with the server selected, **Settings → Models & Providers → Add provider** adds DeepSeek, OpenRouter, Groq or Perplexity to the server. You enter the key; the server uses its own address for the service, tests it, and keeps the key (no device can read it back). Added providers can be renamed or removed there.
- **In the server's environment file** (`/etc/local-cognitive/server.env`, then `sudo local-cognitive-server restart`): `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `QWEN_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY` or `PERPLEXITY_API_KEY`. A provider set there is changed there: computers see it but cannot remove it or change its key.
- **Any other OpenAI-compatible service**, only in the environment file: `LOCAL_COGNITIVE_PROVIDER_<ID>_BASE_URL` with `_API_KEY` and `_MODEL` (and optionally `_NAME`). Its id is `<ID>` in lower case, with `-` for `_`. A service that takes no key still needs one: any value. An entry that is not valid is left out, and `sudo local-cognitive-server logs` says why.

## GPUs and removal

| Command | What it does |
| --- | --- |
| `sudo local-cognitive-server cuda` | Install the CUDA runtime later (NVIDIA driver 570+) |
| `sudo local-cognitive-server sandbox` | Set up bubblewrap for Synthesis contract tests on a server installed before 0.1.3 (0.1.3 or later) |
| `sudo local-cognitive-server error-reports on` | Send the server's error reports to the developers; `off` stops it |
| `sudo local-cognitive-server uninstall` | Remove the server; its data and secrets key stay |

`uninstall` prints the commands that also delete the data, the key and the service user, if you want that.
