# Settings, Profile, Usage, and Plugins: implementation scope

Date: 20 September 2026. Status: finalized product scope. The implementation snapshot was reconciled with the local working tree on 30 September 2026; the original scope below remains a target design, not a claim that every item is already delivered.

Update, 7 October 2026: this remains the historical Settings/integrations scope.
The subsequent account login, Remote Connection, Usage, bug-report and update
work is governed by [the consolidated implementation plan](remote-connection-implementation.md).
The exclusions of cloud accounts, Remote and updates below apply only to the
earlier Settings release and do not override that subsequent plan.

This document consolidates the user's original Settings redesign and subsequent decisions. It specifies one desktop release built on the existing local backend. Earlier investigation documents are background material; their proposals for Telegram, account login, remote execution, and plugin delivery do not override the decisions below.

The implementation model preference is GPT-6 Astra with Max effort. This is a preference for developing this project, not a new default for models used inside Local Cognitive. No percentage of the Codex weekly allowance is promised or reserved.

For the implemented plugin/registry/MCP boundary, read [Plugin module: current implementation](plugin-module-current.md). In particular, the current tree uses in-process `plugin.json` modules plus a local `ToolRegistry`; it does not yet contain the PluginManager, catalog, OAuth connection service, or MCP-to-agent bridge specified later in this scope.

**1. Release outcome and boundaries.** Preserve Local Cognitive's current typography, colors, Liquid Glass treatment, model library, chat, and workflow behavior. Replace the Settings and integration experience, add real local activity reporting, and provide working MCP-backed plugins. Do not redesign the rest of the application.

| Decision | Release scope |
| --- | --- |
| Main navigation | Models, Workflow, Chat; existing chat/task history below; compact local profile entry at the bottom. |
| Settings | Dedicated full view, its own sidebar, search, Back to app, compact rows and entity detail pages. |
| Local Cognitive identity | Profile/account/billing interfaces and explicitly unavailable states only. No Apple, Google, email login, authentication sessions, logout, billing API, or account backend. |
| Plugin identity | Real external-service authorization is included. It is independent of Local Cognitive login. |
| Settings persistence | Local, with autosave for ordinary preferences and explicit actions for destructive or disruptive operations. |
| Plugins | Local PluginManager, portable package metadata, shared MCP client, curated catalog, and one complete Notion OAuth integration. |
| Hosted integration engines | Leave an adapter boundary for Composio/Nango. Neither service is a dependency of this release. |
| Existing agent counts | Preserve the current hard limits; do not add a worker-count slider. |
| Telegram | Remove the active transport, configuration, UI, and associated code. Preserve existing user history. |
| Experimental | No section and no new experimental-settings framework. |
| Deferred | Fallback provider/model, user-configurable Max Agent Steps, workflow model-memory admission checks, Diagnostics UI, app updater, Remote, mobile, cloud accounts, and billing. |
| Later plugin expansion | Public marketplace, arbitrary executable-package installation, MCPB installer, hosted integration-service adapters, and plugin auto-updates. |

Only account/cloud features may be deliberate placeholders. Every active settings control and every integration marked Connected must have a real implementation. Unsupported features are hidden or explained as unavailable, never represented as successful operations.

**2. Navigation and Settings shell.** The main sidebar has Models, Workflow, and Chat in that order. Workflow opens the existing tasks/workflows surface; its task board is preserved. Keep conversation history, creation, selection, rename/delete behavior, and any existing task-history access. Do not invent a second task-history store. Remove permanent Settings and Plugins buttons, and do not add MCP or Connections to the main navigation.

The bottom profile entry opens a compact menu with Profile, Usage, Settings, Open data folder, and About. Settings opens General. Profile and Usage open their pages inside the same Settings shell. About contains version/build/license information; update checking is deferred. Logout is hidden while authentication is unavailable. Do not copy Codex branding, plan labels, remaining-quota percentages, invitation features, or other unrelated menu items.

Use a neutral avatar and Local profile label. Cloud name/avatar editing and sign-in/billing surfaces are prepared as interfaces with honest unavailable states. Do not create fake user identity data or a functioning local-name editor as a substitute for the deferred account system.

The Settings shell replaces the app workspace while open. Follow the supplied Settings sidebar reference: Back to app at the top, a rounded search field underneath, muted group labels, compact icon-and-label rows, and a subtle rounded highlight for the selected page. Content occupies the area to the right. Adapt the screenshot's spacing to the desktop window and Local Cognitive's existing design tokens. Back to app restores the previous app route, selected chat/task, scroll position where feasible, and unsent input. Opening Settings must not interrupt an active run.

| Group | Pages in this release |
| --- | --- |
| Personal | General, Notifications, Profile, Appearance, Keyboard Shortcuts, Usage, Account |
| AI System | Models & Providers, Local Runtime, Agents, Memory |
| Integrations | Plugins, MCP Servers, Connections |
| System | Data & Privacy, About |

Diagnostics is intentionally absent until separately designed. Telegram and Experimental must not appear in navigation, search, or empty placeholder pages.

The screenshot is a layout reference, not an additional feature list. Keep the groups and pages in the table above. Do not import Codex-only entries such as Pets, Parental controls, Appshots, Git, or Worktrees, or reproduce macOS window controls inside the Settings content.

Search covers page names and setting labels/descriptions, opens the relevant page, and focuses/highlights the result. It must not index API keys, connection tokens, chat content, or file contents. Detail pages have a clear parent breadcrumb/back action. Use rows, section labels, separators, concise descriptions, inline validation, and ordinary dialogs for destructive actions. Avoid nested configuration cards.

Keyboard navigation, focus restoration, labels, contrast, scroll behavior, and narrow-window layouts are part of the shell, not later polish. Do not add a new frontend framework migration for this work; modularize the existing vanilla UI as needed and preserve the React workflow editor.

**3. Persistence and applying changes.** Extend the existing local settings store with versioned UI preferences and global agent defaults. Keep per-session and per-workflow overrides. Reuse the existing stable local profile identity for local ownership; provide an identity-provider interface that can later resolve a cloud account without rekeying existing local records.

- Save ordinary text/numeric controls after validation on blur or a short debounce; save toggles/selects immediately. Show Saving, Saved, and failed/retry feedback without a global Save button.
- Send a partial update for the edited entity only. Replace the current whole-form serializer for detail pages: an absent field must not clear another provider, plugin, or setting.
- Merge and validate on the backend, serialize writes, and handle failed saves without claiming success. A later edit must not be overwritten by an earlier response.
- Preference-only changes must not rebuild providers, restart inference, or reconnect plugins. Connection and runtime changes apply through their owning services.
- Model-folder migration, runtime restart, index rebuild, data export, credential disconnect, and deletion remain explicit actions. Show progress and preserve the previous usable configuration if an operation fails.
- Read existing settings/session data through migrations. Preserve provider choices, file-access policy, model paths, history, and workflow configuration. Do not silently switch providers or models.

Use local application data for durable settings. If selected UI preferences are cached in localStorage for first paint, synchronize them with the authoritative local preference store. No cloud synchronization is included.

**4. Personal pages and appearance.** General exposes useful existing defaults for new chats: response language, response style, and default chat mode. These are response preferences, not a promise to localize the whole application. Changes affect new chats unless the user explicitly changes an existing chat.

Appearance supports Light, Dark, and System. System tracks OS theme changes; explicit choices remain stable across relaunch. Preserve existing design tokens. A density control is included only if distinct compact/comfortable layouts are implemented consistently; do not add a nonfunctional density selector or make density a separate redesign project.

Add one global Animations preference, enabled by default. Respect the operating system's reduced-motion preference as well: effective motion is enabled only when the application preference permits it and the OS does not request reduced motion.

The shared motion policy covers navigation, sidebar/panel transitions, expanding sections, menus, hover movement and glass lighting, decorative backgrounds, loading effects, toasts, the reasoning slider, JS/Web Animations, animated scrolling, and effects inside the workflow UI. Switching motion off during an animation must settle it into a usable final state. Show static loading/status indicators with readable text. Keep actual progress reporting, polling, keyboard focus, drag/resize behavior, and other functional interactions working. Individual components consume the shared policy; they do not get independent motion toggles.

Notifications provides controls for task/run completion, failure, and approval-needed events, plus supported sound/native-notification behavior. Respect OS permission denial. Deduplicate notifications, suppress unnecessary native notifications for the foreground conversation, and let a notification open the correct chat/task/approval. Preserve existing inline feedback. Account or cloud push notifications are not included.

Keyboard Shortcuts lists application actions and their shortcuts, supports search, rebinding, conflict feedback, and restoring defaults. Cover opening Settings, navigating supported app areas, creating a chat, toggling panels, and stopping a run, alongside existing shortcuts. Do not override typing, text-editing shortcuts, OS-reserved combinations, or browser shortcuts indiscriminately. Use platform-appropriate modifier labels. Background system-wide hotkeys are outside scope.

Account renders the future account/billing interface in an unavailable state. No fake plan, subscription amount, quota, successful login, or logout action is allowed. Other local settings and local usage work without an account.

**5. Models & Providers.** Display compact rows for the configured provider set, including OpenAI, Anthropic, Gemini, Ollama, LM Studio, and the bundled llama.cpp runtime. This scope does not remove Ollama or LM Studio based on an older investigation proposal.

A row opens one provider detail page with Enabled, API key where applicable, Base URL where applicable, default model, timeout, Test connection, Disable/Disconnect, and Reset configuration. Mask existing secrets and distinguish leave unchanged from explicit removal. The bundled runtime has no user-editable API key or internal server address.

Show configuration and health accurately: Not configured, Disabled, Configured but not checked, Checking, Connected, Unavailable/Error, and local runtime states as applicable. A saved key alone is not evidence of Connected. Test connection checks a selected model and reports the actual error/model; do not generate repeated paid test requests in the background.

Global controls select the default provider and its default model. Preserve explicit chat, agent, and workflow overrides. Fallback settings are deferred and absent from active controls. Disconnect disables use and clears the selected credentials deliberately; it does not silently reroute requests. Reset has a clear scope and must not reset unrelated providers or user data.

**6. Reasoning controls.** Add the reference-style discrete slider/popover to the existing model picker and corresponding default/agent/workflow model settings. Show the active level, model label, available stops, and reset-to-default behavior. The screenshot supplies geometry and hierarchy; animation timing must be tuned in the rendered app rather than claimed to be recoverable from a still image.

- Resolve capabilities for the selected provider/model/API path. Display only supported choices. Use model defaults when there is no explicit override.
- Map the user's choice to the provider's actual reasoning/thinking parameter or documented budget. Do not assume identical level names or semantics across OpenAI, Anthropic, and Gemini.
- Local models get the control only when the selected model/runtime exposes a verified supported parameter. Otherwise hide it and explain the limitation where useful. Prompt wording that asks a model to think more is not a substitute for a supported control.
- Apply the setting to main agents, workers, critics/judges, and workflow agent nodes through a common target configuration. Precedence is explicit request override, then the applicable node/agent/session override, then the app role default, then the provider/model default.
- On model changes, validate retained overrides. Unsupported saved values must not be sent silently. Show the effective default or ask for a supported choice within the UI.
- Record both the requested and effective reasoning configuration in usage events. Keep output-token limits separate from reasoning effort.
- The slider supports keyboard use and accessible value labels. Its animation follows the single global motion preference.

Provider-specific capability and parameter mappings must be verified against current provider documentation during implementation; this document does not hard-code a universal set of stops.

**7. Local Runtime.** Reuse the model library and current local-provider abstractions. Provide runtime selection, current/loaded model, Manage model library, model storage folder, context size, maximum output tokens, memory-warning threshold, load/generation timeout, auto-unload on idle, supported compute-device selection, runtime status, and Restart runtime.

Manage model library opens the existing Models area and has a clear return path. Storage changes use the existing copy/verification behavior. Maximum output tokens must reach the actual generation request and remain valid for the selected model/context. Auto-unload must wait for idle: no active or queued inference may lose its model. Define a disabled default to preserve existing behavior. Changing compute/context settings follows the same safe idle/reload rules.

Display concurrent-job capacity truthfully. The bundled runtime remains one inference slot for this release; this is a read-only capacity value, not a configurable parallelism control. Existing worker counts remain fixed. Expanding runtime concurrency is a separately deferred capability. Expose device choices only when the packaged backend can actually use them.

Restart runtime explicitly stops and reinitializes the bundled model process, with an appropriate busy state and confirmation if interruption is necessary. It is distinct from rebuilding application services. External runtimes expose their supported status/load/unload operations; do not pretend to restart an external Ollama/LM Studio application when that control is unavailable.

No new workflow-wide check that all selected models fit in memory is included. Retain existing model compatibility checks and memory warnings; the user manages workflow model choices.

**8. Agents.** Add global defaults for the main agent, worker/research role, and judge/critic role, with provider/model and supported reasoning settings. Preserve the existing per-chat agent setup, role structure, workflow node overrides, and hard-coded participant limits.

Expose applicable timeout, bounded retry count, and the existing Ask / Default / Full tool-approval policy. Retry configuration applies to eligible failed model/connection requests, not automatic replay of an external write whose outcome is unknown. Internal tool-loop limits, cancellation, and timeouts remain enforced without a Max Agent Steps preference. A rejected approval cannot be retried into acceptance. Fallback model/provider is absent until separately designed.

Keep new settings scoped to roles and behaviors that the current engine can execute. Do not add an unrelated agent marketplace or another orchestration system.

**9. Memory.** Keep the original memory requirements as a distinct functional delivery block: long-term memory enabled, embedding model, retrieval Top-K, similarity threshold, existing partition/chunk controls, automatic extraction, storage path, Inspect, Rebuild index, Export, and Clear memory.

Separate conversation history from long-term recall before adding disable/clear controls. Disabling long-term memory stops its reads, writes, and extraction while preserving chat history. Clearing long-term memory must not delete chats, usage, provider keys, or model files. Existing records need an explicit migration/classification so the separation does not duplicate history or lose recall data.

Add an embedding-service interface and at least one real, verified embedding backend using a supported local runtime or explicitly configured provider. The model picker must show embedding-capable models only. The current character-based vectors are legacy data, not a selectable neural embedding model. Keep vector model/version/dimension metadata; changing embedding models requires a rebuild, and incompatible vectors cannot be searched together. Do not silently send local memory to a cloud provider.

Apply similarity threshold after scoring and before Top-K. Put partition/chunk details and rebuild batching under Advanced on the Memory page; reuse existing controls where meaningful. Rebuild is progress-reporting, cancellable, and replaces the usable index only after success.

Automatic extraction is opt-in and uses the configured worker/research target to produce durable memory entries with source references. Capture its model usage. It must not recursively trigger itself or reinterpret existing chat history as extracted facts without an explicit operation.

Inspect supports browsing/searching stored entries and seeing their origin. Export produces a usable local file. Clear describes what will be deleted and requires confirmation. Use the maintained local memory path for this release; remove the unfinished OpenMemory option from normal selection and provide a clear migration/unavailable state for existing configurations rather than presenting it as working.

**10. Profile and Usage.** Build both pages on a durable local activity ledger that does not depend on the continued existence of chat/memory records. No cloud account is needed. Profile has the neutral identity header, activity summary, token heatmap, insights, and top tools. Usage has date filters and provider/model/agent-role breakdowns with readable empty states.

| Metric | Definition |
| --- | --- |
| Lifetime tokens | Sum of known input and output token usage for this local profile since complete tracking began; state coverage explicitly. |
| Cloud tokens | Known model-call token totals from cloud providers, with separate input/output values available. |
| Local generated tokens | Known output tokens generated by local inference; do not label all local input+output tokens as generated. |
| Agent runtime | Sum of measured active agent-execution intervals; exclude queue/approval wait where measurable, and distinguish this from total wall-clock elapsed time. Concurrent agents can produce a sum greater than elapsed time. |
| Tasks completed | Unique tasks that reached successful completion. Re-running a task does not create another completed task; run count is separate. |
| Token Activity | Daily totals of known model-call tokens, using the selected/local time zone consistently. Missing history is not invented. |
| Most used model/provider | Ranked by completed model-call count for the selected period; also show token totals. |
| Most used reasoning | Actual effective reasoning configurations from calls that support them. Unsupported/unreported values are not counted as a level. |
| Research runs | Completed top-level runs explicitly recorded with the research workflow/profile marker; do not infer this from keywords or count each worker separately. |
| Tool/plugin runs | Invocation counts and outcomes, grouped by tool and owning plugin; approvals denied before execution are distinct from executions. |
| Tasks/chats | Distinct task/chat creation counts for the tracked period, separate from messages and model calls. |

Record a unique event/call ID, run/session/task IDs where applicable, agent role, provider/model, requested/effective reasoning, local/cloud category, token counts and their source, timing, and outcome. Record tool invocation IDs, plugin/connection identifiers, timing, and outcome without storing credentials or full tool payloads in the usage ledger.

Instrument model calls centrally, including workers, critics, translation/normalization, repair attempts, extraction, and provider tests. Give tests/maintenance their own purpose so user activity can filter them. Embedding input usage is classified separately from generated tokens. Support native provider usage formats, including Gemini and Ollama. Unknown counts remain unknown; estimates, if used, are clearly labeled and excluded from exact totals by default.

Do not count reasoning/cached tokens twice when already included in provider input/output totals. Do not invent token usage for an MCP call: the model's use of tool schemas/results is already part of model input/output usage. Keep tool execution activity separate from model-token accounting.

Record provider-reported usage even for failed/incomplete responses when available. Recover after restart without duplicate events. Historical import is explicit and marked partial; deduplicate by original record/run identifiers. Memory copies and workflow/chat representations of the same execution must not multiply counts. Profile does not show a billed amount or subscription quota; those depend on the deferred billing system.

**11. Plugin architecture and release boundary.** This section is the target release design. The current implementation is documented separately in [Plugin module: current implementation](plugin-module-current.md): its manifests are in-process metadata, their `capabilities` are not permissions, and `ToolRegistry` is not an approval or execution engine. Do not read the PluginManager/Catalog requirements below as implemented behavior.

The first catalog is a versioned, curated set bundled with the app; include Notion as the first real external-account integration. A remote-MCP installation registers its package/configuration and selected instructions. It does not require downloading arbitrary executable code. Do not implement a public submission flow, arbitrary remote script installer, automatic plugin updates, or MCPB package manager in this release.

| Owner/module | Responsibility |
| --- | --- |
| PluginCatalog | Curated manifests, descriptions, supported transports/capabilities, versions, and availability. |
| PluginManager | Installation records, enable/disable, uninstall, validation, selected skills, and lifecycle. |
| ConnectionService | External-account identity/status, connect/reconnect/disconnect, credential references, and ownership. |
| McpClientManager | Shared stdio/Streamable HTTP connection lifecycle, tool discovery, calls, cancellation, errors, and reconnection. |
| ToolRegistry/adapter | Namespaced tool IDs, argument schemas, outputs, permissions, and mapping to plugins/connections. |
| Agent execution loop | Provider-specific tool calling, results fed back to the model, approvals, cancellation, and internal bounds. |
| Usage service | Model-call accounting and plugin/tool invocation activity. |
| Future integration adapter | An extension point for hosted services such as Composio; no service account or hosted deployment now. |

Store installation, enabled state, and external-account connection independently. An installed plugin may be disconnected or disabled while retaining its account connection. Use stable local IDs now, with explicit future ownership fields for cloud identity. Never use display names as credential keys.

Plugin skills and server-provided content cannot grant permissions, override the user's settings, or authorize actions. Load only relevant enabled plugin instructions and allowed tool schemas; avoid injecting every installed tool's schema into every request. Support only documented capabilities and show unsupported model/tool combinations honestly.

**12. Plugin, MCP, and Connections UI (target).** These pages are intended to be three views of the same services and state, not independent configuration stores. The current settings plugin panel is a legacy integration view; it is not the shared Plugin/MCP/Connections UI described here.

- Plugins: compact Installed and Catalog lists; name, description, source, status, and action. Each row opens a detail page with description, enabled state, connection, available tools/permissions, and lifecycle actions.
- MCP Servers: compact local/remote server rows and one detail page per server. Support manually configured existing local processes through command/arguments/environment fields and remote Streamable HTTP endpoints. Advanced fields belong on the detail page. This manual process configuration is not an arbitrary package installer.
- Connections: external accounts/workspaces and their status, linked plugins/servers, reconnect, and disconnect. Support a selectable connection when a service exposes multiple accounts; do not assume a plugin name identifies a single account.
- Preserve the existing inbound Local Cognitive MCP server, with its own clearly labeled configuration. Outbound server connections are a separate direction and must not recursively expose/call the application by accident.

Installation states are available, installing, installed, and failed; enabled state is separate. Connection states are disconnected, connecting, connected, reconnect required, and error. Show configuration and process/runtime status independently where relevant.

| Action | Required behavior |
| --- | --- |
| Install | Validate and register one package/version. Repeat requests do not duplicate installation. |
| Enable | Make installed, permitted tools available. If connection is required, offer Connect; enabled alone does not mean Connected. |
| Connect | Start a real provider auth flow and open the system browser. Set Connected only after callback/token exchange and successful connection/tool discovery. |
| Disable | Prevent new calls from this plugin without deleting its saved account connection. Clear stale tools from new model requests. |
| Disconnect | Remove the selected local credential binding and prevent new calls; revoke upstream authorization where supported. Explain if upstream revocation requires the provider's site. Warn about other bindings using the same connection. |
| Uninstall | Remove package registration and plugin bindings. Explain whether a shared connection remains; do not silently remove another plugin's connection. |
| Reconnect | Complete a new auth flow for expired/revoked access without duplicating installations. |

Lifecycle actions must respect active calls: offer Stop and continue, or wait for completion, when required. Do not report cancellation as rollback of an already completed external action. Pin the tool definitions used by an active run; configuration changes must not silently substitute a different tool or account halfway through it.

**13. OAuth and plugin execution (target).** For Notion, implement the documented OAuth Authorization Code + PKCE flow, required discovery/registration, system-browser launch, callback validation, credential exchange, refresh, and reconnect. This uses the local desktop backend; it does not create a Local Cognitive cloud login. For browser/headless entrypoints, expose an honest unsupported state if the callback flow is desktop-only in this release.

This is not the current Notion implementation: the current plugin uses a configured API key, and the Settings test only authenticates with `users/me`; it does not prove access to the selected target or page creation. Likewise, the current outbound `McpClientManager` is independent of the model/agent loop rather than a provider tool-calling adapter.

Keep credentials in OS-protected storage where available, accessed by the backend. Ordinary settings/installation records contain credential references. Do not expose secrets in UI snapshots, logs, URLs after callback handling, exports, or model context. An unavailable secure store must produce an actionable connection error instead of silently persisting new OAuth credentials in plaintext. Persist connections across app restart and serialize token refresh per connection.

Extend model request/response contracts for tool definitions, tool calls, call IDs, structured arguments, and tool results. Implement provider-specific adapters for supported cloud and local models; maintain ordinary text generation for models that lack tool calling. A selected model that cannot use the enabled plugin gets an explicit capability message, not an invented result or silent model switch.

The common execution path must validate tool arguments, apply the current approval policy, bind the intended external account, perform the invocation, return the result to the model, and continue until completion or an internal bound/cancellation. Workflow agent nodes use the same path. Preserve file and command approvals. Do not auto-repeat non-idempotent external actions after an ambiguous timeout.

Use the existing fixed agent-count constraints. An internal bounded tool loop is required for reliable execution but does not add the deferred Max Agent Steps UI setting.

The first integration is complete only when a real account can connect, list usable tools, perform a safe read, and complete one user-approved write in an appropriate test workspace; reconnect, restart, denial, cancellation, and error cases must also work. A successful OAuth redirect by itself is not completion. Live authorization and external writes during implementation require the user's actual account participation and permission; test doubles cannot be presented as live verification.

**14. Data & Privacy and removal work.** Show application/model/memory storage locations with supported open-folder actions. Provide clearly separated export/clear operations for chats/tasks, long-term memory, and usage, and access to external-connection removal. Exports exclude secrets by default. Clearing one category must not silently clear another. Destructive operations state their scope and require an explicit confirmation. Explain when a configured cloud model or plugin receives data; do not promise that external calls stay on-device.

Remove Telegram's transport startup/shutdown, classes, commands, configuration/types/schema fields, environment examples, Settings UI, active status reporting, and transport-only tests. Add migration coverage showing that legacy Telegram settings cannot start a transport. Preserve old Telegram-origin chat/memory records as history; minimal legacy channel parsing is allowed for compatibility, without executable Telegram support. Update current product documentation without rewriting historical investigation documents as if Telegram never existed.

Replace the old Plugins route and in-process integration loader path as the new module becomes functional. Migrate File settings into built-in tool/workspace settings and keep file operations working. Remove the VS Code placeholder. Replace the old Notion integration with the new MCP connection; do not pretend an old API key is an OAuth connection. Preserve a controlled migration/export path for legacy configuration, then retire its active registration. Do not keep two Notion tool sets active accidentally.

**15. Delivery order and code boundaries.** The outbound `McpClientManager` foundation is implemented and described in [Outbound MCP client manager](outbound-mcp-client.md). The remaining order describes the planned work to connect that foundation to a PluginManager and Settings UI. A catalog can describe available plugins, but it cannot establish a connection, authorize an account, or execute a tool. Keep changes reviewable as separate work packages; all required packages together constitute this release.

The repository check supports this order:

- [src/mcp.ts](/Users/pc/Desktop/github/local-cognitive-AI-system/src/mcp.ts) currently hosts an inbound MCP server using McpServer and StdioServerTransport. It is not an outbound client manager and must remain functional.
- [package.json](/Users/pc/Desktop/github/local-cognitive-AI-system/package.json) already declares @modelcontextprotocol/sdk ^1.29.0. Reuse its client transports rather than implementing the protocol; an SDK major-version migration is not required for this milestone.
- [ToolRegistry.ts](/Users/pc/Desktop/github/local-cognitive-AI-system/src/tools/ToolRegistry.ts) still resolves local compatibility tools through input matching and has no approval or execution logic. The project/workflow agent loop now has its own fixed structured file/command schemas, but it does not dynamically expose registry plugins or outbound MCP tools.
- [RuntimeManager.ts](/Users/pc/Desktop/github/local-cognitive-AI-system/src/app/RuntimeManager.ts:67) rebuilds AppRuntime after settings changes. MCP connections need a long-lived owner so an unrelated preference save does not spawn duplicate processes or disconnect active tools.

| Order/package | Main work | Completion evidence |
| --- | --- | --- |
| A. MCP Client Manager — first implementation | Outbound stdio and Streamable HTTP clients, minimal local server configuration, lifecycle, discovery, validated calls, cancellation, status, and credential-provider interface | Controlled local-process and HTTP fixtures connect, list tools, execute, recover, and shut down cleanly; unrelated settings changes preserve connections. |
| B. ConnectionService | Durable external-account records, protected credential storage, OAuth/PKCE, browser callback, refresh, reconnect/disconnect; first provider is Notion | Mock auth/error/refresh tests and persistence checks; real Notion validation remains a separate explicit acceptance step in F. |
| C. Agent tool execution and activity recording | Namespaced tool adapter, provider request/response contracts, common model/tool/result loop, approvals, and durable model/tool usage ledger | Chat and workflow agents consume fixture results; denial/cancellation prevents dispatch; token totals distinguish known and unavailable data. |
| D. PluginManager and small PluginCatalog | Validated package metadata, installation records, enable/disable/uninstall, server/connection bindings, selected skills, and curated catalog entries | A fixture plugin can be installed and used through A–C; repeat installation is safe; disabling removes available tools without deleting shared credentials. |
| E. Settings foundation and integration UI | Partial autosave, preference migrations, account interfaces/placeholders, bottom menu, full shell/search, Appearance/global motion, and Plugins/MCP Servers/Connections rows and detail pages | The new UI operates the same services; settings edits are isolated; Back to app restores context; desktop/theme/motion/keyboard checks pass. |
| F. First real plugin acceptance | Complete the Notion catalog entry and test the entire install/connect/use/manage flow from the Settings UI | Real account read and explicitly approved write, restart, reconnect, denial, Disable, Disconnect, and Uninstall; distinguish live results from mocks. |
| G. AI settings | Provider detail pages, reasoning, runtime controls, and agent defaults/timeouts/retries | Request-parameter and runtime lifecycle tests; capability checks; calls feed the existing usage ledger. |
| H. Personal, Profile/Usage, and privacy | General, notifications, shortcuts, profile/activity/heatmap, usage breakdowns, and category-specific data operations | Real persisted activity, restart recovery, accurate filters, notification/shortcut checks, and export/deletion boundaries. |
| I. Memory | History/recall separation, real embeddings, extraction, retrieval controls, and memory management | Memory can be disabled/rebuilt/exported/cleared independently of chats and usage; retrieval and extraction are exercised. |
| J. Migration and removal | Telegram removal, retirement of the old Plugins route/loader, legacy configuration migration, and current documentation | No active Telegram path; built-in file/command tools and old histories remain; no duplicate Notion tools. |
| K. Release verification | Cross-feature regressions and packaged desktop behavior | Complete-release criteria below pass; remaining platform/live-test limitations are explicit. |

B and C build on A; C can begin with an unauthenticated fixture before Notion authorization is available. D combines those foundations, and its first catalog can be a small bundled manifest list. Do not build a marketplace service before plugin installation and execution work. E precedes the final UI acceptance in F. Activity recording in C precedes the Profile/Usage presentation in H, so early real plugin/model calls are accounted for. Memory/history separation precedes memory disable/clear. J retires legacy plugin execution only after its required replacement behavior works; Telegram removal can be an independent change once migration behavior is defined.

**First implementation package: McpClientManager.** Its deliverable is a working backend service, exercised through controlled test servers. It does not require the new Settings shell, a catalog, a Local Cognitive account, or a real third-party login.

- Define typed server configuration and runtime snapshots. A server has a stable ID, display name, enabled state, transport-specific endpoint or command/arguments/working directory, timeouts, and an optional connection/credential reference. Keep nonsecret environment overrides separate from secret references. Persist configuration locally with isolated updates; recompute live status after restart rather than restoring a stale Connected flag.
- Give the manager application lifetime under RuntimeManager, or an equivalent long-lived integration service passed into rebuilt runtimes. Reconcile only changed server bindings; connect/disconnect/dispose must be safe when repeated. Own and clean up only child processes started by the manager. Two accounts at the same URL must remain distinct bindings, while Plugins and MCP Servers share the same binding rather than starting duplicate clients.
- Support the SDK's stdio and Streamable HTTP transports. Establish the session, negotiate capabilities, discover tools with pagination, and refresh discovery when supported change notifications arrive. Keep raw server tool names/schema data plus a stable server/account-qualified identity for the later tool adapter. Legacy SSE-only compatibility and an installer for server executables are not required in this package.
- Provide list/status, connect, disconnect, discoverTools, callTool, and dispose operations. Validate a selected tool and its arguments against the discovered schema before dispatch. Preserve structured/text content and distinguish a tool-reported error from a transport failure. The internal call API must accept cancellation and time limits; it is not a new unguarded public endpoint for executing tools.
- Report connecting, connected, disconnected, authentication required, and error states with actionable, redacted details. Define an injectable credential/auth provider consumed by the transport; ConnectionService supplies its real implementation in B. An authentication challenge must produce an honest required-auth state, not a fake successful connection or stored plaintext OAuth token.
- Bound connection retries and backoff, clear stale discovery state when access changes, and stop queued/new calls when a binding is disabled or disconnected. Never automatically replay a tool invocation after an ambiguous failure. Cancellation stops local waiting/dispatch and requests protocol cancellation where supported; it cannot promise to undo an external action already performed.
- Emit typed lifecycle and invocation events with server/binding/tool IDs, call ID, outcome, and duration for the later activity service. Include optional run/session linkage supplied by callers. Do not log credentials or raw sensitive arguments/results by default. MCP call counts are not model token counts; model usage is recorded separately in C.

Package A is complete when automated tests demonstrate both transports against controlled servers; discovery and a real fixture call; invalid arguments rejected before dispatch; tool errors versus connection errors; timeout/cancellation; failed startup and bounded recovery; repeated connect/disconnect; configuration persistence and unrelated-setting isolation; separate bindings for separate accounts; and clean shutdown without orphaned owned processes. Include an HTTP authentication challenge test with an injected test credential provider, without claiming live OAuth is implemented. Preserve the existing inbound MCP entrypoint and built-in tools.

The visible outcome of A is verified connection/discovery/call capability available to the application. An agent's ability to select a tool, invoke it under approval rules, and use its result is the completion criterion of C, not A. Full Notion authorization and the finished Settings interface remain required later packages in this release.

Relevant existing boundaries: public/assets/app.js and CSS for the shell; frontend/workflow for node controls; src/app/AppSettingsStore.ts and RuntimeManager.ts for settings; src/session for overrides/identity references; src/llm and src/types for reasoning, tool calling, and token normalization; src/local for runtime controls; src/core/CognitiveEngine.ts and src/workflows for execution; src/plugins and src/tools for replacement integration wiring; src/memory for history/recall separation; src/api for bounded APIs; electron/main.cjs and preload.cjs for folder actions, notifications, and OAuth; src/transports/telegram and src/index.ts for removal.

New UI/API service modules may be introduced where these boundaries require them. Do not perform an unrelated application-wide rewrite. Keep secrets out of frontend bootstrap payloads for the new connection module. Reuse the local backend and current deployment model.

**16. Acceptance criteria for the complete release.** Existing tests should be supplemented only where the implementation changes behavior. Run focused checks while developing, then the project's required build/tests and representative packaged-desktop checks before release.

- The main sidebar contains only the agreed app destinations/history and the bottom profile entry; Settings/Plugins are absent from permanent navigation.
- Profile, Usage, and Settings open the same dedicated shell; Back to app restores drafts/selection without restarting a run.
- Editing one provider or preference cannot reset another provider, plugin, agent, or runtime setting. Failed saves remain visible and preserve the last usable state.
- Light/Dark/System and Animations persist. Turning animations off eliminates nonessential CSS and JS motion, including hover effects and slider movement, while status and interaction remain functional.
- Every active reasoning value reaches the appropriate provider request, is preserved at the right scope, and is recorded as effective usage metadata. Unsupported models have no misleading slider.
- Provider tests distinguish unavailable configuration from a failed connection or failed generation. Runtime restart, idle unload, model-folder migration, and cancellation are exercised under idle and busy conditions.
- Profile/Usage use real records. Mixed local/cloud and multi-agent runs, repairs, extraction, cached/reasoning token fields, cancelled calls, unknown usage, and historical imports do not inflate totals.
- Notifications target the correct run and obey preferences/OS denial. Shortcuts survive relaunch, reject conflicts, and do not interfere with text editing.
- MCP discovery produces real callable schemas. Chat and workflow agents can call a fixture tool, consume its result, and finish; approval rejection and cancellation prevent later dispatch.
- Notion authorization, returning-user/restart, reconnect, read, approved write, Disable, Disconnect, and Uninstall are verified against their defined semantics. No placeholder reports Connected.
- Local Cognitive account, plan, billing, and logout remain unavailable; plugin OAuth works independently.
- Memory can be disabled, inspected, rebuilt, exported, and cleared without losing chats or usage. Extraction is opt-in, and the embedding picker corresponds to a working backend.
- Data deletion and export honor category boundaries and secret exclusions. Existing settings and histories migrate without unintended loss.
- Telegram cannot start from current or legacy configuration. No current UI advertises Telegram or Experimental. Built-in file/command behavior and the inbound MCP server still work.
- No Fallback, Diagnostics, updater, Remote, public marketplace, or cloud-account implementation is introduced under this scope.
- Test/live-verification limitations are recorded explicitly. Do not claim a provider, platform, plugin, or OS notification flow was tested when only mocks were exercised.

**17. References and unresolved implementation details.** The scope is fixed at feature level. Provider-specific reasoning mappings, exact embedding backend/model compatibility, OS notification/credential behavior, and OAuth callback packaging must be verified during their implementation packages. These are implementation checks, not permission to replace required features with placeholders. Runtime parallelism beyond one bundled slot, UI density without working layouts, and the explicitly deferred systems remain outside the baseline.

The user supplied three visual references: the full Settings sidebar, the compact account menu, and the discrete reasoning slider. They are preserved unchanged with this specification. The supplied images establish appearance and hierarchy; behavior and the actual Local Cognitive page list are defined above.

The Settings sidebar is the primary reference for the future Settings panel: Back to app above search, clear group labels, compact rows, restrained selection, and a separate content area to the right. Its Codex-specific entries do not expand this release's feature scope.

![Settings sidebar reference for future implementation](/Users/pc/Desktop/github/local-cognitive-AI-system/architecture/references/settings-sidebar.png)

![Account menu reference](/Users/pc/Desktop/github/local-cognitive-AI-system/architecture/references/settings-account-menu.png)

![Reasoning slider reference](/Users/pc/Desktop/github/local-cognitive-AI-system/architecture/references/settings-reasoning-slider.png)

Source material: the user's requests and clarifications in this task and the repository implementation inspected on 20 September 2026. The earlier broad account/mobile investigation has been consolidated into [the Remote Connection plan](remote-connection-implementation.md); implemented plugin OAuth behaviour is documented in [Plugins: local OAuth implementation](plugins-local-oauth-implementation.md). Historical proposals do not override this Settings scope; subsequent account/Remote work follows the newer consolidated plan.

Primary protocol references consulted during this discussion:

- [Agent Plugins client contract](https://agent-plugins.org/client-implementers/implement-an-agent-plugins-client): package loading/validation and the responsibilities left to the application.
- [MCP TypeScript SDK client](https://ts.sdk.modelcontextprotocol.io/client): local/HTTP transports, discovery, calls, and authorization helpers. Verify the project's installed SDK version when implementing.
- [Notion MCP client guide](https://developers.notion.com/guides/mcp/build-mcp-client): Notion OAuth/PKCE, connection and refresh behavior.
- [Composio authentication](https://docs.composio.dev/docs/authentication) and [production requirements](https://docs.composio.dev/docs/production-readiness): background for the deferred hosted adapter.
- [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning): provider-specific reasoning behavior; not a universal contract for all providers.

No production code, runtime configuration, user data, credentials, or subscriptions were changed to produce this specification.
