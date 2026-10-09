# Runtime operations inventory (R0)

Date: 2026-10-07, at commit `4671a02` plus the R0 working tree. Status: R0 deliverable for
[Remote Connection](remote-connection-implementation.md) §7.1 and §8. Every UI call to the
backend must become an explicit `RuntimeClient` operation (no generic URL proxy). This
table is the starting registry; operation IDs are proposals until the registry module lands.

## How it was enumerated (re-runnable)

```sh
grep -nE "router\.(get|post|put|patch|delete|all)\(" src/api/*.ts      # 104 routes
grep -nE "router\.use\(" src/api/*.ts                                   # mount prefixes
grep -noE "\b(request|fetch|synthesisRequest(<[^>]*>)?)\(" public/assets/{app,plugins-ui,model-manager,settings-data,settings-shell,workflow-live}.js frontend/synthesis/*.ts*
grep -rnE "EventSource|WebSocket|sendBeacon|XMLHttpRequest" public/assets/*.js frontend
grep -rnoE "window\.desktop[A-Za-z]+(\??\.[A-Za-z]+)*" public/assets/*.js frontend
```

Git-ignored build output (`workflow-editor.js`, `synthesis-workspace.js`, `markdown-renderer.js`,
`index-*.mjs`) is excluded; `synthesis-workspace.js` is the bundle of `frontend/synthesis/api.ts`.

## Counts

| | Count |
|---|---|
| Backend routes (`routes.ts` 65, local models 12, integrations 9, MCP 3, synthesis 14, attachments 1) | 104 |
| Routes reached from the UI / not reached | 84 / 20 |
| UI network call sites (+3 helper-internal `fetch`) | 90 |
| `app.js` `request()` calls (41 in the `api` object, 8 inline) | 49 |
| Other: plugins-ui 11, model-manager 8 + 1 EventSource, settings-data 5, workflow-live 1 + 1 EventSource, settings-shell 1, synthesis 12 + 1 iframe | 41 |
| Preload bridge calls (non-voice) / voice bridge methods | 9 / 11 |

Classification of the 90 call sites: **HOST-API** 81 (one dead: `api.stepWorkflowRun`),
**ADAPT** 8, **CLIENT** 1. Swapping only the body of `request()` (`app.js` ~614) covers 63 sites,
because it is injected into model-manager, settings-data and workflow-live.

Classes: **HOST-API** — pure host operation, works remotely through the dispatcher;
**ADAPT** — needs a remote variant per spec §8 (native dialogs, reveal/open editor, file browse,
uploads, OAuth callback forwarding); **CLIENT** — stays on the client.

Abbreviations: A=`public/assets/app.js`, MM=`model-manager.js`, PU=`plugins-ui.js`,
SD=`settings-data.js`, SS=`settings-shell.js`, WL=`workflow-live.js`, PR=`projects-ui.js`,
SW=`frontend/synthesis/SynthesisWorkspace.tsx`, ND=`NewModuleDialog.tsx`. Backend: R=`routes.ts`,
C=`controller.ts`, TC/SC/WC/PC=task/schedule/workflow/project controllers, WR=`workspaceReview.ts`,
LMC=`localModelControllers.ts`, IC=`integrationControllers.ts`, MC=`mcpControllers.ts`,
SY=`synthesisControllers.ts`, AC=`attachmentControllers.ts`. "def→uses" = line of the `api.*`
definition → call sites.

## System, bootstrap

| UI | Route | Notes | Class | Operation |
|---|---|---|---|---|
| A:151→520 | GET /dashboard/bootstrap R:103→C:165 | **Returns secrets** (`providers.*.apiKey`, `telegram.botToken`) and absolute host paths | HOST-API, safe DTO required | `dashboard.bootstrap` |
| A:305→4317,4354,4669,4798 | GET /system/metrics R:104→C:217 | polled 1 s / 5 s | HOST-API | `system.metrics` |
| A:216→4281 | POST /runtime/reload R:131→C:632 | admin | HOST-API | `runtime.reload` |
| A:150→527 | GET /integrations/available R:86→IC:39 | | HOST-API | `integrations.available` |
| SS:337 (browser fallback only) | GET /app/info R:95 | Electron uses IPC | CLIENT | `client.app.info`; host version from handshake |

## Sessions and projects

| UI | Route | Notes | Class | Operation |
|---|---|---|---|---|
| A:157→547,564 | POST /sessions R:121→C:476 | | HOST-API | `sessions.create` |
| A:162→4253,4419,5794 | PATCH /sessions/:id R:122→C:502 | | HOST-API | `sessions.rename` |
| A:167→6020 | DELETE /sessions/:id R:123→C:526 | | HOST-API | `sessions.delete` |
| A:170→594 | GET /sessions/:id/messages R:124→C:548 | absolute paths in tool metadata; inline image dataUrls | HOST-API, bound size | `sessions.messages.list` |
| A:171→595 | GET /sessions/:id/settings R:125→C:370 | | HOST-API | `sessions.settings.get` |
| A:173→412,567,1058,1188,4255,4423,5801 | PUT /sessions/:id/settings R:126→C:382 | autosave | HOST-API | `sessions.settings.update` |
| A:152→310 (PR:139) | POST /projects R:118→PC:13 | host `rootPath` | HOST-API | `projects.create` |
| A:153→311 (PR:139,151,212) | PATCH /projects/:id R:119→PC:22 | | HOST-API | `projects.update` |
| A:3453 | POST /projects/:id/reveal R:120→PC:34 | opens Finder/Explorer on the host | ADAPT | `projects.reveal` |
| PR:128, A:2191 | IPC `projects:select-directory` (main.cjs) | native dialog | ADAPT | `fs.browse` (remote) / `client.dialog.selectDirectory` |

## Chat

| UI | Route | Notes | Class | Operation |
|---|---|---|---|---|
| A:178→3366 | POST /chat R:192→C:28 | open connection for the whole turn; client sends `requestId`; cancel on disconnect; attachments inline | HOST-API via the 202 run API (§7.3) | `chat.runs.start` |
| A:191→1271 | GET /process-runs/:id R:195→C:105 | polled every 600 ms; approval contains paths/commands | HOST-API → subscription | `chat.runs.get` / `chat.runs.subscribe` |
| A:188→1203 | POST /process-runs/:id/review R:194→C:115 | | HOST-API | `chat.approvals.resolve` |
| A:193→1247 | POST /process-runs/:id/cancel R:196→C:126 | | HOST-API | `chat.runs.cancel` |
| A:5642 | POST /attachments/extract R:88→AC:6 | base64 ≤5 MB in JSON (8 MB limit) | ADAPT (upload) | `attachments.extract` |

## Workspace review

| UI | Route | Notes | Class | Operation |
|---|---|---|---|---|
| A:195→337 | GET /workspace/file R:198→WR:90 | 5 MB cap; returns absolute path | HOST-API | `workspace.files.read` |
| A:197→338 | POST /workspace/editor R:197→WR:147 | spawns VS Code on the host | ADAPT | `workspace.files.openInEditor` |
| A:199→4484,6280 | POST /workspace/reveal R:199→C:135 | | ADAPT | `workspace.reveal` |

## Tasks and schedules

| UI | Route | Notes | Class | Operation |
|---|---|---|---|---|
| A:4766 | GET /tasks R:133→TC:22 | polled 1 s while runs are active | HOST-API | `orchestration.snapshot` (R5-2: one revisioned snapshot of tasks, schedules, workflows and runs; 2 s / 15 s poll) |
| A:232→3653 | POST /tasks R:134→TC:33 | attachments inline | HOST-API | `tasks.create` (command; attachments and projects deferred) |
| A:237→1847,3785,5510,5528 | PATCH /tasks/:id R:143→TC:91 | | HOST-API | `tasks.update` |
| A:242→3950 | DELETE /tasks/:id R:144→TC:145 | 204 | HOST-API | `tasks.delete` |
| A:246→3934 (dead) | POST /tasks/:id/queue R:145→TC:163 | no template renders the button | drop | — |
| A:250→4006 | POST /tasks/:id/run R:146→TC:181 | 900 s | HOST-API | `tasks.run` (command, accept-and-observe) |
| A:256→4018 | POST /tasks/run-next R:135→TC:195 | 900 s | HOST-API | `tasks.runNext` (command, accept-and-observe) |
| A:154→1850,1859 | GET /tasks/:id/workspace R:137→TC:134 | absolute rootPath | DEFER (R5 step 4) | `tasks.workspace.get` |
| A:155→1869 | POST /tasks/:id/workspace/reveal R:138 (inline) | | DEFER (R5 step 4) | `tasks.workspace.reveal` |
| A:262→3713 | POST /schedules R:149→SC:21 | | HOST-API | `schedules.create` (command) |
| A:267→1848,3972 | PATCH /schedules/:id R:150→SC:67 | | HOST-API | `schedules.update` |
| A:272→3989 | DELETE /schedules/:id R:151→SC:120 | | HOST-API | `schedules.delete` |

## Workflows and FSM

| UI | Route | Notes | Class | Operation |
|---|---|---|---|---|
| A:286→3898, A:291→3898 | POST /workflows R:154→WC:93, PUT /workflows/:id R:156→WC:110 | one save with the version it was edited from (`expectedUpdatedAt`) | HOST-API | `workflows.save` (command; `workflow_conflict`) |
| A:296→3890 | POST /workflows/:id/validate R:157→WC:130 | | HOST-API | `workflows.validate` |
| A:4766 | GET /workflow-runs R:158→WC:139 | polled 1 s | HOST-API | in `orchestration.snapshot` |
| A:2197 | POST /workflow-runs R:159→WC:6 | `options.rootPath` may come from the picker | HOST-API | `workflows.runs.start` (command, reserved run id; folders deferred) |
| A:275→(9 sites); WL:42 | GET /workflow-runs/:id R:160→WC:150 | | HOST-API | `workflows.runs.get` |
| WL:49 | GET /workflow-runs/:id/events R:161→WC:18 | **SSE** `history`/`update`, `id`=sequence, Last-Event-ID/`?after`, 15 s heartbeat; `EventSourceClass` is injectable | HOST-API (subscribe) | `workflows.runs.events` (history + cursor), then `events.poll` on `workflow-run:<id>` |
| A:2217 | POST /workflow-runs/:id/review R:163→WC:190 | 900 s | HOST-API | `workflows.runs.review` (command) |
| A:282→2215 | POST /workflow-runs/:id/cancel R:164→WC:179 | | HOST-API | `workflows.runs.cancel` |
| A:2216 | POST /workflow-runs/:id/resume R:165→WC:209 | | HOST-API | `workflows.runs.resume` (command) |
| A:6288 | GET /workflow-runs/:runId/agent-runs/:agentRunId R:166 (inline) | | HOST-API | `workflows.runs.agentTrace.get` |
| A:276 (dead) | POST /workflow-runs/:id/step R:162→WC:168 | no callers | drop | — |

## Models and local runtime

| UI | Route | Notes | Class | Operation |
|---|---|---|---|---|
| A:301→4669,4725,4741 | GET /local/models/all R:111→C:270 | file paths | HOST-API | `models.managed.list` |
| A:220→4309; MM:570 | POST /local/models/load R:112→C:282 | no timeout for llama.cpp | HOST-API | `models.load` |
| A:226→4347; MM:570 | POST /local/models/unload R:113→C:304 | | HOST-API | `models.unload` |
| A:210→4378,4402; SD:15→SS:572 | POST /providers/:id/test R:130→C:647 | | HOST-API | `providers.test` (R5-3: `{providerId, model?}`, uses the key saved on the host, answer scrubbed of keys; not for `llamacpp`) |
| MM:441 | GET /local/catalog LMC:13 | | HOST-API | `models.catalog.search` |
| MM:465 | GET /local/catalog/model LMC:14 | | HOST-API | `models.catalog.get` |
| MM:485 | GET /local/runtime LMC:28 | also 5 s fallback poll; paths | HOST-API | `models.local.snapshot` |
| MM:485 | GET /local/downloads LMC:15 | | HOST-API | `models.downloads.list` |
| MM:532 | GET /local/events LMC:29 | **SSE**, first frame is a snapshot; Last-Event-ID ignored | HOST-API (watch) | `models.local.watch` (R5-1: state long-poll `{epoch, after}` → `{epoch, sequence, snapshot?}`) |
| MM:563 | POST /local/downloads LMC:16 | 202 | HOST-API | `models.downloads.start` |
| MM:567 | POST /local/downloads/:id/{pause,resume,cancel} LMC:18-20 | | HOST-API | `models.downloads.pause/resume/cancel` |
| MM:573 | DELETE /local/models/:libraryId LMC:26 | | HOST-API | `models.local.delete` |
| MM:558 | IPC `models:select-files` → `importModel` (REST LMC:21 unused) | native dialog | ADAPT | `fs.browse` + `models.local.import` |
| MM:559 | IPC `models:select-projector` (REST LMC:27 unused) | | ADAPT | `fs.browse` + `models.local.attachProjector` |
| SS:561 | IPC `models:select-directory` → `localModels.modelsDir` | | ADAPT | R5-3: host-only, shown as "Set on <server>"; `fs.browse` later |

## Settings and MCP

| UI | Route | Notes | Class | Operation |
|---|---|---|---|---|
| SD:8→SS:352,417,436,595, A:506,677; A:204→371,421,4395 | PUT /app/settings R:129→C:611 | response returns raw settings with secrets | HOST-API with per-field policy | `settings.get` / `settings.update` (R5-3: safe view; allowlist; keys `{set}` / `{clear}`; appearance and profile never leave the device) |
| SD:18→SS:452 | GET /mcp/clients MC:17 | | HOST-API | `mcp.clients.list` |
| SD:19→SS:444 | POST /mcp/clients/:id/connect MC:25 | | HOST-API | `mcp.clients.connect` |
| SD:20→SS:444 | POST /mcp/clients/:id/disconnect MC:32 | | HOST-API | `mcp.clients.disconnect` |

`settings.update` field policy: `ui` and `profile` are client settings in Remote; `mcp.client.servers`
(stdio command = arbitrary host execution), `filesystem.*`, memory paths and `localModels.modelsDir`
are host-admin scope; secrets are write-only (`set` / `clear` / `unchanged`).

Done in R5-3 (`src/runtime/settingsOperations.ts`, `settingsDto.ts`): a device may change chat
defaults, the default provider, provider enabled/model/timeout (Anthropic version and token limit),
provider keys (written or cleared, never read), local runtime tuning, agent limits and memory tuning.
Refused with the reason, and nothing written: `filesystem.*`, `localModels.modelsDir`, memory paths,
`providers.*.baseUrl`, `mcp.server`, `telegram` (`host_only`); `mcp.client`, `plugins` (`unsupported`,
step 6); `profile` and appearance keys (`client_setting`). The view carries `apiKeyState`, an address's
origin only, and counts instead of folders. No `client.settings.update`: appearance and profile are
saved by this device's own API whichever machine is selected.

## Plugins and integrations (helper PU:16, base `/integrations`)

| UI | Route | Notes | Class | Operation |
|---|---|---|---|---|
| PU:24 | GET /integrations IC:37 | already a safe DTO — the pattern to copy | HOST-API | `integrations.snapshot` |
| PU:42, PU:165 | POST /integrations/connections/:id/refresh IC:54 | polled 2.5 s while connecting | HOST-API | `integrations.connections.refresh` |
| PU:60 | POST /integrations/:id/install IC:40 | | HOST-API | `integrations.install` |
| PU:61 | POST /integrations/:id/connect IC:46 | host opens the browser and a loopback callback | ADAPT (§9) | `integrations.connect` + `integrations.oauth.complete` |
| PU:161,166,167,173 | PATCH /integrations/:id IC:41 | | HOST-API | `integrations.configure` |
| PU:169 | DELETE /integrations/:id IC:44 | | HOST-API | `integrations.uninstall` |
| PU:168 | DELETE /integrations/connections/:id IC:57 | | HOST-API | `integrations.connections.disconnect` |

## Synthesis (`frontend/synthesis/api.ts`, base `/synthesis`)

| UI | Route | Class | Operation |
|---|---|---|---|
| SW:97 | GET /projects/:pid/modules SY:10 | HOST-API | `synthesis.modules.list` |
| SW:98 | GET /projects/:pid/runs SY:25 | HOST-API | `synthesis.runs.list` |
| SW:115 | GET /projects/:pid/modules/:mid SY:18 | HOST-API | `synthesis.modules.get` |
| SW:131 | GET /runs/:id SY:30 (polled 1.2 s) | HOST-API | `synthesis.runs.get` |
| SW:150 | GET /runs/:id/sources SY:31 | HOST-API | `synthesis.runs.sources` |
| SW:165 | GET /runs/:id/diff SY:34 | HOST-API | `synthesis.runs.diff` |
| SW:179 | POST /projects/:pid/open SY:19 (opens an editor on the host) | ADAPT | `synthesis.files.openInEditor` |
| SW:189 | POST /projects/:pid/runs SY:26 | HOST-API | `synthesis.runs.start` |
| SW:194 | POST /runs/:id/{cancel,resume} SY:32-33 | HOST-API | `synthesis.runs.cancel/resume` |
| SW:199 | POST /runs/:id/apply SY:35 | HOST-API | `synthesis.runs.apply` |
| ND:47 | GET /projects/:pid/folders SY:11 | HOST-API | `synthesis.folders.list` |
| ND:58 | POST /projects/:pid/modules SY:12 | HOST-API | `synthesis.modules.create` |
| SW:247 `<iframe src>` | GET /runs/:id/preview/* SY:36 (CSP built from Host) | ADAPT (`readArtifact`) | `synthesis.runs.preview` |

Fixed in R0: `synthesisRequest` did not send `X-Local-Cognitive`, so `localApiOriginGuard`
returned 403 for every synthesis mutation; `test/synthesis-ui.test.ts` now asserts the header.

## Client-only (desktop and voice)

| UI | Channel | Class | Operation |
|---|---|---|---|
| A:57, A:670 `desktopAppearance.setTheme`; `.platform` | IPC `appearance:set-theme` | CLIENT | `client.appearance.setTheme` |
| SS:337 `desktopApp.getInfo` | IPC `app:info` | CLIENT | `client.app.info` |
| SS:581 `desktopApp.openDataFolder` | IPC `app:open-data-folder` | ADAPT (local only; unavailable in Remote) | `client.app.openDataFolder` |
| `voice-input.js` (11 methods) | IPC `voice:*` | CLIENT | `client.voice.*` |

## Routes the UI does not call (20)

GET /health, /meta, /models, /lmstudio/models/{loaded,all}, POST /lmstudio/models/{load,unload},
GET /local/models/loaded, /sessions, /projects, **/app/settings (raw secrets)**, /tasks/:id,
/schedules, /workflows, /workflows/:id, POST /workflow-runs/:id/step (dead), POST /process (legacy
alias of /chat, used by tests and external clients), POST /local/models/import and
/local/models/:id/projector (IPC does this work), PUT /integrations/:id/oauth-client.
Telegram and MCP stdio call runtime services directly; both go through `processRuntimeInput`
(`src/transports/shared/runtimeActions.ts`), the natural handler for `chat.runs.start`.

## Observations for the RuntimeClient design

1. `request(url, options)` (A:614-656): JSON body string, default timeout 30 s (0 = none),
   optional caller `AbortController`, `X-Local-Cognitive: 1` on mutations, non-2xx throws
   `payload.message || payload.error` (status is lost), 204 → `null`. Keep its name and position:
   `local-model-ui-regressions.test.ts:283` and `chat-ui-regressions.test.ts:97` slice the source
   around it.
2. Other helpers: PU:16 (own fetch, 120 s, header even on GET, unguarded `response.json()`),
   `frontend/synthesis/api.ts` (no timeout), SS:337 raw fetch fallback.
3. Streams: MM:532 relies on the browser's reconnect and a 5 s polling fallback, deduplicates by
   sequence and treats each first frame as a snapshot; WL:49 resumes with Last-Event-ID and keeps
   1000 events — its injectable `EventSourceClass` is the seam for `RuntimeClient.subscribe`.
   Polling loops: chat 600 ms, dashboard 1 s/5 s, plugins 2.5 s, synthesis 1.2 s.
4. Secrets: bootstrap, GET and PUT `/app/settings` return raw provider keys and the Telegram token.
   The UI reads them (A:5051 compares `apiKey` with `local`/`lm-studio`; SS:170 uses presence), so
   the safe DTO needs `apiKeyState: unset | set | localAlias`. The global error handler returns
   `message` even for 500s (`src/index.ts`), so errors need a safe DTO too.
5. Absolute host paths appear in bootstrap, `/local/runtime`, `/local/events`,
   `/local/models/all`, `/workspace/file`, `/workspace/editor`, reveal routes,
   `/tasks/:id/workspace`, workflow run detail, session messages and approvals.
6. Host/Origin coupling: `localApiOriginGuard` checks loopback socket, Host, Origin and the header,
   so the dispatcher must call extracted service handlers rather than replaying through Express.
   The synthesis preview CSP uses the Host header; the OAuth callback checks Host;
   `assertAppSender` and voice permission checks compare with `http://127.0.0.1:<port>` and must
   move to the app-protocol origin; `models:*` IPC handlers check only `event.sender`.
7. Express-coupled handlers inline in `routes.ts`: `/health`, `/app/info`, task workspace reveal,
   agent-run trace. Query-string inputs: workspace file, catalog, synthesis folders,
   `workflows/:id?version`, `models?providerId`. Several path params are not URL-encoded.
8. `ScheduleRunner` starts only inside `if (config.server.enabled)` (`src/index.ts`); removing the
   HTTP listener would silently stop schedules.
9. Electron: no `setWindowOpenHandler` (`target=_blank` links at MM:292/349 and PU:99 may open
   windows with the preload); the random port changes the origin and resets `localStorage` each
   launch; host-scoped keys (`lcai.synthesis.project.v1`, `hiddenModules`) need per-host
   namespacing; assets use absolute `/assets/*` paths, so the app protocol must serve `public/` at
   the root.

## Migration order

1. Operation registry (`opId → method, path template, schema, limits, stream, class`); extract
   inline handlers into service-level handlers; IPC channels `runtime:request`,
   `runtime:subscribe`, `runtime:cancel` guarded by `assertAppSender`.
2. Replace the body of `request()` with the same signature (63 sites); update the two
   source-slicing tests.
3. Convert PU:16 and `frontend/synthesis/api.ts`; drop the SS:337 fallback.
4. Subscriptions: an `EventSourceClass` shim for WL:49; MM:532 to `watch("models.local")` (done in R5-1, `public/assets/runtime-routes.js`).
5. ADAPT items: `fs.browse` for all pickers; capability-gated reveal/open-editor; `openDataFolder`
   local only; synthesis preview via `readArtifact`; attachments via `upload`; OAuth per §9.
6. Safe DTOs for bootstrap, settings and errors; split `ui`/`profile` into client settings.
7. Chat run API (§7.3) replacing the open `/chat` request and the 600 ms poll.
8. Electron: app protocol, origin checks, `setWindowOpenHandler`, decouple `ScheduleRunner`, stop
   listening on TCP in the desktop build (Express stays for tests).

## Synthesis (R5-5)

Done: `synthesis.modules.list/get`, `synthesis.folders.list`, `synthesis.runs.list/get/sources/diff/file/cancel`
(requests) and `synthesis.modules.create`, `synthesis.runs.start/resume/apply` (commands, run ids reserved), mapped
from the Synthesis screen's paths by `SYNTHESIS_ROUTES` (public/assets/runtime-routes.js). `POST /synthesis/projects/:id/open`
and `GET /synthesis/runs/:id/preview/*` stay on the host's own screen.
