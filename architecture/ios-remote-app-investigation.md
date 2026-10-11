# iOS Remote App Investigation

Date: 2026-10-11, at commit `0dbef53`. Status: research only; nothing is built. Implementation
starts after the owner answers the open decisions (§14), beginning with the secure-channel spike
(§5). This document collects what an iPhone client needs from the existing Remote stack. The
protocol itself is specified in [Remote Connection](remote-connection-implementation.md) (§6–§7),
and the operation registry is in [Runtime operations inventory](runtime-operations-inventory.md).
Where those documents and the code disagree, the code wins: the §7.2 command envelope
(`idempotencyKey`, `eventId`, scopes) and the §13 endpoint names were not built as written.

Path shorthand: `R` = `src/remote`, `RT` = `src/runtime`, `C` = `apps/cloud/src`,
`S` = `architecture/remote-connection-implementation.md`. Line numbers are at `0dbef53`.

## 1. Goal and scope

An iPhone app (iPhone first) that lets the owner control their Local Cognitive server away from
the desk: see servers and their state, chat with the server's models, watch and unblock runs, and
get notified when something needs them. The phone is one more paired Remote device. It uses the
same account, pairing, relay, end-to-end channel and operations as the desktop app. The spec
planned exactly this: a later mobile client on the same protocol (S:43), one contract for the Mac
and the phone (S:1455-1457), with the mobile shell and push left as future work (S:1514-1517).

**Only the Linux server can be a host today.** `startRemote` is called only by the server daemon
(`src/server/daemon.ts:119`, `src/server/remote.ts:26-48`). The desktop app is a device client
only, and desktop-as-host (an "Allow remote connection" switch, tray, autostart) is listed as the
next step (S:45). So the phone controls the GPU server. It cannot reach a Mac or a Windows PC, and
so not Blender or Unreal through MCP, until the desktop can host. Even then the host-only boundary
keeps host MCP work on the host unless decision 7 changes it.

| The phone can (like any paired device) | The phone cannot |
| --- | --- |
| Sign in, list the account's servers with online state and version, remove a device's access | Create pairing keys or change who owns a server (server CLI only) |
| Pair with a server using its one-time key: pasted, or scanned as a QR code once `pair` prints one | Give anything full access: chats, tasks, schedules, workflow steps |
| Chat with the server's models in ordinary chats and in projects it created, in "Ask for approval" or "Approve for me" mode, with photos and PDFs | Send messages in, or change, a chat the server gave full access; it may read, stop, decline and delete it |
| Approve or decline tool actions in chats it may use; decline in any chat | Approve a waiting host MCP call; work a device starts never gets the host's MCP tools |
| Watch runs live, approve or reject waiting steps of runs it may continue, cancel, resume, run a task, pause a schedule | Start, continue, review or edit work the server set up with full access or in a folder or project chosen on the server; it may only delete, cancel or pause it |
| Load and unload models, set the default, pause, resume or cancel downloads; read RAM and VRAM per GPU | See chats of projects set up on the server; read files other than those its own chat read or wrote |
| Read the server's settings and change the fields open to devices | Change host-only settings (filesystem, model and memory folders, provider addresses, MCP server, Telegram); update the server, install CUDA, share folders, import GGUF files |

The host-only boundary comes from R5 (decided on 2026-10-09 and tightened after a security review)
and applies to the phone unchanged; §6.3 lists where the server enforces it.

## 2. Summary

1. **Feasible without changing the device protocol.** The Cloud already accepts the device platform
   `ios` (`C/remote/remoteRoutes.ts:21`, `apps/cloud/migrations/0003_remote_pairing.sql:26`), and
   `/v1/me`, `/v1/hosts` and `/v1/usage/*` serve a phone as they are. Everything in the MVP except
   push is an existing device operation.
2. **The main risk is the channel.** Remote runs TLS 1.3 with mutual authentication inside
   WebSocket binary messages, and pairing proves the one-time secret over the TLS exporter. iOS has
   no API for TLS over a byte stream the app supplies. Network.framework has every other piece; a
   loopback bridge (or a custom framer) should connect it to the WebSocket. This is spiked first, as
   a Swift package tested against the real Node host (§5).
3. **Push does not exist anywhere** and is the largest piece of new work: a token table, endpoints
   and an APNs sender in the Cloud, a `notify` message from the host over its control WebSocket, and
   payloads without content or encrypted for a Notification Service Extension (§8, §9).
4. **Smaller host and Cloud gaps:** a list of pending approvals across chats and runs, pagination
   (lists are returned whole), a QR code in `pair`, and in-app account deletion, which the App Store
   requires (§8, §11).
5. **Stack: native SwiftUI**, with only Apple's cryptography (no export documents) and Swift types
   generated from the zod schemas through JSON Schema (§10).
6. **App Review** needs Sign in with Apple next to Google, in-app account deletion, and a demo
   account with an always-on demo server that a reviewer's phone can actually pair with (§11).

## 3. What exists today

| Area | Where | Meaning for the phone |
| --- | --- | --- |
| Host | `src/server/daemon.ts:119-145`, `src/server/remote.ts:26-48`, `R/host/{HostAgent,RemoteHost,RemoteHostStore}.ts` | Only the Linux server hosts; it registers all 84 operations |
| Protocol | `R/{connectionKey,identity,channel,messages,wsDuplex}.ts` | Key format, identity, TLS channel, frames and messages: re-implemented in Swift |
| Device client | `R/client/{RemoteClient,RemoteSession,RemoteRuntime}.ts`, `electron/remote.cjs` | The reference client: pairing, reconnect, commands, streams |
| Screen logic | `reduceSessionEvents` in `public/assets/chat-target.js:51-97`; `public/assets/runtime-routes.js` | The chat event reducer is worth porting; the rest is Electron UI |
| Operations | `RT/operationCatalog.ts:14-112`, `RT/*Operations.ts` | 84 operations, each with a strict zod request schema (§6) |
| Events | `RT/eventStreams.ts`, `RT/EventJournal.ts`, `RT/RunService.ts` | Long polls; the host never pushes inside the channel |
| Cloud | `C/remote/{remoteRoutes,relay,remoteRepository}.ts`, `C/app.ts`, `C/usage/usageRoutes.ts` | Devices, tickets, relay, profile and usage: reused unchanged |
| Accounts | `src/account/*` (desktop), `C/auth/*`, `C/accounts/*` | Auth0 with PKCE; the phone needs its own Auth0 Native application |
| Website account page | `account.js` in the separate landing repository | Calls `/v1/me`, `/v1/hosts`, `DELETE /v1/hosts/:h/devices/:d`, `/v1/usage/summary` and `/v1/usage/activity`; the phone's account screens use the same endpoints |
| Shared packages | `packages/protocol` and `packages/runtime-client` were planned (S:1433-1434) | Never created; Swift re-implements the client |
| Push | None. The only system notification is the desktop's update notice (`electron/updates.cjs:142`); Settings → Notifications says "Status stays in the app" (`public/assets/settings-shell.js:467`) | All new (§8, §9) |
| Tests | `test/remote-channel.test.ts`, `test/remote-*-e2e.test.ts`, `test/remoteRuntime.test.ts`, `apps/cloud/test/remote.test.ts` | Conformance references for the Swift client |

What the Swift client can and cannot take over:

- **Portable as a reference** (logic to re-implement, not code to run):
  `R/{connectionKey,identity,messages,channel,wsDuplex}.ts`, `R/client/*`,
  `RT/operationCatalog.ts` and `reduceSessionEvents`.
- **Node only:** the channel itself, which needs `node:tls` and `ws`.
- **Electron only:** `electron/remote.cjs`, the preload bridge, the loopback sign-in and
  `public/assets/{remote-ui,runtime-routes,server-*}.js`.

The spec stages that shaped the client side are R1 (account) and R3–R8 (S:1459-1471).

## 4. Client protocol, step by step

```text
1 sign in        Auth0, PKCE (Google, email, Sign in with Apple)  → access token; accountId from /v1/me
2 device key     P-256 key in a minimal self-signed certificate   → POST /v1/devices → deviceId
3 key or QR      LCR1-… (177 characters)                           → hostId, invitationId, host pin, secret, expiry
4 ticket         POST /v1/connections                              → one-time ticket, valid 60 s
5 relay          wss …/v1/relay/client: auth, then connected       → binary messages carry TLS bytes
6 TLS 1.3        the device is the client, with its certificate    → host pin checked; no resumption
7 hello          hello (+ pairing proof over the TLS exporter)     → welcome: capabilities, authExpiresAt
8 calls          request/response; commands carry a commandId      → events.poll long polls for live data
9 reconnect      purpose "connect" ticket + the saved pin          → a new session, up to 12 h each
```

### 4.1 Sign-in and account

- The desktop signs in with Auth0 Authorization Code + PKCE (S256), `prompt=login`, scope
  `openid profile email offline_access` and the Cloud API as audience (`src/account/oidc.ts:19-31`,
  `src/account/accountConfig.ts:18-19, 37`), returning to a loopback listener on port 17850
  (`accountConfig.ts:16`). A phone cannot use loopback (S:1126-1131). It needs a separate Auth0
  **Native** application with HTTPS (universal link) callbacks, the same audience and scope,
  refresh-token rotation and `offline_access` (§13).
- On iOS, Auth0.swift through Swift Package Manager covers this: `ASWebAuthenticationSession` with
  PKCE; `useHTTPS()` for universal-link callbacks on iOS 17.4 and later; CredentialsManager for
  Keychain storage, refresh and `enableBiometrics`; `useEphemeralSession()` removes the "wants to
  use … to Sign In" alert at the cost of shared sign-in cookies [24]. Plain
  `ASWebAuthenticationSession` with PKCE would mean re-implementing all of it.
- The Cloud accepts an access token after checking the RS256 signature against the tenant's JWKS,
  the issuer, the audience, `sub` and `exp`, with 5 s of clock tolerance
  (`C/auth/verifyAccessToken.ts:16-30`). Machine tokens are refused (`C/auth/profileClaims.ts:26-28`).
- **The first call with a new identity creates the account** (`C/accounts/requireAccount.ts:13-37`).
  A first Sign in with Apple or Google is therefore a sign-up as far as App Review is concerned (§11).
- Connection tickets require the namespaced `email_verified` claim that the Auth0 Post-Login Action
  adds to access tokens; a missing claim fails closed with `email_unverified`
  (`C/auth/profileClaims.ts:3-24`, `C/remote/remoteRoutes.ts:76`). The Action must run for the iOS
  application too; its setup is not in this repository.
- `GET /v1/me` returns `accountId`, `status`, `createdAt`, `email`, `emailVerified`,
  `displayName` and `identities` (each with `provider`, `email`, `emailVerified`, `linkedAt`,
  `current`) (`C/accounts/meResponse.ts:13-28`). `accountId` goes into `hello` and into the
  exporter context.
  An `apple|…` subject is already reported as provider `apple` (`meResponse.ts:3-6`).
- Refresh tokens rotate: refresh one at a time and save the new refresh token before using the new
  access token (`src/account/AccountService.ts:299-328`). CredentialsManager does this on iOS.

### 4.2 Device identity and registration

- The device key is ECDSA P-256 in a minimal self-signed X.509 v3 certificate (ecdsa-with-SHA256,
  common name `local-cognitive-device`, valid 2025-01-01 to 2099-12-31) (`R/identity.ts:19-30`,
  `R/client/RemoteClient.ts:267`). Certificate fields carry no trust; peers pin the key.
- **The device's identity is SHA-256 of its DER SubjectPublicKeyInfo** (`R/identity.ts:17`). For
  P-256 the SPKI is the fixed 26-byte prefix `3059301306072a8648ce3d020106082a8648ce3d030107034200`
  followed by the 65-byte uncompressed point that `SecKeyCopyExternalRepresentation` returns,
  91 bytes in all.
- Register once per account: `POST /v1/devices` with
  `{"spkiSha256": "<64 lower-case hex>", "name": "<1–120 characters>", "platform": "ios"}` returns
  `{"deviceId": "…"}` (`C/remote/remoteRoutes.ts:16, 21, 60-65`). The Cloud upserts by account and
  key, so a retry returns the same `deviceId` (`C/remote/remoteRepository.ts:73-79`).
- Since iOS 16, `UIDevice.name` returns only the model ("iPhone") without a special entitlement; let
  the user name the phone, defaulting to the model.

### 4.3 Connection key (LCR1)

`sudo local-cognitive-server pair` prints a one-time key (`src/server/cli.ts:141-164`), only in that
command's output, never in the service log (`cli.ts:146`).

```text
LCR1-<base32(payload): 164 characters>-<base32(first 4 bytes of SHA-256("lcr1" ‖ payload)): 7 characters>
= 177 characters
```

| Offset | Bytes | Field |
| --- | --- | --- |
| 0 | 1 | Version, 1 |
| 1 | 1 | Environment: 1 = the production Cloud, 2 = any other Cloud; a key never crosses environments |
| 2 | 16 | `hostId` (UUID) |
| 18 | 16 | `invitationId` (UUID) |
| 34 | 32 | SHA-256 of the host's TLS SPKI: the pin |
| 66 | 32 | One-time secret |
| 98 | 4 | `expiresAt`, Unix seconds, big-endian |

Sources: `R/connectionKey.ts:3-15, 26-29, 59-78`.

- Base32 uses the RFC 4648 alphabet without padding and is decoded strictly: unused trailing bits
  must be zero, so every key has one spelling. Case, spaces and line breaks are ignored. Errors are
  `format`, `checksum`, `version`, `environment` and `expired`, and their messages never contain the
  key (`connectionKey.ts:17-24, 39-51, 66-78`). UUIDs decode to lower-case text.
- A key is valid for 10 minutes by default (`pair --ttl` takes 1–60 minutes, `src/server/args.ts:82`;
  the Cloud caps an announced invitation at one hour, `C/remote/relay.ts:164-165`). It works once,
  and its secret lives only in the server process, so restarting the server cancels it
  (`R/host/RemoteHost.ts:64-75`, `cli.ts:149`). The Cloud issues at most 10 tickets per key
  (`remoteRepository.ts:14, 109`).
- The secret never goes to the Cloud, a URL, telemetry or a log (S:370-373).
- Signing in alone grants nothing: every device pairs with its own key for each server, even
  under the same account (S:49-51).
- 177 characters is too long to type on a phone: add QR scanning, plus a SwiftUI `PasteButton`,
  which avoids the paste prompt. The key uses only `A–Z`, `2–7` and `-`, so a QR code in
  alphanumeric mode holds it in version 7 at error-correction level M (45 × 45 modules; 987 of 992
  data bits). The QR code should carry the key text itself, not a link: a link would open a browser
  on a phone without the app and put the secret into a URL. The spec already expected a QR form
  (S:367).

### 4.4 Connection ticket

```text
POST /v1/connections          Authorization: Bearer <access token>
{"purpose":"pair","hostId":"…","deviceId":"…","invitationId":"…"}
{"purpose":"connect","hostId":"…","deviceId":"…"}

201 {"ticketId":"…","ticket":"<base64url of 32 bytes>","expiresAt":"<ISO, now + 60 s>","authExpiresAt":"<ISO, now + 12 h>"}
```

Sources: `C/remote/remoteRoutes.ts:12-13, 22-25, 75-87`.

- Checks run in this order: a verified email (403 `email_unverified`), a valid body (400
  `invalid_request`), 30 tickets per minute per account (429 `rate_limited`), the host online (409
  `host_offline`, checked early so an offline host does not use up a key's tickets), then the
  repository: a pairing ticket needs a live invitation of an unclaimed host or of one the account
  owns, and a connect ticket needs an active grant and ownership (`remoteRepository.ts:91-124`).
  Denials map to 403, 404, 410 or 429 (`remoteRoutes.ts:28-29`).
- The Cloud stores only the ticket's SHA-256, and the relay consumes it once
  (`0003_remote_pairing.sql:56-70`, `remoteRepository.ts:126-143`).

### 4.5 Relay WebSocket

1. Open `wss://<Cloud>/v1/relay/client` without `permessage-deflate`; messages are at most 64 KiB
   (`C/remote/relay.ts:12, 18, 72`; `R/client/RemoteClient.ts:226`).
2. Within 10 s send one text message `{"type":"auth","ticket":"<ticket>"}`. Silence closes the
   socket with 4408, anything else with 4401 (`relay.ts:16, 36, 54-67, 191-193`).
3. The relay consumes the ticket, checks that the host is connected and the session limits, and
   asks the host to dial back. Nothing the device sends meanwhile reaches the host
   (`relay.ts:195-213`). When the host attaches, the relay sends the text message
   `{"type":"connected"}` (`relay.ts:216-241`). Send the TLS ClientHello only after it.
4. From then on only binary messages count: they carry the TLS byte stream. Text messages are relay
   control and never part of it (`R/wsDuplex.ts:24-29`; the relay forwards binary messages only,
   `relay.ts:244-253`). Split every write into binary messages of at most 64 KiB
   (`wsDuplex.ts:4-20`).
5. The relay pings every 25 s and terminates a socket that missed the previous pong
   (`relay.ts:82-88`). It pauses a sender while more than 1 MiB waits for the reader and resumes it
   below 256 KiB (`relay.ts:16-17, 244-253`).

| Close code | Meaning (`relay.ts:11`, `RemoteClient.ts:19-26`) | Client action |
| --- | --- | --- |
| 4401 | Ticket rejected, or a malformed `auth` message | New ticket; retry with backoff |
| 4403 | Device revoked, or the server was unlinked | Stop and say that access was removed |
| 4404 | Server offline, or it did not attach within 10 s | Retry with backoff |
| 4408 | No `auth` message within 10 s | Retry |
| 4410 | Session authorization expired (30 s after `authExpiresAt`, `relay.ts:19, 225`) | Reconnect with a new ticket |
| 4429 | Too many sessions: 8 per account, 16 per claimed server, 2 per unclaimed server, which also accepts pairing only (`relay.ts:16, 200-206`) | Tell the user; retry later |
| 1001, 1011 | Relay shutting down, or a relay error (`relay.ts:104, 125`) | Reconnect with backoff |

Close codes 4000–4999 from either end pass through to the other (`relay.ts:235`).

### 4.6 TLS 1.3 inside the WebSocket

- The host is the TLS server and the device the client (`R/channel.ts:7-9`). Only TLS 1.3 is
  allowed (`channel.ts:16`); every connection is a fresh ECDHE handshake, which gives forward
  secrecy (S:422-424).
- The device presents its certificate. Chain validation and the host-name check are off on purpose,
  because both certificates are self-signed (`channel.ts:48-53`).
- **The host pin is checked before the first write.** SHA-256 of the server's SPKI must equal the
  key's pin when pairing, or the saved profile's pin when reconnecting. Otherwise the result is
  `host_identity_mismatch`, shown as "the server's identity changed"; a changed server key is never
  trusted automatically (`channel.ts:57-62`; `RemoteClient.ts:193`; S:438-439). Never take the pin from
  `GET /v1/hosts`, which also returns `tlsSpkiSha256` (`C/remote/remoteRoutes.ts:70`).
- The host requires a client certificate, compares its SPKI with the key the Cloud registered for
  the ticket's device (`device_key_mismatch`, `R/host/RemoteHost.ts:90`) and refuses resumed
  sessions (`session_resumed`, `channel.ts:70-86`). The client must turn off session resumption and
  session tickets.
- Each side gives the handshake 15 s (`channel.ts:51, 71`).
- Inside TLS, every message is a big-endian u32 length followed by a UTF-8 JSON object of at most
  1 MiB. A larger or malformed frame closes the channel (`channel.ts:15, 88-135`).

### 4.7 Pairing proof

Pairing proves possession of the key's secret, bound to this TLS session, the Cloud ticket, the
account, both keys and the invitation, so a proof the relay sees cannot be replayed into another
session (`R/channel.ts:20-41`; S:417-421):

```text
context  = SHA-256 over these fields, each written as u32be(byte length) ‖ bytes:
           "pair", hostId, invitationId, ticketId, accountId, deviceId,
           device SPKI SHA-256 (32 raw bytes), host SPKI SHA-256 (32 raw bytes)
exporter = TLS exporter, label "EXPORTER-local-cognitive-remote-v1", context, length 32   (RFC 8446 §7.5)
proof    = base64url( HMAC-SHA256(key = secret, message = "lc-pair-proof/v1" ‖ exporter) )
```

Strings are the UTF-8 bytes of the exact id text: lower-case UUIDs, as the key and the Cloud return
them. The host recomputes the proof and answers `proof_invalid` on a mismatch
(`RemoteHost.ts:115-134`); the desktop's side is `R/client/RemoteSession.ts:44-47`. Only standard
primitives are used; no new cryptography is written (S:429-430).

### 4.8 hello, welcome and denied

Within 10 s of the TLS handshake (`RemoteHost.ts:33, 93`) the device sends:

```text
{"type":"hello","protocol":1,"purpose":"pair","accountId":"…","deviceId":"…",
 "deviceName":"…","invitationId":"…","proof":"…"}
```

`deviceName` is optional (at most 120 characters); `invitationId` and `proof` (at most 128
characters) are sent only when pairing. The schema is strict, so an unknown field is a protocol
error (`R/messages.ts:4-8`; `RemoteSession.ts:48-49`). Any message before `welcome` closes the
session (`RemoteHost.ts:91-92`). The host answers with one of:

```text
{"type":"welcome","protocol":1,"hostId":"…","hostName":"…","serverVersion":"…",
 "capabilities":["session.ping","host.info","…"],"authExpiresAt":<epoch ms>}
{"type":"denied","code":"proof_invalid","message":"…","serverVersion":"…"}
```

Sources: `messages.ts:11-17`; `RemoteHost.ts:84-89, 152-153`.

- `capabilities` lists the server's operation names (at most 256). The app detects features by name
  and asks the user to update the server when one is missing, as the desktop does ("Update the
  server to chat", `public/assets/chat-target.js:362`). `hostName` is the server's hostname
  (`src/server/remote.ts:33`). `authExpiresAt` is when the session ends.
- The client checks that `welcome.hostId` is the expected server and that `protocol` is within its
  range (`RemoteSession.ts:57-63`). Both ends speak protocol 1 (`MIN_PROTOCOL_VERSION` =
  `PROTOCOL_VERSION` = 1, `channel.ts:10-13`); a server denies `client_too_old` or `server_too_old`
  and includes its version (`RemoteHost.ts:95-96`). The release manifest carries the protocol range
  (`scripts/pack-server.mjs:157`), but nothing reads it at runtime.
- Because `hello` and `request` are strict, new client data must travel in new operations, which
  the app detects by name, or come with a protocol version bump; never in extra fields that older
  servers reject.

| Denial (`RemoteHost.ts:34-46`) | Meaning |
| --- | --- |
| `device_key_mismatch` | The TLS key is not the one registered for this device |
| `hello_mismatch` | Purpose, account, device or invitation differ from the ticket |
| `invitation_unknown`, `invitation_used`, `invitation_expired` | The key is unknown (for example, the server restarted), used or expired: make a new one |
| `owner_mismatch` | The server belongs to another account |
| `proof_invalid` | The pairing proof does not verify |
| `not_authorized` | No active grant: pair again |
| `protocol`, `client_too_old`, `server_too_old` | A malformed `hello`, or versions out of range |

### 4.9 Requests and commands

```text
→ {"type":"request","id":7,"op":"chat.runs.start","payload":{…}}
← {"type":"response","id":7,"result":{…}}
← {"type":"error","id":7,"code":"session_busy","message":"…"}
← {"type":"closing","reason":"revoked"}          reasons: revoked, auth_expired, shutdown
```

Sources: `R/messages.ts:18-23`; `RemoteHost.ts:143-187`.

- `id` is a non-negative integer, unique within the session. At most 16 requests may be in flight
  (`too_many_requests`); an unknown operation gets `unknown_operation`; a result over 1 MiB gets
  `response_too_large`; a malformed request closes the session (`RemoteHost.ts:157-167`). The
  desktop closes the session when an answer names an unknown id (`RemoteSession.ts:82-92`).
- Each operation has its own client timeout in the catalog, from 15 s to 330 s
  (`RT/operationCatalog.ts:14-112`); the default is 30 s (`RemoteSession.ts:69`).
- **Commands** (the 15 operations of kind `command`) carry a `commandId` of 8–100 characters in the
  payload. The server records it before acting, scoped by account and device. A repeat returns the
  first result; the same id with a different payload is `idempotency_conflict`; a command that a
  restart interrupted is never run again and answers `not_started` or `unknown_outcome`
  (`RT/CommandLedger.ts:30-34`; for chat turns `RT/RunService.ts:110-147`).
- The desktop resends a command whose answer was lost (`disconnected`, `timeout`, `not_connected`)
  with the same `commandId` after reconnecting to the same server, for up to 120 s, and then reports
  `unknown_outcome` (`R/client/RemoteRuntime.ts:14, 42-58`). The phone must also keep in-doubt
  command ids across suspension.
- `chat.runs.start` answers with `commandId`, `status` (`accepted` or `rejected`) and, as they
  apply, `runId`, `userMessageId`, `assistantMessageId`, `code`, `activeRunId` and `replayed`; a
  chat has one active turn at a time (`session_busy`) (`RunService.ts:20-21, 110-147`).
- Every call from a screen names the server it was meant for; the desktop refuses a call when the
  selected server changed in between (`host_changed`, `RemoteRuntime.ts:11-12, 96-98`).

### 4.10 Events and live data

The server never pushes inside the channel; the client long-polls (`RT/eventStreams.ts:22-24`).

```text
→ events.poll {"streams":[{"streamId":"session:<id>","epoch":"…","after":41}, …],"waitMs":20000,"maxEvents":500}
← {"streams":[
     {"streamId":"session:<id>","events":[{"seq":42,"type":"message.delta","runId":"…","occurredAt":"…","payload":{…}}],"head":42,"epoch":"…"},
     {"streamId":"workflow-run:<id>","resync":"cursor_expired"}]}
```

- One poll follows 1–8 streams, waits up to 20 000 ms and returns up to 500 events
  (`eventStreams.ts:5-9`). It answers at once when any stream has news, otherwise after the next
  event, the wait or a disconnect (`eventStreams.ts:60-66`). Give it `waitMs` + 15 s before timing
  out (`RemoteRuntime.ts:65-66`; 35 s in the catalog).
- Stream ids are `session:<sessionId>` (`RT/RunService.ts:52`) and `workflow-run:<runId>`
  (`RT/orchestrationOperations.ts:434-436`). Cursors come with snapshots: `sessions.messages.list`
  returns `{messages, activeRun?, cursor}` (`RT/chatOperations.ts:315-328`) and
  `workflows.runs.events` returns `{events, …, detail, cursor}`
  (`orchestrationOperations.ts:356-370`). Load the snapshot, then poll from its cursor.
- **The phone should follow all of its streams in one `events.poll`.** The desktop runs one long
  poll per stream (`RemoteRuntime.ts:60-75`), which does not fit a phone's budget of 16 requests in
  flight.
- `resync` (`epoch_changed`, `cursor_ahead`, `cursor_expired`, `redacted`, `run_unknown`) means:
  reload the snapshot and continue from its cursor (`RT/EventJournal.ts:10, 48-53`;
  `eventStreams.ts:53-54`; `orchestrationOperations.ts:440-444`). `message.delta` and
  `run.progress` events of finished runs expire after 10 minutes; `message.completed` carries the
  result (`EventJournal.ts:12-14`).

| Chat event | Payload | Notes |
| --- | --- | --- |
| `message.accepted` | `runId, assistantMessageId, message {id, role: "user", content, createdAt, attachments?}` | Also for turns sent from another device (`RunService.ts:136-137`) |
| `run.started` | `runId, assistantMessageId` | |
| `message.delta` | `runId, messageId, offset, text, replace?` | Text from `offset` on; `replace` replaces everything; an offset past the known text means resync; batched every 300 ms (`RunService.ts:15, 315-351`) |
| `run.progress` | `runId, progress` | Phase, agents, activity |
| `approval.requested` | `runId, approvalId, digest, requestedAt, tool, operation, summary, details` | Answer with `chat.approvals.resolve {runId, approvalId, approved}` (`RunService.ts:353-370`; `src/types/index.ts:12-17`) |
| `approval.resolved` | `runId, approvalId, approved` | |
| `message.completed` | `runId, assistantMessageId, text, messages?` | The final text |
| `run.completed`, `run.failed`, `run.cancelled`, `run.interrupted`, `run.needs_review` | `runId, error?` | `interrupted` and `needs_review` follow a server restart (`RunService.ts:218-239, 381-408`) |

The desktop's `reduceSessionEvents` (`public/assets/chat-target.js:51-97`) applies these events to
a chat view and is the reference for the Swift reducer. Other live data:

- **Models:** `models.local.watch {epoch?, after?, waitMs?}` returns `{epoch, sequence, snapshot?}`:
  the whole state when the device is behind, otherwise after the next change (download progress is
  coalesced over 500 ms) or the wait (`RT/modelOperations.ts:128-144`).
- **Tasks, schedules and runs:** `orchestration.snapshot {revision?}` returns
  `{revision, unchanged: true}` or the full lists (`orchestrationOperations.ts:216-224`). The desktop
  polls every 2 s while a run is active and every 15 s otherwise (S:648-651).
- **Synthesis:** `synthesis.runs.get {runId, after}` returns the events after a cursor.

### 4.11 Reconnect, expiry and revocation

- Reconnecting takes an account session, a fresh `purpose: "connect"` ticket and the saved pin, not
  the key (S:435-439). The Cloud checks the grant when it issues and when it consumes the ticket
  (`remoteRepository.ts:111-115, 126-143`); the server checks its own active grant, the owner and
  the device key (`RemoteHost.ts:136-141`).
- A session ends at `authExpiresAt`, 12 h after its ticket: the server sends `closing`
  `auth_expired` (`RemoteHost.ts:148`) and the relay closes 30 s later with 4410.
- The desktop retries only network-level failures (`host_offline`, `network`, `timeout`, `closed`,
  `ticket_rejected`, `auth_expired`), with a backoff that starts at 1 s, doubles up to 30 s and is
  randomized to 50–100 % (`RemoteClient.ts:189-212`). `revoked` and `not_authorized` stop in the
  "revoked" state; `host_identity_mismatch` stops in "identity changed".
- On iOS the socket lives only in the foreground. Close it cleanly when the app goes to the
  background (`beginBackgroundTask` gives about 30 s), reconnect when it returns, and continue from
  the saved cursors or reload the snapshots. Runs continue on the server meanwhile.
- **Disconnect** closes the session, **Forget** deletes the local profile, and **Revoke** removes
  the grant on the server and in the Cloud (S:445-447). A server that was offline during a
  revocation applies it when it reconnects (`R/host/HostAgent.ts:172-183`).

### 4.12 Errors and limits

| HTTP | `error` | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | Body or ids are not valid |
| 401 | `unauthorized`, `invalid_token` | Refresh the access token and retry once (`C/auth/verifyAccessToken.ts:22, 27`) |
| 403 | `email_unverified` | Verify the email address first |
| 403 | `host_owned_by_other`, `not_authorized` | Another account owns the server; or no active grant, pair again |
| 403 | `account_disabled`, `user_token_required` | The account is disabled; a machine token was sent (`C/accounts/requireAccount.ts:18, 32`) |
| 404 | `device_unknown`, `host_unknown`, `invitation_unknown`, `not_found` | |
| 409 | `host_offline` | The server is not connected to the Cloud |
| 410 | `invitation_used`, `invitation_expired` | Make a new key |
| 429 | `invitation_exhausted`, `rate_limited` | 10 tickets per key; 30 tickets per minute |
| 503 | `auth_unavailable` | Auth0 is unreachable; this is not a bad token (`verifyAccessToken.ts:11-14`) |

The desktop maps these codes to messages in `RemoteClient.ts:27-37`.

| Limit | Value | Where |
| --- | --- | --- |
| JSON body sent to the Cloud | 64 KB | `C/app.ts:48` |
| Tickets | 30 per minute per account, 10 per key, 60 s to use; a session lasts 12 h | `remoteRoutes.ts:12-13, 38`; `remoteRepository.ts:14` |
| Usage reads | 120 per minute | `C/usage/usageRoutes.ts:47-48` |
| Relay sessions | 8 per account, 16 per server | `relay.ts:16` |
| WebSocket message | 64 KiB, binary, uncompressed | `relay.ts:18, 72` |
| Channel frame | 1 MiB | `R/channel.ts:15` |
| Requests in flight | 16 | `R/messages.ts:23` |
| `events.poll` | 8 streams, 20 s, 500 events | `RT/eventStreams.ts:5-9` |
| Chat message | 64 Ki characters, up to 5 attachments | `RT/RunService.ts:14`; `chatOperations.ts:56-57` |
| Attachments | Images recompressed on the device to a data URL of about 1 MiB (at most 2 Mi characters); extracted text at most 20 000 characters; chunks of 128 Ki characters; 20 pending uploads and 32 Mi characters per device, kept one day | `RT/uploadStore.ts:6-15` |
| Chat history | The newest 768 KiB, with no way to page back | `chatOperations.ts:20, 326` |

Rate limits live in memory in the single Cloud replica (`C/remote/rateLimit.ts:1`).

### 4.13 What the phone stores

| Item | Desktop vault key (`RemoteClient.ts:256-290`) | iPhone |
| --- | --- | --- |
| Auth0 refresh token | `account/session` | Keychain, through Auth0.swift's CredentialsManager |
| Device key, certificate, `deviceId` | `remote/device/<accountId>` | Keychain; the key in the Secure Enclave if the spike shows that TLS client authentication works with it |
| Paired servers: `hostId, hostName, hostSpkiSha256, deviceId, pairedAt` | `remote/profiles/<accountId>` | Keychain: the pins decide whom the app trusts |
| Last server | `remote/last-host/<accountId>` | App preferences |
| Access token, pairing secret | Memory only | Memory only |
| Stream cursors, in-doubt command ids, drafts | Memory | Saved per account and server, so suspension loses nothing |

- The desktop's vault is `EncryptedCredentialVault` over Electron `safeStorage`
  (`electron/main.cjs:108-116`). Keys and pins are kept per account: signing out closes Remote but
  keeps them, and signing back in to the same account needs no pairing (S:47, S:440-443).
- Keychain items are this-device-only and never synchronized. A server keeps one active grant per
  device key and revokes any other grant that uses the same key
  (`R/host/RemoteHostStore.ts:65-67`), so a key must not reach a second phone through iCloud
  Keychain or a backup; a restored phone pairs again.
- Items the Notification Service Extension reads use `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`
  in a Keychain access group shared with the extension.
- Keychain items survive deleting the app: wipe them on the first launch after an install.

### 4.14 Interoperability checklist

1. Keep every id as the exact text the key or the Cloud gave (lower-case UUIDs). The server
   compares ids as strings and hashes them into the exporter context; Swift's `UUID.uuidString` is
   upper-case.
2. `spkiSha256` is lower-case hex (`^[0-9a-f]{64}$`, `remoteRoutes.ts:16`).
3. The ticket and the proof are base64url without padding (`relay.ts:22`, `RemoteHost.ts:121`).
4. `hello` and `request` are strict: add no fields (§4.8).
5. No TLS bytes before the relay's `connected`; text messages are never TLS data.
6. Binary messages of at most 64 KiB; frames of at most 1 MiB.
7. The exporter's context is the 32-byte hash of the fields, not the fields; the exporter is 32
   bytes long.
8. TLS 1.3 only, with resumption and session tickets off.
9. One answer per request id; use each operation's own timeout.
10. Never take a pin from the Cloud.

## 5. Main technical risk: TLS inside the WebSocket on iOS

### 5.1 The problem

Every TLS implementation Apple ships is tied to a transport it owns. Network.framework runs TLS over
its own TCP or QUIC connections; URLSession speaks HTTPS and WSS to the Cloud; Secure Transport, the
one API that took custom I/O callbacks, has no TLS 1.3 and is deprecated. Remote needs TLS 1.3 over
bytes the app moves itself (WebSocket binary messages through the relay), with a client
certificate, its own pin check, no resumption and the RFC 8446 exporter (§4.6–§4.7). The protocol
is fixed: TLS-PSK and a custom Noise implementation were rejected in R3 (S:46, S:406-410), and the
desktop and the server already speak TLS.

### 5.2 What Network.framework provides

| Need | API (`sec_protocol_options` and `sec_protocol_metadata`) |
| --- | --- |
| Client certificate | `sec_protocol_options_set_local_identity` (a `SecIdentity` from the Keychain) |
| Own trust decision (the SPKI pin) | `sec_protocol_options_set_verify_block`, which runs during the handshake, before any application data |
| TLS 1.3 only | `sec_protocol_options_set_min_tls_protocol_version` and `…_max_…` set to TLS 1.3 |
| No resumption | `sec_protocol_options_set_tls_resumption_enabled(false)`, `sec_protocol_options_set_tls_tickets_enabled(false)` |
| Exporter | `sec_protocol_metadata_create_secret_with_context` (label, context, length 32), reported to give the same output as OpenSSL's TLS 1.3 exporter [15] |

Only the transport is missing.

### 5.3 Options

**A. Loopback bridge (spike first).**

```text
NWConnection: TLS 1.3 client, device identity, pin check in the verify block
   │  TCP to 127.0.0.1:<ephemeral port>
NWListener on 127.0.0.1: accepts one connection (ours), then stops listening
   │  bytes ⇄ binary messages of at most 64 KiB
URLSessionWebSocketTask → wss://<Cloud>/v1/relay/client   (auth → connected first)
   │
relay → host stream → RemoteHost, the TLS server (R/host/RemoteHost.ts)
```

- Loopback is not "local network", so there is no permission prompt [16]. App Transport Security
  covers URLSession and web views [22], not Network.framework connections, so the bridge needs no
  exception.
- Accept a single connection, check that its remote port is our `NWConnection`'s local port, and
  close the listener right after.
- Read from the WebSocket only as fast as the TLS side consumes, so the relay's backpressure keeps
  working.
- The cost is one extra copy through a loopback socket, which is negligible at these sizes.

**B. Custom framer.** Carry the TLS bytes in a custom `NWProtocolFramer` that maps them onto
WebSocket messages, with TLS stacked above it, the pattern people use for STARTTLS [17]. It avoids
the loopback socket, but depends on Network.framework accepting TLS above a custom framer. The spike
checks that after A.

**Rejected or last resort.**

- swift-nio-ssl: no exporter API (issue #599, open since August 2026 [34]), and it bundles
  BoringSSL, which brings back the export compliance documents, including a French encryption
  declaration [13].
- An own BoringSSL build with memory BIOs (`SSL_export_keying_material`, and
  `SSL_PRIVATE_KEY_METHOD` for a Secure Enclave key): it would work, but costs the export paperwork
  and a C dependency to maintain. Only if A and B both fail.
- Secure Transport: no TLS 1.3, and deprecated.
- React Native or a web view: neither can run `node:tls`, so the channel would be native anyway.

### 5.4 Spike plan

1. A Swift package (`RemoteKit`, a working name) with LCR1 parsing; the device identity (key,
   minimal certificate DER as in `R/identity.ts`, SPKI hash); the context hash and proof; the
   bridge (A, then B); framing; `hello` and `welcome`; requests; and one `events.poll`.
2. Tested with `swift test` on the Mac. Network.framework, Security and CryptoKit are the same on
   macOS, so the spike needs neither a simulator nor a device (the Mac has no simulator runtimes,
   §12).
3. Against the real Node host, in two steps:
   - **Channel harness**, a test-only Node script: a WebSocket server on 127.0.0.1 that answers
     `auth` with `connected` like the relay and hands the byte stream to the real
     `RemoteHost.serve` with a test store and identity. It prints a fresh LCR1 key and serves
     `session.ping`, `host.info` and `events.poll`.
   - **Full chain**, as in `test/remote-e2e.test.ts`: the Cloud in-process with Postgres
     (`CLOUD_TEST_DATABASE_URL`) and test-signed tokens, and the server daemon as a child process.
     This covers tickets, the relay and its close codes.
4. Shared test vectors generated from the Node code and kept as JSON in the repository: LCR1
   encoding and decoding, including a bad checksum, non-zero padding bits, a foreign environment and
   an expired key; the context hash of fixed fields; the proof for a fixed secret and exporter; a
   certificate's SPKI hash.

### 5.5 Acceptance criteria

- Pairing completes: the server accepts the proof, so Apple's exporter matches Node's.
- A wrong pin aborts before any application data; a wrong secret gets `proof_invalid`; a resumed
  session is never offered; TLS 1.2 cannot be negotiated.
- Reconnecting works with a `connect` ticket and the saved pin, with the device key from the
  Keychain. A Secure Enclave key either works or is ruled out with the reason.
- A 1 MiB frame makes the round trip; writes over 64 KiB are split; a slow reader does not deadlock
  the bridge under the relay's backpressure.
- Repeated 20 s `events.poll` calls complete; the relay's pings are answered; closing on suspension
  is clean.
- Only Apple frameworks, under Swift 6 strict concurrency.

## 6. Operations available to devices

### 6.1 By area

`RT/operationCatalog.ts:14-112` lists 84 operations: 67 requests, 15 commands (sent with a
`commandId`) and 2 watches (long polls). The server registers all of them
(`src/server/daemon.ts:119-137`, `src/server/remote.ts:35-40`), and `welcome.capabilities` names
them. Each `RT/*Operations.ts` file starts with strict zod request schemas. In the table, (C) marks
a command and (W) a watch; the rest are requests.

| Area | Operations | Phone |
| --- | --- | --- |
| Server | `session.ping`, `host.info`, `host.status` | MVP |
| Owner only | `usage.pending`, `diagnostics.collect`, `diagnostics.consent.get`, `diagnostics.consent.set` | Later (usage, bug reports) |
| Chats | `sessions.list`, `.create`, `.rename`, `.delete`, `.messages.list`, `.settings.get`, `.settings.update`, `.setup.get`; `models.available`; `chat.runs.start` (C), `chat.runs.get`, `chat.runs.cancel`; `chat.approvals.resolve` | MVP |
| Attachments, chat files | `uploads.begin`, `.chunk`, `.commit`, `.cancel`; `files.stat`, `files.read` | Uploads in the MVP (photo, PDF); files later |
| Events | `events.poll` (W) | MVP |
| Projects, shared folders | `projects.list`, `projects.create` (C), `projects.update`; `fs.roots`, `fs.browse`, `fs.mkdir` | Listing in the MVP; creating later |
| Models, GPUs | `models.local.snapshot`, `models.local.watch` (W), `models.load`, `models.unload`, `models.setDefault`, `models.downloads.list`, `.pause`, `.resume`, `.cancel`, `system.metrics` | MVP |
| | `models.catalog.search`, `models.catalog.get`, `models.downloads.start` (C), `models.local.delete`, `models.settings.get`, `models.settings.update` (includes multi-GPU), `models.local.rebalance` | Later |
| Tasks, schedules, runs | `orchestration.snapshot`; `tasks.run` (C), `tasks.runNext` (C); `schedules.update` (pausing); `workflows.runs.get`, `.events`, `.cancel`, `.review` (C), `.resume` (C) | MVP |
| | `tasks.create` (C), `tasks.update`, `tasks.delete`, `schedules.create` (C), `schedules.delete`, `workflows.runs.agentTrace.get` | Later |
| | `workflows.validate`, `workflows.save` (C), `workflows.runs.start` (C) | Not on the iPhone (editor; perhaps on an iPad) |
| Synthesis | `synthesis.modules.list`, `.get`, `.create` (C); `synthesis.folders.list`; `synthesis.runs.list`, `.get`, `.sources`, `.diff`, `.file`, `.start` (C), `.cancel`, `.resume` (C), `.apply` (C) | Later; only projects the device created |
| Settings | `settings.get`, `settings.update` (provider keys are write-only), `providers.test` (spends tokens) | Later |

There are no MCP operations for devices (§6.3).

### 6.2 Cloud endpoints a phone uses

| Endpoint | Use | Where |
| --- | --- | --- |
| `GET /v1/me` | Profile and `accountId` | `C/app.ts:56-58` |
| `POST /v1/devices` | Register the device key | `remoteRoutes.ts:60-65` |
| `GET /v1/hosts` | Servers with `online`, `appVersion`, `claimedAt`, `lastSeenAt`, and their devices with status | `remoteRoutes.ts:67-73` |
| `POST /v1/connections` | Tickets | `remoteRoutes.ts:75-87` |
| `DELETE /v1/hosts/:hostId/devices/:deviceId` | Remove a device's access, for example a lost laptop or phone | `remoteRoutes.ts:89-97` |
| `DELETE /v1/hosts/:hostId` | Unlink a server; no client uses it yet | `remoteRoutes.ts:99-107` |
| `GET /v1/usage/summary`, `GET /v1/usage/activity` | Usage totals; the app computes its time zone's UTC offsets itself | `C/usage/usageRoutes.ts:20-31, 101-120` |
| `wss …/v1/relay/client` | The relay | `C/remote/relay.ts:12, 191-241` |

Devices are managed in the Cloud only. There is no rename endpoint: the device name is set at
`POST /v1/devices`, and a server is named by its hostname. CORS applies to browsers only
(`C/app.ts:21-40`); a native app is not affected by it.

### 6.3 Where the host-only boundary is enforced

- **Chats with full access**, given on the server itself or through Telegram or MCP: a device may
  read, stop, decline and delete them, but not send, change settings or approve
  (`RT/chatOperations.ts:122-154, 374-392, 434-440`). Full access cannot be set from a device
  (`chatOperations.ts:27-29, 376-378`).
- **Tasks, schedules and runs** set up with full access (`accessMode: "full"`, steps with
  `approval: "never"` or `access: "full"`, `runDefaults.accessMode: "full"`, checked across every
  workflow version) or bound to a folder or project chosen on the server: a device may only delete,
  cancel or pause them (`RT/orchestrationOperations.ts:73-76, 93-109, 184-196, 304-306`).
- **Projects** set up on the server are listed by name as `hostOnly`, and their chats are
  invisible. A device may use only projects it created (`origin: "device"`) whose folder is still
  shared, checked at every use (`RT/projectOperations.ts:8-46`; `src/server/daemon.ts:107-115`).
- **Files:** only those the device's own chat read or wrote, with one answer for "missing" and
  "forbidden" (S:798-810).
- **Settings:** a patch that touches a host-only field is refused whole, and nothing is written
  (`RT/settingsOperations.ts:51-62`).
- **MCP:** device turns get no host MCP tools (`src/index.ts:238-243`,
  `src/agents/runtime/AgentLoopRunner.ts:25-26`); tasks and schedules a device creates or changes
  run without them (`orchestrationOperations.ts:89-90`); a waiting MCP call in a server's run can
  only be rejected from a device (`orchestrationOperations.ts:385-388`).
- The app shows the server's refusal text and never strips a host-only field to get a save through.

## 7. MVP: a pocket control room

### 7.1 Scope

| # | Feature | Operations and endpoints | Notes |
| --- | --- | --- | --- |
| 1 | Account and servers | Auth0 with Sign in with Apple; `GET /v1/me`; `GET /v1/hosts`; `DELETE …/devices/:d`; account deletion (§8.1) | Works before pairing, over plain HTTPS: servers with online state, version and last seen, their devices, and removing a lost device's access |
| 2 | Pairing | QR scan (VisionKit) or `PasteButton`; §4.2–§4.8 | On a server with no owner, the account that connects first becomes the owner (`src/server/cli.ts:151`) |
| 3 | Server dashboard | `host.status`: version, available update with notes and the install command, phase including draining, active work, scheduler, inference backend and CPU-fallback reason, loaded models (`src/server/daemon.ts:138-145`); `system.metrics`: RAM and VRAM per GPU; `models.local.watch`; `models.load`, `models.unload`, `models.setDefault`; download pause, resume and cancel | Memory per GPU is shown; multi-GPU settings and catalog search come later |
| 4 | Chat with the server's models | `sessions.*`, `models.available`, `chat.runs.start`, `chat.runs.cancel`, `events.poll`, `chat.approvals.resolve`, `uploads.*` | Streamed text, cancel, model and mode choice, approvals (approve where allowed, decline always), photos (recompressed on the phone) and PDFs (text extracted on the phone, as the desktop does, S:782-797), dictation through the iOS keyboard; subagent and debate progress shown, their setup later |
| 5 | Runs | `orchestration.snapshot`; `workflows.runs.events`, `.get` and the `workflow-run:<id>` stream; `workflows.runs.review` (approve or reject with a comment; MCP steps reject only); `.cancel`; `.resume`; `tasks.run`, `tasks.runNext`; `schedules.update {enabled: false}` | Live log; pausing works even for host-only schedules (`orchestrationOperations.ts:304-306`) |
| 6 | Push | §9 | Approval needed, run finished or failed, server offline or back, update available; tapping opens the item; approving happens in the app behind Face ID |

Why this scope: apart from push it uses only existing device operations inside the boundary, and
it covers the moments away from the desk: unblock, watch, react. Editors and server administration
stay on the desktop.

### 7.2 Behaviour kept from the desktop

- Without a connection, show the last state dimmed, send nothing and keep drafts. Commands queued
  offline never run on their own (S:624-627, S:1074-1077).
- Drafts, cursors and caches are kept per account and server; a late answer meant for a previously
  selected server is dropped (S:1074-1075; `RemoteRuntime.ts:96-98`).
- A missing operation means an older server: say "Update the server" (`chat-target.js:362`).
- Changing a server's runtime settings unloads its models for every device; warn first
  (S:630-631). Models are never unloaded automatically; a model that does not fit shows the
  server's error with its options (S:315-318).
- Paths arrive replaced by `<workspace>`, `<output>`, `<folder>` and `<server>`
  (`RT/chatOperations.ts:101-118`); show them as they are.
- Streaming works only while the app is open. On return, catch up from the saved cursors.

### 7.3 What stays off the phone

| Feature | Why | When |
| --- | --- | --- |
| Unlinking a server (`DELETE /v1/hosts/:h`) | Destructive | Later |
| Renaming the device | No endpoint; the name is set at registration | Later |
| Catalog search, starting a download, deleting a model | Needs room; long downloads | Later |
| Multi-GPU split, pinning, Rebalance | Untested on real hardware; reloads models | Later |
| Subagent and debate setup; chat files (Review, saved copies) | Desktop-sized screens | Later |
| Creating and editing tasks and schedules; agent traces | Forms | Later |
| Synthesis | Still in progress; only projects the device created | Later |
| Server settings, provider keys, diagnostics consent | Administration | Later |
| Usage | Cheap to add: `/v1/usage/*` and `usage.pending` | Later, or early if wanted |
| DOCX attachments | | Later |
| Workflow editor, saving, one-off runs | An editor | Not on the iPhone; perhaps on an iPad |
| Synthesis preview and DSL editing | Host only by design | Never |
| Server update, CUDA, shared folders, GGUF import, full access, MCP and Telegram setup | Server CLI and host screens only | Never |

## 8. Work outside the app

### 8.1 Cloud

**Push tokens.** A new migration, for example `0005_device_push.sql`:

```sql
CREATE TABLE device_push_tokens (
  device_id   uuid PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  token       bytea NOT NULL CHECK (octet_length(token) BETWEEN 32 AND 100),
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

```text
PUT    /v1/devices/:deviceId/push   {"token":"<hex>","environment":"sandbox"}   → 204
DELETE /v1/devices/:deviceId/push                                               → 204
```

- The device must belong to the caller's account and have the platform `ios`. The APNs topic (the
  bundle ID) comes from the Cloud's configuration, not from the request.
- A push goes only to devices with an active grant on the server that asked; a revoked device
  simply stops getting that server's pushes. A token is deleted when APNs answers 410 or
  `BadDeviceToken`, and with its device or account (cascade).

**APNs sender** (for example `C/push/apns.ts`). Token-based authentication with the `.p8` key: an
ES256 JWT (`kid` = Key ID in the header; `iss` = Team ID and `iat` in the claims) made with the
existing `jose` and reused for 20–60 minutes; requests over HTTP/2 with Node's built-in `http2`, to
the sandbox or production endpoint stored with each token; payloads of at most 4 KB [28][29][30].
No new dependencies. The key is mounted as a file, the way `DATABASE_URL_FILE` already works
(`C/config.ts:28-30`).

**`notify` from servers.** Add a `notify` type to the host messages (`C/remote/relay.ts:28-32`) and
handle it in `onHostMessage` (`relay.ts:161-189`); the message is described in §8.2. An older Cloud
ignores unknown host messages (`relay.ts:154-155`), so a newer server stays compatible.

**Server offline or back.** The Cloud sees this itself when a server's control socket closes or
reconnects (`relay.ts:143-148`). `hosts.last_seen_at` is written only when a server connects
(`remoteRepository.ts:63-65`), so "offline since" needs the close time. Wait out a grace period
(for example two minutes) before pushing, because `update` restarts the service.

**Account deletion** (guideline 5.1.1(v); there is no endpoint today, `C/app.ts:56-63`):

```text
DELETE /v1/me        Authorization: Bearer <access token>     → 204
```

1. Unlink every server the account owns, as `DELETE /v1/hosts/:hostId` does: grants revoked, a
   `host` revocation stored and pushed, streams closed (`remoteRepository.ts:189-199`;
   `relay.ts:115-119`). The servers keep their chats, files and models, since they are the user's
   machines; they lose their owner and grants, and the next key can be claimed by any account
   (`R/host/RemoteHostStore.ts:117-123`).
2. Delete the account row. Identity links, devices, grants, tickets, claim receipts, usage events
   and push tokens go with it (`ON DELETE CASCADE` in migrations 0001, 0003 and 0004);
   `hosts.owner_account_id` becomes null; audit rows keep only ids.
3. Delete the Auth0 user through the Management API, with a machine-to-machine client allowed to
   delete users. For Sign in with Apple users, Apple's tokens must be revoked through Apple's REST
   API [6][7]; community reports say Auth0 does this when it deletes the user, which needs checking
   on the tenant.
4. Refuse tokens issued before the deletion. `requireAccount` creates an account on the first call
   with a valid token (`C/accounts/requireAccount.ts:15-30`), so a still-valid access token from
   another device would otherwise create a fresh, empty account. Keep a tombstone of issuer,
   subject and deletion time, and answer `account_deleted` to older tokens.

The app asks the user to sign in again right before deleting, explains what happens to their
servers, and wipes its Keychain items and caches afterwards. The endpoint is idempotent, so a retry
finishes a partial deletion.

**Auth0** (configuration, not code): a separate Native application for iOS with HTTPS callbacks,
refresh-token rotation, `offline_access` and the Cloud API as audience; the Apple connection; the
Post-Login Action adding the namespaced claims for this application too; and the callback
confirmation setting (§13).

**Capacity.** The relay is one in-memory replica with 8 sessions per account (`relay.ts:16`); a
phone adds one session per connected server.

### 8.2 Server

**`notify` message**, server to Cloud over the control WebSocket (a proposal):

```text
{"type":"notify","notificationId":"<uuid>","kind":"approval_needed",
 "deviceIds":["<uuid>"],"collapseKey":"<opaque, at most 64 characters>",
 "sealed":{"<deviceId>":"<base64url AES-GCM ciphertext>"}}
```

- `kind` is one of `approval_needed`, `review_waiting`, `run_finished`, `run_failed`,
  `download_finished`, `download_failed`, `update_available`. Without `deviceIds` the message is for
  every active grant. `collapseKey` is opaque, for example an HMAC of the run id, the way usage
  events refer to runs (S:1179); it is never a title or a path. `sealed` is present only for
  encrypted notifications (§9.3).
- The control socket is already authenticated by the server's signature over the relay's challenge
  (`relay.ts:136-142`), so the message needs no signature of its own, unless the Cloud should keep
  notifications as evidence; then sign it like `claim.confirm` (`R/host/HostAgent.ts:225-235`) with
  a new signature context.
- The Cloud accepts it only from a claimed server, only for devices with an active grant on it, and
  rate-limits it per server and per device.

**Event hooks.** Where pushable events start today:

| Event | Source |
| --- | --- |
| Chat approval needed | `RunService.requestApproval` → `approval.requested` (`RT/RunService.ts:353-359`) |
| Chat turn finished, failed, interrupted or needing review | `RunService.finish` and `recover` (`RunService.ts:381-408, 218-239`) |
| Workflow or scheduled run waiting, done, failed, blocked or interrupted | `WorkflowRunStore.updateRun` (`src/workflows/WorkflowRunStore.ts:76`; statuses in `src/workflows/types.ts:22-30`), with its per-run JSONL log and event bus |
| Synthesis run accepted, needing review, blocked or unresolved | `SynthesisService` run records (`src/synthesis/SynthesisService.ts:447-480`; statuses in `src/synthesis/types.ts:4`); later, with Synthesis on the phone |
| Model download finished or failed, load failed, CPU fallback | `LocalModelService` events (`src/local/LocalModelService.ts:140`); each event is a whole snapshot, so they need diffing |
| Server update available | `UpdateChecker` (`src/update/updateChecker.ts:5-11, 27`), a daily signed-manifest check that feeds `host.status.update` |
| Device paired or removed | The Cloud: claim receipts and revocations |
| Server offline or back | The Cloud: the relay's control socket (§8.1) |

The hooks must cover all chats and runs, not only those a device happens to watch, and follow the
canary rule: no prompts, outputs, paths or keys leave the server (`test/canary-leaks.test.ts`).

**Inbox of pending approvals.** Today a phone would call `sessions.list` (which shows
`activeRunId`), then `chat.runs.get` or `sessions.messages.list` for each chat, and
`orchestration.snapshot` for waiting runs. Proposed:

```text
inbox.list → {"items":[
                {"kind":"chat_approval","sessionId":"…","runId":"…","approvalId":"…","requestedAt":"…","tool":"…","summary":"…"},
                {"kind":"run_review","runId":"…","waitingNodeRunId":"…","requestedAt":"…","rejectOnly":true}],
              "cursor":{"streamId":"inbox:all","epoch":"…","after":17}}
```

plus an `inbox:` stream source for `events.poll` (`RT/eventStreams.ts:11-20`). It lists only what
the device may see and marks what it may only reject.

**Pagination.** `sessions.list` returns every chat (`RT/chatOperations.ts:287-300`);
`sessions.messages.list` returns the newest 768 KiB with no way to page back
(`chatOperations.ts:20, 326`); `orchestration.snapshot` returns full lists
(`RT/orchestrationOperations.ts:216-224`). Add paged variants as new operations, for example
`sessions.page {limit, before?}` and `sessions.messages.page {sessionId, before?, limit?}`, with the
stream cursor only on the newest page. New operations rather than new fields, because the strict
schemas make older servers refuse unknown fields; the app detects the new names in `capabilities`.

**QR code in `pair`.** `pair` prints the key as text only (`src/server/cli.ts:141-164`), and keys
can be made only on the server, through its control socket (`src/server/daemon.ts:171-180`). Print
the same key as a QR code in the terminal (Unicode half blocks) in `pair`, in the server console and
at the end of the installer (`deploy/server/install.sh:305-307`), under the same rule as the key
text: the command's own output only, never the service log.

**Notification key** (encrypted notifications only, §9.3): a `notifications.register {key}`
operation over the end-to-end channel, stored with the device's grant.

**Optional, decision 6.** Approving a new phone from an already paired computer needs a new
owner-only operation that creates an invitation on the server and shows its QR code on the desktop.
It widens trust: today only root on the server can make keys, and a stolen paired laptop could then
add devices. Mitigations would be a confirmation on the server or a notification to every device.

### 8.3 Shared contract and test harness

- **Schemas to Swift.** Each `RT/*Operations.ts` keeps its zod request schemas in a module-private
  `schemas` object (for example `RT/chatOperations.ts:37-69`), and responses have no schemas at all
  (they are built by DTO functions). Export the request schemas of the operations the phone uses,
  with the channel messages (`R/messages.ts`) and the event payloads, into one registry; convert
  them with zod 4's `z.toJSONSchema` (already used in `src/tools/AgentTool.ts:47`); and generate
  Swift `Codable` types from the JSON Schema, for example with quicktype. For the responses the
  phone reads, add response schemas, or write the Swift types by hand and check them with contract
  tests.
- **Test vectors and harness:** §5.4. The Node conformance tests to mirror are
  `test/remote-channel.test.ts` and `test/remote-*-e2e.test.ts`.

## 9. Push notifications

### 9.1 Today

There is no push at all. A device sees changes only while it polls. On iOS the socket closes soon
after the app leaves the foreground, so without push an approval request waits unseen.

### 9.2 Pipeline

```text
event on the server (approval, run end, download, update)
  → server: notify {kind, deviceIds, collapseKey, sealed?} on the control WebSocket
  → Cloud: server claimed? device granted? token present? within rate limits? → APNs request
  → APNs (sandbox or production, per token)
  → iPhone: a generic alert, or the Notification Service Extension decrypts `sealed`
  → tap: the app opens the item; approving asks for Face ID
```

### 9.3 Content-free or encrypted

| | Content-free | Encrypted, decrypted on the phone |
| --- | --- | --- |
| What the Cloud sees | Kind and server name | Kind, server name and ciphertext |
| Alert text | "<server> needs your approval", "A run finished on <server>" | The chat title, tool and summary, or the run's name |
| Phone | Nothing extra | A Notification Service Extension, a shared Keychain group, `mutable-content: 1`, about 30 s to decrypt [18] |
| Server | `notify` | `notify`, a key per device, AES-GCM |
| If decryption fails | Not applicable | The generic text in the same payload stays |

Both satisfy guideline 4.5.4 (no sensitive personal information in notifications), and both keep
the Cloud's design of seeing only metadata (S:83-86).

A proposed encrypted design that needs no new primitives: when the phone pairs, or when the user
turns on detailed notifications, it makes a random 256-bit key for that server and sends it over the
end-to-end channel (`notifications.register`). It keeps the key in the Keychain group the extension
can read (`AfterFirstUnlockThisDeviceOnly`). The server seals `{title, body, target}` with
AES-256-GCM (a random 96-bit nonce; the server id, device id and notification id as associated
data). The Cloud forwards `sealed` untouched and never holds the key. Node's `crypto` and CryptoKit
both provide AES-GCM. The device's TLS key is not reused for this: one key per purpose, as the
server already keeps its TLS and signing keys apart (S:398-399).

### 9.4 Approving from a notification

| Option | How | Trade-offs |
| --- | --- | --- |
| In the app with Face ID (suggested for the MVP) | A time-sensitive alert opens the app on the approval; Face ID (LocalAuthentication, `NSFaceIDUsageDescription`) before Approve | Simple; the app connects in the foreground; the interruption level needs the Time Sensitive Notifications capability |
| Lock-screen actions | Approve and Decline as notification actions that require unlocking; the app then runs in the background and must connect (relay, TLS, `hello`) and send `chat.approvals.resolve` within its background time | No app switch, but it fails silently when the server is unreachable, and the decision rests only on what the notification shows |

Declining is always allowed for a device (`chatOperations.ts:434-438`), so a lock-screen Decline is
lower risk than Approve. Under the host-only boundary, none of these options can approve host MCP
calls or full-access work (decision 7).

### 9.5 APNs specifics

- Token authentication uses the `.p8` key, the Key ID and the Team ID, with an ES256 JWT refreshed
  every 20–60 minutes. Team keys are now Sandbox-only or Production-only (at most two per
  environment), or limited to specific apps [28].
- Builds run from Xcode use the sandbox; TestFlight and App Store builds use production [29][30].
  Store the environment with each token; drop tokens on 410 or `BadDeviceToken`; payloads are at
  most 4 KB.
- Headers: `apns-topic` (the bundle ID), `apns-push-type: alert`, `apns-priority` 10 for alerts
  and 5 for routine updates, `apns-collapse-id` derived from `collapseKey`; `thread-id` in the
  payload groups notifications per server.

### 9.6 Later: Live Activities

For long runs on the Lock Screen and in the Dynamic Island: at most 8 hours active plus 4 hours on
the Lock Screen, 4 KB of data and no network access; updated by `liveactivity` pushes (topic
`<bundle ID>.push-type.liveactivity`, priority 5 for routine updates); starting one by push needs
iOS 17.2 [19][20]. That payload passes the Cloud in clear, so it may carry only progress and
status. `BGContinuedProcessingTask` (iOS 26) is for work on the phone itself, not for watching
remote runs [21].

## 10. Stack decision: native SwiftUI

| Option | For | Against |
| --- | --- | --- |
| **Native SwiftUI (recommended)** | The channel, the notification extension, a Live Activity widget, Keychain and Face ID must be written in Swift whatever the stack; the best native feel (Liquid Glass), which the installed desktop app also aims for; the lowest review risk; only Apple's cryptography, so no export documents; the channel package is testable with `swift test` against the real Node host | Nothing is shared with the TypeScript code except generated types and test vectors |
| React Native or Expo (second choice) | TypeScript; `expo-widgets` stable since SDK 56 [32] | Still needs a Swift module for the channel (React Native cannot run `node:tls`); a second runtime; yearly upgrade churn |
| Capacitor (wrapping the web UI) | Reuse | The desktop UI (about 13 000 lines of hand-written JavaScript, 27 000 with the bundled editors) is laid out for a desktop window and calls a local API, so it needs a phone redesign anyway; it brings the browser-page feel the owner rejected |
| Flutter | | Reuses nothing |

- **Minimum iOS:** 18. HTTPS sign-in callbacks need iOS 17.4.
- **Dependencies:** Auth0.swift through Swift Package Manager [24]; Sentry's Cocoa SDK for error
  reports, opt-in, scrubbed and in the EU region as on the desktop (S:1217-1243); otherwise Apple
  frameworks: Network, Security, CryptoKit, AuthenticationServices, LocalAuthentication,
  UserNotifications, VisionKit and PDFKit. No CocoaPods (its trunk becomes read-only on
  2 December 2026 [1]); fastlane is not needed.
- **Shared types:** generated from the zod schemas (§8.3).
- **Layout (a proposal):** `apps/ios/` next to `apps/cloud/`, holding the `RemoteKit` package and
  the Xcode project; the Node harness lives with the other tests.
- **Android later:** Skip (free since January 2026 [33]) or Kotlin. Either needs its own channel
  implementation.
- **Licence:** code kept in this repository falls under the Elastic License 2.0 like the rest, and
  App Store texts describe the project as source available. Contributions from others would need a
  contributor agreement first.

## 11. App Store requirements

These apply whatever the business model. The guidelines were last updated on 8 June 2026 [5].

| Rule | What it means here |
| --- | --- |
| 4.8 Login Services | Offering Google login requires an equivalent login that collects only name and email, lets the email stay hidden and does no ad tracking; Sign in with Apple meets it. Natively, the AuthenticationServices button returns a code that Auth0.swift exchanges with `login(appleAuthorizationCode:)`, sending no nonce [26] |
| 5.1.1(v) Account deletion | A first Apple or Google sign-in creates an account (`C/accounts/requireAccount.ts:15-30`), so deletion must be available inside the app; deactivation is not enough; with Sign in with Apple, Apple's tokens are revoked [6][7]. Needs `DELETE /v1/me` (§8.1) |
| 2.1(a), 4.2.3(i) | The app needs another product to work: App Review needs a demo account and an always-on demo server. Pairing is per device, and a key lives at most an hour (§4.3), so the reviewer's phone must be able to get a fresh key, for example from a page linked in the review notes that shows the demo server's current QR code. A deletion test would unlink the demo server, so keep a way to restore the demo account. Its email must be verified, because tickets require it |
| 4.2.7, 4.2.7(e) | 4.2.7 covers remote-desktop mirrors of specific software, and 4.2.7(e) bars thin clients for cloud apps; a native API client for servers the user owns is neither. Say so in the review notes; precedents include Enchanted (an Ollama client) [10] and SSH and remote-desktop clients |
| 2.5.2, 4.7 | Never load or stream the desktop UI from the server. Showing AI-generated code as text and running workflows on the server are fine; any HTML preview belongs only in a sandboxed `WKWebView` without a native bridge (4.7.2). Synthesis previews are not offered to devices anyway (`architecture/runtime-operations-inventory.md`, "Synthesis (R5-5)") |
| 5.1.2(i) | Disclose and get explicit permission before personal data goes to a third-party AI service. This matters when the server uses cloud providers; the desktop accepts provider API keys |
| Age rating | The questionnaire (13+, 16+, 18+) asks to take chatbot features into account [11]; unfiltered local models point to 18+. Texas SB2420 (in force since 4 June 2026) adds duties around the Declared Age Range API and PermissionKit [12] |
| 4.5.4 | No sensitive personal information in notifications (§9.3) |
| Privacy labels and manifest | Labels include data that SDKs handle. Apple's "collect" means data kept beyond real-time servicing [8]: end-to-end encrypted chat with the user's own server is arguably not collected, while email, name, user and device ids and opt-in crash data are. A privacy manifest with required-reason APIs (for example UserDefaults, reason `CA92.1`) has been mandatory since May 2024 [9] |
| Export compliance | With only the operating system's cryptography, answer the questions and upload no documents; bundling BoringSSL would require a French encryption declaration [13] |
| EU Digital Services Act | An individual trader's address (or P.O. box), phone and email are shown on EU listings [14]; the EU can be left out at first |
| Pairing wording | Describe the key and its QR code as pairing a device with the user's own server, never as unlocking app features |

- **Usage descriptions:** `NSCameraUsageDescription` for the QR scanner and
  `NSFaceIDUsageDescription`. The photo picker, the document picker and keyboard dictation need no
  permission. A LAN mode, if ever added, would bring the Local Network prompt
  (`NSLocalNetworkUsageDescription`, `NSBonjourServices`), and URLSession connections to raw local
  IP addresses would need `NSAllowsLocalNetworking` [16][23].
- **TestFlight:** up to 100 internal and 10 000 external testers; external builds need Beta App
  Review; public invitation links are available [31].

## 12. Tooling on the owner's Mac

Checked on 2026-10-11 with read-only commands.

| Item | State |
| --- | --- |
| macOS | 26.3.1 (a) |
| Xcode | 26.0.1 (17A400), with the iOS 26.0 SDK |
| Swift | 6.2 |
| Simulators | No simulator runtimes and no simulators |
| CocoaPods, fastlane | Not installed and not needed |
| Signing | Only a Developer ID Application identity (for Mac distribution); no Apple Development or Apple Distribution identity and no provisioning profiles |
| Upload rules | Uploads have needed Xcode 26 or later since 28 April 2026, and will need the iOS 27 SDK (Xcode 27) from about April 2027 [2][3]; Xcode 27 needs macOS 26.6 or later [4] |

What works today is `swift test` for the channel package. Running on a simulator or an iPhone needs
the runtime download and iOS signing (§13).

## 13. Owner-only setup

These steps need the owner's Apple and Auth0 accounts. Private keys (`.p8` files) are downloaded
once, never shared in chat, never committed, and reach the Cloud only as mounted files.

1. Update macOS to 26.6 or later and install Xcode 27 before uploads need it; download the iOS
   simulator runtime.
2. Sign Xcode in to the developer team, which creates the Apple Development certificate. Create an
   Apple Distribution certificate, or use cloud-managed signing. Register the iPhone and turn on
   Developer Mode.
3. Choose the bundle ID and register the App ID with Push Notifications, Sign in with Apple,
   Associated Domains and App Groups, and optionally Time Sensitive Notifications.
4. Create the APNs keys (Sandbox and Production) and a Sign in with Apple key with a Services ID
   (the Services ID is for sign-in on the web and the desktop).
5. Register the email sending domains for Apple's private relay (SPF, DKIM); otherwise Auth0's
   emails to hidden addresses do not arrive [27].
6. Create the app record in App Store Connect: privacy and support URLs, the App Privacy answers,
   the age-rating questionnaire, export compliance, the EU trader decision (or leave the EU out at
   first), and the demo account and demo server for review. On an Individual developer account the
   seller name is the developer's legal name.
7. In Auth0, create the iOS Native application with HTTPS callbacks: `useHTTPS()` needs
   `webcredentials:<Auth0 domain>` in Associated Domains and the Team ID and bundle ID in the
   application's Device Settings [24]. Set up the Apple connection (Team ID, Key ID and the Sign in
   with Apple key) [26], make the Post-Login Action cover this application, and add a
   machine-to-machine client for account deletion. Decide the "Non-Verifiable Callback URI End-User
   Confirmation" setting: Auth0 now asks users to confirm custom-scheme and loopback callbacks, by
   default on older tenants since 28 April 2026 [25], which also affects the desktop's loopback
   sign-in.

## 14. Open decisions for the owner

| # | Decision | Options | Notes |
| --- | --- | --- | --- |
| 1 | Phone first, or desktop-as-host first | The phone controls the GPU server now / the desktop learns to host first (switch, tray, autostart: S:45) | The phone work is the same either way. Desktop-as-host alone does not bring Blender or Unreal to the phone: device turns and device-made tasks get no host MCP tools, and devices cannot approve host MCP calls (§6.3), unless decision 7 changes that |
| 2 | Devices | iPhone only / iPad too; Android later | SwiftUI adapts to the iPad, and the workflow editor could come to the iPad; Android later through Skip or Kotlin |
| 3 | Payment path on iOS | | An open owner decision, tracked outside this document |
| 4 | Accounts in the app | Sign-up in the app / sign-in only | A first Apple or Google sign-in already creates an account (`requireAccount.ts:15-30`), so in-app deletion is needed in practice either way |
| 5 | Notification content and approvals | Generic text / encrypted detailed text; approve from the lock screen / only in the app with Face ID | Generic text is simpler; encrypted text needs the extension and a key per server (§9.3–§9.4). Suggested: generic first, approvals in the app with Face ID |
| 6 | Pairing a phone | QR code from the server (`pair`, console, installer) / approval from an already paired computer | The QR code is in the MVP; the second is a new flow in which a device can create invitations (§8.2) |
| 7 | Host-only boundary for the phone | Keep it (recommended) / let the phone approve full-access work and host MCP calls, for example after Face ID | Face ID is checked only on the phone and the server cannot verify it. Raising a device's rights would have to be granted on the server (for example a "trusted device" set with the server CLI), with Face ID as an extra local gate, and checked against everything §6.3 lists |

## 15. First step and milestones

Implementation starts once the decisions are answered. Each step ends with tests, a commit and a
push, as in the other stages.

| Step | Content | Done when |
| --- | --- | --- |
| 0 | The owner's decisions (§14); Apple and Auth0 setup (§13) can run in parallel | The answers are recorded in this document |
| 1 | **Channel spike:** the `RemoteKit` package, the Node harness and the shared test vectors (§5.4) | §5.5 passes with `swift test` against the real server code |
| 2 | App skeleton: sign-in (Auth0 and Apple), `/v1/me`, servers, device key and registration, QR and paste pairing, connect and reconnect, Keychain. Server: the QR code in `pair`. Cloud: `DELETE /v1/me` | An iPhone pairs with the GPU server through the production relay; an internal TestFlight build exists |
| 3 | Server dashboard and models | Status, metrics and model actions match the desktop |
| 4 | Chat: streaming, cancel, model and mode, approvals, photos and PDFs, dictation; pagination if long histories need it | Suspension and reconnects neither lose nor repeat turns |
| 5 | Runs: live log, review, cancel, resume, run a task, pause a schedule | The same results as the desktop on the same run |
| 6 | Push: Cloud tokens and sender, `notify`, server hooks, the inbox; generic text | An approval request on the server reaches a locked phone and opens the right screen |
| 7 | App Store readiness: privacy labels and manifest, age rating, demo account and demo server with keys on demand, review notes, external TestFlight | Submitted for review |
| Later | Encrypted notifications, Live Activities, usage, the model catalog and downloads, iPad, desktop-as-host, Android | |

**Proposed first step:** step 1, the channel spike. It is the only risk that could change the
design, and it needs neither Apple signing nor a device.

## 16. Sources

External sources were checked on 2026-10-11; repository references are at `0dbef53`.

1. CocoaPods Specs repository goes read-only: https://blog.cocoapods.org/CocoaPods-Specs-Repo/
2. Apple, upcoming requirements: https://developer.apple.com/news/upcoming-requirements/
3. App Store submissions for iOS 27: https://www.iclarified.com/102165/apple-opens-app-store-submissions-for-ios-27-macos-27-and-more
4. Xcode system requirements: https://developer.apple.com/xcode/system-requirements/
5. App Review Guidelines: https://developer.apple.com/app-store/review/guidelines/
6. Offering account deletion in your app: https://developer.apple.com/support/offering-account-deletion-in-your-app/
7. TN3194, account deletions and Sign in with Apple tokens: https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple
8. App privacy details: https://developer.apple.com/app-store/app-privacy-details/
9. Required-reason APIs: https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api
10. Enchanted, an Ollama client: https://github.com/gluonfield/enchanted
11. Age rating updates: https://developer.apple.com/news/?id=ks775ehf
12. Age assurance requirements: https://developer.apple.com/news/?id=sg176nne
13. Export compliance documentation: https://developer.apple.com/help/app-store-connect/reference/export-compliance-documentation-for-encryption
14. EU Digital Services Act trader requirements: https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements
15. TLS exporter in Network.framework: https://developer.apple.com/forums/thread/128938
16. TN3179, local network privacy: https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy
17. TLS over a custom framer (STARTTLS): https://developer.apple.com/forums/thread/129901
18. Notification Service Extension: https://developer.apple.com/documentation/usernotifications/modifying-content-in-newly-delivered-notifications
19. Live Activities: https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities
20. Live Activities by push: https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications
21. BGContinuedProcessingTask: https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtask
22. App Transport Security: https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity
23. NSAllowsLocalNetworking: https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking
24. Auth0.swift (README and FAQ): https://github.com/auth0/Auth0.swift
25. Auth0, measures against app impersonation: https://auth0.com/docs/secure/security-guidance/measures-against-app-impersonation
26. Auth0, Sign in with Apple for native apps: https://auth0.com/docs/authenticate/identity-providers/social-identity-providers/apple-native
27. Private email relay service: https://developer.apple.com/help/account/capabilities/configure-private-email-relay-service
28. Token-based connection to APNs: https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns
29. Sending notification requests to APNs: https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
30. APS environment entitlement: https://developer.apple.com/documentation/bundleresources/entitlements/aps-environment
31. TestFlight: https://developer.apple.com/testflight/
32. Expo widgets and Live Activities: https://expo.dev/blog/home-screen-widgets-and-live-activities-in-expo
33. Skip is free: https://skip.dev/blog/skip-is-free/
34. swift-nio-ssl issue #599: https://github.com/apple/swift-nio-ssl/issues/599
