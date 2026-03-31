const app = document.querySelector("#app");

const state = {
  route: "chat",
  loading: false,
  chatSubmitting: false,
  notice: "",
  error: "",
  bootstrap: null,
  activeSessionId: null,
  sessionSettings: null,
  messages: [],
  drafts: {},
  pendingRequest: null,
  pluginTestResults: {},
  providerTestResults: {}
};

const api = {
  getBootstrap: () => request("/dashboard/bootstrap"),
  createSession: (title) =>
    request("/sessions", {
      method: "POST",
      body: JSON.stringify({ title })
    }),
  renameSession: (sessionId, title) =>
    request(`/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ title })
    }),
  deleteSession: (sessionId) =>
    request(`/sessions/${sessionId}`, {
      method: "DELETE"
    }),
  getSessionMessages: (sessionId) => request(`/sessions/${sessionId}/messages`),
  getSessionSettings: (sessionId) => request(`/sessions/${sessionId}/settings`),
  updateSessionSettings: (sessionId, payload) =>
    request(`/sessions/${sessionId}/settings`, {
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  sendChat: (payload) =>
    request("/chat", {
      method: "POST",
      body: JSON.stringify(payload),
      timeoutMs: 180000
    }),
  updateAppSettings: (payload) =>
    request("/app/settings", {
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  testPlugin: (pluginName) =>
    request(`/plugins/${pluginName}/test`, {
      method: "POST"
    }),
  testProvider: (providerId) =>
    request(`/providers/${providerId}/test`, {
      method: "POST"
    }),
  reloadRuntime: () =>
    request("/runtime/reload", {
      method: "POST"
    }),
  loadModel: (modelId) =>
    request("/lmstudio/models/load", {
      method: "POST",
      body: JSON.stringify({ modelId })
    }),
  unloadModel: (modelIdOrInstanceId) =>
    request("/lmstudio/models/unload", {
      method: "POST",
      body: JSON.stringify({ modelIdOrInstanceId })
    }),
  refreshManagedModels: async () => {
    const [loadedModels, allManagedModels] = await Promise.all([
      request("/lmstudio/models/loaded"),
      request("/lmstudio/models/all")
    ]);
    return { loadedModels, allManagedModels };
  }
};

init().catch((error) => {
  state.error = error instanceof Error ? error.message : "Failed to initialize UI";
  render();
});

window.addEventListener("hashchange", () => {
  syncRouteFromHash();
  render();
});

async function init() {
  syncRouteFromHash();
  await refreshBootstrap();
  await ensureSession();
  render();
}

function syncRouteFromHash() {
  const route = window.location.hash.replace(/^#\/?/, "");
  state.route = ["chat", "models", "plugins", "settings"].includes(route) ? route : "chat";
}

async function refreshBootstrap() {
  state.bootstrap = await api.getBootstrap();
}

async function ensureSession() {
  const sessions = state.bootstrap?.sessions ?? [];

  if (!sessions.length) {
    const session = await api.createSession("New task");
    await refreshBootstrap();
    state.activeSessionId = session.id;
  } else if (!state.activeSessionId || !sessions.some((session) => session.id === state.activeSessionId)) {
    state.activeSessionId = sessions[0].id;
  }

  await loadActiveSession();
}

async function loadActiveSession() {
  if (!state.activeSessionId) {
    return;
  }

  const [messages, settings] = await Promise.all([
    api.getSessionMessages(state.activeSessionId),
    api.getSessionSettings(state.activeSessionId)
  ]);
  state.messages = messages;
  state.sessionSettings = settings;

  if (
    state.pendingRequest &&
    messages.some(
      (message) =>
        message.role === "assistant" &&
        new Date(message.createdAt).getTime() >= new Date(state.pendingRequest.startedAt).getTime()
    )
  ) {
    state.pendingRequest = null;
  }
}

async function request(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 30000;
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      },
      signal: controller.signal,
      ...options
    });

    if (!response.ok) {
      const payload = await safeJson(response);
      throw new Error(payload?.message || payload?.error || `Request failed: ${response.status}`);
    }

    if (response.status === 204) {
      return null;
    }

    return await safeJson(response);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Request timed out.");
    }

    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function render() {
  if (!app) {
    return;
  }

  app.innerHTML = `
    <div class="shell">
      ${renderSidebar()}
      <main class="main">
        <div class="content-shell">
          ${renderTopbar()}
          ${state.notice ? `<div class="notice">${escapeHtml(state.notice)}</div>` : ""}
          ${state.error ? `<div class="notice">${escapeHtml(state.error)}</div>` : ""}
          <section class="route route--chat ${state.route === "chat" ? "active" : ""}">
            ${renderChatRoute()}
          </section>
          <section class="route route--models ${state.route === "models" ? "active" : ""}">
            ${renderModelsRoute()}
          </section>
          <section class="route route--plugins ${state.route === "plugins" ? "active" : ""}">
            ${renderPluginsRoute()}
          </section>
          <section class="route route--settings ${state.route === "settings" ? "active" : ""}">
            ${renderSettingsRoute()}
          </section>
        </div>
      </main>
    </div>
  `;

  bindEvents();
}

function renderSidebar() {
  const sessions = state.bootstrap?.sessions ?? [];
  const providerCount = state.bootstrap?.providers?.length ?? 0;
  const pluginCount = state.bootstrap?.plugins?.length ?? 0;

  return `
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">LC</div>
        <div class="brand-copy">
          <strong>Local Cognitive</strong>
          <span>Headless engine dashboard</span>
        </div>
      </div>

      <nav class="nav">
        ${renderNavButton("chat", "Chat Workspace", "▣")}
        ${renderNavButton("models", "Models", "◎")}
        ${renderNavButton("plugins", "Plugins", "◇")}
        ${renderNavButton("settings", "Settings", "⚙")}
      </nav>

      <section class="sidebar-section">
        <div class="sidebar-header">
          <span>Sessions</span>
          <button class="ghost-button" data-action="new-session">New</button>
        </div>
        <div class="session-list">
          ${
            sessions.length
              ? sessions
                  .map(
                    (session) => `
                      <div class="session-row ${session.id === state.activeSessionId ? "active" : ""}">
                        <button class="session-item ${session.id === state.activeSessionId ? "active" : ""}" data-action="open-session" data-session-id="${session.id}">
                          <span class="session-title">${escapeHtml(session.title)}</span>
                          <span class="session-meta">${formatDate(session.updatedAt)} · ${escapeHtml(session.channel)}</span>
                        </button>
                        <button class="session-delete" type="button" data-action="delete-session-quick" data-session-id="${session.id}" aria-label="Delete chat">
                          ×
                        </button>
                      </div>
                    `
                  )
                  .join("")
              : `<div class="empty">No sessions yet.</div>`
          }
        </div>
      </section>

      <div class="sidebar-footer">
        <div class="status-card">
          <strong>Runtime snapshot</strong>
          <span>${providerCount} providers · ${pluginCount} plugins · ${(state.bootstrap?.loadedModels ?? []).length} loaded local models</span>
        </div>
      </div>
    </aside>
  `;
}

function renderNavButton(route, label, icon) {
  return `
    <button class="nav-button ${state.route === route ? "active" : ""}" data-action="route" data-route="${route}">
      <span class="nav-label"><span>${icon}</span><span>${label}</span></span>
    </button>
  `;
}

function renderTopbar() {
  return `
    <header class="topbar">
      <div class="hero">
        <strong>Browser Control Surface</strong>
        <h1>${state.routeTitle ?? routeTitle(state.route)}</h1>
        <p>
          Localhost dashboard for multi-model chat, debate routing, provider setup, plugin configuration,
          and LM Studio model management.
        </p>
      </div>
      <div class="utility-bar">
        <span class="pill">Default: ${escapeHtml(state.bootstrap?.appSettings?.llm?.defaultProvider ?? "n/a")}</span>
        <span class="pill">${(state.bootstrap?.loadedModels ?? []).length} loaded</span>
      </div>
    </header>
  `;
}

function renderChatRoute() {
  if (!state.activeSessionId || !state.sessionSettings) {
    return `<div class="empty">Loading chat workspace...</div>`;
  }

  const settings = state.sessionSettings;
  const currentSession = (state.bootstrap?.sessions ?? []).find((session) => session.id === state.activeSessionId);
  const defaultModelOptions = getSelectableSessionModels(settings.defaultTarget.providerId, settings.defaultTarget.model);
  const supportModelOptions = getSelectableSessionModels(settings.debate.support.providerId, settings.debate.support.model);
  const attackModelOptions = getSelectableSessionModels(settings.debate.attack.providerId, settings.debate.attack.model);
  const judgeModelOptions = getSelectableSessionModels(settings.debate.judge.providerId, settings.debate.judge.model);
  const providerOptions = getProviderOptions();
  const judgeOptions = [...providerOptions, { id: "local", name: "local" }];
  const messages = [
    ...state.messages,
    ...(state.pendingRequest
      ? [
          {
            id: "pending:assistant",
            role: "assistant",
            content: "Generating response...",
            createdAt: state.pendingRequest.startedAt,
            pending: true
          }
        ]
      : [])
  ];

  return `
    <div class="chat-layout">
      <section class="chat-shell">
        <div class="message-stream">
          ${
            messages.length
              ? messages.map(renderMessage).join("")
              : `<div class="empty">Start the first conversation in this session.</div>`
          }
        </div>

        <form class="composer" id="chat-form">
          <textarea name="input" placeholder="Type a command, ask a question, or run a hypothesis debate...">${escapeHtml(getActiveDraft())}</textarea>
          <div class="composer-footer">
            <div class="chips">
              ${renderChipGroup("Mode", [
                ["mode", "auto", settings.mode === "auto"],
                ["mode", "general", settings.mode === "general"],
                ["mode", "code", settings.mode === "code"],
                ["mode", "hypothesis", settings.mode === "hypothesis"]
              ])}
              ${renderChipGroup("Language", [
                ["language", "auto", settings.language === "auto"],
                ["language", "ru", settings.language === "ru"],
                ["language", "en", settings.language === "en"]
              ])}
              ${renderChipGroup("Debate", [
                ["debate", "debate:off", !settings.debate.enabled],
                ["debate", "debate:on", settings.debate.enabled]
              ])}
            </div>
            <button class="primary-button" type="submit">${state.chatSubmitting ? "Generating..." : "Send"}</button>
          </div>
        </form>
      </section>

      <form class="panel chat-settings form-grid" id="session-settings-form">
        <div class="chat-settings__header">
          <div>
            <h3>Session Setup</h3>
            <div class="subtle">Pinned controls for mode, language, debate, and model routing.</div>
          </div>
          <button class="primary-button" type="submit">Save setup</button>
        </div>

        <div class="chat-settings__grid">
          <div class="field">
            <label>Title</label>
            <input name="sessionTitle" value="${escapeAttr(currentSession?.title ?? "")}" />
          </div>
          <div class="field">
            <label>Mode</label>
            <select name="mode">${["auto", "general", "code", "hypothesis"].map((value) => option(value, settings.mode)).join("")}</select>
          </div>
          <div class="field">
            <label>Language</label>
            <select name="language">${["auto", "ru", "en"].map((value) => option(value, settings.language)).join("")}</select>
          </div>
          <div class="field">
            <label>Debate</label>
            <select name="debateEnabled">${["off", "on"].map((value) => option(value, settings.debate.enabled ? "on" : "off")).join("")}</select>
          </div>
          <div class="field">
            <label>Profile</label>
            <select name="debateProfile">${["general", "technical", "product", "research", "security"].map((value) => option(value, settings.debate.profile)).join("")}</select>
          </div>
          <div class="field">
            <label>Default provider</label>
            <select name="defaultProvider">${providerOptions.map((item) => option(item.id, settings.defaultTarget.providerId, item.name)).join("")}</select>
          </div>
          <div class="field">
            <label>Default model</label>
            ${renderSessionModelControl("defaultModel", settings.defaultTarget.providerId, settings.defaultTarget.model ?? "", defaultModelOptions, "default-model-options")}
          </div>
          <div class="field">
            <label>Support provider</label>
            <select name="supportProvider">${providerOptions.map((item) => option(item.id, settings.debate.support.providerId, item.name)).join("")}</select>
          </div>
          <div class="field">
            <label>Support model</label>
            ${renderSessionModelControl("supportModel", settings.debate.support.providerId, settings.debate.support.model ?? "", supportModelOptions, "support-model-options")}
          </div>
          <div class="field">
            <label>Attack provider</label>
            <select name="attackProvider">${providerOptions.map((item) => option(item.id, settings.debate.attack.providerId, item.name)).join("")}</select>
          </div>
          <div class="field">
            <label>Attack model</label>
            ${renderSessionModelControl("attackModel", settings.debate.attack.providerId, settings.debate.attack.model ?? "", attackModelOptions, "attack-model-options")}
          </div>
          <div class="field">
            <label>Judge provider</label>
            <select name="judgeProvider">${judgeOptions.map((item) => option(item.id, settings.debate.judge.providerId, item.name)).join("")}</select>
          </div>
          <div class="field">
            <label>Judge model</label>
            ${renderSessionModelControl("judgeModel", settings.debate.judge.providerId, settings.debate.judge.model ?? "", judgeModelOptions, "judge-model-options")}
          </div>
        </div>
      </form>
    </div>
  `;
}

function renderModelsRoute() {
  const loaded = state.bootstrap?.loadedModels ?? [];
  const allManaged = [...(state.bootstrap?.allManagedModels ?? [])].sort((left, right) => {
    if (left.loaded !== right.loaded) {
      return left.loaded ? -1 : 1;
    }

    return (left.displayName || left.id).localeCompare(right.displayName || right.id);
  });
  const providerDefaults = state.bootstrap?.appSettings?.providers ?? {};

  return `
    <div class="grid">
      <section class="panel runtime-summary">
        <div class="row-between">
          <div>
            <h2>Runtime Providers</h2>
            <div class="subtle">Read-only snapshot of provider aliases, defaults, and endpoints.</div>
          </div>
        </div>
        <div class="runtime-provider-grid">
        ${(state.bootstrap?.providers ?? [])
          .map(
            (provider) => {
              const status = getRuntimeProviderStatus(provider.id);
              return `
              <article class="list-item runtime-provider-item">
                <div class="runtime-provider-head">
                  <strong>${escapeHtml(provider.name)}</strong>
                  <span class="badge ${status.tone}">${status.label}</span>
                </div>
                <div class="subtle">${escapeHtml(provider.id)}</div>
                <div class="runtime-provider-meta">
                  <span class="mono">${escapeHtml(providerDefaults[provider.id]?.model ?? provider.defaultModel)}</span>
                  <span class="runtime-provider-separator">•</span>
                  <span class="mono">${escapeHtml(providerDefaults[provider.id]?.baseUrl ?? "n/a")}</span>
                </div>
              </article>
            `;
            }
          )
          .join("")}
        </div>
      </section>

      <section class="panel">
        <div class="row-between">
          <div>
            <h2>Loaded Local Models</h2>
            <div class="subtle">LM Studio instances currently ready for routing, debate, and judge roles.</div>
          </div>
          <button class="ghost-button" data-action="refresh-models">Refresh models</button>
        </div>
        <div class="list loaded-models-list">
          ${
            loaded.length
              ? loaded
                  .map(
                    (model) => `
                      <div class="list-item loaded-model-item">
                        <div class="loaded-model-copy">
                            <strong>${escapeHtml(model.displayName || model.id)}</strong>
                            <div class="mono">${escapeHtml(model.id)}</div>
                            <div class="subtle">Instances: ${escapeHtml(model.loadedInstanceIds.join(", ") || "1")}</div>
                        </div>
                        <button class="ghost-button danger-button" data-action="unload-model" data-model-id="${escapeAttr(model.loadedInstanceIds[0] || model.id)}">Unload</button>
                      </div>
                    `
                  )
                  .join("")
              : `<div class="empty">No loaded local models found.</div>`
          }
        </div>
      </section>

      <section class="panel">
        <div class="row-between">
          <div>
            <h2>LM Studio Catalog</h2>
            <div class="subtle">Load or unload local models without leaving the dashboard.</div>
          </div>
        </div>
        <div class="catalog-grid">
          ${allManaged
            .map(
              (model) => `
                <div class="card compact-card catalog-card">
                  <div class="card-header">
                    <div>
                      <h3>${escapeHtml(model.displayName || model.id)}</h3>
                      <div class="mono">${escapeHtml(model.id)}</div>
                    </div>
                    <span class="badge ${model.loaded ? "success" : "warning"}">${model.loaded ? "loaded" : "available"}</span>
                  </div>
                  <div class="footer-row">
                    <span class="subtle">${model.loaded ? "Ready for chat and debate." : "Can be loaded into LM Studio."}</span>
                    ${
                      model.loaded
                        ? `<button class="ghost-button danger-button" data-action="unload-model" data-model-id="${escapeAttr(model.loadedInstanceIds[0] || model.id)}">Unload</button>`
                        : `<button class="primary-button" data-action="load-model" data-model-id="${escapeAttr(model.id)}">Load</button>`
                    }
                  </div>
                </div>
              `
            )
            .join("")}
        </div>
      </section>
    </div>
  `;
}

function renderPluginsRoute() {
  const pluginSettings = state.bootstrap?.appSettings?.plugins ?? {};
  const pluginStatuses = state.bootstrap?.pluginStatuses ?? [];
  const statusByName = Object.fromEntries(pluginStatuses.map((status) => [status.name, status]));

  return `
    <form class="grid" id="plugins-form">
      <section class="panel">
        <div class="row-between">
          <div>
            <h2>Plugin Surface</h2>
            <div class="subtle">Configure tool integrations and future bridges without editing source files.</div>
          </div>
          <button class="primary-button" type="submit">Save plugin settings</button>
        </div>
      </section>

      <div class="plugin-grid">
        ${renderPluginCard("notion", pluginSettings.notion, statusByName.notion, [
          ["apiKey", "API key"],
          ["parentPageId", "Parent page ID"],
          ["dataSourceId", "Data source ID"],
          ["titleProperty", "Title property"],
          ["version", "Notion version"]
        ])}
        ${renderPluginCard("file", pluginSettings.file, statusByName.file, [
          ["outputDir", "Output directory"]
        ])}
        ${renderPluginCard("vscode", pluginSettings.vscode, statusByName.vscode, [
          ["workspaceRoot", "Workspace root"],
          ["bridgeCommand", "Bridge command"],
          ["notes", "Notes", true]
        ])}
      </div>
    </form>
  `;
}

function renderPluginCard(name, plugin, status, fields) {
  const loaded = status?.loaded ?? false;
  const configured = status?.configured ?? false;
  const testResult = state.pluginTestResults[name];
  return `
    <section class="card">
      <div class="card-header">
        <div>
          <h3>${escapeHtml(capitalize(name))}</h3>
          <div class="subtle">${escapeHtml(status?.summary ?? (loaded ? "Loaded in runtime" : "Stored for future/runtime reload"))}</div>
        </div>
        <span class="badge ${loaded ? "success" : configured ? "warning" : "danger"}">${loaded ? "active" : configured ? "configured" : "needs setup"}</span>
      </div>
      <div class="footer-row">
        <span class="subtle">enabled: ${plugin?.enabled ? "yes" : "no"} · loaded: ${loaded ? "yes" : "no"}</span>
        <button class="ghost-button" type="button" data-action="test-plugin" data-plugin-name="${escapeAttr(name)}">Test</button>
      </div>
      ${
        testResult
          ? `<div class="notice">${escapeHtml(`${testResult.ok ? "OK" : "Issue"}: ${testResult.message}`)}</div>`
          : ""
      }
      <div class="field">
        <label>Enabled</label>
        <select name="plugin.${name}.enabled">
          ${["true", "false"].map((value) => option(value, String(plugin?.enabled ?? true), value === "true" ? "on" : "off")).join("")}
        </select>
      </div>
      <div class="form-grid">
        ${fields
          .map(([key, label, multiline]) => {
            const value = plugin?.values?.[key] ?? "";
            return multiline
              ? `
                <div class="field">
                  <label>${escapeHtml(label)}</label>
                  <textarea name="plugin.${name}.${key}">${escapeHtml(String(value))}</textarea>
                </div>
              `
              : `
                <div class="field">
                  <label>${escapeHtml(label)}</label>
                  <input name="plugin.${name}.${key}" value="${escapeAttr(String(value))}" />
                </div>
              `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function renderSettingsRoute() {
  const settings = state.bootstrap?.appSettings;

  if (!settings) {
    return `<div class="empty">Loading settings...</div>`;
  }

  return `
    <form class="grid" id="app-settings-form">
      <section class="panel">
        <div class="row-between">
          <div>
            <h2>Provider & Runtime Settings</h2>
            <div class="subtle">Set local and proprietary provider connections, defaults, and runtime behavior from the browser.</div>
          </div>
          <div class="utility-bar">
            <button class="ghost-button" type="button" data-action="reload-runtime">Reload runtime</button>
            <button class="primary-button" type="submit">Save settings</button>
          </div>
        </div>
      </section>

      <section class="card">
        <h3>Global defaults</h3>
        <div class="field-grid">
          <div class="field">
            <label>Default provider</label>
            <select name="llm.defaultProvider">
              ${(state.bootstrap?.providers ?? []).map((provider) => option(provider.id, settings.llm.defaultProvider, provider.id)).join("")}
            </select>
          </div>
        </div>
      </section>

      <section class="card">
        <h3>Telegram</h3>
        <div class="subtle">Bot token and polling are stored here. Restart the server after changing Telegram settings.</div>
        <div class="field-grid">
          <div class="field">
            <label>Enabled</label>
            <select name="telegram.enabled">
              ${["true", "false"].map((value) => option(value, String(settings.telegram.enabled), value === "true" ? "on" : "off")).join("")}
            </select>
          </div>
          <div class="field">
            <label>Poll timeout (sec)</label>
            <input name="telegram.pollTimeoutSec" type="number" value="${escapeAttr(String(settings.telegram.pollTimeoutSec))}" />
          </div>
          <div class="field full">
            <label>Bot token</label>
            <input type="password" autocomplete="off" name="telegram.botToken" value="${escapeAttr(settings.telegram.botToken || "")}" placeholder="123456:telegram-bot-token" />
          </div>
        </div>
      </section>

      <section class="card">
        <h3>Long Memory</h3>
        <div class="field-grid">
          <div class="field">
            <label>Adapter</label>
            <select name="memory.adapter">
              ${["local-json", "openmemory"].map((value) => option(value, settings.memory.adapter)).join("")}
            </select>
          </div>
          <div class="field">
            <label>Top K</label>
            <input name="memory.topK" type="number" value="${escapeAttr(String(settings.memory.topK))}" />
          </div>
          <div class="field">
            <label>Memory directory</label>
            <input name="memory.baseDir" value="${escapeAttr(settings.memory.baseDir)}" />
          </div>
          <div class="field">
            <label>OpenMemory enabled</label>
            <select name="memory.openMemory.enabled">
              ${["true", "false"].map((value) => option(value, String(settings.memory.openMemory.enabled), value === "true" ? "on" : "off")).join("")}
            </select>
          </div>
          <div class="field full">
            <label>OpenMemory DB path</label>
            <input name="memory.openMemory.dbPath" value="${escapeAttr(settings.memory.openMemory.dbPath)}" />
          </div>
        </div>
      </section>

      <div class="settings-grid">
        ${Object.entries(settings.providers)
          .map(
            ([providerId, provider]) => `
              <section class="card compact-card settings-card">
                <div class="card-header">
                  <div>
                    <h3>${escapeHtml(providerId)}</h3>
                    <div class="subtle">Connection and default model configuration</div>
                  </div>
                  <span class="badge ${provider.enabled ? "success" : "warning"}">${provider.enabled ? "enabled" : "disabled"}</span>
                </div>
                <div class="form-grid">
                  <div class="field">
                    <label>Enabled</label>
                    <select name="provider.${providerId}.enabled">
                      ${["true", "false"].map((value) => option(value, String(provider.enabled), value === "true" ? "on" : "off")).join("")}
                    </select>
                  </div>
                  <div class="field">
                    <label>Base URL</label>
                    <input
                      name="provider.${providerId}.baseUrl"
                      value="${escapeAttr(provider.baseUrl || "")}"
                      placeholder="${escapeAttr(providerBaseUrlPlaceholder(providerId))}"
                    />
                    <div class="subtle">${escapeHtml(providerBaseUrlHelp(providerId))}</div>
                  </div>
                  <div class="field">
                    <label>API key</label>
                    <input type="password" autocomplete="off" name="provider.${providerId}.apiKey" value="${escapeAttr(provider.apiKey || "")}" />
                  </div>
                  <div class="field">
                    <label>Default model</label>
                    <input
                      name="provider.${providerId}.model"
                      list="${providerId}-models-list"
                      value="${escapeAttr(provider.model || "")}"
                      placeholder="${escapeAttr(providerModelPlaceholder(providerId))}"
                    />
                    <div class="subtle">${escapeHtml(providerModelHelp(providerId))}</div>
                    <datalist id="${providerId}-models-list">
                      ${getProviderSuggestedModels(providerId).map((item) => `<option value="${escapeAttr(item)}"></option>`).join("")}
                    </datalist>
                  </div>
                  <div class="field">
                    <label>Timeout (ms)</label>
                    <input name="provider.${providerId}.timeoutMs" type="number" value="${escapeAttr(String(provider.timeoutMs ?? 20000))}" />
                  </div>
                  ${providerId === "anthropic"
                    ? `
                      <div class="field">
                        <label>Anthropic version</label>
                        <input name="provider.${providerId}.version" value="${escapeAttr(provider.version || "")}" />
                      </div>
                      <div class="field">
                        <label>Max tokens</label>
                        <input name="provider.${providerId}.maxTokens" type="number" value="${escapeAttr(String(provider.maxTokens ?? 1024))}" />
                      </div>
                    `
                    : ""}
                </div>
                <div class="footer-row">
                  <span class="subtle">
                    ${
                      state.providerTestResults[providerId]
                        ? escapeHtml(formatProviderTestResult(state.providerTestResults[providerId]))
                        : "Check auth, base URL, and model access before assigning this provider to a role."
                    }
                  </span>
                  <button class="ghost-button" type="button" data-action="test-provider" data-provider-id="${escapeAttr(providerId)}">Test provider</button>
                </div>
              </section>
            `
          )
          .join("")}
      </div>
    </form>
  `;
}

function renderMessage(message) {
  const copyButton =
    message.role === "assistant" && !message.pending
      ? `<button class="ghost-button message-copy-button" type="button" data-action="copy-message" data-message-id="${escapeAttr(message.id)}">Copy</button>`
      : "";
  const footer =
    message.role === "assistant"
      ? `
        <div class="message-footer">
          <span class="message-footer-actions">
            ${copyButton}
          </span>
          <span>${escapeHtml(renderMessageFooterMeta(message))}</span>
        </div>
      `
      : "";

  const content = message.pending
    ? `<div class="thinking-indicator">Thinking</div>`
    : escapeHtml(message.content);

  return `
    <article class="message ${message.role} ${message.pending ? "pending" : ""}">
      <div class="message-meta">
        <span>${escapeHtml(message.role)}</span>
        <span>${escapeHtml(message.role === "assistant" ? formatDate(message.createdAt) : "")}</span>
      </div>
      <div class="message-content">${content}</div>
      ${footer}
    </article>
  `;
}

function bindEvents() {
  document.querySelectorAll("[data-action='route']").forEach((button) => {
    button.addEventListener("click", () => {
      window.location.hash = `/${button.dataset.route}`;
    });
  });

  document.querySelectorAll("[data-action='new-session']").forEach((button) => {
    button.addEventListener("click", async () => {
      await runAction(async () => {
        const currentSettings = state.sessionSettings ? sessionSettingsToPatch(state.sessionSettings) : null;
        const session = await api.createSession("New task");
        if (currentSettings) {
          await api.updateSessionSettings(session.id, currentSettings);
        }
        await refreshBootstrap();
        state.activeSessionId = session.id;
        await loadActiveSession();
        state.notice = "";
      });
    });
  });

  document.querySelectorAll("[data-action='delete-session']").forEach((button) => {
    button.addEventListener("click", async () => {
      await deleteSessionById(state.activeSessionId);
    });
  });

  document.querySelectorAll("[data-action='delete-session-quick']").forEach((button) => {
    button.addEventListener("click", async () => {
      await deleteSessionById(button.dataset.sessionId);
    });
  });

  document.querySelectorAll("[data-action='open-session']").forEach((button) => {
    button.addEventListener("click", async () => {
      await runAction(async () => {
        state.activeSessionId = button.dataset.sessionId;
        await loadActiveSession();
      });
    });
  });

  document.querySelectorAll("[data-action='refresh-session']").forEach((button) => {
    button.addEventListener("click", async () => {
      await runAction(async () => {
        await refreshBootstrap();
        await loadActiveSession();
        state.notice = "";
      });
    });
  });

  document.querySelector("#chat-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const input = String(form.get("input") || "").trim();

    if (!input) {
      return;
    }

    state.route = "chat";
    window.location.hash = "/chat";
    state.pendingRequest = {
      input,
      startedAt: new Date().toISOString()
    };
    state.chatSubmitting = true;
    if (state.activeSessionId) {
      state.drafts[state.activeSessionId] = "";
    }
    state.error = "";
    render();
    requestAnimationFrame(() => scrollChatToBottom("smooth"));

    try {
      const response = await api.sendChat({
        input,
        sessionId: state.activeSessionId
      });
      state.activeSessionId = response.sessionId;
      await refreshBootstrap();
      await loadActiveSession();
    } catch (error) {
      state.error = error instanceof Error ? error.message : "Action failed";
      state.pendingRequest = null;
    } finally {
      state.chatSubmitting = false;
      render();
      requestAnimationFrame(() => scrollChatToBottom("smooth"));
    }
  });

  document.querySelector("#chat-form textarea[name='input']")?.addEventListener("input", (event) => {
    if (!state.activeSessionId) {
      return;
    }

    state.drafts[state.activeSessionId] = event.currentTarget.value;
  });

  document.querySelector("#session-settings-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const sessionTitle = String(form.get("sessionTitle") || "").trim();
    const resolveModelValue = (providerFieldName, modelFieldName) => {
      const providerId = String(form.get(providerFieldName) || "").trim();

      if (!providerId || providerId === "local") {
        return undefined;
      }

      return (
        String(form.get(modelFieldName) || "").trim() || getProviderConfiguredModel(providerId) || undefined
      );
    };
    const payload = {
      mode: form.get("mode"),
      language: form.get("language"),
      defaultTarget: {
        providerId: form.get("defaultProvider"),
        model: resolveModelValue("defaultProvider", "defaultModel")
      },
      debate: {
        enabled: form.get("debateEnabled") === "on",
        profile: form.get("debateProfile"),
        support: {
          providerId: form.get("supportProvider"),
          model: resolveModelValue("supportProvider", "supportModel")
        },
        attack: {
          providerId: form.get("attackProvider"),
          model: resolveModelValue("attackProvider", "attackModel")
        },
        judge: {
          providerId: form.get("judgeProvider"),
          model: resolveModelValue("judgeProvider", "judgeModel")
        }
      }
    };

    await runAction(async () => {
      if (sessionTitle) {
        await api.renameSession(state.activeSessionId, sessionTitle);
      }
      state.sessionSettings = await api.updateSessionSettings(state.activeSessionId, payload);
      await refreshBootstrap();
      state.notice = "";
    });
  });

  bindSessionSetupFieldSync();

  document.querySelector("#plugins-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = buildAppSettingsPayload(form, true);
    await runAction(async () => {
      const response = await api.updateAppSettings(payload);
      state.bootstrap.plugins = response.plugins;
      state.bootstrap.providers = response.providers;
      state.bootstrap.tools = response.tools;
      state.bootstrap.appSettings = response.settings;
      state.bootstrap.pluginStatuses = await request("/plugins/status");
      state.notice = "";
    });
  });

  document.querySelector("#app-settings-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = buildAppSettingsPayload(form, false);

    await runAction(async () => {
      const response = await api.updateAppSettings(payload);
      state.bootstrap.providers = response.providers;
      state.bootstrap.plugins = response.plugins;
      state.bootstrap.tools = response.tools;
      state.bootstrap.appSettings = response.settings;
      state.bootstrap.pluginStatuses = await request("/plugins/status");
      state.notice = "";
    });
  });

  document.querySelector("[data-action='reload-runtime']")?.addEventListener("click", async () => {
    await runAction(async () => {
      await api.reloadRuntime();
      await refreshBootstrap();
      await loadActiveSession();
      state.notice = "";
    });
  });

  document.querySelector("[data-action='refresh-models']")?.addEventListener("click", async () => {
    await refreshModelCollections();
  });

  document.querySelectorAll("[data-action='load-model']").forEach((button) => {
    button.addEventListener("click", async () => {
      await runAction(async () => {
        await api.loadModel(button.dataset.modelId);
        await refreshModelCollections();
        state.notice = "";
      });
    });
  });

  document.querySelectorAll("[data-action='unload-model']").forEach((button) => {
    button.addEventListener("click", async () => {
      await runAction(async () => {
        await api.unloadModel(button.dataset.modelId);
        await refreshModelCollections();
        state.notice = "";
      });
    });
  });

  document.querySelectorAll("[data-action='test-plugin']").forEach((button) => {
    button.addEventListener("click", async () => {
      const pluginName = button.dataset.pluginName;
      await runAction(async () => {
        const result = await api.testPlugin(pluginName);
        state.pluginTestResults[pluginName] = result;
        state.notice = "";
      });
    });
  });

  document.querySelectorAll("[data-action='test-provider']").forEach((button) => {
    button.addEventListener("click", async () => {
      const providerId = button.dataset.providerId;

      await runAction(async () => {
        state.providerTestResults[providerId] = await api.testProvider(providerId);
        state.notice = "";
      });
    });
  });

  document.querySelectorAll("[data-chip-kind]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!state.activeSessionId || !state.sessionSettings) {
        return;
      }

      const kind = button.dataset.chipKind;
      const value = button.dataset.chipValue;
      await runAction(async () => {
        const nextSettings = buildNextSessionSettings(state.sessionSettings, kind, value);
        if (kind === "mode") {
          state.sessionSettings = nextSettings;
        } else if (kind === "language") {
          state.sessionSettings = nextSettings;
        } else if (kind === "debate") {
          state.sessionSettings = nextSettings;
        }
        state.sessionSettings = await api.updateSessionSettings(
          state.activeSessionId,
          sessionSettingsToPatch(nextSettings)
        );
        await refreshBootstrap();
      });
    });
  });

  document.querySelectorAll("[data-action='copy-message']").forEach((button) => {
    button.addEventListener("click", async () => {
      const messageId = button.dataset.messageId;
      const message = state.messages.find((item) => item.id === messageId);

      if (!message?.content) {
        return;
      }

      try {
        await navigator.clipboard.writeText(message.content);
        const original = button.textContent;
        button.textContent = "Copied";
        window.setTimeout(() => {
          button.textContent = original;
        }, 1000);
      } catch (error) {
        state.error = error instanceof Error ? error.message : "Copy failed";
        render();
      }
    });
  });
}

async function refreshModelCollections() {
  await runAction(async () => {
    const managed = await api.refreshManagedModels();
    state.bootstrap.loadedModels = managed.loadedModels;
    state.bootstrap.allManagedModels = managed.allManagedModels;
    state.notice = "Model catalog refreshed.";
  });
}

function buildAppSettingsPayload(form, pluginsOnly) {
  const payload = {
    llm: pluginsOnly
      ? undefined
      : {
          defaultProvider: String(form.get("llm.defaultProvider") || "")
        },
    telegram: pluginsOnly
      ? undefined
      : {
          enabled: form.get("telegram.enabled") === "true",
          botToken: String(form.get("telegram.botToken") || "").trim(),
          pollTimeoutSec: Number(form.get("telegram.pollTimeoutSec") || 25)
        },
    memory: pluginsOnly
      ? undefined
      : {
          adapter: String(form.get("memory.adapter") || "local-json"),
          topK: Number(form.get("memory.topK") || 5),
          baseDir: String(form.get("memory.baseDir") || "").trim(),
          openMemory: {
            enabled: form.get("memory.openMemory.enabled") === "true",
            dbPath: String(form.get("memory.openMemory.dbPath") || "").trim()
          }
        },
    providers: {},
    plugins: {}
  };

  if (!pluginsOnly) {
    for (const provider of state.bootstrap.providers ?? []) {
      payload.providers[provider.id] = {
        enabled: form.get(`provider.${provider.id}.enabled`) === "true",
        baseUrl: String(form.get(`provider.${provider.id}.baseUrl`) || "").trim(),
        apiKey: String(form.get(`provider.${provider.id}.apiKey`) || "").trim(),
        model: String(form.get(`provider.${provider.id}.model`) || "").trim(),
        timeoutMs: Number(form.get(`provider.${provider.id}.timeoutMs`) || 20000)
      };

      if (provider.id === "anthropic") {
        payload.providers[provider.id].version = String(form.get(`provider.${provider.id}.version`) || "").trim();
        payload.providers[provider.id].maxTokens = Number(form.get(`provider.${provider.id}.maxTokens`) || 1024);
      }
    }
  }

  for (const pluginName of ["notion", "file", "vscode"]) {
    const pluginFields = Object.fromEntries(
      [...form.entries()]
        .filter(([key]) => key.startsWith(`plugin.${pluginName}.`) && key !== `plugin.${pluginName}.enabled`)
        .map(([key, value]) => [key.replace(`plugin.${pluginName}.`, ""), String(value)])
    );

    payload.plugins[pluginName] = {
      enabled: form.get(`plugin.${pluginName}.enabled`) === "true",
      values: pluginFields
    };
  }

  return payload;
}

async function runAction(fn) {
  state.loading = true;
  state.error = "";
  render();

  try {
    await fn();
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Action failed";
  } finally {
    state.loading = false;
    render();
  }
}

function routeTitle(route) {
  switch (route) {
    case "models":
      return "Model cockpit";
    case "plugins":
      return "Plugin surface";
    case "settings":
      return "Runtime settings";
    default:
      return "Conversation workspace";
  }
}

function getProviderOptions() {
  return (state.bootstrap?.providers ?? []).map((provider) => ({
    id: provider.id,
    name: provider.name
  }));
}

function getModelOptions() {
  const fromCatalog = (state.bootstrap?.availableModels ?? []).map((model) => model.id);
  const fromManaged = (state.bootstrap?.allManagedModels ?? []).map((model) => model.id);
  return [...new Set([...fromCatalog, ...fromManaged])].sort();
}

function getLoadedModelOptions() {
  return (state.bootstrap?.loadedModels ?? []).map((model) => model.id);
}

function getProviderSuggestedModels(providerId) {
  const localModels = getModelOptions();

  switch (providerId) {
    case "openai":
      return [
        "gpt-5.1",
        "gpt-5-mini",
        "gpt-5-nano",
        "gpt-5-pro",
        "gpt-4.1",
        "gpt-4.1-mini",
        "gpt-4.1-nano",
        "gpt-5.1-codex-mini",
        "codex-mini-latest"
      ];
    case "anthropic":
      return [
        "claude-sonnet-4-5",
        "claude-opus-4-1",
        "claude-haiku-4-5"
      ];
    case "gemini":
      return [
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite"
      ];
    case "lmstudio":
    case "ollama":
      return localModels;
    default:
      return [];
  }
}

function getRuntimeProviderStatus(providerId) {
  const provider = state.bootstrap?.appSettings?.providers?.[providerId];

  if (!provider?.enabled) {
    return {
      label: "not configured",
      tone: "danger"
    };
  }

  if (!provider.baseUrl || !provider.model) {
    return {
      label: "not configured",
      tone: "danger"
    };
  }

  if (providerId === "lmstudio" || providerId === "ollama") {
    return {
      label: "configured",
      tone: "success"
    };
  }

  const apiKey = String(provider.apiKey || "").trim();
  const isLocalAlias =
    isLocalishUrl(provider.baseUrl) ||
    apiKey.toLowerCase() === "local" ||
    apiKey.toLowerCase() === "lm-studio";

  if (!apiKey) {
    return {
      label: "not configured",
      tone: "danger"
    };
  }

  if (isLocalAlias) {
    return {
      label: "local alias",
      tone: "warning"
    };
  }

  return {
    label: "configured",
    tone: "success"
  };
}

function providerBaseUrlPlaceholder(providerId) {
  switch (providerId) {
    case "openai":
      return "https://api.openai.com/v1";
    case "anthropic":
      return "https://api.anthropic.com";
    case "gemini":
      return "https://generativelanguage.googleapis.com";
    case "lmstudio":
      return "http://127.0.0.1:1234/v1";
    case "ollama":
      return "http://127.0.0.1:11434";
    default:
      return "";
  }
}

function isLocalishUrl(value) {
  const normalized = String(value || "").toLowerCase();
  return normalized.includes("127.0.0.1") || normalized.includes("localhost");
}

function providerBaseUrlHelp(providerId) {
  switch (providerId) {
    case "openai":
      return "For real OpenAI API use https://api.openai.com/v1. Keep localhost only if this alias targets LM Studio.";
    case "anthropic":
      return "Use the official Anthropic API base URL unless this alias intentionally points to a local compatible endpoint.";
    case "gemini":
      return "Use the official Gemini API base URL unless you route this through another compatible gateway.";
    case "lmstudio":
      return "LM Studio OpenAI-compatible local server. Typical value: http://127.0.0.1:1234/v1";
    case "ollama":
      return "Ollama local HTTP server. Typical value: http://127.0.0.1:11434";
    default:
      return "";
  }
}

function providerModelPlaceholder(providerId) {
  switch (providerId) {
    case "openai":
      return "gpt-5-mini";
    case "anthropic":
      return "claude-sonnet-4-5";
    case "gemini":
      return "gemini-2.5-flash";
    default:
      return "Model id";
  }
}

function providerModelHelp(providerId) {
  switch (providerId) {
    case "openai":
      return "Suggested OpenAI ids are listed here. For judge usage start with gpt-5-mini or gpt-4.1-mini.";
    case "anthropic":
      return "Suggested Claude ids are listed here. Pick one and keep the official base URL if you use Anthropic directly.";
    case "gemini":
      return "Suggested Gemini ids are listed here. Pick one and add your Gemini API key.";
    case "lmstudio":
    case "ollama":
      return "Local models come from your current runtime catalog.";
    default:
      return "";
  }
}

function getSelectableSessionModels(providerId, ...selected) {
  const providerModel = providerId ? state.bootstrap?.appSettings?.providers?.[providerId]?.model : undefined;
  const models =
    providerId === "lmstudio" || providerId === "ollama"
      ? [...getLoadedModelOptions(), ...selected]
      : [
          providerModel,
          ...Object.values(state.bootstrap?.appSettings?.providers ?? {}).map((provider) => provider.model),
          ...selected
        ];

  return [...new Set(models.filter(Boolean))].sort();
}

function getProviderConfiguredModel(providerId) {
  return state.bootstrap?.appSettings?.providers?.[providerId]?.model || "";
}

function renderChip(kind, value, active) {
  return `
    <button type="button" class="chip-button ${active ? "active" : ""}" data-chip-kind="${kind}" data-chip-value="${escapeAttr(value)}">
      ${escapeHtml(value)}
    </button>
  `;
}

function renderChipGroup(label, chips) {
  return `
    <div class="chip-group">
      <div class="chip-group__list">
        ${chips.map(([kind, value, active]) => renderChip(kind, value, active)).join("")}
      </div>
    </div>
  `;
}

function renderDatalistOptions(values) {
  return values.map((value) => `<option value="${escapeAttr(value)}"></option>`).join("");
}

function formatProviderTestResult(result) {
  const message = String(result?.message || "");

  if (/status 429/i.test(message)) {
    return "Issue: rate limit or quota exceeded.";
  }

  if (/status 401/i.test(message)) {
    return "Issue: invalid API key or unauthorized request.";
  }

  if (/status 403/i.test(message)) {
    return "Issue: access denied for this provider or model.";
  }

  if (/status 404/i.test(message)) {
    return "Issue: base URL or model id is incorrect.";
  }

  if (/timed out/i.test(message)) {
    return "Issue: provider request timed out.";
  }

  return `${result?.ok ? "OK" : "Issue"}: ${message}`;
}

function getActiveDraft() {
  if (!state.activeSessionId) {
    return "";
  }

  return state.drafts[state.activeSessionId] ?? "";
}

function scrollChatToBottom(behavior = "auto") {
  const stream = document.querySelector(".message-stream");
  if (!stream) {
    return;
  }

  stream.scrollTo({
    top: stream.scrollHeight,
    behavior
  });
}

function renderSessionModelControl(name, providerId, value, options, datalistId) {
  if (providerId === "local") {
    return `<input name="${escapeAttr(name)}" value="" placeholder="local judge" disabled />`;
  }

  const resolvedValue = value || getProviderConfiguredModel(providerId) || "";

  if (isLocalProvider(providerId)) {
    return `
      <select name="${escapeAttr(name)}">
        ${renderModelSelectOptions(options, resolvedValue, "Select model")}
      </select>
    `;
  }

  return `
    <input
      name="${escapeAttr(name)}"
      list="${escapeAttr(datalistId)}"
      value="${escapeAttr(resolvedValue)}"
      placeholder="${escapeAttr(providerModelPlaceholder(providerId))}"
    />
    <datalist id="${escapeAttr(datalistId)}">${renderDatalistOptions(options)}</datalist>
  `;
}

function sessionModelLabel(name) {
  switch (name) {
    case "defaultModel":
      return "Default model";
    case "supportModel":
      return "Support model";
    case "attackModel":
      return "Attack model";
    case "judgeModel":
      return "Judge model";
    default:
      return "Model";
  }
}

async function deleteSessionById(sessionId) {
  if (!sessionId) {
    return;
  }

  await runAction(async () => {
    const deletingActive = sessionId === state.activeSessionId;
    await api.deleteSession(sessionId);
    delete state.drafts[sessionId];
    await refreshBootstrap();

    if (!state.bootstrap.sessions?.length) {
      const session = await api.createSession("New task");
      await refreshBootstrap();
      state.activeSessionId = session.id;
      await loadActiveSession();
    } else if (
      deletingActive ||
      !state.bootstrap.sessions.some((session) => session.id === state.activeSessionId)
    ) {
      state.activeSessionId = state.bootstrap.sessions[0].id;
      await loadActiveSession();
    }

    state.notice = "";
  });
}

function buildNextSessionSettings(current, kind, value) {
  if (kind === "mode") {
    return {
      ...current,
      mode: value
    };
  }

  if (kind === "language") {
    return {
      ...current,
      language: value
    };
  }

  if (kind === "debate") {
    return {
      ...current,
      debate: {
        ...current.debate,
        enabled: value === "debate:on"
      }
    };
  }

  return current;
}

function sessionSettingsToPatch(settings) {
  return {
    mode: settings.mode,
    language: settings.language,
    defaultTarget: { ...settings.defaultTarget },
    debate: {
      enabled: settings.debate.enabled,
      profile: settings.debate.profile,
      support: { ...settings.debate.support },
      attack: { ...settings.debate.attack },
      judge: { ...settings.debate.judge }
    }
  };
}

function bindSessionSetupFieldSync() {
  const form = document.querySelector("#session-settings-form");
  if (!form) {
    return;
  }

  const mappings = [
    ["defaultProvider", "defaultModel", "default-model-options"],
    ["supportProvider", "supportModel", "support-model-options"],
    ["attackProvider", "attackModel", "attack-model-options"],
    ["judgeProvider", "judgeModel", "judge-model-options"]
  ];

  const syncField = (providerFieldName, modelFieldName, datalistId) => {
    const providerField = form.querySelector(`[name="${providerFieldName}"]`);

    if (!providerField) {
      return;
    }

    const providerId = providerField.value;
    const currentValue = form.querySelector(`[name="${modelFieldName}"]`)?.value ?? "";
    const options = getSelectableSessionModels(providerId, currentValue);
    const field = form.querySelector(`.field [name="${modelFieldName}"]`)?.closest(".field");

    if (!field) {
      return;
    }

    field.innerHTML = `
      <label>${escapeHtml(sessionModelLabel(modelFieldName))}</label>
      ${renderSessionModelControl(modelFieldName, providerId, isCloudProvider(providerId) && isLocalCatalogModel(currentValue) ? "" : currentValue, options, datalistId)}
    `;
  };

  mappings.forEach(([providerFieldName, modelFieldName, datalistId]) => {
    const providerField = form.querySelector(`[name="${providerFieldName}"]`);
    if (!providerField) {
      return;
    }

    syncField(providerFieldName, modelFieldName, datalistId);
    providerField.addEventListener("change", () => syncField(providerFieldName, modelFieldName, datalistId));
  });
}

function isCloudProvider(providerId) {
  return ["openai", "anthropic", "gemini"].includes(providerId);
}

function isLocalProvider(providerId) {
  return ["lmstudio", "ollama"].includes(providerId);
}

function isLocalCatalogModel(modelId) {
  return getModelOptions().includes(modelId);
}

function option(value, currentValue, label = value) {
  return `<option value="${escapeAttr(value)}" ${value === currentValue ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

function renderModelSelectOptions(values, selectedValue, placeholder) {
  const options = [...new Set(values.filter(Boolean))];
  return [
    `<option value="">${escapeHtml(placeholder)}</option>`,
    ...options.map((value) => option(value, selectedValue, value))
  ].join("");
}

function formatDate(value) {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function renderMessageMeta(message) {
  const parts = [formatDate(message.createdAt)];

  if (message.metrics?.durationMs) {
    parts.unshift(`${(message.metrics.durationMs / 1000).toFixed(1)}s`);
  }

  if (message.metrics?.usage?.totalTokens) {
    parts.unshift(`${message.metrics.usage.totalTokens} tok`);
  }

  if (message.pending) {
    parts.unshift("loading");
  }

  return parts.join(" · ");
}

function renderMessageFooterMeta(message) {
  const parts = [];

  if (message.metrics?.durationMs) {
    parts.push(`${(message.metrics.durationMs / 1000).toFixed(1)}s`);
  }

  if (message.metrics?.usage?.totalTokens) {
    parts.push(`${message.metrics.usage.totalTokens} tok`);
  }

  if (message.pending) {
    parts.push("loading");
  }

  return parts.join(" · ");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
