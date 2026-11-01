---
title: OpenAI-compatible API
description: Use your models from scripts, bots and other programs through an API that speaks OpenAI's.
---

Programs such as scripts, bots, n8n or an editor's AI plugin can use the models of your computer, or of your server, through an API that speaks OpenAI's: `GET /v1/models` and `POST /v1/chat/completions`, streamed or not. Any OpenAI client library works with it: give it the address and a key.

Each request is a model call on its own. Nothing is remembered between requests, no chat is made or kept, and no tools, plugins or MCP servers are used. Tokens count in **Usage** like the app's own.

## Turn it on

- **In the app:** **Settings → API**, then the **OpenAI-compatible API** switch. The address is `http://127.0.0.1:4141/v1`. Change the port in the same place.
- **On a server:** `sudo local-cognitive-server api on` (or `api on 5000` for another port).

It answers only on the computer itself (`127.0.0.1` or `localhost`). To let other devices on your network reach it, turn on **Other devices on this network** in the app, or run `api on --lan` on a server. Requests and keys then travel unencrypted (plain HTTP), so do this only on a network you trust. On a server, open the port in its firewall too.

## Keys

Make a key for each program, so that you can revoke it alone:

- **In the app:** **Settings → API → Make key**, then copy the key. It is shown only once.
- **On a server:** `sudo local-cognitive-server api key "News bot"` prints the key once. `api` lists the keys, and `api revoke <id>` revokes one.

A program sends its key as `Authorization: Bearer <key>`. A key calls the models and nothing else: it opens no settings, chats or files. The app's own API key does not work here, and an API key does not work on the app's own API.

## Models

| Name | Model |
| --- | --- |
| `qwen3-8b` | A local model, by its id. It must be loaded: load it in **Models** first. A request never loads one. |
| `deepseek/deepseek-flash` | A cloud provider's model, as `provider/model`, for a provider set up in **Settings → Models & Providers**. It is called with your key, under the provider's terms. |

`GET /v1/models` lists the loaded local models and each provider that is set up, with its default model. Any other model of that provider works too.

## Example

```bash
curl http://127.0.0.1:4141/v1/chat/completions \
  -H "Authorization: Bearer $LOCAL_COGNITIVE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "qwen3-8b", "messages": [{"role": "system", "content": "Answer briefly."}, {"role": "user", "content": "What changed in this headline?"}]}'
```

With the OpenAI library for Python:

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:4141/v1", api_key="lcsk_...")
reply = client.chat.completions.create(model="qwen3-8b", messages=[{"role": "user", "content": "Hello"}])
print(reply.choices[0].message.content)
```

## What a request may carry

- **Messages:** `system` (or `developer`), `user` and `assistant`. The last one is the user's. A conversation is sent to the model turn by turn in one prompt.
- **Images:** in user messages, as `data:` URLs (PNG, JPEG, WebP or GIF), five at most. Links are not fetched. The model must accept images.
- **Sampling:** `temperature`, `top_p`, `max_tokens` (or `max_completion_tokens`), `seed`, and `stop` (up to four sequences, left out of the answer).
- **Thinking:** `reasoning_effort`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. A local model that thinks before it answers gets that level's budget, as in chats: 128 to 4,096 tokens, 512 when the request names no level, and never more than half of `max_tokens`. `none` turns thinking off, which is the fastest answer. A cloud provider gets the level as it is, and keeps its own default with `none`.
- **Token limit:** an answer that reaches `max_tokens` comes with what was written so far and `finish_reason: "length"`. Thinking counts toward the limit, so on a model that thinks a limit under about 64 tokens can leave an empty answer; ask for more, or send `reasoning_effort: "none"`.
- **JSON:** `response_format` `json_object` or `json_schema`. Where the provider cannot enforce a schema, the schema goes into the instructions, and an answer that is not JSON is refused with `422 invalid_json_output`.
- **Streaming:** `stream: true` sends server-sent events as OpenAI does, ending with `data: [DONE]`. `stream_options.include_usage` adds the token counts. Local models stream as they write; a cloud model's answer comes in one piece. A model's reasoning is never sent.

Not supported: tools (function calling), more than one choice (`n`), and audio. A request with them is refused rather than answered differently.

## Limits and errors

One key runs at most four requests at once; more get `429` with `Retry-After`. Errors come in OpenAI's shape (`{"error": {"message", "type", "code"}}`):

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `invalid_api_key` | No key, or not one of this API's |
| 404 | `model_not_found` | No such local model, or the provider is not set up |
| 409 | `model_not_loaded` | The local model is not loaded |
| 400 | `context_length_exceeded` | The request is longer than the model's context |
| 502 | `upstream_key_refused` | The cloud provider refused your provider key |
| 422 | `invalid_json_output` | JSON was asked for and the answer was not JSON |
