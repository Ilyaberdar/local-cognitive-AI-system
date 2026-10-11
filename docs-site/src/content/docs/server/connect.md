---
title: Connect a computer
description: Pair the app with your server using a one-time key.
---

A computer connects to the server with a one-time key. You need to be signed in to Local Cognitive on that computer.

## 1. Get a key on the server

```bash
sudo local-cognitive-server pair
```

It prints a key that starts with `LCR1-` and waits until a computer uses it. The key:

- works once and expires after 10 minutes (`--ttl <minutes>` sets 1 to 60);
- carries the server's identity, so the app can check it is talking to this server and nothing in between;
- needs no sign-in on the server.

The installer prints the first key itself.

## 2. Paste it in the app

Open **Remote → Connect a server**, paste the key and choose **Connect**. The server then appears under **Your servers** with its state, backend (CUDA or CPU), loaded models and work.

## 3. Use the server

Choose the server in the switch at the top right of the window (**This computer** or your server's name). Chats, models, tasks and workflows now run on the server. Switch back to **This computer** at any time.

## Who can connect

- The first account that connects **owns** the server.
- More computers of the same account connect the same way, each with a new key from `pair`.
- Other accounts can't connect, even with a key.
- `sudo local-cognitive-server devices` lists the computers; `revoke-device <id>` removes one.

## Questions

**Does my computer need to be on the same network?** No. Both sides connect out to the Local Cognitive relay over HTTPS; see [how Remote works](/guides/remote/).

**The key expired.** Run `pair` again; each key is new.

**I reinstalled the app.** Connect again with a new key. The server keeps its data.
