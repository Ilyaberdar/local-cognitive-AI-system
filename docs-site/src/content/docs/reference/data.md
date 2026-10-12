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
| `app/integrations/vault/` | Encrypted secrets: provider keys, sign-in, Remote keys, plugin tokens |
| `app/diagnostics/` | A small technical log of event codes, without text from your chats |
| `output/` | Files the app wrote for you |

Secrets are encrypted. On a Mac the key is kept in the Keychain, on Windows by the system's data protection, and on a server in `/etc/local-cognitive/vault.key`.

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
