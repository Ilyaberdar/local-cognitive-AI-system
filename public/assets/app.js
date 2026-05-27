const app = document.querySelector("#app");
let systemMetricsPollTimer = null;
const DEFAULT_SUBAGENT_NAMES = ["Atlas", "Nova", "Vector", "Echo", "Orion", "Lyra", "Kepler", "Sable", "Rook", "Mira"];
const MAX_HYPOTHESIS_ADVISORS = 5;
const MAX_HYPOTHESIS_AGENTS = 3 + MAX_HYPOTHESIS_ADVISORS;
const SUBAGENT_PENDING_MESSAGES = [
  "Routing a focused pass to {agents}...",
  "Spinning up {agents} with the current context...",
  "Asking {agents} for a second look...",
  "Launching {agents} into the task...",
  "Handing this pass to {agents}..."
];

const state = {
  route: "chat",
  loading: false,
  chatSubmitting: false,
  notice: "",
  error: "",
  toasts: [],
  bootstrap: null,
  activeSessionId: null,
  sessionSettings: null,
  messages: [],
  drafts: {},
  draftAttachments: {},
  pendingRequest: null,
  modelActions: {},
  pluginTestResults: {},
  providerTestResults: {},
  savedButtons: {},
  ui: {
    sidebarCollapsed: localStorage.getItem("lcai.sidebarCollapsed") === "true",
    sidebarWidth: Number(localStorage.getItem("lcai.sidebarWidth") || 240),
    sessionSetupCollapsed: localStorage.getItem("lcai.sessionSetupCollapsed") === "true",
    sessionSetupWidth: Number(localStorage.getItem("lcai.sessionSetupWidth") || 360),
    autosaveStatus: "idle",
    autosaveTimer: null,
    autosaveSeq: 0,
    messageStreamScrollTop: 0,
    messageStreamPinnedToBottom: true,
    showScrollToBottom: false
  }
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
      timeoutMs: 900000
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
  },
  getSystemMetrics: () => request("/system/metrics")
};

init().catch((error) => {
  pushToast(error instanceof Error ? error.message : "Failed to initialize UI", "danger");
  render();
});

window.addEventListener("hashchange", () => {
  if (state.route === "chat") {
    rememberMessageStreamScroll();
  }
  syncRouteFromHash();
  render();
  syncSystemMetricsPolling();
});

async function init() {
  syncRouteFromHash();
  await refreshBootstrap();
  await ensureSession();
  render();
  syncSystemMetricsPolling();
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
    <div class="shell ${state.ui.sidebarCollapsed ? "shell--sidebar-collapsed" : ""}" style="--sidebar-width: ${Math.max(180, Math.min(window.innerWidth * 0.5, state.ui.sidebarWidth || 240))}px;">
      ${renderSidebar()}
      <main class="main">
        <div class="content-shell">
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
        ${renderToasts()}
      </main>
    </div>
  `;

  bindEvents();
  if (state.route === "chat") {
    restoreStoredMessageStreamScroll();
  }
}

function getSaveButtonLabel(key, fallback) {
  return state.savedButtons[key] ? "Saved" : fallback;
}

function flashSavedButton(key) {
  state.savedButtons[key] = true;
  render();
  window.setTimeout(() => {
    state.savedButtons[key] = false;
    render();
  }, 1000);
}

function renderSidebar() {
  const sessions = state.bootstrap?.sessions ?? [];
  const providerCount = state.bootstrap?.providers?.length ?? 0;
  const pluginCount = state.bootstrap?.plugins?.length ?? 0;

  return `
    <aside class="sidebar">
      <button class="sidebar-toggle" type="button" data-action="toggle-sidebar" title="${state.ui.sidebarCollapsed ? "Show navigation" : "Hide navigation"}">${state.ui.sidebarCollapsed ? "›" : "‹"}</button>
      <div class="sidebar-resize-handle" data-action="resize-sidebar" title="Resize navigation"></div>
      <nav class="nav">
        ${renderNavButton("chat", "Chat Workspace")}
        ${renderNavButton("models", "Models")}
        ${renderNavButton("plugins", "Plugins")}
        ${renderNavButton("settings", "Settings")}
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

function captureScrollState() {
  const activeRoute = document.querySelector(".route.active");
  const messageStream = document.querySelector(".message-stream");
  const chatSettings = document.querySelector(".chat-settings");
  const sidebar = document.querySelector(".sidebar");

  return {
    activeRouteScrollTop: activeRoute?.scrollTop ?? 0,
    messageStreamScrollTop: messageStream?.scrollTop ?? 0,
    messageStreamPinnedToBottom: messageStream ? isMessageStreamNearBottom(messageStream) : state.ui.messageStreamPinnedToBottom,
    chatSettingsScrollTop: chatSettings?.scrollTop ?? 0,
    sidebarScrollTop: sidebar?.scrollTop ?? 0
  };
}

function restoreScrollState(snapshot) {
  if (!snapshot) {
    return;
  }

  window.requestAnimationFrame(() => {
    const activeRoute = document.querySelector(".route.active");
    const messageStream = document.querySelector(".message-stream");
    const chatSettings = document.querySelector(".chat-settings");
    const sidebar = document.querySelector(".sidebar");

    if (activeRoute && typeof snapshot.activeRouteScrollTop === "number") {
      activeRoute.scrollTop = snapshot.activeRouteScrollTop;
    }

    if (messageStream && typeof snapshot.messageStreamScrollTop === "number") {
      if (snapshot.messageStreamPinnedToBottom) {
        messageStream.scrollTop = messageStream.scrollHeight;
      } else {
        messageStream.scrollTop = snapshot.messageStreamScrollTop;
      }
      rememberMessageStreamScroll();
      syncScrollToBottomButton();
    }

    if (chatSettings && typeof snapshot.chatSettingsScrollTop === "number") {
      chatSettings.scrollTop = snapshot.chatSettingsScrollTop;
    }

    if (sidebar && typeof snapshot.sidebarScrollTop === "number") {
      sidebar.scrollTop = snapshot.sidebarScrollTop;
    }
  });
}

function renderToasts() {
  if (!state.toasts.length) {
    return "";
  }

  return `
    <div class="toast-stack">
      ${state.toasts
        .map(
          (toast) => `
            <aside class="toast toast--${escapeAttr(toast.tone)}" data-toast-id="${escapeAttr(toast.id)}">
              <div class="toast__body">
                <div class="toast__label">${toast.tone === "danger" ? "Error" : "Notice"}</div>
                <div class="toast__message">${escapeHtml(toast.message)}</div>
              </div>
              <div class="toast__actions">
                <button class="toast__button" type="button" data-action="copy-toast" data-toast-id="${escapeAttr(toast.id)}">Copy</button>
                <button class="toast__button" type="button" data-action="dismiss-toast" data-toast-id="${escapeAttr(toast.id)}">Close</button>
              </div>
            </aside>
          `
        )
        .join("")}
    </div>
  `;
}

function renderNavButton(route, label) {
  return `
    <button class="nav-button ${state.route === route ? "active" : ""}" data-action="route" data-route="${route}">
      <span class="nav-label"><span class="nav-icon" aria-hidden="true">${renderNavIcon(route)}</span><span>${label}</span></span>
    </button>
  `;
}

function renderNavIcon(route) {
  const paths = {
    chat: `
      <rect x="4" y="5" width="16" height="14" rx="1.5"></rect>
      <path d="M8 9h8M8 13h5"></path>
    `,
    models: `
      <circle cx="8" cy="8" r="3"></circle>
      <circle cx="16" cy="8" r="3"></circle>
      <circle cx="12" cy="16" r="3"></circle>
    `,
    plugins: `
      <path d="M12 4l6 6-6 10-6-10 6-6z"></path>
      <path d="M9 10h6"></path>
    `,
    settings: `
      <path d="M5 7h14M5 12h14M5 17h14"></path>
      <circle cx="9" cy="7" r="1.8"></circle>
      <circle cx="15" cy="12" r="1.8"></circle>
      <circle cx="11" cy="17" r="1.8"></circle>
    `
  };

  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round">
      ${paths[route] ?? paths.chat}
    </svg>
  `;
}

function renderChatRoute() {
  if (!state.activeSessionId || !state.sessionSettings) {
    return `<div class="empty">Loading chat workspace...</div>`;
  }

  const settings = state.sessionSettings;
  const currentSession = (state.bootstrap?.sessions ?? []).find((session) => session.id === state.activeSessionId);
  const providerOptions = getProviderOptions();
	  const messages = [
	    ...state.messages,
	    ...(state.pendingRequest
	      ? [
	          {
	            id: "pending:user",
	            role: "user",
	            content: state.pendingRequest.input,
	            createdAt: state.pendingRequest.startedAt,
	            pending: true
	          },
	          {
	            id: "pending:assistant",
	            role: "assistant",
            content: renderPendingAssistantText(state.pendingRequest),
            createdAt: state.pendingRequest.startedAt,
	            pending: true,
	            pendingKind: isSubagentRequest(state.pendingRequest.input) ? "subagent" : "default"
	          }
        ]
      : [])
  ];
  const draftAttachments = getActiveDraftAttachments();

  return `
    <div class="chat-layout" style="--session-panel-width: ${Math.max(280, Math.min(window.innerWidth * 0.5, state.ui.sessionSetupWidth || 360))}px;">
      <section class="chat-shell">
        <div class="message-stream">
          ${
            messages.length
              ? messages.map(renderMessage).join("")
              : `<div class="empty">Start the first conversation in this session.</div>`
          }
        </div>
        <button
          class="scroll-bottom-button ${state.ui.showScrollToBottom ? "visible" : ""}"
          type="button"
          data-action="scroll-chat-bottom"
          title="Scroll to latest message"
          aria-label="Scroll to latest message"
        >↓</button>

        <form class="composer" id="chat-form">
          <input id="chat-attachment-input" type="file" multiple class="sr-only" accept="image/*,.txt,.md,.markdown,.json,.csv,.ts,.tsx,.js,.jsx,.py,.html,.css,.yml,.yaml,.xml,.toml,.sh,.log,.pdf,.doc,.docx" />
          ${
            draftAttachments.length
              ? `<div class="composer-attachments">${draftAttachments.map(renderDraftAttachment).join("")}</div>`
              : ""
          }
          <textarea name="input" placeholder="Type a command, ask a question, or run a hypothesis debate...">${escapeHtml(getActiveDraft())}</textarea>
          <div class="mention-menu" data-mention-menu hidden></div>
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
            <div class="composer-actions">
              <button class="ghost-button" type="button" data-action="attach-files">Attach</button>
              <button class="primary-button" type="submit">${state.chatSubmitting ? "Generating..." : "Send"}</button>
            </div>
          </div>
        </form>
      </section>

      ${renderSessionSetupPanel(settings, currentSession, providerOptions)}
    </div>
  `;
}

function isSubagentRequest(input) {
  return /spawn\s+sub-?agent|sub-?agent|заспавн.*с[ау]б.?агент|с[ау]б.?агент|@[\p{L}\p{N}_-]+/iu.test(input);
}

function renderPendingAssistantText(pendingRequest) {
  const input = typeof pendingRequest === "string" ? pendingRequest : pendingRequest.input;

  if (isSubagentRequest(input)) {
    return pendingRequest.pendingText || chooseSubagentPendingText(input, pendingRequest.startedAt);
  }

  return "Generating response...";
}

function chooseSubagentPendingText(input, seed = new Date().toISOString()) {
  const agents = resolvePendingSubagentNames(input);
  const agentLabel = agents.length ? agents.map((name) => `@${name}`).join(", ") : "a subagent";
  const index = stableMessageIndex(`${seed}:${input}`, SUBAGENT_PENDING_MESSAGES.length);
  return SUBAGENT_PENDING_MESSAGES[index].replace("{agents}", agentLabel);
}

function stableMessageIndex(value, modulo) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return modulo > 0 ? hash % modulo : 0;
}

function resolvePendingSubagentNames(input) {
  const agents = state.sessionSettings?.codeAgents ?? [];
  const mentions = Array.from(input.matchAll(/@([\p{L}\p{N}_-]+)/gu)).map((match) => match[1].toLowerCase());

  if (mentions.length > 0) {
    return agents.filter((agent) => mentions.includes(agent.name.toLowerCase())).map((agent) => agent.name);
  }

  if (agents.length === 0) {
    return ["Default"];
  }

  return [agents.slice().sort((left, right) => estimateAgentCost(left) - estimateAgentCost(right))[0].name];
}

function estimateAgentCost(agent) {
  const providerScore = ["lmstudio", "ollama"].includes(agent.providerId)
    ? 0
    : agent.providerId === "gemini"
      ? 20
      : agent.providerId === "openai"
        ? 30
        : agent.providerId === "anthropic"
          ? 40
          : 50;
  const model = String(agent.model || "").toLowerCase();
  const modelScore = /nano|mini|flash|haiku|small|lite|3b|4b|7b|8b/.test(model)
    ? -5
    : /opus|large|70b|120b/.test(model)
      ? 15
      : /pro|sonnet|medium|14b|20b|32b/.test(model)
        ? 5
        : 0;

  return providerScore + modelScore;
}

function renderSessionSetupPanel(settings, currentSession, providerOptions) {
  const setupMode = getEffectiveSetupMode(settings);
  const defaultModelOptions = getSelectableSessionModels(settings.defaultTarget.providerId, settings.defaultTarget.model);
  const collapsed = state.ui.sessionSetupCollapsed;

  return `
    <form
      class="panel chat-settings form-grid ${collapsed ? "chat-settings--collapsed" : ""}"
      id="session-settings-form"
      style="--session-panel-width: ${Math.max(280, Math.min(window.innerWidth * 0.5, state.ui.sessionSetupWidth || 360))}px;"
    >
      <div class="session-resize-handle" data-action="resize-session-setup" title="Resize setup"></div>
      <div class="chat-settings__header">
        <button class="ghost-button setup-toggle" type="button" data-action="toggle-session-setup" title="${collapsed ? "Show setup" : "Hide setup"}">${collapsed ? "‹" : "›"}</button>
        <div class="chat-settings__title">
          <h3>Session Setup</h3>
          <div class="subtle" data-autosave-status>${escapeHtml(autosaveStatusLabel(state.ui.autosaveStatus))}</div>
        </div>
      </div>

      <div class="chat-settings__body">
        <div class="chat-type-bar">
          ${["general", "code", "hypothesis"].map((mode) => `
            <button
              class="chat-type-button ${setupMode === mode ? "active" : ""}"
              type="button"
              data-action="set-chat-type"
              data-chat-type="${mode}"
            >${escapeHtml(mode)}</button>
          `).join("")}
        </div>

        <div class="chat-settings__grid compact">
          <div class="field">
            <label>Title</label>
            <input name="sessionTitle" value="${escapeAttr(currentSession?.title ?? "")}" />
          </div>
          <div class="field">
            <label>Language</label>
            <select name="language">${["auto", "ru", "en"].map((value) => option(value, settings.language)).join("")}</select>
          </div>
          <div class="field">
            <label>Output</label>
            <select name="outputStyle">${["compact", "balanced", "detailed", "exhaustive"].map((value) => option(value, settings.outputStyle)).join("")}</select>
          </div>
          <input type="hidden" name="mode" value="${escapeAttr(setupMode === "general" ? "general" : setupMode)}" />
          <input type="hidden" name="debateEnabled" value="${setupMode === "hypothesis" ? "on" : "off"}" />
        </div>

        <section class="setup-section">
          <div class="section-label">Main model</div>
          <div class="chat-settings__grid compact">
            <div class="field">
              <label>Provider</label>
              <select name="defaultProvider">${providerOptions.map((item) => option(item.id, settings.defaultTarget.providerId, item.name)).join("")}</select>
            </div>
	            <div class="field">
	              <label>Model</label>
	              ${renderSessionModelControl("defaultModel", settings.defaultTarget.providerId, settings.defaultTarget.model ?? "", defaultModelOptions, "default-model-options")}
	            </div>
	            <div class="field">
	              <label>Access</label>
	              <select name="defaultAccess">${["default", "full"].map((value) => option(value, settings.defaultAccessMode ?? "default")).join("")}</select>
	            </div>
	          </div>
	        </section>

        ${setupMode === "hypothesis"
          ? renderHypothesisSetup(settings, providerOptions)
          : renderSubagentSetup(settings, providerOptions)}
      </div>
    </form>
  `;
}

function getEffectiveSetupMode(settings) {
  if (settings.debate?.enabled || settings.mode === "hypothesis") {
    return "hypothesis";
  }

  if (settings.mode === "code") {
    return "code";
  }

  return "general";
}

function renderSubagentSetup(settings, providerOptions) {
  const subagents = settings.codeAgents ?? [];

  return `
    <section class="setup-section">
      <div class="row-between">
        <div>
          <div class="section-label">Subagents</div>
          <div class="subtle">Use @name in chat or ask to spawn a subagent. Max 4 active.</div>
        </div>
        <button class="ghost-button" type="button" data-action="add-code-agent" ${subagents.length >= 4 ? "disabled" : ""}>+</button>
      </div>
      <div class="code-agents">
        ${subagents.length ? subagents.map((agent, index) => renderCodeAgentCard(agent, index, providerOptions)).join("") : `<div class="empty compact-empty">No configured subagents. Spawn uses the main model.</div>`}
      </div>
    </section>
  `;
}

function renderHypothesisSetup(settings, providerOptions) {
  const agents = normalizeHypothesisAgentsForUi(settings);
  const judgeOptions = [...providerOptions, { id: "local", name: "local" }];

  return `
    <section class="setup-section">
      <div class="chat-settings__grid compact">
        <div class="field">
          <label>Profile</label>
          <select name="debateProfile">${["general", "technical", "product", "research", "security"].map((value) => option(value, settings.debate.profile)).join("")}</select>
        </div>
      </div>
      <div class="row-between">
        <div>
          <div class="section-label">Hypothesis models</div>
          <div class="subtle">Support, attack, and judge are used now. Add up to 5 advisors for expanded debate flow.</div>
        </div>
        <button class="ghost-button" type="button" data-action="add-hypothesis-agent" ${agents.length >= MAX_HYPOTHESIS_AGENTS ? "disabled" : ""}>+</button>
      </div>
      <div class="code-agents hypothesis-agents">
        ${agents.map((agent, index) => renderHypothesisAgentCard(agent, index, agent.role === "judge" ? judgeOptions : providerOptions)).join("")}
      </div>
    </section>
  `;
}

function normalizeHypothesisAgentsForUi(settings) {
  const configured = settings.hypothesisAgents?.length ? settings.hypothesisAgents : [];
  const fallback = [
    { id: "hypothesis-support", name: "Support", role: "support", ...settings.debate.support },
    { id: "hypothesis-attack", name: "Attack", role: "attack", ...settings.debate.attack },
    { id: "hypothesis-judge", name: "Judge", role: "judge", ...settings.debate.judge }
  ];
  const merged = configured.length ? configured : fallback;
  const byRole = new Map(merged.map((agent) => [agent.role, agent]));

  return [
    byRole.get("support") ?? fallback[0],
    byRole.get("attack") ?? fallback[1],
    byRole.get("judge") ?? fallback[2],
    ...merged.filter((agent) => agent.role === "advisor").slice(0, MAX_HYPOTHESIS_ADVISORS)
  ];
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
  const systemMetrics = state.bootstrap?.systemMetrics;

  return `
    <div class="grid">
      <section class="panel runtime-summary">
        <div class="row-between">
          <div>
            <h2>Runtime Providers</h2>
            <div class="subtle">Read-only snapshot of provider aliases, defaults, and endpoints.</div>
          </div>
          ${renderSystemMetricsPanel(systemMetrics, loaded)}
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
                ${renderRuntimeProviderQuota(provider.id, status.label)}
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
                  <div class="subtle">${formatManagedModelSize(model.sizeBytes)}</div>
                  <div class="footer-row">
                    <span class="subtle">${model.loaded ? "Ready for chat and debate." : "Can be loaded into LM Studio."}</span>
                    ${
                      model.loaded
                        ? renderModelActionButton("unload", model.loadedInstanceIds[0] || model.id)
                        : renderModelActionButton("load", model.id)
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

function renderModelActionButton(action, modelId) {
  const stateKey = `${action}:${modelId}`;
  const pending = Boolean(state.modelActions[stateKey]);

  if (action === "unload") {
    return `
      <button class="ghost-button danger-button" data-action="unload-model" data-model-id="${escapeAttr(modelId)}" ${pending ? "disabled" : ""}>
        ${pending ? `<span class="button-spinner"></span>Unloading...` : "Unload"}
      </button>
    `;
  }

  return `
    <button class="primary-button" data-action="load-model" data-model-id="${escapeAttr(modelId)}" ${pending ? "disabled" : ""}>
      ${pending ? `<span class="button-spinner"></span>Loading...` : "Load"}
    </button>
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
          <button class="primary-button" type="submit">${getSaveButtonLabel("plugin-settings", "Save plugin settings")}</button>
        </div>
      </section>

      <div class="plugin-grid">
        ${renderPluginCard("notion", pluginSettings.notion, statusByName.notion, [
          ["apiKey", "API key"],
          ["parentPageUrl", "Parent page URL"],
          ["dataSourceUrl", "Data source URL"],
          ["titleProperty", "Title property"],
          ["version", "Notion version"]
        ])}
        ${renderPluginCard("file", pluginSettings.file, statusByName.file, [
          ["outputDir", "Output directory"],
          ["accessMode", "Access mode"],
          ["allowedDirectories", "Allowed directories", true]
        ])}
        ${renderPluginCard("vscode", pluginSettings.vscode, statusByName.vscode, [
          ["workspaceRoot", "Workspace root"],
          ["accessMode", "Access mode"],
          ["allowedDirectories", "Allowed directories", true],
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
  const testTone = testResult ? (testResult.ok ? "success" : "danger") : "";
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
          ? `
            <div class="status-block ${testTone}">
              <div class="status-block__label">${testResult.ok ? "Test passed" : "Test failed"}</div>
              <div class="status-block__text">${escapeHtml(testResult.message)}</div>
            </div>
          `
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
            if (key === "accessMode") {
              return `
                <div class="field">
                  <label>${escapeHtml(label)}</label>
                  <select name="plugin.${name}.${key}">
                    ${["restricted", "full"]
                      .map((mode) => option(mode, String(value || "restricted"), mode))
                      .join("")}
                  </select>
                </div>
              `;
            }

            return multiline
              ? `
                <div class="field">
                  <label>${escapeHtml(label)}</label>
                  <textarea name="plugin.${name}.${key}" placeholder="${escapeAttr(pluginFieldPlaceholder(name, key))}">${escapeHtml(String(value))}</textarea>
                </div>
              `
              : `
                <div class="field">
                  <label>${escapeHtml(label)}</label>
                  <input name="plugin.${name}.${key}" value="${escapeAttr(String(value))}" placeholder="${escapeAttr(pluginFieldPlaceholder(name, key))}" />
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
            <button class="primary-button" type="submit">${getSaveButtonLabel("app-settings", "Save settings")}</button>
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
                    ${renderProviderSettingsModelControl(providerId, provider.model || "")}
                    <div class="subtle">${escapeHtml(providerModelHelp(providerId))}</div>
                  </div>
                  <div class="field">
                    <label>Timeout (ms)</label>
                    <input name="provider.${providerId}.timeoutMs" type="number" min="1000" step="1000" value="${escapeAttr(String(provider.timeoutMs ?? defaultProviderTimeoutMs(providerId)))}" />
                    <div class="subtle">${escapeHtml(providerTimeoutHelp(providerId))}</div>
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
                  <span class="subtle">Check auth, base URL, and model access before assigning this provider to a role.</span>
                  <button class="ghost-button" type="button" data-action="test-provider" data-provider-id="${escapeAttr(providerId)}">Test provider</button>
                </div>
                ${
                  state.providerTestResults[providerId]
                    ? `
                      <div class="status-block ${providerTestTone(state.providerTestResults[providerId])}">
                        <div class="status-block__label">${state.providerTestResults[providerId].ok ? "Provider ready" : "Provider issue"}</div>
                        <div class="status-block__text">${escapeHtml(formatProviderTestResult(state.providerTestResults[providerId]))}</div>
                      </div>
                    `
                    : ""
                }
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
    ? renderPendingMessageContent(message)
    : renderMessageContent(message);
  const attachments =
    message.attachments?.length
      ? `<div class="message-attachments">${message.attachments.map(renderMessageAttachment).join("")}</div>`
      : "";

  return `
    <article class="message ${message.role} ${message.pending ? "pending" : ""}">
      <div class="message-meta">
        <span>${escapeHtml(message.role)}</span>
        <span>${escapeHtml(message.role === "assistant" ? formatDate(message.createdAt) : "")}</span>
      </div>
      <div class="message-content">${content}</div>
      ${attachments}
      ${footer}
    </article>
  `;
}

function renderPendingMessageContent(message) {
  if (message.pendingKind === "subagent") {
    return `<div class="subagent-pending-line">${renderInlineMessageText(message.content || "Thinking")}</div>`;
  }

  return `<div class="thinking-indicator">${renderInlineMessageText(message.content || "Thinking")}</div>`;
}

function renderMessageContent(message) {
  if (message.role !== "assistant") {
    return renderInlineMessageText(message.content);
  }

  return renderAssistantMessageContent(message.content);
}

function renderAssistantMessageContent(rawContent) {
  const marker = "\nJudge Conclusion\n";
  const markerIndex = rawContent.indexOf(marker);

  if (markerIndex === -1) {
    return renderPlainMessageText(rawContent);
  }

  const before = rawContent.slice(0, markerIndex).replace(/\n+$/, "");
  const afterMarkerIndex = markerIndex + marker.length;
  const tail = rawContent.slice(afterMarkerIndex);
  const nextSectionMatch = tail.match(/\n\n(?=(Pro|Contra|Tools)\n)/);
  const conclusion = (
    nextSectionMatch ? tail.slice(0, nextSectionMatch.index) : tail
  ).trim();
  const after = (
    nextSectionMatch ? tail.slice(nextSectionMatch.index).replace(/^\n+/, "") : ""
  ).trim();

  return [
    before ? renderPlainMessageText(before) : "",
    conclusion
      ? `
        <section class="judge-conclusion">
          <div class="judge-conclusion__label">Judge Conclusion</div>
          <blockquote class="judge-conclusion__body">${escapeHtml(conclusion)}</blockquote>
        </section>
      `
      : "",
    after ? renderPlainMessageText(after) : ""
  ]
    .filter(Boolean)
    .join("");
}

function renderPlainMessageText(value) {
  const chunks = [];
  const plainLines = [];
  const flushPlainLines = () => {
    const text = plainLines.join("\n").replace(/^\n+|\n+$/g, "");
    plainLines.length = 0;
    if (text) {
      chunks.push(`<div class="message-text-block">${renderInlineMessageText(text)}</div>`);
    }
  };

  for (const line of value.split(/\r?\n/)) {
    const runtimeMatch = line.match(/^(Research agents|Research status|Final collector|Provider|Model):\s*(.+)$/i);
    if (runtimeMatch) {
      flushPlainLines();
      chunks.push(renderRuntimeMetaLine(runtimeMatch[1], runtimeMatch[2]));
      continue;
    }

    plainLines.push(normalizeFallbackResponseLine(line));
  }

  flushPlainLines();
  return chunks.join("");
}

function normalizeFallbackResponseLine(line) {
  if (!/^Mock response from /i.test(line.trim())) {
    return line;
  }

  const providerMatch = line.match(/^Mock response from ([^.]+)\./i);
  const modelMatch = line.match(/\bModel:\s*([^.]*)\./i);
  const provider = providerMatch?.[1] === "lmstudio" ? "LM Studio" : providerMatch?.[1] || "provider";
  const model = modelMatch?.[1] ? ` (${modelMatch[1]})` : "";

  return [
    `Provider request failed or timed out for ${provider}${model}.`,
    "Check that the provider is running, the selected model is loaded, and the timeout is high enough for this model."
  ].join("\n");
}

function renderInlineMessageText(value) {
  const knownAgents = getKnownAgentMentionNames();

  return String(value ?? "")
    .split(/(@[\p{L}\p{N}_-]+)/gu)
    .map((part) => {
      const mention = part.match(/^@([\p{L}\p{N}_-]+)$/u);
      if (!mention) {
        return escapeHtml(part);
      }

      if (!knownAgents.has(mention[1].toLowerCase())) {
        return escapeHtml(part);
      }

      const hue = stableMentionHue(mention[1]);
      return `<span class="agent-mention" style="--mention-hue: ${hue}">${escapeHtml(part)}</span>`;
    })
    .join("");
}

function getKnownAgentMentionNames() {
  return new Set((state.sessionSettings?.codeAgents ?? []).map((agent) => agent.name.toLowerCase()));
}

function stableMentionHue(name) {
  const hues = [188, 214, 258, 286, 324, 18, 42, 146, 166, 232];
  return hues[stableMessageIndex(String(name).toLowerCase(), hues.length)];
}

function renderRuntimeMetaLine(label, value) {
  return `
    <div class="message-runtime-line">
      <span>${escapeHtml(label)}</span>
      <strong class="runtime-gradient-text">${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderDraftAttachment(attachment) {
  return `
    <div class="draft-attachment">
      <div class="draft-attachment__copy">
        <strong>${escapeHtml(attachment.name)}</strong>
        <span>${escapeHtml(renderAttachmentMeta(attachment))}</span>
      </div>
      <button class="ghost-button draft-attachment__remove" type="button" data-action="remove-draft-attachment" data-attachment-id="${escapeAttr(attachment.id)}">×</button>
    </div>
  `;
}

function renderMessageAttachment(attachment) {
  return `
    <div class="message-attachment">
      ${
        attachment.kind === "image" && attachment.dataUrl
          ? `<img class="message-attachment__image" src="${escapeAttr(attachment.dataUrl)}" alt="${escapeAttr(attachment.name)}" />`
          : ""
      }
      <div class="message-attachment__copy">
        <strong>${escapeHtml(attachment.name)}</strong>
        <span>${escapeHtml(renderAttachmentMeta(attachment))}</span>
      </div>
    </div>
  `;
}

function renderAttachmentMeta(attachment) {
  const parts = [attachment.kind, `${Math.max(1, Math.round(attachment.sizeBytes / 1024))} KB`];

  if (attachment.mimeType) {
    parts.unshift(attachment.mimeType);
  }

  return parts.join(" · ");
}

function bindEvents() {
  document.querySelectorAll("[data-action='route']").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.route === "chat") {
        rememberMessageStreamScroll();
      }
      window.location.hash = `/${button.dataset.route}`;
    });
  });

  document.querySelector("[data-action='toggle-sidebar']")?.addEventListener("click", () => {
    state.ui.sidebarCollapsed = !state.ui.sidebarCollapsed;
    localStorage.setItem("lcai.sidebarCollapsed", String(state.ui.sidebarCollapsed));
    document.querySelector(".shell")?.classList.toggle("shell--sidebar-collapsed", state.ui.sidebarCollapsed);
    const button = document.querySelector("[data-action='toggle-sidebar']");
    if (button) {
      button.textContent = state.ui.sidebarCollapsed ? "›" : "‹";
      button.setAttribute("title", state.ui.sidebarCollapsed ? "Show navigation" : "Hide navigation");
    }
    window.setTimeout(syncScrollToBottomButton, 340);
  });

  bindResizeHandle("[data-action='resize-sidebar']", "sidebarWidth", "lcai.sidebarWidth", 180, Math.floor(window.innerWidth * 0.5), (event) => event.clientX);

  document.querySelector("[data-action='toggle-session-setup']")?.addEventListener("click", () => {
    state.ui.sessionSetupCollapsed = !state.ui.sessionSetupCollapsed;
    localStorage.setItem("lcai.sessionSetupCollapsed", String(state.ui.sessionSetupCollapsed));
    const panel = document.querySelector(".chat-settings");
    panel?.classList.toggle("chat-settings--collapsed", state.ui.sessionSetupCollapsed);
    const button = document.querySelector("[data-action='toggle-session-setup']");
    if (button) {
      button.textContent = state.ui.sessionSetupCollapsed ? "‹" : "›";
      button.setAttribute("title", state.ui.sessionSetupCollapsed ? "Show setup" : "Hide setup");
    }
    window.setTimeout(syncScrollToBottomButton, 340);
  });

  bindResizeHandle("[data-action='resize-session-setup']", "sessionSetupWidth", "lcai.sessionSetupWidth", 280, Math.floor(window.innerWidth * 0.5), (event) => window.innerWidth - event.clientX);

  document.querySelector(".message-stream")?.addEventListener("scroll", () => {
    rememberMessageStreamScroll();
    syncScrollToBottomButton();
  });

  document.querySelector("[data-action='scroll-chat-bottom']")?.addEventListener("click", () => {
    state.ui.messageStreamPinnedToBottom = true;
    scrollChatToBottom("auto");
  });

  document.querySelectorAll("[data-action='new-session']").forEach((button) => {
    button.addEventListener("click", async () => {
      await runAction(async () => {
        const snapshot = readSessionSetupSnapshot();
        const currentSettings = snapshot ? sessionSettingsToPatch(snapshot.settings) : null;
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
        await persistActiveSessionSetup({ refreshBootstrap: false });
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

  document.querySelectorAll("[data-action='add-code-agent']").forEach((button) => {
    button.addEventListener("click", () => {
      if (!state.sessionSettings) {
        return;
      }

      const snapshot = readSessionSetupSnapshot();
      const baseSettings = snapshot?.settings ?? state.sessionSettings;
      const nextIndex = (baseSettings.codeAgents?.length ?? 0) + 1;
      const agentName = chooseSubagentName(baseSettings.codeAgents ?? []);
      state.sessionSettings = {
        ...baseSettings,
        codeAgents: [
          ...(baseSettings.codeAgents ?? []),
          {
            id: `agent-${Date.now()}`,
            name: agentName || `Agent${nextIndex}`,
            providerId: baseSettings.defaultTarget.providerId,
            model: baseSettings.defaultTarget.model,
            accessMode: "default"
          }
        ].slice(0, 4)
      };
      render();
      scheduleSessionSetupAutosave();
    });
  });

  document.querySelectorAll("[data-action='delete-code-agent']").forEach((button) => {
    button.addEventListener("click", () => {
      if (!state.sessionSettings) {
        return;
      }

      const snapshot = readSessionSetupSnapshot();
      const baseSettings = snapshot?.settings ?? state.sessionSettings;
      const index = Number(button.dataset.codeAgentIndex);
      state.sessionSettings = {
        ...baseSettings,
        codeAgents: (baseSettings.codeAgents ?? []).filter((_, itemIndex) => itemIndex !== index)
      };
      render();
      scheduleSessionSetupAutosave();
    });
  });

  document.querySelectorAll("[data-action='add-hypothesis-agent']").forEach((button) => {
    button.addEventListener("click", () => {
      if (!state.sessionSettings) {
        return;
      }

      const snapshot = readSessionSetupSnapshot();
      const baseSettings = snapshot?.settings ?? state.sessionSettings;
      const agents = normalizeHypothesisAgentsForUi(baseSettings);
      const advisorCount = agents.filter((agent) => agent.role === "advisor").length;
      if (advisorCount >= MAX_HYPOTHESIS_ADVISORS) {
        return;
      }

      state.sessionSettings = {
        ...baseSettings,
        hypothesisAgents: [
          ...agents,
          {
            id: `hypothesis-${Date.now()}`,
            name: `Advisor${advisorCount + 1}`,
            role: "advisor",
            providerId: baseSettings.defaultTarget.providerId,
            model: baseSettings.defaultTarget.model
          }
        ].slice(0, MAX_HYPOTHESIS_AGENTS)
      };
      render();
      scheduleSessionSetupAutosave();
    });
  });

  document.querySelectorAll("[data-action='delete-hypothesis-agent']").forEach((button) => {
    button.addEventListener("click", () => {
      if (!state.sessionSettings) {
        return;
      }

      const snapshot = readSessionSetupSnapshot();
      const baseSettings = snapshot?.settings ?? state.sessionSettings;
      const index = Number(button.dataset.hypothesisAgentIndex);
      state.sessionSettings = {
        ...baseSettings,
        hypothesisAgents: normalizeHypothesisAgentsForUi(baseSettings).filter((_, itemIndex) => itemIndex !== index)
      };
      render();
      scheduleSessionSetupAutosave();
    });
  });

  document.querySelectorAll("[data-action='set-chat-type']").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!state.sessionSettings) {
        return;
      }

      const type = button.dataset.chatType;
      const snapshot = readSessionSetupSnapshot();
      const baseSettings = snapshot?.settings ?? state.sessionSettings;
      state.sessionSettings = {
        ...baseSettings,
        mode: type === "hypothesis" ? "hypothesis" : type === "code" ? "code" : "general",
        debate: {
          ...baseSettings.debate,
          enabled: type === "hypothesis"
        }
      };
      render();
      scheduleSessionSetupAutosave();
    });
  });

  document.querySelector("#chat-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const input = String(form.get("input") || "").trim();

    if (!input) {
      return;
    }

    try {
      const attachments = getActiveDraftAttachments();
      await persistActiveSessionSetup({ refreshBootstrap: false });
      state.route = "chat";
      window.location.hash = "/chat";
      state.pendingRequest = {
        input,
        startedAt: new Date().toISOString(),
        pendingText: isSubagentRequest(input) ? chooseSubagentPendingText(input) : undefined
      };
      state.chatSubmitting = true;
      if (state.activeSessionId) {
        state.drafts[state.activeSessionId] = "";
      }
      const wasNearBottom = state.ui.messageStreamPinnedToBottom || isMessageStreamNearBottom();
      render();
      if (wasNearBottom) {
        requestAnimationFrame(() => scrollChatToBottom("auto"));
      }

      const response = await api.sendChat({
        input,
        sessionId: state.activeSessionId,
        metadata: attachments.length
          ? {
              attachments
            }
          : undefined
      });
      state.activeSessionId = response.sessionId;
      if (state.activeSessionId) {
        state.draftAttachments[state.activeSessionId] = [];
      }
      await refreshBootstrap();
      await loadActiveSession();
    } catch (error) {
      pushToast(error instanceof Error ? error.message : "Action failed", "danger");
      state.pendingRequest = null;
    } finally {
      state.chatSubmitting = false;
      render();
      if (state.ui.messageStreamPinnedToBottom) {
        requestAnimationFrame(() => scrollChatToBottom("auto"));
      }
    }
  });

  document.querySelector("#chat-form textarea[name='input']")?.addEventListener("input", (event) => {
    if (!state.activeSessionId) {
      return;
    }

    state.drafts[state.activeSessionId] = event.currentTarget.value;
    updateMentionMenu(event.currentTarget);
  });

  document.querySelector("#chat-form textarea[name='input']")?.addEventListener("focus", (event) => {
    updateMentionMenu(event.currentTarget);
  });

  document.querySelector("[data-action='attach-files']")?.addEventListener("click", () => {
    document.querySelector("#chat-attachment-input")?.click();
  });

  document.querySelector("#chat-attachment-input")?.addEventListener("change", async (event) => {
    const files = [...(event.currentTarget.files ?? [])];

    if (!files.length || !state.activeSessionId) {
      return;
    }

    try {
      const attachments = await buildAttachments(files);
      state.draftAttachments[state.activeSessionId] = [
        ...getActiveDraftAttachments(),
        ...attachments
      ].slice(0, 5);
      render();
    } catch (error) {
      pushToast(error instanceof Error ? error.message : "Failed to read attachments", "danger");
    } finally {
      event.currentTarget.value = "";
    }
  });

  document.querySelectorAll("[data-action='remove-draft-attachment']").forEach((button) => {
    button.addEventListener("click", () => {
      if (!state.activeSessionId) {
        return;
      }

      state.draftAttachments[state.activeSessionId] = getActiveDraftAttachments().filter(
        (attachment) => attachment.id !== button.dataset.attachmentId
      );
      render();
    });
  });

  document.querySelector("#session-settings-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const snapshot = readSessionSetupSnapshot();
    if (!snapshot) {
      return;
    }

    await runAction(async () => {
      if (snapshot.title) {
        await api.renameSession(state.activeSessionId, snapshot.title);
      }
      state.sessionSettings = await api.updateSessionSettings(
        state.activeSessionId,
        sessionSettingsToPatch(snapshot.settings)
      );
      await refreshBootstrap();
      state.notice = "";
    });
    flashSavedButton("session-setup");
  });

  const sessionSettingsForm = document.querySelector("#session-settings-form");
  sessionSettingsForm?.addEventListener("input", (event) => {
    if (event.target?.matches?.("input, textarea")) {
      scheduleSessionSetupAutosave();
    }
  });
  sessionSettingsForm?.addEventListener("change", () => {
    scheduleSessionSetupAutosave();
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
    flashSavedButton("plugin-settings");
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
    flashSavedButton("app-settings");
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
      const modelId = button.dataset.modelId;

      if (!modelId) {
        return;
      }

      const key = `load:${modelId}`;
      const scrollSnapshot = captureScrollState();
      state.modelActions[key] = true;
      render();
      restoreScrollState(scrollSnapshot);

      try {
        await api.loadModel(modelId);
        const [managed, systemMetrics] = await Promise.all([api.refreshManagedModels(), api.getSystemMetrics()]);
        state.bootstrap.loadedModels = managed.loadedModels;
        state.bootstrap.allManagedModels = managed.allManagedModels;
        state.bootstrap.systemMetrics = systemMetrics;
        state.notice = "";
      } catch (error) {
        pushToast(error instanceof Error ? error.message : "Load failed", "danger");
      } finally {
        delete state.modelActions[key];
        render();
        restoreScrollState(scrollSnapshot);
      }
    });
  });

  document.querySelectorAll("[data-action='unload-model']").forEach((button) => {
    button.addEventListener("click", async () => {
      const modelId = button.dataset.modelId;

      if (!modelId) {
        return;
      }

      const key = `unload:${modelId}`;
      const scrollSnapshot = captureScrollState();
      state.modelActions[key] = true;
      render();
      restoreScrollState(scrollSnapshot);

      try {
        await api.unloadModel(modelId);
        const [managed, systemMetrics] = await Promise.all([api.refreshManagedModels(), api.getSystemMetrics()]);
        state.bootstrap.loadedModels = managed.loadedModels;
        state.bootstrap.allManagedModels = managed.allManagedModels;
        state.bootstrap.systemMetrics = systemMetrics;
        state.notice = "";
      } catch (error) {
        pushToast(error instanceof Error ? error.message : "Unload failed", "danger");
      } finally {
        delete state.modelActions[key];
        render();
        restoreScrollState(scrollSnapshot);
      }
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
        const snapshot = readSessionSetupSnapshot();
        if (snapshot?.title) {
          await api.renameSession(state.activeSessionId, snapshot.title);
        }
        const baseSettings = snapshot?.settings ?? state.sessionSettings;
        const nextSettings = buildNextSessionSettings(baseSettings, kind, value);
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
        pushToast(error instanceof Error ? error.message : "Copy failed", "danger");
        render();
      }
    });
  });

  document.querySelectorAll("[data-action='dismiss-toast']").forEach((button) => {
    button.addEventListener("click", () => {
      dismissToast(button.dataset.toastId);
    });
  });

  document.querySelectorAll("[data-action='copy-toast']").forEach((button) => {
    button.addEventListener("click", async () => {
      const toast = state.toasts.find((item) => item.id === button.dataset.toastId);

      if (!toast) {
        return;
      }

      try {
        await navigator.clipboard.writeText(toast.message);
        const original = button.textContent;
        button.textContent = "Copied";
        window.setTimeout(() => {
          button.textContent = original;
        }, 1000);
      } catch (error) {
        pushToast(error instanceof Error ? error.message : "Copy failed", "danger");
        render();
      }
    });
  });
}

function bindResizeHandle(selector, stateKey, storageKey, minWidth, maxWidth, readWidth) {
  const handle = document.querySelector(selector);

  if (!handle) {
    return;
  }

  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture?.(event.pointerId);

    const onMove = (moveEvent) => {
      const width = Math.max(minWidth, Math.min(maxWidth, Math.round(readWidth(moveEvent))));
      state.ui[stateKey] = width;
      localStorage.setItem(storageKey, String(width));
      document.querySelector(".shell")?.style.setProperty("--sidebar-width", `${state.ui.sidebarWidth}px`);
      document.querySelector(".chat-layout")?.style.setProperty("--session-panel-width", `${state.ui.sessionSetupWidth}px`);
      document.querySelector("#session-settings-form")?.style.setProperty("--session-panel-width", `${state.ui.sessionSetupWidth}px`);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

function scheduleSessionSetupAutosave() {
  if (!state.activeSessionId || !state.sessionSettings) {
    return;
  }

  window.clearTimeout(state.ui.autosaveTimer);
  setAutosaveStatus("saving");
  state.ui.autosaveTimer = window.setTimeout(async () => {
    const saveSeq = state.ui.autosaveSeq + 1;
    state.ui.autosaveSeq = saveSeq;

    try {
      await persistActiveSessionSetup({ refreshBootstrap: false });
      if (state.ui.autosaveSeq === saveSeq) {
        setAutosaveStatus("saved");
      }
    } catch (error) {
      pushToast(error instanceof Error ? error.message : "Autosave failed", "danger");
      setAutosaveStatus("error");
    }
  }, 650);
}

function autosaveStatusLabel(status) {
  if (status === "saving") {
    return "Saving...";
  }

  if (status === "saved") {
    return "Autosaved";
  }

  if (status === "error") {
    return "Autosave failed";
  }

  return "Autosave enabled";
}

function setAutosaveStatus(status) {
  state.ui.autosaveStatus = status;
  const statusElement = document.querySelector("[data-autosave-status]");
  if (statusElement) {
    statusElement.textContent = autosaveStatusLabel(status);
  }
}

function chooseSubagentName(existingAgents) {
  const used = new Set(existingAgents.map((agent) => agent.name));
  const candidates = DEFAULT_SUBAGENT_NAMES
    .filter((name) => !used.has(name))
    .sort(() => Math.random() - 0.5);

  return candidates[0];
}

function updateMentionMenu(textarea) {
  const menu = document.querySelector("[data-mention-menu]");
  const agents = state.sessionSettings?.codeAgents ?? [];

  if (!menu || agents.length === 0) {
    return;
  }

  const beforeCursor = textarea.value.slice(0, textarea.selectionStart ?? textarea.value.length);
  const match = beforeCursor.match(/@([\p{L}\p{N}_-]*)$/u);

  if (!match) {
    menu.hidden = true;
    menu.innerHTML = "";
    return;
  }

  const query = match[1].toLowerCase();
  const candidates = agents
    .filter((agent) => agent.name.toLowerCase().includes(query))
    .slice(0, 4);

  if (candidates.length === 0) {
    menu.hidden = true;
    menu.innerHTML = "";
    return;
  }

  menu.hidden = false;
  menu.innerHTML = candidates
    .map((agent) => `<button type="button" class="mention-item" data-mention-agent="${escapeAttr(agent.name)}">@${escapeHtml(agent.name)}</button>`)
    .join("");
  menu.querySelectorAll("[data-mention-agent]").forEach((button) => {
    button.addEventListener("click", () => {
      const insert = `@${button.dataset.mentionAgent} `;
      const cursor = textarea.selectionStart ?? textarea.value.length;
      const start = beforeCursor.length - match[0].length;
      textarea.value = `${textarea.value.slice(0, start)}${insert}${textarea.value.slice(cursor)}`;
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = start + insert.length;
      if (state.activeSessionId) {
        state.drafts[state.activeSessionId] = textarea.value;
      }
      menu.hidden = true;
    });
  });
}

async function refreshModelCollections() {
  await runAction(async () => {
    const [managed, systemMetrics] = await Promise.all([api.refreshManagedModels(), api.getSystemMetrics()]);
    state.bootstrap.loadedModels = managed.loadedModels;
    state.bootstrap.allManagedModels = managed.allManagedModels;
    state.bootstrap.systemMetrics = systemMetrics;
    pushToast("Model catalog refreshed.", "info");
  });
}

async function pollSystemMetrics() {
  if (state.route !== "models" || !state.bootstrap) {
    return;
  }

  try {
    const scrollSnapshot = captureScrollState();
    state.bootstrap.systemMetrics = await api.getSystemMetrics();
    render();
    restoreScrollState(scrollSnapshot);
  } catch {
    // keep the dashboard usable even if metrics polling fails
  }
}

function syncSystemMetricsPolling() {
  if (systemMetricsPollTimer) {
    window.clearInterval(systemMetricsPollTimer);
    systemMetricsPollTimer = null;
  }

  if (state.route !== "models") {
    return;
  }

  systemMetricsPollTimer = window.setInterval(() => {
    void pollSystemMetrics();
  }, 5000);
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
        timeoutMs: Number(form.get(`provider.${provider.id}.timeoutMs`) || defaultProviderTimeoutMs(provider.id))
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
  const scrollSnapshot = captureScrollState();
  state.loading = true;
  render();
  restoreScrollState(scrollSnapshot);

  try {
    await fn();
  } catch (error) {
    pushToast(error instanceof Error ? error.message : "Action failed", "danger");
  } finally {
    state.loading = false;
    render();
    restoreScrollState(scrollSnapshot);
  }
}

function pushToast(message, tone = "danger") {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  state.toasts = [
    ...state.toasts,
    {
      id,
      message,
      tone
    }
  ].slice(-5);
  window.setTimeout(() => {
    dismissToast(id, false);
  }, 5000);
}

function dismissToast(id, rerender = true) {
  if (!id) {
    return;
  }

  state.toasts = state.toasts.filter((toast) => toast.id !== id);
  if (rerender) {
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

function defaultProviderTimeoutMs(providerId) {
  return isLocalProvider(providerId) ? 300000 : 60000;
}

function providerTimeoutHelp(providerId) {
  return isLocalProvider(providerId)
    ? "Local multi-agent runs can need several minutes. 300000 ms is the recommended baseline."
    : "Remote providers usually work with 60000 ms, increase it for longer reasoning runs.";
}

function getSelectableSessionModels(providerId, ...selected) {
  const providerModel = providerId ? state.bootstrap?.appSettings?.providers?.[providerId]?.model : undefined;
  const normalizedSelected = selected.filter(Boolean);
  const models = isLocalProvider(providerId)
    ? [...getLoadedModelOptions(), ...normalizedSelected]
    : [
        !isLocalCatalogModel(providerModel) ? providerModel : undefined,
        ...getProviderSuggestedModels(providerId),
        ...normalizedSelected.filter((modelId) => !isLocalCatalogModel(modelId))
      ];

  return [...new Set(models.filter(Boolean))].sort();
}

function renderRuntimeProviderQuota(providerId, statusLabel) {
  const result = state.providerTestResults?.[providerId];

  if (result?.rateLimit && (result.rateLimit.remainingRequests || result.rateLimit.remainingTokens)) {
    return `
      <div class="subtle runtime-provider-quota">
        ${escapeHtml(formatRuntimeQuota(result.rateLimit))}
      </div>
    `;
  }

  if (["openai", "anthropic"].includes(providerId) && statusLabel !== "not configured") {
    return `<div class="subtle runtime-provider-quota">Run Test provider to fetch current rate-limit window.</div>`;
  }

  return "";
}

function formatRuntimeQuota(rateLimit) {
  const parts = [];

  if (rateLimit.remainingRequests) {
    parts.push(`requests left: ${rateLimit.remainingRequests}`);
  }

  if (rateLimit.remainingTokens) {
    parts.push(`tokens left: ${rateLimit.remainingTokens}`);
  }

  if (rateLimit.resetRequests) {
    parts.push(`req reset: ${rateLimit.resetRequests}`);
  }

  if (rateLimit.resetTokens) {
    parts.push(`tok reset: ${rateLimit.resetTokens}`);
  }

  return parts.join(" · ");
}

function renderSystemMetricsPanel(metrics, loadedModels = []) {
  if (!metrics) {
    return "";
  }

  const loadedModelBytes = loadedModels.reduce((sum, model) => sum + (Number(model.sizeBytes) || 0), 0);
  const estimatedModelPercent =
    metrics.memoryTotalBytes > 0 ? Math.max(0, Math.min(100, (loadedModelBytes / metrics.memoryTotalBytes) * 100)) : 0;

  return `
    <div class="system-metrics">
      ${renderMetricMini("CPU", metrics.cpuPercent, `${metrics.cpuPercent.toFixed(0)}%`)}
      ${renderMetricMini(
        "RAM",
        metrics.ramPercent,
        [
          `${metrics.ramPercent.toFixed(0)}% · ${formatBytes(metrics.memoryUsedBytes)} / ${formatBytes(metrics.memoryTotalBytes)}`,
          metrics.memoryCachedBytes ? `cached ${formatBytes(metrics.memoryCachedBytes)}` : ""
        ]
          .filter(Boolean)
          .join(" · ")
      )}
      ${renderMetricMini(
        "LM",
        estimatedModelPercent,
        loadedModelBytes ? `${formatBytes(loadedModelBytes)} est.` : "No loaded model memory"
      )}
    </div>
  `;
}

function renderMetricMini(label, percent, text) {
  const normalized = Math.max(0, Math.min(100, Number(percent) || 0));
  const tone = getMetricTone(normalized);
  return `
    <div class="metric-mini metric-mini--${tone}">
      <div class="metric-mini__head">
        <span>${escapeHtml(label)}</span>
        <span>${escapeHtml(text)}</span>
      </div>
      <div class="metric-mini__track">
        <span class="metric-mini__bar" style="width:${normalized}%"></span>
      </div>
    </div>
  `;
}

function getMetricTone(percent) {
  if (percent >= 85) {
    return "danger";
  }

  if (percent >= 60) {
    return "warning";
  }

  return "success";
}

function formatManagedModelSize(sizeBytes) {
  if (!sizeBytes || !Number.isFinite(sizeBytes)) {
    return "Size unavailable";
  }

  return `Size: ${formatBytes(sizeBytes)}`;
}

function formatBytes(value) {
  const bytes = Number(value || 0);

  if (!bytes || bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let current = bytes;
  let unitIndex = -1;

  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }

  return `${current.toFixed(current >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function getProviderConfiguredModel(providerId) {
  return state.bootstrap?.appSettings?.providers?.[providerId]?.model || "";
}

function getProviderSettingsModelOptions(providerId, currentValue = "") {
  return [...new Set([currentValue, ...getProviderSuggestedModels(providerId)].filter(Boolean))];
}

function renderProviderSettingsModelControl(providerId, value) {
  const options = getProviderSettingsModelOptions(providerId, value || getProviderConfiguredModel(providerId));
  const selectedValue = value || getProviderConfiguredModel(providerId) || "";

  return `
    <select name="provider.${escapeAttr(providerId)}.model">
      ${renderModelSelectOptions(options, selectedValue, "Select model")}
    </select>
  `;
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

function pluginFieldPlaceholder(pluginName, key) {
  if (pluginName === "notion" && key === "parentPageUrl") {
    return "https://www.notion.so/... paste page URL";
  }

  if (pluginName === "notion" && key === "dataSourceUrl") {
    return "https://www.notion.so/... paste data source URL";
  }

  return "";
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

function providerTestTone(result) {
  return result?.ok ? "success" : "danger";
}

function getActiveDraft() {
  if (!state.activeSessionId) {
    return "";
  }

  return state.drafts[state.activeSessionId] ?? "";
}

function getActiveDraftAttachments() {
  if (!state.activeSessionId) {
    return [];
  }

  return state.draftAttachments[state.activeSessionId] ?? [];
}

function isTextAttachment(file) {
  const textLikeExtensions = [
    ".txt",
    ".md",
    ".markdown",
    ".json",
    ".csv",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".html",
    ".css",
    ".xml",
    ".yaml",
    ".yml",
    ".toml",
    ".sh",
    ".log"
  ];
  const lowerName = file.name.toLowerCase();

  return file.type.startsWith("text/") || textLikeExtensions.some((ext) => lowerName.endsWith(ext));
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function buildAttachments(files) {
  const attachments = [];

  for (const file of files.slice(0, 5)) {
    if (file.size > 5 * 1024 * 1024) {
      pushToast(`${file.name} is larger than 5 MB and was skipped.`, "danger");
      continue;
    }

    const attachment = {
      id:
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      kind: file.type.startsWith("image/") ? "image" : isTextAttachment(file) ? "text" : "binary"
    };

    if (attachment.kind === "text") {
      attachment.textContent = (await file.text()).slice(0, 20000);
    }

    if (attachment.kind === "image" && file.size <= 350 * 1024) {
      attachment.dataUrl = await fileToDataUrl(file);
    }

    attachments.push(attachment);
  }

  return attachments;
}

function cloneSessionSettings(settings) {
  return JSON.parse(JSON.stringify(settings));
}

function getCurrentSessionSummary() {
  return (state.bootstrap?.sessions ?? []).find((session) => session.id === state.activeSessionId);
}

function readSessionSetupSnapshot() {
  if (!state.sessionSettings) {
    return null;
  }

  const fallbackSettings = cloneSessionSettings(state.sessionSettings);
  const fallbackTitle = getCurrentSessionSummary()?.title ?? "New task";
  const form = document.querySelector("#session-settings-form");

  if (!form) {
    return {
      title: fallbackTitle,
      settings: fallbackSettings
    };
  }

  const formData = new FormData(form);
  const resolveModelValue = (providerFieldName, modelFieldName, fallbackModel) => {
    const providerId = String(formData.get(providerFieldName) || "").trim();

    if (!providerId || providerId === "local") {
      return undefined;
    }

    return String(formData.get(modelFieldName) || "").trim() || fallbackModel || getProviderConfiguredModel(providerId) || undefined;
  };
  const codeAgentCards = [...form.querySelectorAll(".code-agent-card")];
  const codeAgents = codeAgentCards
    .filter((card) => card.matches("[data-code-agent-index]"))
    .map((card, index) => {
    const agentIndex = card.dataset.codeAgentIndex ?? String(index);
    const existingAgent = fallbackSettings.codeAgents?.[index];
    const providerId =
      String(formData.get(`codeAgentProvider:${agentIndex}`) || existingAgent?.providerId || fallbackSettings.defaultTarget.providerId).trim() ||
      fallbackSettings.defaultTarget.providerId;

    return {
      id: String(formData.get(`codeAgentId:${agentIndex}`) || existingAgent?.id || `agent-${index + 1}`).trim(),
      name: String(formData.get(`codeAgentName:${agentIndex}`) || existingAgent?.name || `Agent${index + 1}`).trim() || `Agent${index + 1}`,
      providerId,
      accessMode: String(formData.get(`codeAgentAccess:${agentIndex}`) || existingAgent?.accessMode || "default") === "full" ? "full" : "default",
      model:
        resolveModelValue(`codeAgentProvider:${agentIndex}`, `codeAgentModel:${agentIndex}`, existingAgent?.model) ||
        existingAgent?.model ||
        getProviderConfiguredModel(providerId)
    };
  }).slice(0, 4);
  const hypothesisAgentCards = [...form.querySelectorAll("[data-hypothesis-agent-index]")];
  const hypothesisAgents = hypothesisAgentCards.map((card, index) => {
    const agentIndex = card.dataset.hypothesisAgentIndex ?? String(index);
    const existingAgent = fallbackSettings.hypothesisAgents?.[index];
    const role = String(formData.get(`hypothesisAgentRole:${agentIndex}`) || existingAgent?.role || (index === 0 ? "support" : index === 1 ? "attack" : index === 2 ? "judge" : "advisor")).trim();
    const providerId =
      String(formData.get(`hypothesisAgentProvider:${agentIndex}`) || existingAgent?.providerId || fallbackSettings.defaultTarget.providerId).trim() ||
      fallbackSettings.defaultTarget.providerId;

    return {
      id: String(formData.get(`hypothesisAgentId:${agentIndex}`) || existingAgent?.id || `hypothesis-${index + 1}`).trim(),
      name: String(formData.get(`hypothesisAgentName:${agentIndex}`) || existingAgent?.name || (index === 0 ? "Support" : index === 1 ? "Attack" : index === 2 ? "Judge" : `Advisor${index - 2}`)).trim(),
      role: ["support", "attack", "judge", "advisor"].includes(role) ? role : "advisor",
      providerId,
      model:
        resolveModelValue(`hypothesisAgentProvider:${agentIndex}`, `hypothesisAgentModel:${agentIndex}`, existingAgent?.model) ||
        existingAgent?.model ||
        getProviderConfiguredModel(providerId)
    };
  }).slice(0, MAX_HYPOTHESIS_AGENTS);
  const supportAgent = hypothesisAgents.find((agent) => agent.role === "support");
  const attackAgent = hypothesisAgents.find((agent) => agent.role === "attack");
  const judgeAgent = hypothesisAgents.find((agent) => agent.role === "judge");

  return {
    title: String(formData.get("sessionTitle") || fallbackTitle).trim() || fallbackTitle,
    settings: {
      mode: String(formData.get("mode") || fallbackSettings.mode),
      language: String(formData.get("language") || fallbackSettings.language),
      outputStyle:
        String(formData.get("outputStyle") || fallbackSettings.outputStyle || "balanced"),
	      defaultTarget: {
	        providerId: String(formData.get("defaultProvider") || fallbackSettings.defaultTarget.providerId).trim() || fallbackSettings.defaultTarget.providerId,
	        model: resolveModelValue("defaultProvider", "defaultModel", fallbackSettings.defaultTarget.model)
	      },
	      defaultAccessMode: String(formData.get("defaultAccess") || fallbackSettings.defaultAccessMode || "default") === "full" ? "full" : "default",
	      codeAgents,
      subagents: codeAgents,
      hypothesisAgents,
      debate: {
        enabled: formData.get("debateEnabled") === "on",
        profile: String(formData.get("debateProfile") || fallbackSettings.debate.profile),
        support: {
          providerId: supportAgent?.providerId || fallbackSettings.debate.support.providerId,
          model: supportAgent?.model
        },
        attack: {
          providerId: attackAgent?.providerId || fallbackSettings.debate.attack.providerId,
          model: attackAgent?.model
        },
        judge: {
          providerId: judgeAgent?.providerId || fallbackSettings.debate.judge.providerId,
          model: judgeAgent?.model
        }
      }
    }
  };
}

async function persistActiveSessionSetup(options = {}) {
  if (!state.activeSessionId || !state.sessionSettings) {
    return null;
  }

  const snapshot = readSessionSetupSnapshot();
  if (!snapshot) {
    return null;
  }

  const currentSession = getCurrentSessionSummary();
  if (options.renameSession !== false && snapshot.title && snapshot.title !== currentSession?.title) {
    await api.renameSession(state.activeSessionId, snapshot.title);
    if (currentSession) {
      currentSession.title = snapshot.title;
      currentSession.updatedAt = new Date().toISOString();
    }
  }

  state.sessionSettings = await api.updateSessionSettings(
    state.activeSessionId,
    sessionSettingsToPatch(snapshot.settings)
  );

  if (options.refreshBootstrap) {
    await refreshBootstrap();
  }

  return snapshot;
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
  state.ui.messageStreamScrollTop = stream.scrollHeight;
  state.ui.messageStreamPinnedToBottom = true;
  state.ui.showScrollToBottom = false;
  syncScrollToBottomButton();
}

function getMessageStreamDistanceToBottom(stream = document.querySelector(".message-stream")) {
  if (!stream) {
    return 0;
  }

  return Math.max(0, stream.scrollHeight - stream.clientHeight - stream.scrollTop);
}

function isMessageStreamNearBottom(stream = document.querySelector(".message-stream"), threshold = 96) {
  return getMessageStreamDistanceToBottom(stream) <= threshold;
}

function rememberMessageStreamScroll() {
  const stream = document.querySelector(".message-stream");
  if (!stream) {
    return;
  }

  state.ui.messageStreamScrollTop = stream.scrollTop;
  state.ui.messageStreamPinnedToBottom = isMessageStreamNearBottom(stream);
  state.ui.showScrollToBottom = !state.ui.messageStreamPinnedToBottom;
}

function restoreStoredMessageStreamScroll() {
  if (state.route !== "chat") {
    return;
  }

  const stream = document.querySelector(".message-stream");
  if (!stream) {
    return;
  }

  window.requestAnimationFrame(() => {
    if (state.ui.messageStreamPinnedToBottom) {
      stream.scrollTop = stream.scrollHeight;
    } else {
      stream.scrollTop = Math.min(state.ui.messageStreamScrollTop, stream.scrollHeight);
    }
    rememberMessageStreamScroll();
    syncScrollToBottomButton();
  });
}

function syncScrollToBottomButton() {
  const button = document.querySelector("[data-action='scroll-chat-bottom']");
  if (!button) {
    return;
  }

  button.classList.toggle("visible", state.ui.showScrollToBottom);
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

function renderCodeAgentCard(agent, index, providerOptions) {
  const modelOptions = getSelectableSessionModels(agent.providerId, agent.model);

  return `
    <div class="code-agent-card" data-code-agent-index="${index}">
      <input type="hidden" name="codeAgentId:${index}" value="${escapeAttr(agent.id)}" />
      <div class="field">
        <label>Name</label>
        <input name="codeAgentName:${index}" value="${escapeAttr(agent.name)}" />
      </div>
      <div class="field">
        <label>Provider</label>
        <select name="codeAgentProvider:${index}">
          ${providerOptions.map((item) => option(item.id, agent.providerId, item.name)).join("")}
        </select>
      </div>
      <div class="field code-agent-model-field" data-code-agent-model-index="${index}">
        <label>Model</label>
        ${renderSessionModelControl(`codeAgentModel:${index}`, agent.providerId, agent.model ?? "", modelOptions, `code-agent-model-options-${index}`)}
      </div>
      <div class="field">
        <label>Access</label>
        <select name="codeAgentAccess:${index}">
          ${["default", "full"].map((value) => option(value, agent.accessMode ?? "default")).join("")}
        </select>
      </div>
      <div class="field code-agent-delete">
        <label>&nbsp;</label>
        <button class="ghost-button" type="button" data-action="delete-code-agent" data-code-agent-index="${index}">Delete</button>
      </div>
    </div>
  `;
}

function renderHypothesisAgentCard(agent, index, providerOptions) {
  const modelOptions = getSelectableSessionModels(agent.providerId, agent.model);

  return `
    <div class="code-agent-card hypothesis-agent-card" data-hypothesis-agent-index="${index}">
      <input type="hidden" name="hypothesisAgentId:${index}" value="${escapeAttr(agent.id)}" />
      <div class="field">
        <label>Name</label>
        <input name="hypothesisAgentName:${index}" value="${escapeAttr(agent.name)}" />
      </div>
      <div class="field">
        <label>Role</label>
        <select name="hypothesisAgentRole:${index}" ${index < 3 ? "disabled" : ""}>
          ${["support", "attack", "judge", "advisor"].map((value) => option(value, agent.role)).join("")}
        </select>
        ${index < 3 ? `<input type="hidden" name="hypothesisAgentRole:${index}" value="${escapeAttr(agent.role)}" />` : ""}
      </div>
      <div class="field">
        <label>Provider</label>
        <select name="hypothesisAgentProvider:${index}">
          ${providerOptions.map((item) => option(item.id, agent.providerId, item.name)).join("")}
        </select>
      </div>
      <div class="field hypothesis-agent-model-field" data-hypothesis-agent-model-index="${index}">
        <label>Model</label>
        ${renderSessionModelControl(`hypothesisAgentModel:${index}`, agent.providerId, agent.model ?? "", modelOptions, `hypothesis-agent-model-options-${index}`)}
      </div>
      <div class="field code-agent-delete">
        <label>&nbsp;</label>
        <button class="ghost-button" type="button" data-action="delete-hypothesis-agent" data-hypothesis-agent-index="${index}" ${index < 3 ? "disabled" : ""}>Delete</button>
      </div>
    </div>
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
    delete state.draftAttachments[sessionId];
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
      mode: value,
      outputStyle: current.outputStyle,
      codeAgents: current.codeAgents ?? [],
      hypothesisAgents: current.hypothesisAgents ?? []
    };
  }

  if (kind === "language") {
    return {
      ...current,
      language: value,
      outputStyle: current.outputStyle,
      codeAgents: current.codeAgents ?? [],
      hypothesisAgents: current.hypothesisAgents ?? []
    };
  }

  if (kind === "debate") {
    return {
      ...current,
      outputStyle: current.outputStyle,
      codeAgents: current.codeAgents ?? [],
      hypothesisAgents: current.hypothesisAgents ?? [],
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
	    outputStyle: settings.outputStyle,
	    defaultTarget: { ...settings.defaultTarget },
	    defaultAccessMode: settings.defaultAccessMode ?? "default",
	    codeAgents: (settings.codeAgents ?? []).map((agent) => ({ ...agent })),
    subagents: (settings.codeAgents ?? []).map((agent) => ({ ...agent })),
    hypothesisAgents: (settings.hypothesisAgents ?? []).map((agent) => ({ ...agent })),
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

  form.querySelectorAll("[name^='codeAgentProvider:']").forEach((providerField) => {
    providerField.addEventListener("change", () => {
      const index = providerField.getAttribute("name")?.split(":")[1];

      if (!index) {
        return;
      }

      const providerId = providerField.value;
      const modelField = form.querySelector(`[name="codeAgentModel:${index}"]`);
      const currentValue = modelField?.value ?? "";
      const options = getSelectableSessionModels(providerId, currentValue);
      const field = form.querySelector(`[data-code-agent-model-index="${index}"]`);

      if (!field) {
        return;
      }

      field.innerHTML = `
        <label>Model</label>
        ${renderSessionModelControl(`codeAgentModel:${index}`, providerId, isCloudProvider(providerId) && isLocalCatalogModel(currentValue) ? "" : currentValue, options, `code-agent-model-options-${index}`)}
      `;
    });
  });

  form.querySelectorAll("[name^='hypothesisAgentProvider:']").forEach((providerField) => {
    providerField.addEventListener("change", () => {
      const index = providerField.getAttribute("name")?.split(":")[1];

      if (!index) {
        return;
      }

      const providerId = providerField.value;
      const modelField = form.querySelector(`[name="hypothesisAgentModel:${index}"]`);
      const currentValue = modelField?.value ?? "";
      const options = getSelectableSessionModels(providerId, currentValue);
      const field = form.querySelector(`[data-hypothesis-agent-model-index="${index}"]`);

      if (!field) {
        return;
      }

      field.innerHTML = `
        <label>Model</label>
        ${renderSessionModelControl(`hypothesisAgentModel:${index}`, providerId, isCloudProvider(providerId) && isLocalCatalogModel(currentValue) ? "" : currentValue, options, `hypothesis-agent-model-options-${index}`)}
      `;
    });
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
