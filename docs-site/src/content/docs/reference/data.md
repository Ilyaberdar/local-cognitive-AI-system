---
title: Your data and privacy
description: Where Local Cognitive keeps your data, what reaches the Cloud, and how error reports work.
---

## Where your data lives

| | Data | App |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Local Cognitive` | `/Applications/Local Cognitive.app` |
| Windows | `%LOCALAPPDATA%\Local Cognitive` | `%LOCALAPPDATA%\Programs\Local Cognitive` |
| Linux server | `/srv/local-cognitive` | `/opt/local-cognitive/current` |

**Settings → Data & Privacy** sets the folder for files written in chats, the folders the built-in file tools may use, and error reports. **Settings → Local Runtime** moves model storage to another folder; models are copied and checked before the switch, and the old files stay as a backup. **Open data folder** in the profile menu opens the data folder.

Inside the data folder:

| Path | What it holds |
| --- | --- |
| `sessions/`, `memory/` | Chats and long-term memory |
| `models/` | Downloaded models |
| `app/settings.json` | Settings |
| `app/runtime/host.db` | Work in progress, the token ledger, Remote access (SQLite) |
| `app/runtime/api-token` (a server, a run from source) | The key of the local HTTP API, readable only by its owner; a server removes it when it stops |
| `app/integrations/vault/` (the app), `app/integrations/host-vault/` (a server) | Encrypted secrets: provider API keys and the Telegram bot token, sign-in, Remote keys, plugin and MCP tokens |
| `app/diagnostics/` | A small technical log of event codes, without text from your chats |
| `output/` | Files the app wrote for you |

Secrets are encrypted, and `app/settings.json` names each provider key and the bot token only by a reference. On a Mac the encryption key is kept in the Keychain, on Windows by the system's data protection for your account, and on a server in `/etc/local-cognitive/vault.key`, outside the data folder. On a Mac, a run from source (the development window, `npm start`, `npm run mcp:stdio`) keeps its secrets in `app/integrations/dev-vault/`, with its key in `~/.config/local-cognitive/dev-vault.key`: any program running as you can read that file, and so the secrets. The encryption protects keys in a copy of the data folder or a backup without that key; a program running as your user on Windows, or as the server's account on Linux, can still decrypt them.

A saved key is sent only to the host (origin: scheme, host and port) it was saved for: when you move a provider to another host, enter its key again; another path on the same host keeps it. Keys set in the environment (a server's `/etc/local-cognitive/server.env`, or `.env` for a run from source) stay there as written and are never copied into the settings; a key saved in Settings is used instead of one from the environment. Version 0.1.9 and earlier kept keys in `settings.json`: they move to the vault at the first start where it can be used, and are removed from the `settings.pre-*.json` archives of earlier updates too, but not from backups or copies made before. A Notion key saved by a development build from before the first release stays, in plain text, in `app/settings.pre-integrations.json`, the recovery copy of the change that replaced that plugin: delete the file if you do not need it.

## What reaches the Cloud

The Cloud at `api.local-cognitive.com` handles accounts, servers, devices, permissions and the Remote relay. It stores:

- your account (from sign-in), your servers and computers, and which computer may use which server;
- one-time Remote tickets, stored only as hashes;
- token counts per model, provider, computer and day, for **Usage**.

It never receives prompts, answers, files or model output. Remote traffic passes through the relay [encrypted end to end](/guides/remote/#how-the-connection-works).

Local chats with local models work without an account and without the Cloud.

## Cloud models

When you choose a cloud provider (OpenAI, Anthropic, Gemini or Qwen), that chat's messages go to that provider under its terms, directly from your computer or server. Qwen runs on Alibaba Cloud in the region your key belongs to: Singapore by default, which serves from outside mainland China; the China (Beijing) region serves from mainland China.

## Error reports

Error reports and crash dumps go to Sentry (EU region) only if you turn on **Send error reports and crash dumps** in **Settings → Data & Privacy**. Only a short list of technical details leaves: error codes, stack frames without variables, and error messages cut short with paths, addresses and keys masked. **Report a bug** sends when you press Send, with exactly what its preview shows. A server's error reports are its owner's choice: `sudo local-cognitive-server error-reports on` or `off`.
