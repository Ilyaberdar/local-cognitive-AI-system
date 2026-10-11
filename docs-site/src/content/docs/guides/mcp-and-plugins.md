---
title: MCP and plugins
description: Connect MCP servers and services such as Notion or GitHub, and use Local Cognitive itself as an MCP server.
---

## MCP servers

**Settings → MCP Servers** connects Model Context Protocol servers, such as Blender's or your editor's, so agents can use their tools.

- **Local servers** start as a command with arguments and environment variables, the same way Codex or Claude Desktop starts them. **Remote servers** are a URL.
- **Import** reads the servers you already configured in Codex (`~/.codex/config.toml`), Claude Desktop or Cursor, or a pasted snippet.
- **Approval** is set per server: ask on every call (the default), approve read-only tools automatically, or trust the server.
- In workflows, the **MCP tool** step calls one tool directly, without a model.

Tool results that contain images reach only models that can see images.

## Plugins

**Settings → Plugins** lists Notion, GitHub, Slack, Google Drive, Linear, Jira, Outlook Email, Outlook Calendar, Microsoft Teams and Dropbox.

1. **Install** the plugin.
2. **Connect** an account in your browser.
3. Choose **Read only** or **Read & write**, and enable it.

Installing alone grants no access. Every write asks for approval, even with full access. Account tokens stay on your device, encrypted, and never reach prompts or tool output. **Settings → Connected accounts** lists the accounts; disconnecting deletes the local credentials.

## Local Cognitive as an MCP server

Other agents can call Local Cognitive's models through MCP over stdio. From a [source checkout](/developers/build/):

```bash
npm run build
npm run mcp:stdio
```

It offers `local_ai_chat`, `local_ai_code`, `local_ai_hypothesis`, `local_ai_runtime_status`, `local_ai_list_models`, `local_ai_get_session_settings` and `local_ai_update_session_settings`.
