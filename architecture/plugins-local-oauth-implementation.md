# Plugins: local OAuth implementation

Implementation map, 30 September 2026. The older plugin scope/current-state notes
describe the preceding loader and are retained as historical source material.

## Product boundary

Settings → Plugins owns a ten-service release catalog. The management list uses
small service logos, two-line rows and access switches. Browse directory exposes
Install; Install immediately opens account sign-in, then local permissions → Enable.
The switch is on only when the selected account is live and the plugin is enabled.
Switching an unconnected, available service on installs it and opens sign-in without
implicitly granting local tool access. Accounts shows connected-account count and
opens Connected accounts; MCP servers opens server settings. Its count includes the
built-in Local Cognitive incoming server (even when disabled) and manually configured
outgoing servers, exactly matching the entries shown. Plugin-managed MCP services
remain under Plugins. Both subpages have parent arrows back to Plugins.

Catalog entries: Notion, GitHub, Slack, Google Drive, Linear, Jira/Atlassian,
Outlook Email, Outlook Calendar, Microsoft Teams, Dropbox. These are shipped
integration adapters, not arbitrary downloaded JavaScript packages. No public
remote marketplace, plugin SDK or executable package installer is implemented.

## Architecture and file ownership

| Boundary | Files | Responsibility |
| --- | --- | --- |
| Catalog/contracts | `src/plugins/catalog.ts`, `contracts.ts` | Release-owned IDs, provider endpoints, capabilities contract |
| Owner state | `PluginStore.ts`, `PluginManager.ts` | Installations, selected accounts, permissions, discovery, saved approvals and operation outcomes |
| OAuth | `OAuthConnections.ts` | Native PKCE/device flow; official MCP SDK discovery/DCR/PKCE; loopback callbacks, refresh and cancellation |
| Credentials | `EncryptedCredentialVault.ts`, `electron/main.cjs` | Electron safeStorage encryption, private atomic files; no plaintext fallback |
| Service access | `DirectIntegrationAdapter.ts`, `NativeServiceTools.ts` | Official MCP or bounded direct REST calls; real account/tool probes |
| Shared MCP | `src/mcp/client/McpClientManager.ts` | Separate manual/plugin configuration scopes and reserved plugin credential namespace |
| Runtime lifetime | `src/app/RuntimeManager.ts`, `buildRuntime.ts`, `src/index.ts` | One shared manager per owner, injection of vault and system browser opener |
| API | `src/api/integrationControllers.ts`, `routes.ts` | Same-origin local management routes; no arbitrary call-tool or token-export route |
| Agent bridge | `AgentTool.ts`, `OperationExecutor.ts`, `AgentLoopRunner.ts`, `CognitiveEngine.ts`, `WorkspaceResolver.ts` | `plugins.search` / `plugins.call` in ordinary/project chats and workflow agent steps; builtin file/command tools remain available |
| Settings UI | `public/assets/plugins-ui.js`, `settings-shell.js`, `settings-shell.css`, `plugin-icons/` | Catalog, details, browser sign-in, account selection, permissions, connections and accessible switches |
| Legacy migration | `AppSettingsStore.ts`, `settingsValidation.ts`, `src/types/index.ts` | Move file settings to builtin filesystem configuration; retire old integration settings with a private recoverable backup |

Notion, Linear and Jira use the existing MCP client and official
`@modelcontextprotocol/sdk`. The rest are explicit REST adapters with a bounded
set of useful tools, not generic API proxies. The lifecycle/UI/store are local
implementation; the module is not wholly written from scratch and uses no hosted
Composio dependency.

## Account/backend decision

No cloud backend or Local Cognitive login is needed to store provider tokens.
Vault keys and installation/operation stores are namespaced by owner; the current
owner is `local:<profile-id>`. `RuntimeManager.switchIntegrationOwner` is the
internal handover point for a future authenticated `account:<id>`. It disposes the
old manager before restoring the new owner's connections. No owner-switch HTTP
endpoint, account signup, billing or cloud sync has been added.

An OAuth application registration is different from a user's service account.
GitHub, Slack, Google Drive, Microsoft Graph and Dropbox still need developer
client IDs/configuration. Google Desktop clients also use their downloaded native
client secret. These registrations belong to the application distributor, not to
each end user. They cannot be invented by the app. Notion/Linear/Jira
negotiate client registration with their official MCP servers. Provider plan,
workspace and administrator restrictions still apply.

For a public release, provide operator-owned registrations for native providers
where public desktop clients are supported, with approved consent/redirects.
Electron loads `electron/plugin-oauth-clients.json` (ignored by git) or a file supplied
with `LOCAL_COGNITIVE_OAUTH_CLIENTS_FILE`. The `.example.json` documents its format;
do not ship placeholder entries. These are shared application identities across
profiles, never user access/refresh tokens. Only public/native clients are allowed:
a desktop bundle cannot keep a confidential web-client secret confidential. Google
Desktop's downloaded client secret is not a substitute for a confidential backend.
Registered application config takes precedence over legacy encrypted developer
overrides; the UI no longer exposes developer forms or arbitrary redirect links.
Missing registrations show an unavailable integration, not a demand to create a
new user account. This does not require an account/billing backend simultaneously.

For Google development, create a dedicated Cloud project, enable Drive API, configure
Google Auth Platform branding/audience, add approved test users and create a Desktop
OAuth client. Supply its native credentials in the distributor file, rebuild/restart,
then test Install → Google consent → local permissions. The adapter currently asks
for full `drive` scope to support search/read plus explicitly approved writes; Google
verification and production distribution are separate release requirements. Test-mode
grants may expire sooner than production grants. Never silently publish the OAuth app,
add billing, reuse another product's client ID, or treat browser sign-in as API consent.

## Execution and safety

Tools are available only for an installed/enabled service with a verified selected
account and matching local permission. Schemas are validated before dispatch.
Every external write requires saved approval even in Full access. Changing an
account, policy, schema or owner invalidates the saved proposal. Disconnect and
policy changes fence pending dispatch and cancel in-flight operations.

The durable operation journal records waiting/approved/executing/completed/unknown.
Network failures after dispatch are not proof of failure: unknown operations must
be checked in the service and are never automatically replayed. Known pre-effect
auth/validation rejection is recoverable, not falsely reported as an unknown write.
Locks are process-local, not a distributed exactly-once guarantee.

Uninstall retains independent connections; Disconnect deletes local credentials.
Provider-side grant revocation remains an explicit action in that provider's account
settings. Secret files are encrypted, but ordinary chat/operation journals can
contain service content needed for answers and approvals. There is no claim that
all application data is encrypted.

The previous loader, bundled Files/Notion implementations and VS Code placeholder
are retired. Builtin filesystem tools move to Data & Privacy. The original settings
backup may contain a legacy Notion API key; it is private and recoverable, not
returned by the API. Users may remove that backup after validating migration.

## Verification boundary

`test/plugins.test.ts` exercises lifecycle, grants, owner separation, saved approvals,
no-replay behavior, disconnect/policy races, encrypted vault, native HTTP request
builders, real loopback callbacks, official SDK OAuth/Streamable HTTP fixtures,
origin checks, migration and actual tool-result delivery to chat/workflow agents.
`test/plugins-ui.test.ts` adds targeted DOM regressions for catalog switches,
install-to-login handoff, disabling, missing-registration gating without developer
forms, parent arrows, server counts and preservation of search/menus during polling.
Backend tests also cover distributor registrations across isolated owners and a
Google Desktop PKCE callback/token exchange using a local fixture, including
owner-local credential storage. Existing MCP/provider tests remain in the full suite.

On 30 September 2026 the macOS arm64 build passed the full suite (553 passed,
2 skipped) and bundled llama/speech runtime verification. Independent review
findings were fixed and rechecked. In an isolated desktop profile, real Notion
OAuth discovered 44 tools; local read-only access was enabled with user consent.
A local LM Studio model completed a real `notion-search` in an ordinary chat
(10 results) and in a workflow agent step after its saved approval/resume flow.
Restarting the final packaged app restored the connection and read-only policy
without another login, and rediscovered the same 44 tools.
An earlier malformed model-generated JSON call was rejected before dispatch.
No live external write was approved or performed. At this initial acceptance point,
other provider accounts were not live-verified; native-provider OAuth registrations
remained prerequisites. Subsequent Google verification is recorded below.

Fixtures and successful packaging are not proof of ten live connected accounts.
Live acceptance requires user login/consent, real tool discovery/read results,
an explicitly approved harmless write and reconnection/restart checks for each
provider. Until that matrix is completed, do not claim all ten providers are
end-to-end verified. DSL integration remains deliberately separate.

## Consumer OAuth UX follow-up

The follow-up passed 557 tests with 2 existing opt-in tests skipped (559 total),
plus arm64 DMG packaging and both bundled runtime checks. A second independent
review found no confirmed P1/P2 findings in this increment. In the rebuilt desktop
profile, Accounts → Plugins and MCP → Local Cognitive → MCP → Plugins were checked
through the rendered UI; the catalog and MCP page both show one built-in server.
Notion restored its connected state and 44 tools. Missing Google registration no
longer exposes redirect links or technical forms to the end user.

## Google Desktop OAuth acceptance

A dedicated Google Cloud project and Drive API were created/enabled with the
owner's authorization. The owner completed Google Auth Platform branding and its
User Data Policy agreement. With explicit approval, a Desktop OAuth client for
Local Cognitive's AI-agent use was created and an approved account added as a test
user. The app remains in Testing; no publication or billing was enabled.

Native client credentials are stored in the ignored distributor configuration,
with private file permissions, and included in the rebuilt arm64 desktop bundle.
They were not added to source control or printed into chat/logs. User account
tokens remain in the encrypted, owner-local vault rather than that build file.

The rebuilt app's Connect account button opened Google's actual authorization
flow. The owner completed sign-in and consent; the app verified the account and
exposed three Google Drive tools. Separate, explicit approval enabled local
Read only access for chats and workflow agents. This is a real account connection,
not just a saved client ID or a mocked callback.

After adding the Google-specific fixture, the full suite passed 558 tests with
2 existing opt-in tests skipped (560 total). Both packaged llama and speech
runtime checks passed. End-to-end local-model search acceptance is recorded
separately from OAuth connection success.

With the owner's read-only approval, local `qwen/qwen3.5-9b` through LM Studio
(`127.0.0.1:1234`) completed one real Google Drive `search_files` in an ordinary
chat and one in a workflow agent step. Both saved operation results contain
38 matching file metadata entries and no next-page token. No file contents were
read and no external writes were performed. The workflow reached `done` after its
saved read-operation approval/resume. Cloud LLMs were not selected or called.
The chat model's final prose miscounted the list as 39, while the workflow answer
reported 38; the API traces, not generated prose, are the acceptance evidence.
Restarting the packaged Mac app with the same isolated profile restored the
verified Google account, all three tools and the enabled Read only policy without
another browser login. Other providers' live acceptance and public Google OAuth
verification remain separate release work; this result does not certify all ten
catalog entries end to end.

## Chat mentions and workflow plugin selection

`public/assets/mentions.js` provides one grouped picker for plugins and configured
subagents, bound to the ordinary/project chat composer in `app.js`. Typing `@`
lists only usable connected/enabled plugins with the same local service icons as
Settings, plus a separate Subagents group. Search, arrow keys, Enter/Tab, Escape,
click selection and removable badges share the same draft-text state. Message
rendering shows the service's human label and logo. A canonical `@google-drive`
token remains in the text; `@agent:name` disambiguates an agent named like a plugin.
Mentioning a service neither installs it nor grants additional access.

`GET /integrations/available` derives choices from the manager's live, permitted
tools, not from saved OAuth configuration. The picker refreshes on focus/open and
on return from Settings. A disconnected selection is marked unavailable and
rejected by the backend rather than silently falling back to another service.

`src/plugins/PluginSelection.ts` validates catalog IDs and shares token semantics
with the composer. `CognitiveEngine`, `AgentLoopRunner`, `OperationExecutor` and
`PluginManager` carry the selection through discovery, dispatch and approval
identity. Both discovery and actual tool calls are restricted to the selected
plugins. Emails and plugin tags do not trigger subagents. The existing local
filesystem/command tools remain available under their existing permissions.

The workflow inspector's `PluginFields` (`frontend/workflow/NodeConfigFields.tsx`)
offers Automatic or Only selected plugins with logo/checkbox rows. Selections are
stored in `node.config.pluginIds`, validated by `WorkflowStore`, frozen with the
run and forwarded by `AgentNodeExecutor`. Undefined preserves automatic discovery;
an empty array permits no plugins. Workflow text interpolation cannot override
that selection. Refreshing connected choices preserves the current graph draft
and unavailable saved selections remain removable. DSL integration is unchanged.

`test/plugin-mentions.test.ts` covers the shared UI, keyboard/cursor behavior,
rendering/escaping, parser parity, agent-name collisions and real React workflow
checkboxes. Plugin fixtures cover all ten catalog IDs, unavailable services,
scope-filtered discovery/dispatch, approval invalidation and selected-plugin
results reaching real chat/workflow engine paths. The full suite passes 567 tests
with 2 existing opt-in tests skipped (569 total), and both arm64 packaged runtime
checks pass. Fixtures do not certify live accounts for all ten providers.

Live checks found an empty structured response from the installed Qwen 3.8 27B
MLX model. The agent now permits one schema-to-validated-JSON-text retry before
any tool runs; it never interprets reasoning as executable actions or replays a
completed operation. Focused regression tests cover success and another empty
reply. With this fallback, Qwen 27B really searched Drive, but timed out before
its final answer, so that run is not counted as completed acceptance. The native
Drive search description now explicitly documents `{}` for a default listing
and valid Drive query syntax rather than empty strings or wildcard `*`.

Final live acceptance (30 September–1 October 2026) used an isolated profile and
an additional local LM Studio `qwen/qwen3.5-9b` instance with 32K context. The
user's existing 8K instance and main application profile were not reconfigured.
The 8K attempt exhausted its context after tool discovery, including a Notion
search-discovery response; it is not counted as successful live Notion acceptance
for this increment. No cloud LLM was selected or called.

An ordinary chat selected Google Drive from the `@` menu, obtained a real read-only
`search_files` response after approval and completed a final answer containing
three names verified against the returned metadata. A workflow saved Google Drive
through its checkbox list, preserved it after reopening, limited tool discovery to
Drive, resumed its saved read approval and reached the `done` terminal. Its final
answer also contained three verified names. Each actual API result contained the
first page of 100 metadata entries; no file contents or external writes were used.
The small model's initial workflow attempts produced invalid arguments; these were
rejected before service dispatch. Acceptance required a more explicit prompt about
valid `argumentsJson`, and one rejected proposal was corrected before the read.
This establishes working scope/dispatch/approval paths, not perfect tool-calling
reliability for every local model or natural-language prompt.

The final arm64 app was placed in `release/mac-arm64/Local Cognitive AI System.app`
after the user approved quitting the previous version. The previous bundle is
retained at `release/plugin-mentions/previous-mac-arm64/Local Cognitive AI System.app`.
The new app was not opened; the user's Application Support profile was not replaced
with QA data. Source/bundle hashes for the picker, workflow UI, selection validation,
Drive adapter and agent loop were checked after replacement.
