---
title: Chats and agents
description: Chat modes, subagents, debates, access modes and approvals.
---

Each chat keeps its own settings in **Session Setup**, the panel on the right: its title, language, mode, main model and subagents.

<video controls playsinline preload="none" poster="/videos/chat.jpg" aria-label="A chat with a local model: the launch notes turned into a release checklist by Qwen3.8 27B on this Mac, streaming in as it is written"><source src="/videos/chat-720.mp4" type="video/mp4" media="(max-width: 900px)" /><source src="/videos/chat.mp4" type="video/mp4" /></video>

*A real answer from Qwen3.8 27B on an M4 Pro Mac: it streams in as it is written, then the formatted answer replaces it. The wait before it is sped up 8× and the streaming 2×; the video marks both.*

## Modes

| Mode | For |
| --- | --- |
| **General** | One model answers. |
| **Code** | The main model plans and writes; subagents can help. Files and commands go through [approvals](#access-and-approvals). |
| **Hypothesis** | A debate: a supporter and an attacker argue, a judge weighs the evidence. |

Local and cloud models can be mixed in one chat, for example a local supporter with a cloud judge.

## Subagents

Add subagents in Session Setup, each with its own model and access. Call one with `@Name` in a message, or ask the chat to spawn a subagent. Up to four work at once; their results appear as expandable cards, and the main model writes the final answer.

Subagents that use the same local model take turns on it: each loaded model runs one request at a time.

<video controls playsinline preload="none" poster="/videos/subagents.jpg" aria-label="A subagent named Reviewer is added in Session Setup, called with @Reviewer, and its findings arrive in their own card"><source src="/videos/subagents-720.mp4" type="video/mp4" media="(max-width: 900px)" /><source src="/videos/subagents.mp4" type="video/mp4" /></video>

*A real run on Qwen3.5 9B: the main model drafts, the reviewer takes its turn, then the final answer. 3 min 36 s of waiting is sped up 40×, and the video marks it.*

## Access and approvals

The access icon beside the model in the composer sets what the chat's agents may do. It applies to the chat and every agent in it.

| Access | Reads in the workspace | Writes in the workspace | Delete, commands, outside paths |
| --- | --- | --- | --- |
| **Ask for approval** | allowed | asks | asks |
| **Approve for me** | allowed | allowed | asks |
| **Full access** | allowed | allowed | allowed |

An approval card shows the exact paths and contents, or the command and its arguments. **Approve** runs that proposal once; **Cancel** skips it. Text in a prompt or an attachment can never grant access, and writes through plugins always ask, even with full access.

:::note
Access modes are the app's policy, not a sandbox: approved commands run with your user's permissions.
:::

## Projects

A project is a folder on your disk with its own chats. Add one under **Projects** in the sidebar; the app never moves or deletes the folder. Agents in a project chat read, search, edit and run checks inside it.

## Reviewing edited files

When an agent edits a file, **Review** opens it in the right panel. Select text, add a comment and send it back to the chat; the agent changes only that part.

## Images

Attach images to a chat with a vision model (one with a vision adapter). Models without one say so instead of guessing.
