---
title: Remote
description: How the app talks to your server, what stays private, and what a connected computer can do.
---

Remote lets the app on your Mac or PC use your own server: its chats, models, tasks and workflows run there, and you see them in the app as if they were local. Set it up with [Install the server](/server/install/) and [Connect a computer](/server/connect/).

<video controls playsinline preload="none" poster="/videos/remote.jpg" aria-label="The chat switches from This computer to a GPU server, and the server's model writes the answer, streaming back to the Mac"><source src="/videos/remote-720.mp4" type="video/mp4" media="(max-width: 900px)" /><source src="/videos/remote.mp4" type="video/mp4" /></video>

*A real chat on a Linux server with a GTX 1070 Ti, answered by Qwen2.5 14B in 29.6 s. The streaming is sped up 3×, and the video marks it.*

## How the connection works

```
Your computer ──wss──▶ Local Cognitive relay ◀──wss── Your server
      └──────────── TLS 1.3 inside: only these two hold the keys ────────────┘
```

1. The server keeps one outbound connection to the relay at `api.local-cognitive.com`, which is how the app knows it is online.
2. When you choose the server, the app gets a one-time ticket (valid for 60 seconds) for your account and that server, and connects to the relay.
3. The server opens a connection of its own for your computer, and the relay joins the two.
4. Inside, your computer and the server run **TLS 1.3 with mutual authentication**. Each side checks the other's key against the one it paired with, so the relay only passes encrypted bytes it cannot read.

Both sides only connect out on port 443: no open ports, and it works behind NAT. All Remote traffic goes through the relay, also when both machines are on the same network.

## What the relay and the Cloud see

- **They see:** your account, your servers and computers, which computer connects to which server and when, how much data passes, and token counts for usage.
- **They never see:** prompts, answers, files, model output or your provider keys.

Models are downloaded by the server straight from Hugging Face, and updates straight from GitHub.

## What a connected computer can do

A computer of the owner's account can use almost everything on the server:

- chats, including subagents, debates and attachments;
- models: download, load, unload, delete, settings, GPUs and Rebalance;
- tasks, schedules, workflows and Synthesis;
- projects in the server's shared folders;
- the server's settings: provider keys can be replaced but never read back;
- usage and error-report settings.

## What stays on the server

Some things can only be set up on the server itself, because they reach its whole file system or its own programs:

- full file access, and anything set up on the server with it;
- folders and projects chosen on the server;
- the server's MCP servers and plugins.

From a computer you can delete, cancel or pause such work, but not start, continue or edit it.

## When the app is closed

Work you started on the server keeps running when you close the app, put the computer to sleep or lose the connection. When you connect again, the chat catches up. If the server itself restarts, unfinished turns are marked as interrupted rather than repeated.
