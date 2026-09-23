import { createProjectsUi, projectOptions } from "./projects-ui.js";
import { createSettingsShell } from "./settings-shell.js";
import { createSettingsData } from "./settings-data.js";
import { motionEnabled, setAnimations } from "./motion.js";
import { icon, glassFilters, bindGlassLighting } from "./ui-primitives.js";
import { createModelManager } from "./model-manager.js";
import { createReviewPanel } from "./review-panel.js";
import { createSessionSetupMotion } from "./session-setup-motion.js";
import { createVoiceInput, appendDictation } from "./voice-input.js";

const app = document.querySelector("#app");
const sessionSetupMotion = createSessionSetupMotion();
let systemMetricsPollTimer = null;
let sessionLoadSequence = 0;
let workflowPollInFlight = false;
let workflowEditorHandle = null;
let workflowEditorModulePromise = null;
let workflowEditorMountGeneration = 0;
const UI_THEMES = ["dark", "light", "system"];
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
const resolveTheme = theme => theme === "system" ? (systemTheme.matches ? "dark" : "light") : theme;
const initialTheme = UI_THEMES.includes(localStorage.getItem("lcai.theme"))
  ? localStorage.getItem("lcai.theme")
  : "dark";
document.documentElement.dataset.theme = resolveTheme(initialTheme);
applyFontScale(Number(localStorage.getItem("lcai.fontScale")) || 100);
if (window.desktopAppearance) {
  document.documentElement.dataset.desktop = window.desktopAppearance.platform;
  window.desktopAppearance.setTheme(resolveTheme(initialTheme));
}
const DEFAULT_SUBAGENT_NAMES = ["Atlas", "Nova", "Vector", "Echo", "Orion", "Lyra", "Kepler", "Sable", "Rook", "Mira"];
const MAX_HYPOTHESIS_ADVISORS = 5;
const MAX_HYPOTHESIS_AGENTS = 3 + MAX_HYPOTHESIS_ADVISORS;
const DEFAULT_SCHEDULE_TIMEZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Kyiv";
  } catch {
    return "Europe/Kyiv";
  }
})();
const SCHEDULE_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SUBAGENT_PENDING_MESSAGES = [
  "Routing a focused pass to {agents}...",
  "Spinning up {agents} with the current context...",
  "Asking {agents} for a second look...",
  "Launching {agents} into the task...",
  "Handing this pass to {agents}..."
];

const ACCESS_MODES = [
  { id: "ask", label: "Ask for approval", icon: "hand", description: "Always ask before changing files, running commands or using the internet" },
  { id: "default", label: "Approve for me", icon: "shield", description: "Allow workspace edits; ask before commands, external access or deletions" },
  { id: "full", label: "Full access", icon: "shieldAlert", description: "Run actions without asking, with access to files and the internet" }
];

const ATTACHMENT_ACCEPT = "image/png,image/jpeg,image/webp,.txt,.md,.markdown,.json,.csv,.ts,.tsx,.js,.jsx,.py,.html,.css,.yml,.yaml,.xml,.toml,.sh,.log,.pdf,.docx";

const state = {
  route: "chat",
  loading: false,
  chatSubmitting: false,
  accessSaving: false,
  activeChatRequest: null,
  notice: "",
  error: "",
  toasts: [],
  bootstrap: null,
  activeSessionId: null,
  activeProjectId: null,
  taskWorkspaces: {},
  sessionSettings: null,
  messages: [],
  drafts: {},
  draftAttachments: {},
  taskDraftAttachments: [],
  attachmentImports: {},
  pendingRequest: null,
  modelActions: {},
  pluginTestResults: {},
  providerTestResults: {},
  localModelTest: null,
  savedButtons: {},
  activeWorkflowRunId: null,
  workflowRunDetail: null,
  workflowAgentTraces: {},
  orchestrationTab: "tasks",
  workflowBuilder: {
    draft: null,
    validation: null
  },
  ui: {
    theme: initialTheme,
    sidebarCollapsed: localStorage.getItem("lcai.sidebarCollapsed") === "true",
    sidebarWidth: Number(localStorage.getItem("lcai.sidebarWidth") || 232),
    sessionSetupCollapsed: localStorage.getItem("lcai.sessionSetupCollapsed") === "true",
    rightPanelWidth: Math.max(320, Number(localStorage.getItem("lcai.rightPanelWidth") || localStorage.getItem("lcai.sessionSetupWidth") || 420)),
    workflowSideCollapsed: localStorage.getItem("lcai.workflowSideCollapsed") !== "false",
    workflowSideWidth: Number(localStorage.getItem("lcai.workflowSideWidth") || 300),
    taskSearch: "",
    autosaveStatus: "idle",
    autosaveTimer: null,
    autosaveSeq: 0,
    autosavePromise: Promise.resolve(),
    messageStreamScrollTop: 0,
    messageStreamPinnedToBottom: true,
    showScrollToBottom: false
  }
};

const api = {
  getBootstrap: () => request("/dashboard/bootstrap"),
  createProject: payload => request("/projects", { method: "POST", body: JSON.stringify(payload) }),
  updateProject: (id, payload) => request(`/projects/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) }),
  getTaskWorkspace: taskId => request(`/tasks/${encodeURIComponent(taskId)}/workspace`),
  revealTaskWorkspace: taskId => request(`/tasks/${encodeURIComponent(taskId)}/workspace/reveal`, { method: "POST" }),
  createSession: (title, projectId) =>
    request("/sessions", {
      method: "POST",
      body: JSON.stringify({ title, ...(projectId ? { projectId } : {}) })
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
  sendChat: (payload, controller) =>
    request("/chat", {
      method: "POST",
      body: JSON.stringify(payload),
      timeoutMs: 900000,
      controller
    }),
  reviewProcessRun: (requestId, sessionId, approvalId, approved) =>
    request(`/process-runs/${encodeURIComponent(requestId)}/review`, {
      method: "POST", body: JSON.stringify({ sessionId, approvalId, approved })
    }),
  getProcessRun: (requestId) => request(`/process-runs/${encodeURIComponent(requestId)}`),
  cancelProcessRun: (requestId) =>
    request(`/process-runs/${encodeURIComponent(requestId)}/cancel`, { method: "POST" }),
  readWorkspaceFile: (filePath, sessionId) =>
    request(`/workspace/file?path=${encodeURIComponent(filePath)}&sessionId=${encodeURIComponent(sessionId || "")}`),
  openWorkspaceEditor: (filePath, sessionId) =>
    request("/workspace/editor", { method: "POST", body: JSON.stringify({ path: filePath, sessionId }) }),
  revealWorkspacePath: (filePath, sessionId = state.activeSessionId, runId) =>
    request("/workspace/reveal", {
      method: "POST",
      body: JSON.stringify({ path: filePath, ...(runId ? { runId } : { sessionId }) })
    }),
  updateAppSettings: (payload) =>
    request("/app/settings", {
      method: "PUT",
      timeoutMs: payload.localModels?.modelsDir ? 900000 : 60000,
      body: JSON.stringify(payload)
    }),
  testPlugin: (pluginName) =>
    request(`/plugins/${pluginName}/test`, {
      method: "POST"
    }),
  testProvider: (providerId, model) =>
    request(`/providers/${providerId}/test`, {
      method: "POST",
      body: JSON.stringify({ model }),
      timeoutMs: providerId === "llamacpp" ? 0 : Math.max(defaultProviderTimeoutMs(providerId), Number(state.bootstrap?.appSettings?.providers?.[providerId]?.timeoutMs) || 0) + 30000
    }),
  reloadRuntime: () =>
    request("/runtime/reload", {
      method: "POST"
    }),
  loadModel: (providerId, modelId) =>
    request("/local/models/load", {
      method: "POST",
      timeoutMs: localModelActionTimeoutMs(providerId),
      body: JSON.stringify({ providerId, modelId })
    }),
  unloadModel: (providerId, modelIdOrInstanceId) =>
    request("/local/models/unload", {
      method: "POST",
      timeoutMs: localModelActionTimeoutMs(providerId),
      body: JSON.stringify({ providerId, modelIdOrInstanceId })
    }),
  createTask: (payload) =>
    request("/tasks", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateTask: (taskId, payload) =>
    request(`/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  deleteTask: (taskId) =>
    request(`/tasks/${taskId}`, {
      method: "DELETE"
    }),
  queueTask: (taskId) =>
    request(`/tasks/${taskId}/queue`, {
      method: "POST"
    }),
  runTask: (taskId) =>
    request(`/tasks/${taskId}/run`, {
      method: "POST",
      timeoutMs: 900000,
      body: JSON.stringify({ background: true })
    }),
  runNextTask: () =>
    request("/tasks/run-next", {
      method: "POST",
      timeoutMs: 900000,
      body: JSON.stringify({ background: true })
    }),
  createSchedule: (payload) =>
    request("/schedules", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateSchedule: (scheduleId, payload) =>
    request(`/schedules/${scheduleId}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  deleteSchedule: (scheduleId) =>
    request(`/schedules/${scheduleId}`, {
      method: "DELETE"
    }),
  getWorkflowRun: (runId) => request(`/workflow-runs/${runId}`),
  stepWorkflowRun: (runId) =>
    request(`/workflow-runs/${runId}/step`, {
      method: "POST",
      timeoutMs: 900000
    }),
  cancelWorkflowRun: (runId) =>
    request(`/workflow-runs/${runId}/cancel`, {
      method: "POST"
    }),
  createWorkflow: (workflow) =>
    request("/workflows", {
      method: "POST",
      body: JSON.stringify(workflow)
    }),
  updateWorkflow: (workflowId, workflow) =>
    request(`/workflows/${workflowId}`, {
      method: "PUT",
      body: JSON.stringify(workflow)
    }),
  validateWorkflow: (workflow) =>
    request(`/workflows/${workflow.id || "draft"}/validate`, {
      method: "POST",
      body: JSON.stringify(workflow)
    }),
  refreshManagedModels: async () => {
    const allManagedModels = await request("/local/models/all");
    const loadedModels = allManagedModels.filter((model) => model.loaded || model.loadedInstanceIds?.length);
    return { loadedModels, allManagedModels };
  },
  getSystemMetrics: () => request("/system/metrics")
};

const projectsUi = createProjectsUi({
  getState: () => state,
  createProject: api.createProject,
  updateProject: api.updateProject,
  notify: message => { pushToast(message, "danger"); render(); },
  refresh: refreshBootstrap,
  render,
  selectProject: projectId => runAction(async () => {
    await persistActiveSessionSetup({ refreshBootstrap: false });
    voiceInput.leaveChat();
    ++sessionLoadSequence;
    state.activeProjectId = projectId;
    state.activeSessionId = null;
    state.sessionSettings = null;
    state.messages = [];
    state.route = "chat";
    window.location.hash = "/chat";
  })
});

const reviewPanel = createReviewPanel({
  sessionId: () => state.activeSessionId,
  isCollapsed: () => state.ui.sessionSetupCollapsed,
  showPanel: () => {
    state.ui.sessionSetupCollapsed = false;
    localStorage.setItem("lcai.sessionSetupCollapsed", "false");
  },
  busy: () => Boolean(state.chatSubmitting || state.activeChatRequest || state.accessSaving),
  readFile: api.readWorkspaceFile,
  openEditor: api.openWorkspaceEditor,
  findChange: findFileChangeMetadata,
  beforeOpen: async () => {
    const sessionId = state.activeSessionId;
    const snapshot = readSessionSetupSnapshot();
    window.clearTimeout(state.ui.autosaveTimer);
    await state.ui.autosavePromise.catch(() => undefined);
    await persistActiveSessionSetup({ refreshBootstrap: false, sessionId, snapshot });
  },
  changed: render,
  notify: (message) => { pushToast(message, "danger"); render(); },
  icon,
  send: ({ input, attachments, sessionId, reviewSelection }) => submitChatMessage(input, attachments, { sessionId, fromReview: true, reviewSelection })
});

const voiceInput = createVoiceInput({
  bridge: window.desktopVoice,
  sessionId: () => state.activeSessionId,
  isChat: () => state.route === "chat" && document.getElementById('settings-root')?.hidden !== false,
  hasSession: id => (state.bootstrap?.sessions ?? []).some(session => session.id === id),
  sendBusy: () => Boolean(state.chatSubmitting || state.activeChatRequest || state.accessSaving),
  icon,
  appendText: (sessionId, text) => {
    state.drafts[sessionId] = appendDictation(state.drafts[sessionId] || "", text);
    if (state.activeSessionId === sessionId) {
      const textarea = document.querySelector("#chat-form textarea");
      if (textarea) textarea.value = state.drafts[sessionId];
    }
  },
  notify: message => { pushToast(message, "info"); render(); }
});

const modelManager = createModelManager({
  request,
  getContext: () => ({
    models: state.bootstrap?.allManagedModels ?? [],
    runtime: state.bootstrap?.localModels?.runtime,
    systemMetrics: state.bootstrap?.systemMetrics,
    settings: state.bootstrap?.appSettings,
    testing: Boolean(state.localModelTest),
    currentTarget: state.sessionSettings?.defaultTarget
  }),
  isVisible: () => state.route === "models",
  notify: (message, tone) => {
    const scroll = captureScrollState();
    pushToast(message, tone);
    render();
    restoreScrollState(scroll);
  },
  onLibraryChange: (models, runtime) => {
    if (!state.bootstrap) return;
    const localModels = models.filter((model) => model.providerId === "llamacpp");
    state.bootstrap.allManagedModels = [...(state.bootstrap.allManagedModels ?? []).filter((model) => model.providerId !== "llamacpp"), ...localModels];
    state.bootstrap.loadedModels = state.bootstrap.allManagedModels.filter((model) => model.loaded || model.loadedInstanceIds?.length || model.state === "ready");
    state.bootstrap.availableModels = [...(state.bootstrap.availableModels ?? []).filter((model) => model.providerId !== "llamacpp"), ...localModels];
    if (runtime) state.bootstrap.localModels = { ...state.bootstrap.localModels, models: localModels, runtime };
    updateLocalModelTestProgress();
    updateAttachmentGuidance();
  },
  onUse: async (model) => {
    if (!state.activeSessionId || !state.sessionSettings) await createChatInProject(state.activeProjectId);
    const sessionId = state.activeSessionId;
    window.clearTimeout(state.ui.autosaveTimer);
    await state.ui.autosavePromise.catch(() => undefined);
    const saved = await api.updateSessionSettings(sessionId, {
      defaultTarget: { providerId: "llamacpp", model: model.libraryId || model.id }
    });
    if (state.activeSessionId !== sessionId) return;
    state.sessionSettings = saved;
    render();
    window.location.hash = "#/chat";
  },
  onDefault: async (model) => {
    const response = await api.updateAppSettings({
      llm: { defaultProvider: "llamacpp" },
      providers: { llamacpp: { model: model.libraryId || model.id, enabled: true } }
    });
    state.bootstrap.appSettings = response.settings;
    state.bootstrap.providers = response.providers;
  }
});

let appRenderDeferred = false;
const settingsData = createSettingsData({ request, onSaved: (response, patch) => {
  if (Object.keys(patch).some(key => key !== "ui")) appRenderDeferred = true;
  if (!state.bootstrap) return;
  state.bootstrap.appSettings = response.settings;
  for (const key of ["providers", "plugins", "tools", "availableModels"]) if (response[key] !== undefined) state.bootstrap[key] = response[key];
} });
function applyUiPreferences(preferences) {
  if (preferences.theme) applyTheme(preferences.theme, false);
  if (typeof preferences.animations === "boolean") setAnimations(preferences.animations);
  if (typeof preferences.fontScale === "number") applyFontScale(preferences.fontScale);
}
function applyFontScale(value) {
  const scale = Number.isFinite(value) && value >= 85 && value <= 150 ? value : 100;
  document.documentElement.style.setProperty("--font-scale", String(scale / 100));
  localStorage.setItem("lcai.fontScale", String(scale));
}
const settingsShell = createSettingsShell({ app, data: settingsData, voiceInput,
  getContext: () => ({ ...state.bootstrap, route: state.route }),
  renderModelControl: renderProviderSettingsModelControl, applyPreferences: applyUiPreferences,
  captureScroll: captureScrollState, restoreScroll: restoreScrollState,
  onReturn: () => {
    if (appRenderDeferred && !workflowEditorHandle) render();
    appRenderDeferred = false;
  }
});
systemTheme.addEventListener("change", () => { if (state.ui.theme === "system") applyTheme("system", false); });

window.addEventListener("beforeunload", () => modelManager.dispose());

init().catch((error) => {
  pushToast(error instanceof Error ? error.message : "Failed to initialize UI", "danger");
  render();
});

window.addEventListener("hashchange", () => {
  const wasSettings = settingsShell.isOpen();
  if (settingsShell.route(window.location.hash)) return;
  if (state.route === "chat") rememberMessageStreamScroll();
  const previous = state.route;
  syncRouteFromHash();
  if (!wasSettings || state.route !== previous) render();
  syncSystemMetricsPolling();
});

async function init() {
  window.addEventListener("keydown", handleGlobalKeydown);
  syncRouteFromHash();
  await refreshBootstrap();
  await ensureSession();
  const preferences = state.bootstrap.appSettings.ui;
  if (preferences) applyUiPreferences(preferences);
  else {
    try { await settingsData.save({ ui: { theme: state.ui.theme, animations: localStorage.getItem("lcai.animations") !== "false" } }); }
    catch (error) { pushToast(`Could not save appearance: ${error.message}`, "danger"); }
  }
  render();
  settingsShell.route(window.location.hash);
  syncSystemMetricsPolling();
}

function syncRouteFromHash() {
  const route = window.location.hash.replace(/^#\/?/, "");
  state.route = ["chat", "orchestration", "models"].includes(route) ? route : "chat";
}

async function refreshBootstrap() {
  state.bootstrap = await api.getBootstrap();
}

async function ensureSession() {
  const sessions = state.bootstrap?.sessions ?? [];
  if (state.activeSessionId && sessions.some(session => session.id === state.activeSessionId)) {
    state.activeProjectId = sessions.find(session => session.id === state.activeSessionId)?.projectId ?? null;
  } else {
    const scoped = sessions.filter(session => (session.projectId ?? null) === state.activeProjectId);
    if (scoped.length) state.activeSessionId = scoped[0].id;
    else if (!state.activeProjectId) {
      const session = await api.createSession("New chat");
      await refreshBootstrap();
      state.activeSessionId = session.id;
    } else {
      ++sessionLoadSequence;
      state.activeSessionId = null;
      state.sessionSettings = null;
      state.messages = [];
    }
  }
  await loadActiveSession();
}

async function createChatInProject(projectId) {
  const snapshot = readSessionSetupSnapshot();
  const currentSettings = snapshot ? sessionSettingsToPatch(snapshot.settings) : null;
  await persistActiveSessionSetup({ refreshBootstrap: false });
  const session = await api.createSession("New chat", projectId);
  if (currentSettings) {
    const defaults = state.bootstrap?.appSettings?.ui;
    await api.updateSessionSettings(session.id, {
      ...currentSettings,
      ...(defaults ? { language: defaults.language, outputStyle: defaults.outputStyle, mode: defaults.mode } : {})
    });
  }
  await refreshBootstrap();
  state.activeProjectId = session.projectId ?? projectId ?? null;
  projectsUi.revealSession(state.activeProjectId);
  state.activeSessionId = session.id;
  await loadActiveSession();
  state.notice = "";
  state.route = "chat";
  window.location.hash = "/chat";
}

function currentProject() {
  return (state.bootstrap?.projects ?? []).find(project => project.id === state.activeProjectId);
}

async function loadActiveSession() {
  if (!state.activeSessionId) {
    return;
  }

  const sessionId = state.activeSessionId;
  const sequence = ++sessionLoadSequence;
  const [messages, settings] = await Promise.all([
    api.getSessionMessages(sessionId),
    api.getSessionSettings(sessionId)
  ]);
  if (state.activeSessionId !== sessionId || sequence !== sessionLoadSequence) return;
  state.messages = messages;
  state.sessionSettings = settings;

  if (
    state.pendingRequest?.sessionId === sessionId &&
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
  const controller = options.controller ?? new AbortController();
  const { controller: _providedController, timeoutMs: _timeoutMs, ...fetchOptions } = options;
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 30000;
  const timeoutId = timeoutMs > 0 ? window.setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      },
      signal: controller.signal,
      ...fetchOptions
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
      throw new Error(options.controller ? "Request cancelled." : "Request timed out.");
    }

    throw error;
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  }
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function applyTheme(theme, persist = true) {
  const nextTheme = UI_THEMES.includes(theme) ? theme : "dark";
  state.ui.theme = nextTheme;
  document.documentElement.dataset.theme = resolveTheme(nextTheme);
  localStorage.setItem("lcai.theme", nextTheme);
  window.desktopAppearance?.setTheme(resolveTheme(nextTheme));
  workflowEditorHandle?.setColorMode(resolveTheme(nextTheme));
  document.querySelectorAll("[data-action='set-theme']").forEach((button) => {
    button.classList.toggle("active", button.dataset.theme === nextTheme);
    button.setAttribute("aria-pressed", String(button.dataset.theme === nextTheme));
  });
  const select = document.querySelector("#appearance-theme");
  if (select) select.value = nextTheme;
  if (persist) void settingsData.save({ ui: { theme: nextTheme } }).catch(error => { pushToast(`Theme not saved: ${error.message}`, "danger"); render(); });
}

function render(options = {}) {
  if (settingsShell.isOpen()) { appRenderDeferred = true; return; }
  if (!app) {
    return;
  }

  reviewPanel.capture();
  const setupViewport = sessionSetupMotion.capture();
  const presentation = capturePresentationState();
  const viewKey = `${state.route}:${state.route === "orchestration" ? state.orchestrationTab : state.activeSessionId}`;
  const viewChanged = app.dataset.view !== viewKey;
  app.dataset.view = viewKey;
  unmountWorkflowEditor();

  app.innerHTML = `
    ${glassFilters()}
    <div class="shell ${viewChanged ? "view-enter" : ""} ${state.ui.sidebarCollapsed ? "shell--sidebar-collapsed" : ""}" style="--sidebar-width: ${Math.max(180, state.ui.sidebarWidth || 232)}px;">
      ${renderSidebar()}
      <main class="main">
        <header class="app-topbar">
          <div class="app-topbar__title"><button class="icon-button mobile-sessions-button" data-action="toggle-mobile-sessions" aria-label="Show conversations" aria-expanded="false">${icon("sidebar")}</button><span class="topbar-mark">${icon(state.route)}</span><h1>${escapeHtml(state.route === "chat" ? getCurrentSessionSummary()?.title || currentProject()?.name || "New chat" : routeTitle(state.route))}</h1></div>
          <div class="app-topbar__actions">
            ${state.route === "chat" ? `<span class="topbar-mode">${escapeHtml(capitalize(getEffectiveSetupMode(state.sessionSettings || {})))}</span>` : ""}
            <span class="local-indicator" title="Runs on your computer"><span class="status-dot"></span>Local</span>
          </div>
        </header>
        <div class="content-shell">
          <section class="route route--chat ${state.route === "chat" ? "active" : ""}">
            ${renderChatRoute()}
          </section>
          <section class="route route--models ${state.route === "models" ? "active" : ""}">
            ${renderModelsRoute()}
          </section>
          <section class="route route--orchestration ${state.route === "orchestration" ? "active" : ""}">
            ${renderOrchestrationRoute()}
          </section>
        </div>
        ${renderToasts()}
      </main>
    </div>
  `;

  bindEvents();
  projectsUi.bind();
  settingsShell.bindProfile();
  voiceInput.bind();
  reviewPanel.bind();
  modelManager.bind(document.querySelector("#local-model-manager"));
  restorePresentationState(presentation);
  sessionSetupMotion.restore(setupViewport, options.setupAddedId);
  bindGlassLighting(app);
  mountActiveWorkflowEditor();
  if (state.route === "chat") {
    restoreStoredMessageStreamScroll();
  }
}

// Preserve presentation state when runtime polling replaces the template.
function capturePresentationState() {
  const forms = [...document.querySelectorAll("#task-form, #schedule-form, .workspace-edit-form")].map((form) => ({
    id: form.id, values: [...new FormData(form).entries()]
  }));
  const disclosures = [...document.querySelectorAll("[data-ui-disclosure]")].map((element) => ({
    key: element.dataset.uiDisclosure, open: element.open
  }));
  const focused = document.activeElement;
  const sidebarScroll = [...document.querySelectorAll("[data-sidebar-scroll]")].map(element => ({ key: element.dataset.sidebarScroll, top: element.scrollTop }));
  const mobileConversationsOpen = Boolean(document.querySelector(".shell")?.classList.contains("mobile-sessions-open"));
  return { forms, disclosures, sidebarScroll, mobileConversationsOpen, focusId: focused?.closest?.("#session-setup-body") ? null : focused?.id, start: focused?.selectionStart, end: focused?.selectionEnd };
}

function restorePresentationState(snapshot) {
  if (typeof snapshot.mobileConversationsOpen === "boolean") {
    document.querySelector(".shell")?.classList.toggle("mobile-sessions-open", snapshot.mobileConversationsOpen);
    document.querySelector("[data-action='toggle-mobile-sessions']")?.setAttribute("aria-expanded", String(snapshot.mobileConversationsOpen));
  }
  snapshot.forms.forEach(({ id, values }) => {
    const form = document.getElementById(id);
    values.forEach(([name, value]) => {
      const field = form?.elements.namedItem(name);
      if (field && typeof value === "string") field.value = value;
    });
    form?.querySelector("#schedule-frequency")?.dispatchEvent(new Event("change"));
    form?.querySelector("[data-workspace-project]")?.dispatchEvent(new Event("change"));
  });
  (snapshot.sidebarScroll ?? []).forEach(({ key, top }) => { const list = document.querySelector(`[data-sidebar-scroll="${CSS.escape(key)}"]`); if (list) list.scrollTop = top; });
  snapshot.disclosures.forEach(({ key, open }) => {
    const element = document.querySelector(`[data-ui-disclosure="${CSS.escape(key)}"]`);
    if (element) {
      element.classList.toggle("is-restored", open);
      element.open = open;
    }
  });
  const focused = snapshot.focusId && document.getElementById(snapshot.focusId);
  if (focused && focused.getClientRects().length) {
    focused.focus({ preventScroll: true });
    if (typeof snapshot.start === "number" && typeof focused.setSelectionRange === "function") {
      try { focused.setSelectionRange(snapshot.start, snapshot.end); } catch { /* Non-text inputs have no selection. */ }
    }
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
  const providerCount = state.bootstrap?.providers?.length ?? 0;
  const pluginCount = state.bootstrap?.plugins?.length ?? 0;

  return `
    <aside class="sidebar liquid-glass">
      <div class="sidebar-brand">
        <span class="brand-orbit" aria-hidden="true"></span><span class="brand-name">Cognitive</span>
        <button class="sidebar-toggle icon-button" type="button" data-action="toggle-sidebar" aria-label="Toggle navigation" aria-expanded="${!state.ui.sidebarCollapsed}" title="${state.ui.sidebarCollapsed ? "Show navigation" : "Hide navigation"}">${icon("sidebar")}</button>
      </div>
      <div class="sidebar-resize-handle" data-action="resize-sidebar" title="Resize navigation"></div>
      <button class="new-task-button liquid-glass" type="button" data-action="new-session" title="${currentProject() ? `New chat in ${escapeAttr(currentProject().name)}` : "New chat"}" aria-label="New chat">${icon("plus")}<span>New chat</span></button>
      <nav class="nav" aria-label="Main navigation">
        ${renderNavButton("chat", "Chat")}
        ${renderNavButton("orchestration", "Workflow")}
        ${renderNavButton("models", "Models")}
      </nav>

      ${projectsUi.sidebar()}

      <div class="sidebar-footer">
        <details class="runtime-disclosure" data-ui-disclosure="runtime"><summary><span class="status-dot"></span><span>Local runtime</span></summary><div>${providerCount} providers · ${pluginCount} plugins · ${(state.bootstrap?.loadedModels ?? []).length} loaded local models</div></details>
        <div class="theme-switch" role="group" aria-label="Appearance">
          ${["light", "dark"].map((theme) => `<button class="icon-button ${state.ui.theme === theme ? "active" : ""}" type="button" data-action="set-theme" data-theme="${theme}" aria-label="${capitalize(theme)} Liquid Glass" aria-pressed="${state.ui.theme === theme}" title="${capitalize(theme)} Liquid Glass">${icon(theme === "light" ? "sun" : "moon")}</button>`).join("")}
        </div>
        ${settingsShell.profileButton()}
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

function renderNavButton(route, label, note) {
  const accessibleLabel = note ? `${label} (${note})` : label;

  return `
    <button class="nav-button liquid-glass ${state.route === route ? "active" : ""}" data-action="route" data-route="${route}" aria-current="${state.route === route ? "page" : "false"}" aria-label="${escapeAttr(label)}" title="${escapeAttr(accessibleLabel)}">
      <span class="nav-label"><span class="nav-icon" aria-hidden="true">${renderNavIcon(route)}</span><span class="nav-text">${escapeHtml(label)}</span></span>
    </button>
  `;
}

function renderNavIcon(route) {
  return icon(route);
}

function renderChatRoute() {
  if (!state.activeSessionId) {
    const project = currentProject();
    return `<div class="project-landing">${icon(project ? "folder" : "chat")}<h2>${escapeHtml(project?.name || "Your conversations")}</h2><p>${escapeHtml(project?.rootPath || "Start a chat to explore an idea.")}</p><button class="primary-button" type="button" data-action="new-session" ${project?.archivedAt ? "disabled" : ""}>${project ? "New chat in project" : "New chat"}</button>${project ? `<button class="ghost-button" type="button" data-action="open-project-folder" data-project-id="${escapeAttr(project.id)}">Open folder</button>` : ""}</div>`;
  }
  if (!state.sessionSettings) return `<div class="empty">Loading chat workspace...</div>`;

  const settings = state.sessionSettings;
  const currentSession = (state.bootstrap?.sessions ?? []).find((session) => session.id === state.activeSessionId);
  const providerOptions = getProviderOptions();
  const pendingMessages = state.pendingRequest && state.pendingRequest.sessionId === state.activeSessionId
    ? [
        {
          id: "pending:user",
          role: "user",
          content: state.pendingRequest.input,
          createdAt: state.pendingRequest.startedAt,
          pending: true
        },
        {
          id: "pending:assistant", role: "assistant",
          content: renderPendingAssistantText(state.pendingRequest),
          createdAt: state.pendingRequest.startedAt, pending: true, pendingKind: "subagent",
          agents: state.pendingRequest.progress?.agents ?? []
        }
      ]
    : [];
  const messages = [
    ...state.messages,
    ...pendingMessages
  ];
  const draftAttachments = getActiveDraftAttachments();
  const attachmentGuidance = getImageAttachmentGuidance(draftAttachments, settings);
  const preparingAttachments = Boolean(state.attachmentImports[`chat:${state.activeSessionId}`]);

  return `
    <div class="chat-layout ${reviewPanel.expanded() ? "review-expanded" : ""}" style="--session-panel-width: ${state.ui.rightPanelWidth}px;">
      <section class="chat-shell">
        <div class="message-stream">
          ${
            messages.length
              ? messages.map(renderMessage).join("")
              : `<div class="chat-welcome"><h2>What would you like<br />to work on?</h2><p>Ask a question, write code, or explore an idea.</p></div>`
          }
        </div>
        <button
          class="scroll-bottom-button ${state.ui.showScrollToBottom ? "visible" : ""}"
          type="button"
          data-action="scroll-chat-bottom"
          title="Scroll to latest message"
          aria-label="Scroll to latest message"
        >${icon("arrowDown")}</button>

        <div class="chat-approval-slot" data-chat-approval>${renderChatApproval()}</div>
        <form class="composer liquid-glass" id="chat-form">
          <input id="chat-attachment-input" type="file" multiple class="sr-only" accept="${ATTACHMENT_ACCEPT}" />
          ${
            draftAttachments.length
              ? `<div class="composer-attachments">${draftAttachments.map((attachment) => renderDraftAttachment(attachment)).join("")}</div>`
              : ""
          }
          <div class="attachment-guidance ${attachmentGuidance.blocked ? "is-blocked" : ""}" data-attachment-guidance role="status" ${!preparingAttachments && !attachmentGuidance.message ? "hidden" : ""}>${escapeHtml(preparingAttachments ? "Preparing attachments…" : attachmentGuidance.message)}</div>
          <textarea name="input" aria-label="Message" placeholder="Ask anything…">${escapeHtml(getActiveDraft())}</textarea>
          ${voiceInput.renderStrip()}
          <div class="mention-menu" data-mention-menu hidden></div>
          <div class="composer-footer">
            <button class="icon-button composer-attach" type="button" data-action="attach-files" aria-label="Attach files" title="Attach files" ${preparingAttachments ? "disabled" : ""}>${icon("plus")}</button>
            ${renderChatActivityBar(settings)}
            <div class="composer-actions">
              ${voiceInput.renderButton()}
              ${state.chatSubmitting ? `<button class="icon-button stop-button" type="button" data-action="stop-chat" aria-label="Stop generation" title="Stop generation (Esc)">${icon("stop")}</button>` : ""}
              <button class="primary-button send-button" type="submit" aria-label="Send message" title="Send message" ${state.chatSubmitting || state.accessSaving || preparingAttachments || attachmentGuidance.blocked ? "disabled" : ""}>${icon("arrowUp")}</button>
            </div>
          </div>
        </form>
      </section>

      ${renderChatRightPanel(settings, currentSession, providerOptions)}
    </div>
  `;
}

function isSubagentRequest(input) {
  return /spawn\s+sub-?agent|sub-?agent|заспавн.*с[ау]б.?агент|с[ау]б.?агент|@[\p{L}\p{N}_-]+/iu.test(input);
}

function renderChatActivityBar(settings) {
  const running = Boolean(state.chatSubmitting || state.pendingRequest);
  const target = settings?.defaultTarget ?? {};
  const provider = getProviderDisplayName(target.providerId);
  const model = getModelDisplayName(target.providerId, target.model) || "default";
  const modelInfo = getTargetModel(target);
  const capability = modelInfo?.vision === true ? "Images" : modelInfo?.vision === false ? "Text only" : "";
  const progress = state.pendingRequest?.progress;
  const label = progress?.label || (running
    ? state.pendingRequest && isSubagentRequest(state.pendingRequest.input)
      ? "Agents"
      : "Build"
    : "Ready");
  const activityDetail = formatLocalModelReferences(progress?.detail) || `${provider} ${model}${capability ? ` · ${capability}` : ""}`;

  return `
    <div class="chat-activity-bar ${running ? "is-running" : "is-stopped"}" aria-live="polite">
      <span class="activity-scan status-dot" aria-hidden="true"><span></span></span>
      <span class="activity-label">${escapeHtml(label)}</span>
      <span class="activity-model" title="${escapeAttr(`${provider} ${model}`)}">${escapeHtml(activityDetail)}</span>
      ${renderAccessControl(settings)}
      <span class="activity-hint">${running ? "esc to stop" : ""}</span>
    </div>
  `;
}

function renderAccessControl(settings) {
  const mode = ACCESS_MODES.find((item) => item.id === settings.defaultAccessMode) || ACCESS_MODES[1];
  const busy = state.accessSaving || state.activeChatRequest?.sessionId === state.activeSessionId;
  return `<button type="button" class="icon-button access-trigger ${mode.id === "full" ? "access-full" : ""}"
    popovertarget="chat-access-menu" aria-label="Access: ${mode.label}" title="${mode.label}" ${busy ? "disabled" : ""}>${icon(mode.icon)}</button>
    <div id="chat-access-menu" class="access-menu" popover="auto" role="group" aria-label="Chat access">
      <div class="access-menu__heading">How should agent actions be approved?</div>
      ${ACCESS_MODES.map((item) => `<button type="button" class="access-option ${item.id === "full" ? "access-full" : ""}"
        data-access-mode="${item.id}" aria-pressed="${item.id === mode.id}">
        ${icon(item.icon)}<span><strong>${item.label}</strong><small>${item.description}</small></span>
        <span class="access-option__check">${item.id === mode.id ? icon("check") : ""}</span>
      </button>`).join("")}
      <div class="access-menu__footer">Applies to this chat and its agents.</div>
    </div>`;
}

function renderChatApproval() {
  const pending = state.pendingRequest;
  if (!pending?.approval || pending.sessionId !== state.activeSessionId) return "";
  const approval = pending.approval;
  return `<section class="chat-approval" role="region" aria-label="Approval request">
    <div class="chat-approval__heading">${icon("hand")}<strong>Approval required</strong><span>${escapeHtml(approval.tool)}</span></div>
    <p>${escapeHtml(approval.summary)}</p>
    <pre tabindex="0">${escapeHtml(approval.details)}</pre>
    <div class="chat-approval__actions"><span>Waiting for your decision</span>
      <button type="button" class="ghost-button" data-approval-id="${escapeAttr(approval.id)}" data-approval-decision="cancel" ${pending.reviewing ? "disabled" : ""}>Cancel</button>
      <button type="button" class="primary-button" data-approval-id="${escapeAttr(approval.id)}" data-approval-decision="approve" ${pending.reviewing ? "disabled" : ""}>Approve</button>
    </div>
  </section>`;
}

function updateChatApproval(approval) {
  if (!state.pendingRequest) return;
  const changed = state.pendingRequest.approval?.id !== approval?.id;
  state.pendingRequest.approval = approval;
  if (changed && state.pendingRequest.sessionId === state.activeSessionId) {
    const slot = document.querySelector("[data-chat-approval]");
    if (slot) slot.innerHTML = renderChatApproval();
  }
}

function bindChatAccess() {
  const menu = document.querySelector("#chat-access-menu");
  menu?.addEventListener("beforetoggle", (event) => {
    if (event.newState !== "open") return;
    const trigger = document.querySelector(".access-trigger").getBoundingClientRect();
    const width = Math.min(280, window.innerWidth - 24);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(12, Math.min(trigger.left, window.innerWidth - width - 12))}px`;
    menu.style.bottom = `${window.innerHeight - trigger.top + 7}px`;
  });
  menu?.addEventListener("click", async (event) => {
    const option = event.target.closest("[data-access-mode]");
    if (!option || state.accessSaving || state.activeChatRequest?.sessionId === state.activeSessionId) return;
    const mode = option.dataset.accessMode;
    if (!ACCESS_MODES.some((item) => item.id === mode)) return;
    menu.hidePopover();
    const sessionId = state.activeSessionId;
    // Finish any older setup save before updating access, then preserve all unsaved setup fields.
    state.accessSaving = true;
    window.clearTimeout(state.ui.autosaveTimer);
    state.ui.autosaveSeq++;
    const previousMode = state.sessionSettings.defaultAccessMode;
    const snapshot = readSessionSetupSnapshot();
    state.sessionSettings = { ...snapshot.settings, defaultAccessMode: mode };
    render();
    try {
      await state.ui.autosavePromise.catch(() => undefined);
      const saved = await api.updateSessionSettings(sessionId, sessionSettingsToPatch({ ...snapshot.settings, defaultAccessMode: mode }));
      if (state.activeSessionId === sessionId) state.sessionSettings = saved;
    } catch (error) {
      if (state.activeSessionId === sessionId) state.sessionSettings.defaultAccessMode = previousMode;
      pushToast(error instanceof Error ? error.message : "Could not save access", "danger");
    } finally { state.accessSaving = false; render(); }
  });
  document.querySelector("[data-chat-approval]")?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-approval-decision]");
    const pending = state.pendingRequest;
    if (!button || !pending?.approval || pending.reviewing || pending.sessionId !== state.activeSessionId ||
        button.dataset.approvalId !== pending.approval.id) return;
    pending.reviewing = true;
    document.querySelector("[data-chat-approval]").innerHTML = renderChatApproval();
    try {
      await api.reviewProcessRun(pending.requestId, pending.sessionId, pending.approval.id, button.dataset.approvalDecision === "approve");
      if (state.pendingRequest === pending) updateChatApproval(undefined);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : "Could not submit decision", "danger");
    } finally {
      pending.reviewing = false;
      if (state.pendingRequest === pending && pending.sessionId === state.activeSessionId) {
        const slot = document.querySelector("[data-chat-approval]");
        if (slot) slot.innerHTML = renderChatApproval();
      }
    }
  });
}

function getProviderDisplayName(providerId) {
  const provider = (state.bootstrap?.providers ?? []).find((item) => item.id === providerId);
  return provider?.name || providerId || "provider";
}

function renderPendingAssistantText(pendingRequest) {
  if (pendingRequest.progress) return pendingRequest.progress.detail || pendingRequest.progress.label;
  const input = typeof pendingRequest === "string" ? pendingRequest : pendingRequest.input;

  if (isSubagentRequest(input)) {
    return pendingRequest.pendingText || chooseSubagentPendingText(input, pendingRequest.startedAt);
  }

  return "";
}

function handleGlobalKeydown(event) {
  if (event.key === "Escape" && voiceInput.escape()) { event.preventDefault(); event.stopImmediatePropagation(); return; }
  if (event.key === "Escape" && document.querySelector("#chat-access-menu:popover-open")) return;
  if (event.key !== "Escape" || !state.activeChatRequest) {
    return;
  }

  event.preventDefault();
  void cancelActiveChatRequest();
}

async function cancelActiveChatRequest() {
  const active = state.activeChatRequest;
  if (!active || active.cancelled) {
    return;
  }

  active.cancelled = true;
  stopProcessProgressPolling(active);

  try {
    await api.cancelProcessRun(active.requestId);
  } catch {
    // The local abort still stops the UI even if the cancellation endpoint already completed.
  } finally {
    active.controller.abort();
    if (state.activeChatRequest?.requestId === active.requestId) {
      preserveStoppedChatRequest(active, "Generation interrupted.", "cancelled");
      state.activeChatRequest = null;
      state.pendingRequest = null;
      state.chatSubmitting = false;
      pushToast("Generation interrupted.", "info");
      render();
    }
  }
}

function startProcessProgressPolling(active) {
  active.progressTimer = window.setInterval(async () => {
    if (state.activeChatRequest?.requestId !== active.requestId || active.cancelled) {
      stopProcessProgressPolling(active);
      return;
    }

    if (active.pollInFlight) return;
    active.pollInFlight = true;
    try {
      const run = await api.getProcessRun(active.requestId);
      if (state.activeChatRequest?.requestId !== active.requestId || active.cancelled) return;
      updateChatApproval(run?.approval);
      if (run?.progress && state.pendingRequest && state.pendingRequest.sessionId === state.activeSessionId) {
        state.pendingRequest.progress = run.progress;
        updateChatActivityProgress(run.progress);
      }
      if (run?.status && run.status !== "running") {
        stopProcessProgressPolling(active);
      }
    } catch {
      // The first poll can race request registration; keep polling until the chat request settles.
    } finally {
      active.pollInFlight = false;
    }
  }, 600);
}

function stopProcessProgressPolling(active) {
  if (active?.progressTimer) {
    window.clearInterval(active.progressTimer);
    active.progressTimer = null;
  }
}

function updateChatActivityProgress(progress) {
  const pendingLine = document.querySelector(".message.pending .subagent-pending-line");
  if (pendingLine) pendingLine.textContent = formatLocalModelReferences(progress.detail) || progress.label || "Working";
  const agentPanel = document.querySelector(".message.pending [data-agent-progress]");
  if (agentPanel) {
    const snapshot = JSON.stringify(progress.agents ?? []);
    if (agentPanel.dataset.snapshot !== snapshot) {
      const openAgents = new Set([...agentPanel.querySelectorAll("details[open]")].map((item) => item.dataset.agentId));
      agentPanel.innerHTML = renderAgentProgress(progress.agents ?? []);
      agentPanel.querySelectorAll("details").forEach((item) => { item.open = openAgents.has(item.dataset.agentId); });
      agentPanel.dataset.snapshot = snapshot;
    }
  }
  const bar = document.querySelector(".chat-activity-bar");
  if (!bar) {
    return;
  }

  const label = bar.querySelector(".activity-label");
  const detail = bar.querySelector(".activity-model");
  if (label) {
    label.textContent = progress.label || "Working";
  }
  if (detail) {
    detail.textContent = formatLocalModelReferences(progress.detail) || "Processing";
  }
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
  const providerScore = isLocalProvider(agent.providerId)
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
      data-session-id="${escapeAttr(state.activeSessionId)}" data-setup-mode="${escapeAttr(setupMode)}"
    >
      <div class="session-resize-handle" data-action="resize-right-panel" title="Resize panel"></div>
      ${reviewPanel.tabs()}
      <div id="session-setup-body" class="chat-settings__body">
        <div class="chat-type-bar">
          ${["general", "code", "hypothesis"].map((mode) => `
            <button
              class="chat-type-button ${setupMode === mode ? "active" : ""}"
              type="button"
              data-action="set-chat-type"
              data-chat-type="${mode}"
            >${escapeHtml(capitalize(mode))}</button>
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

	          </div>
	        </section>

        ${setupMode === "hypothesis"
          ? renderHypothesisSetup(settings, providerOptions)
          : renderSubagentSetup(settings, providerOptions)}
        <div class="subtle setup-save-status" data-autosave-status aria-live="polite">${escapeHtml(autosaveStatusLabel(state.ui.autosaveStatus))}</div>
      </div>
    </form>
  `;
}

function renderChatRightPanel(settings, currentSession, providerOptions) {
  return reviewPanel.render() || renderSessionSetupPanel(settings, currentSession, providerOptions);
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
        <button class="ghost-button" type="button" data-action="add-code-agent" aria-label="Add subagent" title="Add subagent" ${subagents.length >= 4 ? "disabled" : ""}>${icon("plus")}</button>
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
        <button class="ghost-button" type="button" data-action="add-hypothesis-agent" aria-label="Add advisor" title="Add advisor" ${agents.length >= MAX_HYPOTHESIS_AGENTS ? "disabled" : ""}>${icon("plus")}</button>
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
  const seenAdvisorIds = new Set();
  const seenAdvisorNames = new Set();
  const advisors = merged.filter((agent) => {
    if (agent.role !== "advisor") {
      return false;
    }

    const id = String(agent.id || "").trim();
    const name = String(agent.name || "").trim().toLowerCase();
    if ((id && seenAdvisorIds.has(id)) || (name && seenAdvisorNames.has(name))) {
      return false;
    }

    if (id) {
      seenAdvisorIds.add(id);
    }
    if (name) {
      seenAdvisorNames.add(name);
    }
    return true;
  });

  return [
    byRole.get("support") ?? fallback[0],
    byRole.get("attack") ?? fallback[1],
    byRole.get("judge") ?? fallback[2],
    ...advisors.slice(0, MAX_HYPOTHESIS_ADVISORS)
  ];
}

function renderOrchestrationRoute() {
  const workflows = state.bootstrap?.workflows ?? [];
  const tasks = state.bootstrap?.tasks ?? [];
  const schedules = state.bootstrap?.schedules ?? [];
  const workflowRuns = state.bootstrap?.workflowRuns ?? [];
  const workflowDraft = ensureWorkflowBuilderDraft(workflows);
  const selectedRunId = state.activeWorkflowRunId;
  const selectedRun = state.workflowRunDetail?.run?.id === selectedRunId
    ? state.workflowRunDetail.run
    : workflowRuns.find((run) => run.id === selectedRunId);
  const activeTab = state.orchestrationTab === "workflow" ? "workflow" : "tasks";

  return `
    <div class="orchestration-shell">
      <div class="orchestration-tabs">
        <div class="segmented-control">
          <button class="orchestration-tab ${activeTab === "tasks" ? "active" : ""}" type="button" data-action="set-orchestration-tab" data-orchestration-tab="tasks">${icon("orchestration")}Tasks</button>
          <button class="orchestration-tab ${activeTab === "workflow" ? "active" : ""}" type="button" data-action="set-orchestration-tab" data-orchestration-tab="workflow">${icon("workflow")}Workflow</button>
        </div>
        <div class="orchestration-toolbar-actions">
          ${activeTab === "tasks" ? `<label class="task-search">${icon("search")}<input id="task-search" type="search" aria-label="Search tasks" placeholder="Search tasks" value="${escapeAttr(state.ui.taskSearch)}" /></label>
          <button class="ghost-button" type="button" data-action="toggle-task-panel" data-panel="schedules">${icon("clock")}Schedules <span class="quiet-count">${schedules.length}</span></button>
          <button class="primary-button" type="button" data-action="toggle-task-panel" data-panel="task-create">${icon("plus")}New task</button>` : ""}
          ${activeTab === "workflow" ? `<button class="ghost-button workflow-side-toggle ${state.ui.workflowSideCollapsed ? "" : "is-active"}" type="button" data-action="toggle-workflow-side" aria-label="Toggle workflows panel" aria-expanded="${!state.ui.workflowSideCollapsed}" aria-controls="workflow-side-panel" title="${state.ui.workflowSideCollapsed ? "Show workflows and run trace" : "Hide workflows and run trace"}">${icon("sidebar")}<span>Workflows &amp; trace</span></button>` : ""}
          <button class="ghost-button refresh-button" type="button" data-action="refresh-orchestration" title="Refresh" aria-label="Refresh orchestration">${icon("refresh")}<span>Refresh</span></button>
        </div>
      </div>
      ${
        activeTab === "workflow"
          ? renderWorkflowOrchestrationTab(workflows, workflowDraft, selectedRun)
          : renderTasksOrchestrationTab(workflows, tasks, workflowRuns, schedules)
      }
    </div>
  `;
}

function renderTasksOrchestrationTab(workflows, tasks, workflowRuns, schedules) {
  const defaultWorkflowId = workflows[0]?.id ?? "default-task-workflow";

  return `
    <div class="orchestration-layout orchestration-layout--tasks">
      <details class="panel orchestration-intake task-disclosure" data-ui-disclosure="task-create">
        <summary><span>New task</span>${icon("close")}</summary>
        <p class="subtle">Add a task to your queue.</p>
        <form id="task-form" class="form-grid">
          <div class="field">
            <label for="task-title">Title</label>
            <input id="task-title" name="title" type="text" placeholder="Implement provider adapter" required />
          </div>
          <div class="field">
            <label for="task-priority">Priority</label>
            <select id="task-priority" name="priority">
              ${option("normal", "normal", "Normal")}
              ${option("high", "normal", "High")}
              ${option("low", "normal", "Low")}
            </select>
          </div>
          <div class="field field--full">
            <label for="task-workflow">Workflow</label>
            <select id="task-workflow" name="workflowId">
              ${
                workflows.length
                  ? workflows.map((workflow) => option(workflow.id, defaultWorkflowId, `${workflow.name} v${workflow.version}`)).join("")
                  : option("default-task-workflow", "default-task-workflow", "Default Task Workflow")
              }
            </select>
          </div>
          ${renderWorkspaceFields("task")}
          <div class="field field--full">
            <label for="task-description">Description</label>
            <textarea id="task-description" name="description" rows="5" placeholder="Describe the expected outcome, constraints, files, and verification." required></textarea>
          </div>
          <div class="field field--full">${renderTaskAttachments(null)}</div>
          <div class="footer-row field--full">
            <span class="subtle">${tasks.length} tasks · ${workflowRuns.length} runs · ${schedules.length} schedules</span>
            <button class="primary-button" type="submit" ${state.loading || state.attachmentImports["task:new"] ? "disabled" : ""}>Create Task</button>
          </div>
        </form>
      </details>

      <section class="panel orchestration-main">
        <div class="card-header">
          <div>
            <h2>Tasks</h2>
            <p class="subtle">Your workspace, one task at a time.</p>
          </div>
          <button class="ghost-button" type="button" data-action="run-next-task" ${state.loading || Object.keys(state.attachmentImports).some((key) => key.startsWith("task:")) ? "disabled" : ""}>${icon("play")}Run next</button>
        </div>
        ${renderTaskBoard(tasks)}
      </section>

      <details class="panel schedule-panel task-disclosure" data-ui-disclosure="schedules">
        <summary><span>Schedules</span>${icon("close")}</summary>
        <div class="schedule-panel__intake">
          <div class="card-header">
            <div>
              <h2>Scheduled Task</h2>
              <p class="subtle">Creates a fresh task daily or weekly while this app is running.</p>
            </div>
          </div>
          <form id="schedule-form" class="form-grid">
            <div class="field field--full">
              <label for="schedule-title">Task title</label>
              <input id="schedule-title" name="title" type="text" placeholder="Market analysis" required />
            </div>
            <div class="field">
              <label for="schedule-frequency">Repeats</label>
              <select id="schedule-frequency" name="frequency">
                <option value="daily" selected>Every day</option>
                <option value="weekly">Every week</option>
              </select>
            </div>
            <div class="field" data-schedule-weekday-field hidden>
              <label for="schedule-weekday">Every week on</label>
              <select id="schedule-weekday" name="weekday">
                <option value="1" selected>Monday</option>
                <option value="2">Tuesday</option>
                <option value="3">Wednesday</option>
                <option value="4">Thursday</option>
                <option value="5">Friday</option>
                <option value="6">Saturday</option>
                <option value="0">Sunday</option>
              </select>
            </div>
            <div class="field">
              <label for="schedule-time" data-schedule-time-label>Every day at</label>
              <input id="schedule-time" name="time" type="time" value="09:00" required />
            </div>
            <div class="field field--full">
              <label for="schedule-timezone">Timezone</label>
              <input id="schedule-timezone" name="timezone" type="text" value="${escapeAttr(DEFAULT_SCHEDULE_TIMEZONE)}" placeholder="Europe/Kyiv" required />
            </div>
            <div class="field">
              <label for="schedule-priority">Priority</label>
              <select id="schedule-priority" name="priority">
                ${option("normal", "normal", "Normal")}
                ${option("high", "normal", "High")}
                ${option("low", "normal", "Low")}
              </select>
            </div>
            <div class="field">
              <label for="schedule-workflow">Workflow</label>
              <select id="schedule-workflow" name="workflowId">
                ${
                  workflows.length
                    ? workflows.map((workflow) => option(workflow.id, defaultWorkflowId, `${workflow.name} v${workflow.version}`)).join("")
                    : option("default-task-workflow", "default-task-workflow", "Default Task Workflow")
                }
              </select>
            </div>
            ${renderWorkspaceFields("schedule")}
            <div class="field field--full">
              <label for="schedule-description">Task description</label>
              <textarea id="schedule-description" name="description" rows="4" placeholder="Describe the analysis, sources, expected result, and constraints." required></textarea>
            </div>
            <div class="footer-row field--full">
              <span class="subtle">Missed time triggers one catch-up run when the app starts again.</span>
              <button id="schedule-submit" class="primary-button" type="submit" ${state.loading ? "disabled" : ""}>Create Daily Schedule</button>
            </div>
          </form>
        </div>
        <div class="schedule-panel__list">
          <div class="card-header compact-header">
            <div>
              <h3>Active schedules</h3>
              <p class="subtle">Pause or delete a schedule at any time.</p>
            </div>
          </div>
          ${renderScheduleList(schedules)}
        </div>
      </details>
    </div>
  `;
}

function renderWorkflowOrchestrationTab(workflows, workflowDraft, selectedRun) {
  const sideCollapsed = state.ui.workflowSideCollapsed;
  const sideWidth = Math.max(280, state.ui.workflowSideWidth || 300);

  return `
    <div class="workflow-view">
          <div class="card-header workflow-view__header">
            <div>
              <h2>Workflow editor</h2>
              <p class="subtle">Connect steps. Shape how your agents work.</p>
            </div>
            <div class="task-actions">
              <button class="ghost-button" type="button" data-action="new-workflow">New</button>
              <button class="ghost-button" type="button" data-action="duplicate-workflow">Duplicate</button>
              <button class="ghost-button" type="button" data-action="validate-workflow">Validate</button>
              <button class="primary-button" type="button" data-action="save-workflow" ${state.loading ? "disabled" : ""}>Save</button>
            </div>
          </div>
      <div class="orchestration-layout orchestration-layout--workflow ${sideCollapsed ? "orchestration-layout--workflow-side-collapsed" : ""}" style="--workflow-side-width: ${sideWidth}px;">
      <section class="orchestration-main">
        <div class="panel workflow-builder-panel">
          ${renderWorkflowBuilder(workflowDraft)}
        </div>
      </section>

      <aside id="workflow-side-panel" class="panel orchestration-side workflow-side-panel" ${sideCollapsed ? "hidden" : ""}>
        <div class="workflow-side-resize-handle" data-action="resize-workflow-side" title="Resize workflow panel"></div>
        <div class="workflow-side-content">
          <div class="card-header">
            <div>
              <h2>Workflows</h2>
              <p class="subtle">Definitions available for task execution.</p>
            </div>
          </div>
          <div class="workflow-list">
            ${workflows.length ? workflows.map(renderWorkflowCard).join("") : `<div class="empty">No workflows configured.</div>`}
          </div>

          <div class="card-header run-header">
            <div>
              <h2>Run Trace</h2>
              <p class="subtle">${selectedRun ? `${selectedRun.workflowId} v${selectedRun.workflowVersion}` : "Select Trace on a task card."}</p>
            </div>
            ${
              selectedRun
                ? `<div class="task-actions">
                    <button class="ghost-button" type="button" data-action="step-workflow-run" data-run-id="${escapeAttr(selectedRun.id)}" ${state.loading || ["running", "waiting", "interrupted", "done", "failed", "cancelled", "blocked"].includes(selectedRun.status) ? "disabled" : ""}>Step</button>
                    ${
                      ["done", "failed", "cancelled"].includes(selectedRun.status)
                        ? ""
                        : `<button class="ghost-button" type="button" data-action="cancel-workflow-run" data-run-id="${escapeAttr(selectedRun.id)}" ${state.loading ? "disabled" : ""}>Cancel</button>`
                    }
                  </div>`
                : ""
            }
          </div>
          ${renderWorkflowRunTrace(selectedRun)}
        </div>
      </aside>
      </div>
    </div>
  `;
}

const TASK_STATUS_COLUMNS = [
  ["todo", "Todo"],
  ["in_progress", "In Progress"],
  ["done", "Done"]
];

const TASK_STATUS_GROUPS = {
  todo: new Set(["todo", "backlog", "queued"]),
  in_progress: new Set(["in_progress", "running", "waiting", "interrupted", "blocked", "failed"]),
  done: new Set(["done", "cancelled"])
};

function renderTaskBoard(tasks) {
  return `
    <div class="task-board">
      ${TASK_STATUS_COLUMNS.map(([status, label]) => {
        const columnTasks = tasks.filter((task) => getTaskBoardStatus(task) === status);

        return `
          <section class="task-column" data-drop-status="${escapeAttr(status)}">
            <div class="task-column__header">
              <strong><span class="column-dot column-dot--${status}"></span>${label}</strong>
              <span>${columnTasks.length}</span>
            </div>
            <div class="task-list">
              ${columnTasks.length ? columnTasks.map(renderTaskCard).join("") : `<div class="empty compact">No tasks.</div>`}
              <div class="empty compact task-filter-empty" role="status" hidden>No matching tasks.</div>
            </div>
            ${status === "todo" ? `<button class="add-task-inline" type="button" data-action="toggle-task-panel" data-panel="task-create">${icon("plus")}Add task</button>` : ""}
          </section>
        `;
      }).join("")}
    </div>
  `;
}

function workspaceHint(projectId) {
  const project = (state.bootstrap?.projects ?? []).find(item => item.id === projectId);
  return project ? project.rootPath : "Uses a separate, persistent task folder. Files stay available after the run.";
}

function renderWorkspaceFields(prefix, value = {}, disabled = false) {
  return `<div class="field">
    <div class="workspace-project-label"><label for="${escapeAttr(prefix)}-project">Project</label><button id="${escapeAttr(prefix)}-add-project" class="icon-button" type="button" data-action="add-workspace-project" data-project-select-id="${escapeAttr(prefix)}-project" aria-label="Add project" title="Add project" ${disabled ? "disabled" : ""}>${icon("plus")}</button></div>
    <select id="${escapeAttr(prefix)}-project" name="projectId" data-workspace-project aria-describedby="${escapeAttr(prefix)}-workspace-hint" ${disabled ? "disabled" : ""}>${projectOptions(state.bootstrap?.projects, value.projectId)}</select>
  </div><div class="field">
    <label for="${escapeAttr(prefix)}-access">Access</label>
    <select id="${escapeAttr(prefix)}-access" name="accessMode" ${disabled ? "disabled" : ""}>${ACCESS_MODES.map(mode => option(mode.id, value.accessMode || "default", mode.label)).join("")}</select>
  </div><p class="field--full workspace-hint" id="${escapeAttr(prefix)}-workspace-hint" data-workspace-hint>${escapeHtml(workspaceHint(value.projectId))}</p>`;
}

function renderWorkspaceEditor(kind, value) {
  const running = kind === "task" && ["in_progress", "running", "waiting", "interrupted"].includes(value.status);
  const workspace = state.taskWorkspaces[value.id];
  return `<form id="${kind}-workspace-${escapeAttr(value.id)}" class="form-grid workspace-fields workspace-edit-form" data-workspace-kind="${kind}" data-workspace-id="${escapeAttr(value.id)}">
    ${renderWorkspaceFields(`${kind}-${value.id}`, value, running)}
    <div class="field--full task-workspace-actions"><button class="ghost-button" type="submit" ${running || state.loading ? "disabled" : ""}>Save workspace</button>${kind === "task" ? `<button class="ghost-button" type="button" data-action="open-task-folder" data-task-id="${escapeAttr(value.id)}">${icon("folder")}Open folder</button>` : ""}</div>
    ${running ? '<p class="field--full workspace-hint">This run keeps the workspace chosen when it started.</p>' : ""}
    ${kind === "task" ? `<span class="field--full task-workspace-path" data-task-workspace-path="${escapeAttr(value.id)}">${escapeHtml(workspace?.rootPath || "")}</span>` : ""}
  </form>`;
}

function bindWorkspaceForms() {
  document.querySelectorAll("[data-action='add-workspace-project']").forEach(button => button.addEventListener("click", () => {
    if (button.disabled || state.loading) return;
    projectsUi.openCreateProject(project => selectCreatedWorkspaceProject(button.dataset.projectSelectId, project));
  }));
  document.querySelectorAll("[data-workspace-project]").forEach(select => select.addEventListener("change", () => {
    const hint = select.closest("form")?.querySelector("[data-workspace-hint]");
    if (hint) hint.textContent = workspaceHint(select.value);
  }));
  document.querySelectorAll(".workspace-edit-form").forEach(form => {
    const taskId = form.dataset.workspaceId;
    const kind = form.dataset.workspaceKind;
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (state.loading) return;
      const data = new FormData(form);
      await runAction(async () => {
        const payload = { projectId: String(data.get("projectId") || "") || null, accessMode: String(data.get("accessMode") || "default") };
        if (kind === "task") { await api.updateTask(taskId, payload); delete state.taskWorkspaces[taskId]; }
        else await api.updateSchedule(taskId, payload);
        await refreshBootstrap();
        if (kind === "task") state.taskWorkspaces[taskId] = await api.getTaskWorkspace(taskId);
        pushToast("Workspace saved.", "info");
      });
    });
    if (kind === "task") {
      const disclosure = form.closest("details");
      disclosure?.addEventListener("toggle", async () => {
        if (!disclosure.open || state.taskWorkspaces[taskId]) return;
        try {
          const workspace = await api.getTaskWorkspace(taskId);
          state.taskWorkspaces[taskId] = workspace;
          const path = document.querySelector(`[data-task-workspace-path="${CSS.escape(taskId)}"]`);
          if (path) path.textContent = workspace.rootPath;
        } catch (error) { pushToast(error.message, "danger"); }
      });
    }
  });
  document.querySelectorAll("[data-action='open-task-folder']").forEach(button => button.addEventListener("click", async () => {
    button.disabled = true;
    try { await api.revealTaskWorkspace(button.dataset.taskId); }
    catch (error) { pushToast(error.message, "danger"); }
    finally { button.disabled = false; }
  }));
}

function selectCreatedWorkspaceProject(selectId, project) {
  // Polling can replace the form while the dialog is open, so find its current control.
  const select = document.getElementById(selectId);
  if (!select) return;
  select.innerHTML = projectOptions(state.bootstrap?.projects, project.id);
  select.value = project.id;
  select.dispatchEvent(new Event("change"));
  // createProjectsUi renders after this callback; presentation capture keeps every draft field.
}

function renderTaskCard(task) {
  const workflow = (state.bootstrap?.workflows ?? []).find((item) => item.id === task.workflowId);
  const canRun = getTaskBoardStatus(task) === "todo" || ["blocked", "failed"].includes(task.status);

  return `
    <article class="task-card priority-${escapeAttr(task.priority)}" draggable="true" data-task-id="${escapeAttr(task.id)}" data-search-text="${escapeAttr(`${task.title} ${task.description || ""}`.toLowerCase())}">
      <div class="task-card__top">
        <span class="badge ${statusTone(task.status)}">${escapeHtml(task.status)}</span>
        <span class="task-priority">${escapeHtml(task.priority)}</span>
      </div>
      <h3>${escapeHtml(task.title)}</h3>
      <p>${escapeHtml(task.description || "No description.")}</p>
      <details class="task-card-details" data-ui-disclosure="task-${escapeAttr(task.id)}"><summary>Details</summary><div class="task-model-line">Models: ${escapeHtml(getWorkflowTargetSummary(workflow))}</div>
      <div class="task-meta">
        <span>${escapeHtml(workflow?.name ?? task.workflowId)}</span>
        <span>${task.scheduledFor ? `Scheduled ${formatDate(task.scheduledFor)}` : formatDate(task.updatedAt)}</span>
      </div>${renderWorkspaceEditor("task", task)}${renderTaskAttachments(task)}</details>
      <div class="task-actions task-actions--card">
        <div class="task-actions__primary">
          ${canRun ? `<button class="primary-button" type="button" data-action="run-task" data-task-id="${escapeAttr(task.id)}" ${state.loading || state.attachmentImports[`task:${task.id}`] ? "disabled" : ""}>Run</button>` : ""}
          ${
            task.lastRunId
              ? `<button class="ghost-button" type="button" data-action="select-workflow-run" data-run-id="${escapeAttr(task.lastRunId)}">Trace</button>`
              : ""
          }
        </div>
        <button class="ghost-button task-delete-button" type="button" data-action="delete-task" data-task-id="${escapeAttr(task.id)}">Delete</button>
      </div>
    </article>
  `;
}

function renderScheduleList(schedules) {
  if (!schedules.length) {
    return `<div class="empty compact">No schedules yet.</div>`;
  }

  return `<div class="schedule-list">${schedules.map(renderScheduleCard).join("")}</div>`;
}

function renderScheduleCard(schedule) {
  const workflow = (state.bootstrap?.workflows ?? []).find((item) => item.id === schedule.workflowId);
  const status = schedule.enabled ? "active" : "paused";

  return `
    <article class="schedule-card ${schedule.enabled ? "" : "schedule-card--paused"}">
      <div class="task-card__top">
        <span class="badge ${schedule.enabled ? "success" : "danger"}">${status}</span>
        <span class="task-priority">${escapeHtml(formatScheduleCadence(schedule))}</span>
      </div>
      <h3>${escapeHtml(schedule.title)}</h3>
      <p>${escapeHtml(schedule.description || "No description.")}</p>
      <div class="task-model-line">Models: ${escapeHtml(getWorkflowTargetSummary(workflow))}</div>
      <div class="task-meta">
        <span>Next: ${formatDate(schedule.nextRunAt)}</span>
        <span>${schedule.lastRunAt ? `Last: ${formatDate(schedule.lastRunAt)}` : "Not run yet"}</span>
      </div>
      <details class="task-card-details" data-ui-disclosure="schedule-${escapeAttr(schedule.id)}"><summary>Workspace</summary>${renderWorkspaceEditor("schedule", schedule)}</details>
      ${schedule.lastError ? `<p class="schedule-error">Last error: ${escapeHtml(schedule.lastError)}</p>` : ""}
      <div class="task-actions task-actions--card">
        <button class="ghost-button" type="button" data-action="toggle-schedule" data-schedule-id="${escapeAttr(schedule.id)}" ${state.loading ? "disabled" : ""}>${schedule.enabled ? "Pause" : "Resume"}</button>
        <button class="ghost-button task-delete-button" type="button" data-action="delete-schedule" data-schedule-id="${escapeAttr(schedule.id)}" ${state.loading ? "disabled" : ""}>Delete</button>
      </div>
    </article>
  `;
}

function formatScheduleCadence(schedule) {
  if (schedule.frequency === "weekly") {
    const weekday = SCHEDULE_WEEKDAYS[Number(schedule.weekday)] || "day not set";
    return `weekly · ${weekday} · ${schedule.time} · ${schedule.timezone}`;
  }

  return `daily · ${schedule.time} · ${schedule.timezone}`;
}

function getTaskBoardStatus(task) {
  for (const [status, aliases] of Object.entries(TASK_STATUS_GROUPS)) {
    if (aliases.has(task.status)) {
      return status;
    }
  }

  return "todo";
}

function renderWorkflowCard(workflow) {
  const draft = state.workflowBuilder?.draft;
  const isActive = draft?.id === workflow.id && draft?.version === workflow.version;

  return `
    <article class="workflow-card ${isActive ? "active" : ""}">
      <div class="workflow-card__title">
        <strong>${escapeHtml(workflow.name)}</strong>
        <span>v${escapeHtml(workflow.version)}</span>
      </div>
      <p>${escapeHtml(workflow.description || "No description.")}</p>
      <div class="workflow-graph">
        ${workflow.nodes.map(renderWorkflowNodeChip).join("")}
      </div>
      <div class="workflow-transitions">
        ${workflow.transitions.map((transition) => `<span>${escapeHtml(transition.from)} -> ${escapeHtml(transition.to)}</span>`).join("")}
      </div>
      <div class="task-actions">
        <button class="ghost-button" type="button" data-action="edit-workflow" data-workflow-id="${escapeAttr(workflow.id)}" data-workflow-version="${escapeAttr(workflow.version)}">Edit</button>
        <button class="ghost-button" type="button" data-action="duplicate-workflow-card" data-workflow-id="${escapeAttr(workflow.id)}" data-workflow-version="${escapeAttr(workflow.version)}">Duplicate</button>
      </div>
    </article>
  `;
}

const WORKFLOW_NODE_TYPES = [
  "entry",
  "agent",
  "file_search",
  "web_search",
  "file_write",
  "command",
  "decision",
  "tool",
  "human_review",
  "terminal"
];
const WORKFLOW_GUARD_TYPES = ["always", "status", "event", "json_path"];
const WORKFLOW_NODE_STATUSES = ["ok", "failed", "blocked", "needs_input"];

function renderWorkflowBuilder(workflow) {
  if (!workflow) {
    return `<div class="empty">No workflow draft available.</div>`;
  }

  return `<div id="workflow-graph-editor" class="workflow-graph-editor" aria-label="Visual workflow editor" aria-busy="${state.loading}" ${state.loading ? "inert" : ""}></div>`;
}

function unmountWorkflowEditor() {
  workflowEditorMountGeneration += 1;
  workflowEditorHandle?.unmount?.();
  workflowEditorHandle = null;
}

async function mountActiveWorkflowEditor() {
  const container = document.querySelector("#workflow-graph-editor");
  const workflow = state.workflowBuilder?.draft;

  if (!container || !workflow || state.route !== "orchestration" || state.orchestrationTab !== "workflow") {
    return;
  }

  const generation = workflowEditorMountGeneration;
  container.innerHTML = `<div class="empty compact">Loading visual workflow editor...</div>`;

  try {
    workflowEditorModulePromise ??= import("/assets/workflow-editor.js");
    const module = await workflowEditorModulePromise;

    if (generation !== workflowEditorMountGeneration || !container.isConnected) {
      return;
    }

    const providers = getProviderOptions().map((provider) => ({
      ...provider,
      models: getSelectableSessionModels(provider.id, getProviderConfiguredModel(provider.id)),
      defaultModel: getProviderConfiguredModel(provider.id),
      installedOnly: provider.id === "llamacpp",
      modelLabels: Object.fromEntries(getModelOptions(provider.id).map((modelId) => [modelId, getModelDisplayName(provider.id, modelId)]))
    }));

    container.innerHTML = "";
    workflowEditorHandle = module.mountWorkflowEditor(container, {
      workflow: cloneWorkflow(workflow),
      providers,
      validation: state.workflowBuilder?.validation ?? null,
      nodeRuns: getActiveWorkflowNodeRuns(workflow.id),
      colorMode: resolveTheme(state.ui.theme),
      onChange: (nextWorkflow) => {
        state.workflowBuilder.draft = cloneWorkflow(nextWorkflow);
        state.workflowBuilder.validation = null;
      }
    });
  } catch (error) {
    container.innerHTML = `<div class="status-block danger"><div class="status-block__label">Editor failed to load</div><div class="status-block__text">${escapeHtml(error instanceof Error ? error.message : "Unknown error")}</div></div>`;
  }
}

function renderWorkflowNodeEditor(node, index) {
  const isAgent = node.type === "agent";
  const providerId = String(node.config?.providerId ?? "");
  const model = String(node.config?.model ?? "");
  const fallbackTarget = getWorkflowFallbackTarget();
  const providerOptions = [
    {
      id: "",
      name: `Task/session default (${formatProviderTarget(fallbackTarget.providerId, fallbackTarget.model)})`
    },
    ...getProviderOptions()
  ];

  return `
    <article class="workflow-editor-card" data-node-index="${index}">
      <div class="workflow-builder-grid node-grid">
        <div class="field">
          <label>Node ID</label>
          <input name="node-id-${index}" type="text" value="${escapeAttr(node.id)}" required />
        </div>
        <div class="field">
          <label>Label</label>
          <input name="node-label-${index}" type="text" value="${escapeAttr(node.label)}" required />
        </div>
        <div class="field">
          <label>Type</label>
          <select name="node-type-${index}">
            ${WORKFLOW_NODE_TYPES.map((type) => option(type, node.type, type)).join("")}
          </select>
        </div>
        <div class="field">
          <label>X</label>
          <input name="node-x-${index}" type="number" value="${escapeAttr(node.position?.x ?? 0)}" />
        </div>
        <div class="field">
          <label>Y</label>
          <input name="node-y-${index}" type="number" value="${escapeAttr(node.position?.y ?? 0)}" />
        </div>
        ${
          isAgent
            ? `<div class="field">
                <label>Provider</label>
                <select name="node-provider-${index}">
                  ${providerOptions.map((item) => option(item.id, providerId, item.name)).join("")}
                </select>
              </div>
              <div class="field">
                <label>Model</label>
                ${renderWorkflowModelControl(index, providerId, model, fallbackTarget)}
              </div>`
            : ""
        }
        <div class="field field--full">
          <label>Config JSON</label>
          <textarea name="node-config-${index}" rows="4">${escapeHtml(JSON.stringify(getNodeEditableConfig(node), null, 2))}</textarea>
        </div>
      </div>
      <div class="footer-row">
        <span class="subtle">${escapeHtml(node.type)} node</span>
        <button class="ghost-button" type="button" data-action="delete-workflow-node" data-node-index="${index}">Delete</button>
      </div>
    </article>
  `;
}

function getNodeEditableConfig(node) {
  const config = { ...(node.config ?? {}) };
  delete config.providerId;
  delete config.model;
  return config;
}

function renderWorkflowModelControl(index, providerId, model, fallbackTarget) {
  const effectiveProviderId = providerId || fallbackTarget.providerId;
  const defaultModel = getProviderConfiguredModel(effectiveProviderId) || fallbackTarget.model || "";
  const options = getSelectableSessionModels(effectiveProviderId, model, defaultModel);
  const placeholder = defaultModel ? `Provider default: ${getModelDisplayName(effectiveProviderId, defaultModel)}` : "Use provider default";

  if (isLocalProvider(effectiveProviderId)) {
    const unavailable = model && !options.includes(model);
    return `
      <select name="node-model-${index}">
        <option value="">${escapeHtml(placeholder)}</option>
        ${unavailable ? `<option value="${escapeAttr(model)}" selected disabled>${escapeHtml(model)} · unavailable</option>` : ""}
        ${options.map((value) => option(value, model, getModelDisplayName(effectiveProviderId, value))).join("")}
      </select>
      ${unavailable ? '<div class="mm-unavailable-target">The saved model is unavailable. Download it or select an installed model.</div>' : ""}
    `;
  }

  return `
    <input
      name="node-model-${index}"
      list="workflow-node-model-options-${index}"
      value="${escapeAttr(model)}"
      placeholder="${escapeAttr(placeholder)}"
    />
    <datalist id="workflow-node-model-options-${index}">${renderDatalistOptions(options)}</datalist>
  `;
}

function getWorkflowFallbackTarget() {
  const sessionTarget = state.sessionSettings?.defaultTarget;
  const providerId = sessionTarget?.providerId || state.bootstrap?.appSettings?.llm?.defaultProvider || "lmstudio";

  return {
    providerId,
    model: sessionTarget?.model || getProviderConfiguredModel(providerId) || ""
  };
}

function formatProviderTarget(providerId, model) {
  if (providerId === "llamacpp") return model ? `Local models / ${getModelDisplayName(providerId, model)}` : "Local models";
  return model ? `${providerId}/${model}` : providerId || "runtime default";
}

function renderWorkflowTransitionEditor(transition, index, nodes) {
  const guard = transition.guard ?? { type: "always" };

  return `
    <article class="workflow-editor-card" data-transition-index="${index}">
      <div class="workflow-builder-grid transition-grid">
        <div class="field">
          <label>Transition ID</label>
          <input name="transition-id-${index}" type="text" value="${escapeAttr(transition.id)}" required />
        </div>
        <div class="field">
          <label>From</label>
          <select name="transition-from-${index}">
            ${nodes.map((node) => option(node.id, transition.from, node.id)).join("")}
          </select>
        </div>
        <div class="field">
          <label>To</label>
          <select name="transition-to-${index}">
            ${nodes.map((node) => option(node.id, transition.to, node.id)).join("")}
          </select>
        </div>
        <div class="field">
          <label>Priority</label>
          <input name="transition-priority-${index}" type="number" value="${escapeAttr(transition.priority ?? 100)}" />
        </div>
        <div class="field">
          <label>Guard</label>
          <select name="transition-guard-type-${index}">
            ${WORKFLOW_GUARD_TYPES.map((type) => option(type, guard.type, type)).join("")}
          </select>
        </div>
        <div class="field">
          <label>Status</label>
          <select name="transition-status-equals-${index}">
            ${WORKFLOW_NODE_STATUSES.map((status) => option(status, guard.equals, status)).join("")}
          </select>
        </div>
        <div class="field">
          <label>Event</label>
          <input name="transition-event-equals-${index}" type="text" value="${escapeAttr(guard.type === "event" ? guard.equals : "")}" />
        </div>
        <div class="field">
          <label>JSON Path</label>
          <input name="transition-json-path-${index}" type="text" value="${escapeAttr(guard.type === "json_path" ? guard.path : "")}" placeholder="data.score" />
        </div>
        <div class="field">
          <label>JSON Op</label>
          <select name="transition-json-op-${index}">
            ${["exists", "eq", "contains"].map((op) => option(op, guard.op, op)).join("")}
          </select>
        </div>
        <div class="field">
          <label>JSON Value</label>
          <input name="transition-json-value-${index}" type="text" value="${escapeAttr(guard.type === "json_path" && guard.value !== undefined ? JSON.stringify(guard.value) : "")}" />
        </div>
        <div class="field field--full">
          <label>Label</label>
          <input name="transition-label-${index}" type="text" value="${escapeAttr(transition.label || "")}" />
        </div>
      </div>
      <div class="footer-row">
        <span class="subtle">${escapeHtml(transition.from)} -> ${escapeHtml(transition.to)}</span>
        <button class="ghost-button" type="button" data-action="delete-workflow-transition" data-transition-index="${index}">Delete</button>
      </div>
    </article>
  `;
}

function renderWorkflowRunTrace(selectedRun) {
  if (!selectedRun) {
    return `<div class="empty">No run selected.</div>`;
  }

  const detail = state.workflowRunDetail?.run?.id === selectedRun.id ? state.workflowRunDetail : null;
  const nodeRuns = detail?.nodeRuns ?? [];
  const pendingNode = [...nodeRuns].reverse().find(node => node.status === "waiting" && node.nodeId === selectedRun.currentNodeId);
  const approval = pendingNode?.output?.data;
  const approvalId = approval?.permissionRequired ? approval.approvalId : "";
  const workspace = selectedRun.workspace ?? detail?.run?.workspace;

  return `
    <div class="run-trace">
      <div class="status-block ${statusTone(selectedRun.status)}">
        <div class="status-block__label">${escapeHtml(selectedRun.status)}</div>
        <div class="status-block__text">
          Current node: ${escapeHtml(selectedRun.currentNodeId ?? "terminal")} · Updated ${formatDate(selectedRun.updatedAt)}
        </div>
      </div>
      ${
        selectedRun.error
          ? `<div class="status-block danger"><div class="status-block__label">Error</div><div class="status-block__text">${escapeHtml(selectedRun.error)}</div></div>`
          : ""
      }
      ${workspace ? `<div class="run-workspace"><strong>${escapeHtml(workspace.projectName || "Task folder")}</strong><span>${escapeHtml(workspace.rootPath)}</span><button class="ghost-button" type="button" data-action="open-run-folder" data-run-id="${escapeAttr(selectedRun.id)}" data-root-path="${escapeAttr(workspace.rootPath)}">${icon("folder")}Open folder</button></div>` : ""}
      ${selectedRun.status === "interrupted" ? `<p class="workspace-hint">The run was interrupted. Resume continues from its saved checkpoint. Actions with an unknown result are not repeated.</p><button class="primary-button" type="button" data-action="resume-workflow-run" data-run-id="${escapeAttr(selectedRun.id)}" ${state.loading ? "disabled" : ""}>Resume run</button>` : ""}
      ${selectedRun.status === "waiting" ? `${pendingNode ? `<div class="workflow-approval-description"><strong>${escapeHtml(approval?.permissionRequired ? "Permission required" : "Review required")}</strong><p>${escapeHtml(pendingNode.output?.summary || "Review this step before continuing.")}</p>${approval?.details ? `<pre>${escapeHtml(typeof approval.details === "string" ? approval.details : JSON.stringify(approval.details, null, 2))}</pre>` : ""}</div>` : ""}<div class="footer-row">
        <button class="primary-button" type="button" data-action="review-workflow-run" data-run-id="${escapeAttr(selectedRun.id)}" data-approval-id="${escapeAttr(approvalId || "")}" data-waiting-node-run-id="${escapeAttr(pendingNode?.id || "")}" data-approved="true" ${state.loading || !pendingNode || (approval?.permissionRequired && !approvalId) ? "disabled" : ""}>Approve & continue</button>
        <button class="ghost-button" type="button" data-action="review-workflow-run" data-run-id="${escapeAttr(selectedRun.id)}" data-approval-id="${escapeAttr(approvalId || "")}" data-waiting-node-run-id="${escapeAttr(pendingNode?.id || "")}" data-approved="false" ${state.loading || !pendingNode || (approval?.permissionRequired && !approvalId) ? "disabled" : ""}>Reject</button>
      </div>` : ""}
      <div class="run-node-list">
        ${nodeRuns.length ? nodeRuns.map(renderNodeRunCard).join("") : `<div class="empty compact">Open Trace on a task to load node runs.</div>`}
      </div>
    </div>
  `;
}

function getActiveWorkflowNodeRuns(workflowId) {
  const detail = state.workflowRunDetail;
  return detail?.run?.workflowId === workflowId ? detail.nodeRuns ?? [] : [];
}

function renderNodeRunCard(nodeRun) {
  const output = nodeRun.output;
  const target = output?.data?.target;
  const agentRunId = nodeRun.agentRunId || output?.data?.agentRunId;
  const targetLabel = target?.providerId ? formatProviderTarget(target.providerId, target.model) : "";

  return `
    <article class="node-run-card">
      <div class="node-run-card__header">
        <strong>${escapeHtml(nodeRun.nodeId)}</strong>
        <span class="badge ${statusTone(nodeRun.status)}">${escapeHtml(nodeRun.status)}</span>
      </div>
      <p>${["running", "queued"].includes(nodeRun.status) && nodeRun.progress ? '<span class="activity-scan" aria-hidden="true"></span> ' : ""}${escapeHtml(output?.summary ?? nodeRun.error ?? nodeRun.progress?.label ?? "Node is still running.")}</p>
      <div class="task-meta">
        <span>${escapeHtml(targetLabel || output?.event || "no-event")}</span>
        <span>${formatDate(nodeRun.completedAt ?? nodeRun.startedAt)}</span>
      </div>
      ${agentRunId ? `<details class="node-run-output" data-agent-trace="${escapeAttr(agentRunId)}" data-run-id="${escapeAttr(nodeRun.runId)}"><summary>Agent steps</summary><pre data-agent-steps>${escapeHtml(state.workflowAgentTraces[agentRunId] || "Open to load agent steps.")}</pre></details>` : ""}
      ${
        output?.data && Object.keys(output.data).length
          ? `<details class="node-run-output">
              <summary>Output parameters</summary>
              <pre>${escapeHtml(renderNodeOutputData(output.data))}</pre>
            </details>`
          : ""
      }
    </article>
  `;
}

function renderNodeOutputData(data) {
  const serialized = JSON.stringify(data, null, 2);
  return serialized.length > 12000
    ? `${serialized.slice(0, 12000)}\n... output truncated`
    : serialized;
}

function renderWorkflowNodeChip(node) {
  const target = node.type === "agent" ? getAgentNodeTargetLabel(node) : node.type;
  return `<span>${escapeHtml(node.label)} <small>${escapeHtml(target)}</small></span>`;
}

function getWorkflowTargetSummary(workflow) {
  if (!workflow) {
    return "workflow unavailable";
  }

  const targets = workflow.nodes
    .filter((node) => node.type === "agent")
    .map((node) => `${node.label}: ${getAgentNodeTargetLabel(node)}`);

  return targets.length ? targets.join("; ") : "no agent nodes";
}

function getAgentNodeTargetLabel(node) {
  const providerId = String(node.config?.providerId ?? "");
  const model = String(node.config?.model ?? "");

  if (!providerId && !model) {
    return "task/session default";
  }

  return formatProviderTarget(providerId || "session provider", model);
}

function statusTone(status) {
  if (["done", "ok", "success"].includes(status)) {
    return "success";
  }

  if (["todo", "queued"].includes(status)) {
    return "";
  }

  if (["in_progress", "running", "waiting", "interrupted"].includes(status)) {
    return "warning";
  }

  if (["failed", "blocked", "cancelled"].includes(status)) {
    return "danger";
  }

  return "";
}

function ensureWorkflowBuilderDraft(workflows) {
  if (state.workflowBuilder?.draft) {
    return state.workflowBuilder.draft;
  }

  const source = workflows[0] ?? createBlankWorkflow();
  state.workflowBuilder = {
    draft: cloneWorkflow(source),
    validation: null
  };
  return state.workflowBuilder.draft;
}

function createBlankWorkflow() {
  const now = new Date().toISOString();

  return {
    id: `workflow-${Date.now()}`,
    name: "New Workflow",
    version: 1,
    description: "",
    entryNodeId: "entry",
    nodes: [
      {
        id: "entry",
        type: "entry",
        label: "Entry",
        position: { x: 0, y: 0 },
        config: {}
      },
      {
        id: "done",
        type: "terminal",
        label: "Done",
        position: { x: 320, y: 0 },
        config: { runStatus: "done" }
      }
    ],
    transitions: [
      {
        id: "entry-done",
        from: "entry",
        to: "done",
        priority: 100,
        guard: { type: "always" }
      }
    ],
    createdAt: now,
    updatedAt: now
  };
}

function cloneWorkflow(workflow) {
  return JSON.parse(JSON.stringify(workflow));
}

function duplicateWorkflow(workflow) {
  const now = new Date().toISOString();
  const next = cloneWorkflow(workflow);

  next.id = `${workflow.id}-copy-${Date.now()}`;
  next.name = `${workflow.name} Copy`;
  next.version = 1;
  next.createdAt = now;
  next.updatedAt = now;
  return next;
}

function readWorkflowBuilderDraftFromForm() {
  const form = document.querySelector("#workflow-builder-form");

  if (!form) {
    const draft = state.workflowBuilder?.draft ?? createBlankWorkflow();
    return {
      ...cloneWorkflow(draft),
      updatedAt: new Date().toISOString()
    };
  }

  const data = new FormData(form);
  const existing = state.workflowBuilder?.draft ?? createBlankWorkflow();
  const nodes = [...form.querySelectorAll("[data-node-index]")].map((element) => {
    const index = element.dataset.nodeIndex;
    const type = readFormString(data, `node-type-${index}`, "agent");
    const config = parseJsonField(
      readFormString(data, `node-config-${index}`, "{}"),
      {},
      `Node ${index} config`
    );

    if (type === "agent") {
      const providerId = readFormString(data, `node-provider-${index}`, "").trim();
      const model = readFormString(data, `node-model-${index}`, "").trim();

      if (providerId) {
        config.providerId = providerId;
      } else {
        delete config.providerId;
      }

      if (model) {
        config.model = model;
      } else {
        delete config.model;
      }
    } else {
      delete config.providerId;
      delete config.model;
    }

    return {
      id: readFormString(data, `node-id-${index}`, "node").trim(),
      type,
      label: readFormString(data, `node-label-${index}`, "Node").trim(),
      position: {
        x: readFormNumber(data, `node-x-${index}`, 0),
        y: readFormNumber(data, `node-y-${index}`, 0)
      },
      config
    };
  });
  const transitions = [...form.querySelectorAll("[data-transition-index]")].map((element) => {
    const index = element.dataset.transitionIndex;
    const guardType = readFormString(data, `transition-guard-type-${index}`, "always");

    return {
      id: readFormString(data, `transition-id-${index}`, "transition").trim(),
      from: readFormString(data, `transition-from-${index}`, "").trim(),
      to: readFormString(data, `transition-to-${index}`, "").trim(),
      label: readFormString(data, `transition-label-${index}`, "").trim() || undefined,
      priority: readFormNumber(data, `transition-priority-${index}`, 100),
      guard: buildWorkflowGuard(data, index, guardType)
    };
  });
  const now = new Date().toISOString();

  return {
    ...existing,
    id: readFormString(data, "id", existing.id).trim(),
    name: readFormString(data, "name", existing.name).trim(),
    version: Math.max(1, readFormNumber(data, "version", existing.version ?? 1)),
    description: readFormString(data, "description", "").trim(),
    entryNodeId: readFormString(data, "entryNodeId", nodes[0]?.id ?? "entry").trim(),
    nodes,
    transitions,
    createdAt: existing.createdAt ?? now,
    updatedAt: now
  };
}

function buildWorkflowGuard(data, index, guardType) {
  if (guardType === "status") {
    return {
      type: "status",
      equals: readFormString(data, `transition-status-equals-${index}`, "ok")
    };
  }

  if (guardType === "event") {
    return {
      type: "event",
      equals: readFormString(data, `transition-event-equals-${index}`, "").trim()
    };
  }

  if (guardType === "json_path") {
    const rawValue = readFormString(data, `transition-json-value-${index}`, "").trim();
    const guard = {
      type: "json_path",
      path: readFormString(data, `transition-json-path-${index}`, "").trim(),
      op: readFormString(data, `transition-json-op-${index}`, "exists")
    };

    if (rawValue) {
      guard.value = parseJsonValue(rawValue);
    }

    return guard;
  }

  return { type: "always" };
}

function readFormString(data, key, fallback = "") {
  const value = data.get(key);
  return typeof value === "string" ? value : fallback;
}

function readFormNumber(data, key, fallback = 0) {
  const parsed = Number(readFormString(data, key, String(fallback)));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJsonField(value, fallback, label) {
  if (!value.trim()) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must be valid JSON.`);
  }
}

function parseJsonValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function updateWorkflowDraft(mutator) {
  const draft = readWorkflowDraftOrToast();

  if (!draft) {
    return;
  }

  try {
    mutator(draft);
    state.workflowBuilder = {
      draft,
      validation: null
    };
    render();
  } catch (error) {
    pushToast(error instanceof Error ? error.message : "Workflow edit failed.", "danger");
  }
}

function readWorkflowDraftOrToast() {
  try {
    return readWorkflowBuilderDraftFromForm();
  } catch (error) {
    pushToast(error instanceof Error ? error.message : "Workflow draft is invalid.", "danger");
    return null;
  }
}

function renderModelsRoute() {
  const externalModels = (state.bootstrap?.allManagedModels ?? []).filter((model) => model.providerId !== "llamacpp");
  const providerDefaults = state.bootstrap?.appSettings?.providers ?? {};
  const providers = (state.bootstrap?.providers ?? []).filter((provider) => provider.id !== "llamacpp");
  return `
    <div class="grid">
      ${modelManager.render()}
      <details class="panel mm-legacy-providers" data-ui-disclosure="external-model-providers">
        <summary><div><strong>Connected providers</strong><span class="subtle">Cloud APIs, LM Studio and Ollama · ${providers.length} providers</span></div>${icon("chevronRight")}</summary>
        <div class="mm-legacy-body">
          <div class="runtime-provider-grid">
            ${providers.map((provider) => {
              const status = getRuntimeProviderStatus(provider.id);
              return `<article class="list-item runtime-provider-item"><div class="runtime-provider-head"><strong>${escapeHtml(provider.name)}</strong><span class="badge ${status.tone}">${status.label}</span></div><div class="runtime-provider-meta"><span class="mono">${escapeHtml(providerDefaults[provider.id]?.model ?? provider.defaultModel ?? "No default model")}</span><span class="mono">${escapeHtml(providerDefaults[provider.id]?.baseUrl ?? "")}</span></div>${renderRuntimeProviderQuota(provider.id, status.label)}</article>`;
            }).join("")}
          </div>
          <div class="row-between"><div><h3>External local models</h3><span class="subtle">Manage models in your connected LM Studio and Ollama runtimes.</span></div><button class="ghost-button" data-action="refresh-models">Refresh models</button></div>
          <div class="catalog-grid">${externalModels.map((model) => `<article class="card compact-card catalog-card"><div class="card-header"><div><h3>${escapeHtml(model.displayName || model.id)}</h3><div class="mono">${escapeHtml(model.id)}</div></div><span class="badge ${model.loaded ? "success" : ""}">${escapeHtml(model.providerName || model.providerId)} · ${model.loaded ? "loaded" : "available"}</span></div><div class="subtle">${formatManagedModelSize(model.sizeBytes)}</div><div class="footer-row"><span class="subtle">${model.loaded ? "Ready for chat and workflows." : "Available in the connected runtime."}</span>${model.loaded ? renderModelActionButton("unload", model.loadedInstanceIds?.[0] || model.id, model.providerId, model.id) : renderModelActionButton("load", model.id, model.providerId)}</div></article>`).join("") || '<div class="empty compact">No models found in connected local runtimes.</div>'}</div>
        </div>
      </details>
    </div>
  `;
}

function renderModelActionButton(action, modelId, providerId = "lmstudio", modelKey = modelId) {
  const stateKey = `${action}:${providerId}:${modelId}`;
  const pending = Boolean(state.modelActions[stateKey]);

  if (action === "unload") {
    return `
      <button class="ghost-button danger-button" data-action="unload-model" data-provider-id="${escapeAttr(providerId)}" data-model-id="${escapeAttr(modelId)}" data-model-key="${escapeAttr(modelKey)}" ${pending ? "disabled" : ""}>
        ${pending ? `<span class="button-spinner"></span>Unloading...` : "Unload"}
      </button>
    `;
  }

  return `
    <button class="primary-button" data-action="load-model" data-provider-id="${escapeAttr(providerId)}" data-model-id="${escapeAttr(modelId)}" ${pending ? "disabled" : ""}>
      ${pending ? `<span class="button-spinner"></span>Loading...` : "Load"}
    </button>
  `;
}

function renderLocalModelTestFeedback() {
  if (state.localModelTest) {
    const runtime = state.bootstrap?.localModels?.runtime;
    const phase = runtime?.status === "loading" ? "Loading model into memory"
      : runtime?.status === "stopping" ? "Switching local model"
      : runtime?.queueLength ? `Local runtime busy · ${runtime.queueLength} waiting`
      : runtime?.busy && runtime.modelId === state.localModelTest.model ? "Generating test response"
      : "Preparing model test";
    return `<div class="status-block"><div class="status-block__label">${escapeHtml(phase)}</div><div class="status-block__text">${escapeHtml(getModelDisplayName("llamacpp", state.localModelTest.model))}</div></div>`;
  }
  const result = state.providerTestResults.llamacpp;
  return result ? `<div class="status-block ${providerTestTone(result)}"><div class="status-block__label">${result.ok ? "Model ready" : "Model issue"}</div><div class="status-block__text">${escapeHtml(formatProviderTestResult(result))}</div></div>` : "";
}

function updateLocalModelTestProgress() {
  const feedback = document.querySelector("[data-local-test-feedback]");
  if (feedback) {
    const content = renderLocalModelTestFeedback();
    if (feedback.innerHTML !== content) feedback.innerHTML = content;
  }
  const button = document.querySelector('[data-action="test-provider"][data-provider-id="llamacpp"]');
  if (button) {
    button.disabled = Boolean(state.localModelTest);
    button.textContent = state.localModelTest ? "Testing model…" : "Test model";
  }
}

function renderMessage(message) {
  const copyButton =
    !message.pending
      ? `<button class="ghost-button message-copy-button" type="button" data-action="copy-message" data-message-id="${escapeAttr(message.id)}">Copy</button>`
      : "";
  const footer =
    !message.pending
      ? `
        <div class="message-footer">
          <span class="message-footer-actions">
            ${copyButton}
          </span>
          <span>${escapeHtml(message.role === "assistant" ? renderMessageFooterMeta(message) : "")}</span>
        </div>
      `
      : "";

  const content = message.pending
    ? renderPendingMessageContent(message)
    : renderMessageContent(message);
  const toolCards =
    message.role === "assistant" && !message.pending && message.tools?.length
      ? renderMessageTools(message.tools)
      : "";
  const subagentCards =
    message.role === "assistant" && !message.pending && message.subagents?.length
      ? renderMessageSubagents(message.subagents)
      : "";
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
      <div class="message-content">${toolCards}${subagentCards}${message.role === "assistant" && (message.pending || message.agents?.length) ? `<div data-agent-progress>${renderAgentProgress(message.agents ?? [])}</div>` : ""}${content}</div>
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
    const runtimeMatch = line.match(/^(Delegated agents|Agent status|Final response|Provider|Model):\s*(.+)$/i);
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
  return 205;
}

function renderRuntimeMetaLine(label, value) {
  const isFinalResponse = label.trim().toLowerCase() === "final response";
  const displayValue = label.trim().toLowerCase() === "model" ? formatLocalModelReferences(value) : value;

  return `
    <div class="message-runtime-line ${isFinalResponse ? "is-final-response" : ""}">
      <span>${escapeHtml(label)}</span>
      <strong class="runtime-gradient-text">${escapeHtml(displayValue)}</strong>
    </div>
  `;
}

function renderMessageTools(tools) {
  const cards = tools.map(renderToolCard).filter(Boolean);

  if (!cards.length) {
    return "";
  }

  return `<div class="process-card-stack">${cards.join("")}</div>`;
}

function renderAgentProgress(agents) {
  if (!agents.length) return "";
  const labels = { queued: "Waiting", running: "Working", completed: "Done", degraded: "Failed", cancelled: "Interrupted" };
  return `<div class="agent-progress-stack" aria-live="polite">${agents.map((agent) => `
    <details class="agent-progress-card ${agent.status === "running" ? "is-running" : "is-stopped"}" data-ui-disclosure="agent-${escapeAttr(agent.id)}" data-agent-id="${escapeAttr(agent.id)}" data-status="${escapeAttr(agent.status)}">
      <summary class="agent-progress-header">
        <span class="activity-scan status-dot" aria-hidden="true"><span></span></span>
        <strong>${escapeHtml(agent.name)}</strong>
        <span class="subagent-card__role">${escapeHtml(agent.role)}</span>
        <span class="subagent-card__status">${escapeHtml(labels[agent.status] || agent.status)}</span>
      </summary>
      <div class="agent-progress-detail">${escapeHtml([agent.provider, getModelDisplayName(agent.provider, agent.model), formatLocalModelReferences(agent.phase)].filter(Boolean).join(" · "))}</div>
      ${agent.error ? `<div class="agent-progress-detail">${escapeHtml(agent.error)}</div>` : ""}
    </details>`).join("")}</div>`;
}

function preserveStoppedChatRequest(active, message, status) {
  const pending = state.pendingRequest;
  if (!pending || pending.requestId !== active.requestId || pending.sessionId !== state.activeSessionId) return;
  state.messages.push(
    { id: `${active.requestId}:user`, role: "user", content: pending.input, createdAt: pending.startedAt },
    { id: `${active.requestId}:stopped`, role: "assistant", content: message, createdAt: new Date().toISOString(),
      agents: (pending.progress?.agents ?? []).map((agent) => ["queued", "running"].includes(agent.status)
        ? { ...agent, status, phase: status === "cancelled" ? "Interrupted" : "Failed" } : agent) }
  );
}

function renderMessageSubagents(subagents) {
  const cards = subagents.map(renderSubagentCard).filter(Boolean);

  if (!cards.length) {
    return "";
  }

  return `<div class="subagent-card-stack">${cards.join("")}</div>`;
}

function renderSubagentCard(agent) {
  const roleLabel = agent.role === "advisor" ? "task" : agent.role;
  const status = agent.status === "ok" ? "done" : "degraded";
  const output = String(
    agent.output ||
      agent.error ||
      (agent.status === "degraded"
        ? "Provider request failed or timed out. The collector continued without this output."
        : "No separate output was returned.")
  ).trim();

  return `
    <details class="subagent-card ${agent.status === "ok" ? "is-ok" : "is-degraded"}">
      <summary>
        <span class="subagent-card__name">${renderInlineMessageText(`@${agent.name}`)}</span>
        <span class="subagent-card__role">${escapeHtml(roleLabel)}</span>
        <span class="subagent-card__status">${escapeHtml(status)}</span>
      </summary>
      <div class="subagent-card__meta">
        <span>${escapeHtml(agent.provider || "provider")}</span>
        <span>${escapeHtml(getModelDisplayName(agent.provider, agent.model) || "model")}</span>
        <span>access=${escapeHtml(agent.accessMode || "default")}</span>
      </div>
      <pre class="subagent-card__output">${escapeHtml(output)}</pre>
    </details>
  `;
}

function renderToolCard(tool) {
  if (tool.tool === "file") {
    return renderFileToolCard(tool);
  }

  return `
    <section class="process-card ${tool.ok ? "is-ok" : "is-error"}">
      <div class="process-card__header">
        <span class="process-card__status">${tool.ok ? "✓" : "!"}</span>
        <span class="process-card__title">${escapeHtml(tool.tool || "tool")}</span>
      </div>
      <pre class="process-card__output">${escapeHtml(String(tool.output || ""))}</pre>
    </section>
  `;
}

function renderFileToolCard(tool) {
  const metadata = tool.metadata || {};
  const files = Array.isArray(metadata.files) ? metadata.files : [];
  const operation = metadata.operation || inferFileOperation(metadata);
  const title = metadata.cancelled ? "Action cancelled" : metadata.permissionRequired ? "Permission required" : fileOperationLabel(operation);
  const targetPath = metadata.filePath || metadata.path || metadata.directory || metadata.baseDir;
  const statusLabel = tool.ok ? "done" : metadata.cancelled ? "cancelled" : metadata.permissionRequired ? "needs approval" : "failed";

  if (files.length) {
    return `
      <section class="process-card ${tool.ok ? "is-ok" : "is-error"}">
        <div class="process-card__header">
          <span class="process-card__status">${tool.ok ? "✓" : "!"}</span>
          <span class="process-card__title">Scaffold</span>
          <span class="process-card__meta">${escapeHtml(statusLabel)} · ${files.length} files</span>
        </div>
        ${renderFilePathBar(metadata.baseDir || "project", "Project")}
        ${files.slice(0, 4).map((file) => renderFileDiffBlock(file.filePath, file.diff, file.operation)).join("")}
        ${
          files.length > 4
            ? `<div class="process-card__more">${files.slice(4).map((file) => renderReviewButton(file.filePath, compactPath(file.filePath))).join("")}</div>`
            : ""
        }
      </section>
    `;
  }

  return `
    <section class="process-card ${tool.ok ? "is-ok" : "is-error"}">
      <div class="process-card__header">
        <span class="process-card__status">${tool.ok ? "✓" : "!"}</span>
        <span class="process-card__title">${escapeHtml(title)}</span>
        <span class="process-card__meta">${escapeHtml(statusLabel)}</span>
        ${tool.ok && targetPath && !["delete", "directory", "create directory"].includes(operation) ? renderReviewButton(targetPath) : ""}
      </div>
      ${targetPath ? renderFilePathBar(targetPath, fileOperationLabel(operation), "", false) : ""}
      ${metadata.diff ? renderFileDiffBlock(targetPath, metadata.diff, operation, false) : renderToolOutput(tool.output)}
    </section>
  `;
}

function inferFileOperation(metadata) {
  if (metadata.permissionRequired) {
    return metadata.operation || "access";
  }

  if (metadata.directory) {
    return "directory";
  }

  if (metadata.path) {
    return "delete";
  }

  return "file";
}

function fileOperationLabel(operation) {
  const labels = {
    access: "Access",
    append: "Append",
    "create directory": "Create directory",
    delete: "Delete",
    directory: "List directory",
    file: "File",
    read: "Read",
    write: "Edit"
  };

  return labels[operation] || String(operation || "File");
}

function renderFileDiffBlock(filePath, diff, operation = "write", showPath = true) {
  if (!diff?.preview?.length) {
    return showPath && filePath
      ? `<div class="process-file-block">${renderFilePathBar(filePath, fileOperationLabel(operation), "process-file-block__pathbar")}</div>`
      : "";
  }

  return `
    <div class="process-file-block">
      ${
        showPath && filePath
          ? renderFilePathBar(filePath, fileOperationLabel(operation), "process-file-block__pathbar")
          : ""
      }
      <div class="diff-summary">
        <span class="diff-summary__add">+${Number(diff.added || 0)}</span>
        <span class="diff-summary__remove">-${Number(diff.removed || 0)}</span>
        ${diff.truncated ? `<span class="diff-summary__muted">preview truncated</span>` : ""}
        ${diff.truncated && filePath ? `<button class="ghost-button diff-summary__view" type="button" data-action="open-tool-path" data-path="${escapeAttr(filePath)}">View full</button>` : ""}
      </div>
      <div class="diff-preview">
        ${diff.preview.map(renderDiffRow).join("")}
      </div>
    </div>
  `;
}

function renderFilePathBar(filePath, label = "File", extraClass = "", showReview = true) {
  const value = String(filePath || "");
  const isDirectory = ["Project", "List directory", "Create directory"].includes(label);

  return `
    <div class="process-pathbar ${escapeAttr(extraClass)}">
      <div class="process-pathbar__copy">
        <span>${escapeHtml(label)}</span>
        <code title="${escapeAttr(value)}">${escapeHtml(compactPath(value))}</code>
      </div>
      ${isDirectory ? `
        <div class="process-pathbar__actions">
          <button class="ghost-button process-pathbar__button" type="button" data-action="copy-tool-path" data-path="${escapeAttr(value)}">Copy</button>
          <button class="ghost-button process-pathbar__button" type="button" data-action="reveal-tool-path" data-path="${escapeAttr(value)}">Open</button>
        </div>
      ` : showReview && label !== "Delete" ? renderReviewButton(value) : ""}
    </div>
  `;
}

function renderReviewButton(filePath, label = "Review") {
  return `<button class="ghost-button process-card__review" type="button" data-action="open-tool-path" data-path="${escapeAttr(filePath)}" title="Review ${escapeAttr(filePath)}">${icon("code")} ${escapeHtml(label)}</button>`;
}

function renderDiffRow(row) {
  const prefix = row.type === "add" ? "+" : row.type === "remove" ? "-" : " ";

  return `
    <div class="diff-row diff-row--${escapeAttr(row.type)}">
      <span class="diff-row__line">${escapeHtml(String(row.line || ""))}</span>
      <span class="diff-row__prefix">${prefix}</span>
      <code>${escapeHtml(row.text || "")}</code>
    </div>
  `;
}

function renderToolOutput(output) {
  const text = String(output || "").trim();
  return text ? `<pre class="process-card__output">${escapeHtml(text)}</pre>` : "";
}

function compactPath(value) {
  const pathValue = String(value || "");
  const parts = pathValue.split(/[\\/]/).filter(Boolean);

  if (parts.length <= 4) {
    return pathValue;
  }

  return `.../${parts.slice(-4).join("/")}`;
}

function renderDraftAttachment(attachment, options = {}) {
  return `
    <div class="draft-attachment">
      ${attachment.kind === "image" && attachment.dataUrl ? `<img class="draft-attachment__image" src="${escapeAttr(attachment.dataUrl)}" alt="" />` : ""}
      <div class="draft-attachment__copy">
        <strong>${escapeHtml(attachment.name)}</strong>
        <span>${escapeHtml(renderAttachmentMeta(attachment))}</span>
        ${renderAttachmentWarning(attachment)}
      </div>
      <button class="ghost-button draft-attachment__remove" type="button" data-action="${options.task ? "remove-task-attachment" : "remove-draft-attachment"}" data-attachment-id="${escapeAttr(attachment.id)}" ${options.task ? `data-task-id="${escapeAttr(options.taskId || "")}"` : ""} aria-label="${escapeAttr(`Remove ${attachment.name}`)}" ${options.disabled ? "disabled" : ""}>×</button>
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
        ${renderAttachmentWarning(attachment)}
      </div>
    </div>
  `;
}

function renderAttachmentMeta(attachment) {
  const labels = { "image/png": "PNG image", "image/jpeg": "JPEG image", "image/webp": "WebP image", "application/pdf": "PDF · Extracted text", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX · Extracted text" };
  const extension = attachment.name?.split(".").at(-1);
  const label = labels[attachment.mimeType] || (extension && extension.length <= 8 ? extension.toUpperCase() : attachment.kind === "text" ? "Text" : "File");
  const parts = [label, `${Math.max(1, Math.round(attachment.sizeBytes / 1024))} KB`];
  return parts.join(" · ");
}

function renderAttachmentWarning(attachment) {
  const warning = attachment.warning || (attachment.truncated ? "Text was shortened to fit the attachment limit." : "");
  return warning ? `<span class="attachment-warning">${escapeHtml(warning)}</span>` : "";
}

function renderTaskAttachments(task) {
  const taskId = task?.id || "";
  const pending = Boolean(state.attachmentImports[`task:${taskId || "new"}`]);
  const attachments = task ? task.attachments || [] : state.taskDraftAttachments;
  const running = isTaskAttachmentLocked(task) || state.loading;
  return `<div class="task-attachments"><div class="task-attachments__header"><span class="subtle">Files for this workflow · ${attachments.length}/5</span><button type="button" class="ghost-button" data-action="attach-task-files" data-task-id="${escapeAttr(taskId)}" ${pending || running || attachments.length >= 5 ? "disabled" : ""}>${icon("plus")}${pending ? "Preparing…" : "Attach files"}</button><input type="file" multiple class="sr-only" data-task-attachment-input data-task-id="${escapeAttr(taskId)}" accept="${ATTACHMENT_ACCEPT}" /></div>${attachments.length ? `<div class="composer-attachments task-attachment-list">${attachments.map((attachment) => renderDraftAttachment(attachment, { task: true, taskId, disabled: pending || running })).join("")}</div>` : ""}<div class="subtle attachment-help">PNG, JPEG, WebP, text, PDF or DOCX · Up to 5 files, 5 MB each.${attachments.some((attachment) => attachment.kind === "image") ? " Workflow agents need an image-capable model to read images." : ""}</div></div>`;
}

async function submitChatMessage(input, attachments, options = {}) {
  if (voiceInput.busy(state.activeSessionId)) return;
  if (!input || state.chatSubmitting || state.activeChatRequest || state.accessSaving || state.attachmentImports?.[`chat:${state.activeSessionId}`] || (options.sessionId && options.sessionId !== state.activeSessionId)) {
    return;
  }
  const setupSnapshot = readSessionSetupSnapshot();
  const attachmentGuidance = getImageAttachmentGuidance(attachments, setupSnapshot?.settings || state.sessionSettings);
  if (attachmentGuidance.blocked) { pushToast(attachmentGuidance.message, "danger"); render(); return; }

  const requestId = createUiEntityId("chat");
  const controller = new AbortController();
  const activeRequest = { requestId, controller, cancelled: false, progressTimer: null };
  const sessionId = state.activeSessionId;
  activeRequest.sessionId = sessionId;
  state.activeChatRequest = activeRequest;
  state.chatSubmitting = true;
  const submitButton = document.querySelector("#chat-form button[type='submit']");
  if (submitButton) submitButton.disabled = true;
  let completed = false;
  try {
    window.clearTimeout(state.ui.autosaveTimer);
    await state.ui.autosavePromise.catch(() => undefined);
    await persistActiveSessionSetup({ refreshBootstrap: false, sessionId, snapshot: setupSnapshot });
    if (activeRequest.cancelled || state.activeChatRequest?.requestId !== requestId) return;
    state.route = "chat";
    window.location.hash = "/chat";
    state.pendingRequest = {
      requestId,
      sessionId,
      input,
      startedAt: new Date().toISOString(),
      pendingText: isSubagentRequest(input) ? chooseSubagentPendingText(input) : undefined
    };
    state.activeChatRequest = activeRequest;
    state.chatSubmitting = true;
    if (!options.fromReview) {
      state.drafts[sessionId] = "";
    }
    const wasNearBottom = state.ui.messageStreamPinnedToBottom || isMessageStreamNearBottom();
    render();
    if (wasNearBottom) {
      requestAnimationFrame(() => scrollChatToBottom("auto"));
    }
    startProcessProgressPolling(activeRequest);

    const response = await api.sendChat({
      requestId,
      input,
      sessionId,
      metadata: buildChatAttachmentMetadata(attachments, options.reviewSelection)
    }, controller);
    if (activeRequest.cancelled) {
      return;
    }
    if (!options.fromReview) state.draftAttachments[sessionId] = [];
    completed = true;
    await refreshBootstrap();
    if (state.activeSessionId === sessionId) {
      await loadActiveSession();
      if (reviewPanel.isOpen()) await reviewPanel.refresh();
    }
  } catch (error) {
    if (state.activeChatRequest?.requestId === requestId && !activeRequest.cancelled) {
      const message = error instanceof Error ? error.message : "Action failed";
      preserveStoppedChatRequest(activeRequest, message, "degraded");
      pushToast(message, "danger");
    }
  } finally {
    stopProcessProgressPolling(activeRequest);
    if (state.activeChatRequest?.requestId === requestId) {
      state.activeChatRequest = null;
      state.pendingRequest = null;
      state.chatSubmitting = false;
      render();
      if (state.ui.messageStreamPinnedToBottom) requestAnimationFrame(() => scrollChatToBottom("auto"));
    }
  }
  return completed;
}

function bindEvents() {
  bindWorkspaceForms();
  document.querySelectorAll("[data-action='open-project-folder']").forEach(button => button.addEventListener("click", async () => {
    button.disabled = true;
    try { await request(`/projects/${encodeURIComponent(button.dataset.projectId)}/reveal`, { method: "POST" }); }
    catch (error) { pushToast(error.message, "danger"); }
    finally { button.disabled = false; }
  }));
  bindChatAccess();
  document.querySelectorAll(".field").forEach((field, index) => {
    const label = field.querySelector("label");
    const control = field.querySelector('input:not([type="hidden"]), select, textarea');
    if (label && control && !label.htmlFor) {
      if (!control.id) control.id = `ui-field-${index}`;
      label.htmlFor = control.id;
    }
  });
  document.querySelector("[data-action='toggle-mobile-sessions']")?.addEventListener("click", (event) => {
    const open = document.querySelector(".shell")?.classList.toggle("mobile-sessions-open");
    event.currentTarget.setAttribute("aria-expanded", String(Boolean(open)));
  });
  document.querySelectorAll("[data-action='set-theme']").forEach((button) => {
    button.addEventListener("click", () => applyTheme(button.dataset.theme));
  });
  document.querySelector("[data-action='stop-chat']")?.addEventListener("click", () => void cancelActiveChatRequest());
  document.querySelectorAll("[data-action='toggle-task-panel']").forEach((button) => {
    button.addEventListener("click", () => {
      const panel = document.querySelector(`[data-ui-disclosure="${button.dataset.panel}"]`);
      const opening = panel && !panel.open;
      document.querySelectorAll(".task-disclosure").forEach((item) => { item.open = false; });
      if (panel) {
        panel.classList.remove("is-restored");
        panel.open = opening;
        if (opening) panel.querySelector("input")?.focus({ preventScroll: true });
      }
    });
  });
  document.querySelectorAll(".task-disclosure > summary").forEach((summary) => {
    summary.addEventListener("click", () => summary.parentElement.classList.remove("is-restored"));
  });
  const filterTasks = () => {
    const query = state.ui.taskSearch.toLowerCase().trim();
    document.querySelectorAll(".task-card").forEach((card) => {
      card.hidden = !card.dataset.searchText.includes(query);
    });
    document.querySelectorAll(".task-column").forEach((column) => {
      const cards = [...column.querySelectorAll(".task-card")];
      const empty = column.querySelector(".task-filter-empty");
      if (empty) empty.hidden = !query || !cards.length || cards.some((card) => !card.hidden);
    });
  };
  document.querySelector("#task-search")?.addEventListener("input", (event) => {
    state.ui.taskSearch = event.target.value;
    filterTasks();
  });
  filterTasks();
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
      button.innerHTML = icon("sidebar");
      button.setAttribute("aria-expanded", String(!state.ui.sidebarCollapsed));
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
    document.querySelector(".chat-layout")?.classList.toggle("review-expanded", reviewPanel.expanded());
    document.querySelector(".review-selection-plus")?.setAttribute("hidden", "");
    const button = document.querySelector("[data-action='toggle-session-setup']");
    if (button) {
      button.innerHTML = icon(state.ui.sessionSetupCollapsed ? "chevronLeft" : "chevronRight");
      button.setAttribute("aria-expanded", String(!state.ui.sessionSetupCollapsed));
      button.setAttribute("title", state.ui.sessionSetupCollapsed ? "Show panel" : "Hide panel");
      button.setAttribute("aria-label", state.ui.sessionSetupCollapsed ? "Show panel" : "Hide panel");
    }
    window.setTimeout(syncScrollToBottomButton, 340);
  });

  bindResizeHandle("[data-action='resize-right-panel']", "rightPanelWidth", "lcai.rightPanelWidth", 320, Math.floor(window.innerWidth * 0.7), (event) => document.querySelector(".chat-layout").getBoundingClientRect().right - event.clientX);

  document.querySelector("[data-action='toggle-workflow-side']")?.addEventListener("click", () => {
    state.ui.workflowSideCollapsed = !state.ui.workflowSideCollapsed;
    localStorage.setItem("lcai.workflowSideCollapsed", String(state.ui.workflowSideCollapsed));
    document.querySelector(".orchestration-layout--workflow")?.classList.toggle("orchestration-layout--workflow-side-collapsed", state.ui.workflowSideCollapsed);
    const panel = document.querySelector("#workflow-side-panel");
    if (panel) panel.hidden = state.ui.workflowSideCollapsed;
    const button = document.querySelector("[data-action='toggle-workflow-side']");
    button?.classList.toggle("is-active", !state.ui.workflowSideCollapsed);
    button?.setAttribute("aria-expanded", String(!state.ui.workflowSideCollapsed));
    button?.setAttribute("title", state.ui.workflowSideCollapsed ? "Show workflows and run trace" : "Hide workflows and run trace");
  });

  const workflowLayout = document.querySelector(".orchestration-layout--workflow");
  bindResizeHandle(
    "[data-action='resize-workflow-side']",
    "workflowSideWidth",
    "lcai.workflowSideWidth",
    280,
    Math.floor((workflowLayout?.clientWidth ?? window.innerWidth) * 0.55),
    (event) => (workflowLayout?.getBoundingClientRect().right ?? window.innerWidth) - event.clientX
  );

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
      if (state.loading) return;
      const projectId = button.hasAttribute("data-project-id") ? button.dataset.projectId || null : state.activeProjectId;
      await runAction(() => createChatInProject(projectId));
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
        state.activeProjectId = (state.bootstrap?.sessions ?? []).find(session => session.id === state.activeSessionId)?.projectId ?? null;
        await loadActiveSession();
        window.location.hash = "/chat";
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

  document.querySelector("#task-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") || "").trim();
    const description = String(form.get("description") || "").trim();
    const workflowId = String(form.get("workflowId") || "").trim();
    const priority = String(form.get("priority") || "normal");

    if (!title || !description || state.loading || state.attachmentImports["task:new"]) {
      return;
    }

    await runAction(async () => {
      await api.createTask({
        title,
        description,
        workflowId,
        priority,
        attachments: state.taskDraftAttachments,
        projectId: String(form.get("projectId") || "") || null,
        accessMode: String(form.get("accessMode") || "default")
      });
      state.taskDraftAttachments = [];
      document.querySelector("#task-form")?.reset();
      const intake = document.querySelector('[data-ui-disclosure="task-create"]');
      if (intake) intake.open = false;
      await refreshBootstrap();
    });
  });

  const scheduleForm = document.querySelector("#schedule-form");
  const scheduleFrequency = document.querySelector("#schedule-frequency");
  const scheduleWeekdayField = document.querySelector("[data-schedule-weekday-field]");
  const scheduleWeekday = document.querySelector("#schedule-weekday");
  const scheduleTimeLabel = document.querySelector("[data-schedule-time-label]");
  const scheduleSubmit = document.querySelector("#schedule-submit");
  const syncScheduleFrequency = () => {
    const isWeekly = scheduleFrequency?.value === "weekly";

    if (scheduleWeekdayField) {
      scheduleWeekdayField.hidden = !isWeekly;
    }
    if (scheduleWeekday) {
      scheduleWeekday.required = isWeekly;
    }
    if (scheduleTimeLabel) {
      scheduleTimeLabel.textContent = isWeekly ? "Every week at" : "Every day at";
    }
    if (scheduleSubmit) {
      scheduleSubmit.textContent = isWeekly ? "Create Weekly Schedule" : "Create Daily Schedule";
    }
  };

  scheduleFrequency?.addEventListener("change", syncScheduleFrequency);
  syncScheduleFrequency();

  scheduleForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") || "").trim();
    const description = String(form.get("description") || "").trim();
    const workflowId = String(form.get("workflowId") || "").trim();
    const priority = String(form.get("priority") || "normal");
    const frequency = String(form.get("frequency") || "daily") === "weekly" ? "weekly" : "daily";
    const weekday = Number(form.get("weekday"));
    const time = String(form.get("time") || "").trim();
    const timezone = String(form.get("timezone") || "").trim();

    if (!title || !description || !workflowId || !time || !timezone || (frequency === "weekly" && !Number.isInteger(weekday))) {
      return;
    }

    await runAction(async () => {
      await api.createSchedule({
        title,
        description,
        workflowId,
        priority,
        frequency,
        ...(frequency === "weekly" ? { weekday } : {}),
        time,
        timezone,
        projectId: String(form.get("projectId") || "") || null,
        accessMode: String(form.get("accessMode") || "default")
      });
      await refreshBootstrap();
      pushToast(frequency === "weekly" ? "Weekly schedule created." : "Daily schedule created.", "info");
    });
  });

  document.querySelector("[data-action='refresh-orchestration']")?.addEventListener("click", async () => {
    await runAction(async () => {
      await refreshBootstrap();
      if (state.activeWorkflowRunId) {
        state.workflowRunDetail = await api.getWorkflowRun(state.activeWorkflowRunId);
      }
    });
  });

  document.querySelectorAll("[data-action='set-orchestration-tab']").forEach((button) => {
    button.addEventListener("click", () => {
      state.orchestrationTab = button.dataset.orchestrationTab === "workflow" ? "workflow" : "tasks";
      render();
    });
  });

  document.querySelectorAll(".task-card[draggable='true']").forEach((card) => {
    card.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("text/plain", card.dataset.taskId || "");
      event.dataTransfer?.setData("application/x-lcai-task-id", card.dataset.taskId || "");
      card.classList.add("is-dragging");
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("is-dragging");
      document.querySelectorAll(".task-column.is-drop-target").forEach((column) => {
        column.classList.remove("is-drop-target");
      });
    });
  });

  document.querySelectorAll("[data-drop-status]").forEach((column) => {
    column.addEventListener("dragover", (event) => {
      event.preventDefault();
      column.classList.add("is-drop-target");
    });
    column.addEventListener("dragleave", () => {
      column.classList.remove("is-drop-target");
    });
    column.addEventListener("drop", async (event) => {
      event.preventDefault();
      column.classList.remove("is-drop-target");
      const taskId =
        event.dataTransfer?.getData("application/x-lcai-task-id") ||
        event.dataTransfer?.getData("text/plain");
      const status = column.dataset.dropStatus;

      if (!taskId || !status) {
        return;
      }

      await runAction(async () => {
        await api.updateTask(taskId, { status });
        await refreshBootstrap();
      });
    });
  });

  document.querySelector("[data-action='new-workflow']")?.addEventListener("click", () => {
    state.workflowBuilder = {
      draft: createBlankWorkflow(),
      validation: null
    };
    render();
  });

  document.querySelector("[data-action='duplicate-workflow']")?.addEventListener("click", () => {
    const draft = readWorkflowDraftOrToast();

    if (!draft) {
      return;
    }

    state.workflowBuilder = {
      draft: duplicateWorkflow(draft),
      validation: null
    };
    render();
  });

  document.querySelectorAll("[data-action='edit-workflow']").forEach((button) => {
    button.addEventListener("click", () => {
      const workflow = (state.bootstrap?.workflows ?? []).find(
        (item) =>
          item.id === button.dataset.workflowId &&
          String(item.version) === String(button.dataset.workflowVersion)
      );

      if (!workflow) {
        return;
      }

      state.workflowBuilder = {
        draft: cloneWorkflow(workflow),
        validation: null
      };
      render();
    });
  });

  document.querySelectorAll("[data-action='duplicate-workflow-card']").forEach((button) => {
    button.addEventListener("click", () => {
      const workflow = (state.bootstrap?.workflows ?? []).find(
        (item) =>
          item.id === button.dataset.workflowId &&
          String(item.version) === String(button.dataset.workflowVersion)
      );

      if (!workflow) {
        return;
      }

      state.workflowBuilder = {
        draft: duplicateWorkflow(workflow),
        validation: null
      };
      render();
    });
  });

  document.querySelector("[data-action='add-workflow-node']")?.addEventListener("click", () => {
    updateWorkflowDraft((draft) => {
      const index = draft.nodes.length + 1;
      draft.nodes.push({
        id: `agent-${index}`,
        type: "agent",
        label: `Agent ${index}`,
        position: { x: 220 * index, y: 0 },
        config: {
          mode: "code",
          promptTemplate: "{{task.title}}\n\n{{task.description}}"
        }
      });
    });
  });

  document.querySelectorAll("select[name^='node-type-']").forEach((select) => {
    select.addEventListener("change", () => {
      updateWorkflowDraft(() => undefined);
    });
  });

  document.querySelectorAll("select[name^='node-provider-']").forEach((select) => {
    select.addEventListener("change", () => {
      const index = Number(select.name.replace("node-provider-", ""));
      updateWorkflowDraft((draft) => {
        if (draft.nodes[index]?.config) {
          delete draft.nodes[index].config.model;
        }
      });
    });
  });

  document.querySelectorAll("[data-action='delete-workflow-node']").forEach((button) => {
    button.addEventListener("click", () => {
      updateWorkflowDraft((draft) => {
        const index = Number(button.dataset.nodeIndex);
        const [removed] = draft.nodes.splice(index, 1);

        if (!removed) {
          return;
        }

        draft.transitions = draft.transitions.filter(
          (transition) => transition.from !== removed.id && transition.to !== removed.id
        );

        if (draft.entryNodeId === removed.id) {
          draft.entryNodeId = draft.nodes[0]?.id ?? "";
        }
      });
    });
  });

  document.querySelector("[data-action='add-workflow-transition']")?.addEventListener("click", () => {
    updateWorkflowDraft((draft) => {
      const from = draft.nodes[0]?.id ?? "";
      const to = draft.nodes[1]?.id ?? from;
      draft.transitions.push({
        id: `${from || "node"}-${to || "node"}-${draft.transitions.length + 1}`,
        from,
        to,
        priority: 100,
        guard: { type: "always" }
      });
    });
  });

  document.querySelectorAll("[data-action='delete-workflow-transition']").forEach((button) => {
    button.addEventListener("click", () => {
      updateWorkflowDraft((draft) => {
        draft.transitions.splice(Number(button.dataset.transitionIndex), 1);
      });
    });
  });

  document.querySelector("[data-action='validate-workflow']")?.addEventListener("click", async () => {
    const draft = readWorkflowDraftOrToast();

    if (!draft) {
      return;
    }

    await runAction(async () => {
      const validation = await api.validateWorkflow(draft);
      state.workflowBuilder = {
        draft,
        validation
      };
      pushToast(validation.ok ? "Workflow is valid." : "Workflow has validation errors.", validation.ok ? "info" : "danger");
    });
  });

  document.querySelector("[data-action='save-workflow']")?.addEventListener("click", async () => {
    const draft = readWorkflowDraftOrToast();

    if (!draft) {
      return;
    }

    await runAction(async () => {
      const validation = await api.validateWorkflow(draft);
      state.workflowBuilder = {
        draft,
        validation
      };

      if (!validation.ok) {
        throw new Error(`Workflow is invalid: ${validation.errors.join("; ")}`);
      }

      const exists = (state.bootstrap?.workflows ?? []).some(
        (workflow) => workflow.id === draft.id && workflow.version === draft.version
      );
      const saved = exists
        ? await api.updateWorkflow(draft.id, draft)
        : await api.createWorkflow(draft);

      await refreshBootstrap();
      state.workflowBuilder = {
        draft: cloneWorkflow(saved),
        validation: { ok: true, errors: [] }
      };
      pushToast("Workflow saved.", "info");
    });
  });

  document.querySelectorAll("[data-action='queue-task']").forEach((button) => {
    button.addEventListener("click", async () => {
      const taskId = button.dataset.taskId;

      if (!taskId) {
        return;
      }

      await runAction(async () => {
        await api.queueTask(taskId);
        await refreshBootstrap();
      });
    });
  });

  document.querySelectorAll("[data-action='delete-task']").forEach((button) => {
    button.addEventListener("click", async () => {
      const taskId = button.dataset.taskId;
      const task = (state.bootstrap?.tasks ?? []).find((item) => item.id === taskId);

      if (!taskId || !window.confirm(`Delete task "${task?.title ?? "Untitled"}"?`)) {
        return;
      }

      await runAction(async () => {
        await api.deleteTask(taskId);

        if (task?.lastRunId && state.activeWorkflowRunId === task.lastRunId) {
          state.activeWorkflowRunId = null;
          state.workflowRunDetail = null;
        }

        await refreshBootstrap();
      });
    });
  });

  document.querySelectorAll("[data-action='toggle-schedule']").forEach((button) => {
    button.addEventListener("click", async () => {
      const scheduleId = button.dataset.scheduleId;
      const schedule = (state.bootstrap?.schedules ?? []).find((item) => item.id === scheduleId);

      if (!scheduleId || !schedule) {
        return;
      }

      await runAction(async () => {
        await api.updateSchedule(scheduleId, { enabled: !schedule.enabled });
        await refreshBootstrap();
        pushToast(schedule.enabled ? "Schedule paused." : "Schedule resumed.", "info");
      });
    });
  });

  document.querySelectorAll("[data-action='delete-schedule']").forEach((button) => {
    button.addEventListener("click", async () => {
      const scheduleId = button.dataset.scheduleId;
      const schedule = (state.bootstrap?.schedules ?? []).find((item) => item.id === scheduleId);

      if (!scheduleId || !schedule || !window.confirm(`Delete schedule "${schedule.title}"?`)) {
        return;
      }

      await runAction(async () => {
        await api.deleteSchedule(scheduleId);
        await refreshBootstrap();
        pushToast("Schedule deleted.", "info");
      });
    });
  });

  document.querySelectorAll("[data-action='run-task']").forEach((button) => {
    button.addEventListener("click", async () => {
      const taskId = button.dataset.taskId;

      if (!taskId || state.attachmentImports[`task:${taskId}`]) {
        return;
      }

      await runAction(async () => {
        const result = await api.runTask(taskId);
        state.activeWorkflowRunId = result.runId;
        await refreshBootstrap();
        state.workflowRunDetail = result.runId ? await api.getWorkflowRun(result.runId) : null;
      });
    });
  });

  document.querySelector("[data-action='run-next-task']")?.addEventListener("click", async () => {
    if (Object.keys(state.attachmentImports).some((key) => key.startsWith("task:"))) return;
    await runAction(async () => {
      const result = await api.runNextTask();
      state.activeWorkflowRunId = result.runId;
      await refreshBootstrap();
      state.workflowRunDetail = result.runId ? await api.getWorkflowRun(result.runId) : null;
    });
  });

  document.querySelectorAll("[data-action='select-workflow-run']").forEach((button) => {
    button.addEventListener("click", async () => {
      const runId = button.dataset.runId;

      if (!runId) {
        return;
      }

      await runAction(async () => {
        state.activeWorkflowRunId = runId;
        state.workflowRunDetail = await api.getWorkflowRun(runId);
        state.orchestrationTab = "workflow";
        state.ui.workflowSideCollapsed = false;
      });
    });
  });

  bindWorkflowReviewActions();

  document.querySelector("[data-action='step-workflow-run']")?.addEventListener("click", async (event) => {
    const runId = event.currentTarget.dataset.runId;

    if (!runId) {
      return;
    }

    await runAction(async () => {
      await api.stepWorkflowRun(runId);
      await refreshBootstrap();
      state.workflowRunDetail = await api.getWorkflowRun(runId);
    });
  });

  document.querySelector("[data-action='cancel-workflow-run']")?.addEventListener("click", async (event) => {
    const runId = event.currentTarget.dataset.runId;

    if (!runId) {
      return;
    }

    await runAction(async () => {
      await api.cancelWorkflowRun(runId);
      await refreshBootstrap();
      state.workflowRunDetail = await api.getWorkflowRun(runId);
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
      const addedId = createUiEntityId("agent");
      state.sessionSettings = {
        ...baseSettings,
        codeAgents: [
          ...(baseSettings.codeAgents ?? []),
          {
            id: addedId,
            name: agentName || `Agent${nextIndex}`,
            providerId: baseSettings.defaultTarget.providerId,
            model: baseSettings.defaultTarget.model,
            accessMode: "default"
          }
        ].slice(0, 4)
      };
      render({ setupAddedId: addedId });
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

      const addedId = createUiEntityId("hypothesis");
      state.sessionSettings = {
        ...baseSettings,
        hypothesisAgents: [
          ...agents,
          {
            id: addedId,
            name: chooseHypothesisAdvisorName(agents),
            role: "advisor",
            providerId: baseSettings.defaultTarget.providerId,
            model: baseSettings.defaultTarget.model
          }
        ].slice(0, MAX_HYPOTHESIS_AGENTS)
      };
      render({ setupAddedId: addedId });
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
      const agentId = button.dataset.hypothesisAgentId;
      const agents = normalizeHypothesisAgentsForUi(baseSettings);
      let removed = false;

      if (!Number.isInteger(index) || index < 3) {
        return;
      }

      state.sessionSettings = {
        ...baseSettings,
        hypothesisAgents: agents.filter((agent, itemIndex) => {
          if (removed || itemIndex < 3) {
            return true;
          }

          const matches = agentId ? agent.id === agentId : itemIndex === index;
          if (matches) {
            removed = true;
            return false;
          }

          return true;
        })
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
    await submitChatMessage(input, getActiveDraftAttachments());
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
    const input = event.currentTarget;
    const files = [...(input.files ?? [])];
    const sessionId = state.activeSessionId;
    input.value = "";
    if (files.length && sessionId) await addChatAttachments(files, sessionId);
  });

  document.querySelectorAll("[data-action='attach-task-files']").forEach((button) => {
    button.addEventListener("click", () => button.closest(".task-attachments")?.querySelector("[data-task-attachment-input]")?.click());
  });
  document.querySelectorAll("[data-task-attachment-input]").forEach((input) => {
    input.addEventListener("change", async () => {
      const files = [...(input.files ?? [])];
      input.value = "";
      if (files.length) await addTaskAttachments(files, input.dataset.taskId || "");
    });
  });
  document.querySelectorAll("[data-action='remove-task-attachment']").forEach((button) => {
    button.addEventListener("click", async () => {
      await removeTaskAttachment(button.dataset.taskId || "", button.dataset.attachmentId);
    });
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
      updateAttachmentGuidance();
      scheduleSessionSetupAutosave();
    }
  });
  sessionSettingsForm?.addEventListener("change", () => {
    updateAttachmentGuidance();
    scheduleSessionSetupAutosave();
  });

  bindSessionSetupFieldSync();

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
      const providerId = button.dataset.providerId || "lmstudio";

      if (!modelId) {
        return;
      }

      const key = `load:${providerId}:${modelId}`;
      if (state.modelActions[key]) return;
      const scrollSnapshot = captureScrollState();
      state.modelActions[key] = true;
      render();
      restoreScrollState(scrollSnapshot);

      try {
        await api.loadModel(providerId, modelId);
        try {
          const managed = await waitForManagedModelState(providerId, modelId, true);
          state.bootstrap.loadedModels = managed.loadedModels;
          state.bootstrap.allManagedModels = managed.allManagedModels;
        } catch {
          pushToast("Model loaded, but its catalog status could not be refreshed yet.", "warning");
        }
        try { state.bootstrap.systemMetrics = await api.getSystemMetrics(); } catch { /* Metrics do not determine load success. */ }
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
      const modelKey = button.dataset.modelKey || modelId;
      const providerId = button.dataset.providerId || "lmstudio";

      if (!modelId) {
        return;
      }

      const key = `unload:${providerId}:${modelId}`;
      if (state.modelActions[key]) return;
      const scrollSnapshot = captureScrollState();
      state.modelActions[key] = true;
      render();
      restoreScrollState(scrollSnapshot);

      try {
        await api.unloadModel(providerId, modelId);
        optimisticallyUnloadModel(providerId, modelKey, modelId);
        invalidateSessionModelSelection(providerId, modelKey);
        render();
        const managed = await waitForManagedModelState(providerId, modelKey, false);
        state.bootstrap.loadedModels = managed.loadedModels;
        state.bootstrap.allManagedModels = managed.allManagedModels;
        try { state.bootstrap.systemMetrics = await api.getSystemMetrics(); } catch { /* Metrics do not determine unload success. */ }
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
      const model = button.form?.elements.namedItem(`provider.${providerId}.model`)?.value?.trim();

      if (providerId === "llamacpp") {
        if (state.localModelTest) return;
        state.localModelTest = { model: model ?? getProviderConfiguredModel(providerId) };
        delete state.providerTestResults[providerId];
        updateLocalModelTestProgress();
        modelManager.start();
        try {
          state.providerTestResults[providerId] = await api.testProvider(providerId, model);
        } catch (error) {
          state.providerTestResults[providerId] = { ok: false, providerId, model, message: error instanceof Error ? error.message : "Model test failed." };
        } finally {
          state.localModelTest = null;
          updateLocalModelTestProgress();
        }
        return;
      }

      const settingsForm = document.querySelector("#app-settings-form");
      const settingsPayload = settingsForm
        ? buildAppSettingsPayload(new FormData(settingsForm), false)
        : null;

      await runAction(async () => {
        if (settingsPayload) {
          const savedSettings = await api.updateAppSettings(settingsPayload);
          state.bootstrap.providers = savedSettings.providers;
          state.bootstrap.plugins = savedSettings.plugins;
          state.bootstrap.tools = savedSettings.tools;
          state.bootstrap.appSettings = savedSettings.settings;
          state.bootstrap.availableModels = savedSettings.availableModels ?? state.bootstrap.availableModels;
        }
        state.providerTestResults[providerId] = await api.testProvider(providerId, model);
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

  document.querySelectorAll("[data-action='copy-tool-path']").forEach((button) => {
    button.addEventListener("click", async () => {
      const filePath = button.dataset.path;

      if (!filePath) {
        return;
      }

      try {
        await navigator.clipboard.writeText(filePath);
        const original = button.textContent;
        button.textContent = "Copied";
        window.setTimeout(() => {
          button.textContent = original;
        }, 1000);
      } catch (error) {
        showToast(error.message, "danger");
      }
    });
  });

  document.querySelectorAll("[data-action='reveal-tool-path']").forEach((button) => {
    button.addEventListener("click", async () => {
      const filePath = button.dataset.path;
      if (!filePath) {
        return;
      }

      try {
        await api.revealWorkspacePath(filePath);
        pushToast("Opened in file manager", "success");
      } catch (error) {
        pushToast(error instanceof Error ? error.message : "Unable to open directory", "danger");
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

function findFileChangeMetadata(filePath) {
  for (const message of [...state.messages].reverse()) {
    for (const tool of [...(message.tools || [])].reverse()) {
      if (tool.tool !== "file") {
        continue;
      }
      const metadata = tool.metadata || {};
      const file = (metadata.files || []).find((item) => item.filePath === filePath);
      if (file) {
        return {
          operation: file.operation || "write",
          beforeExists: file.beforeExists,
          afterHash: file.afterHash,
          diff: file.diff
        };
      }
      if (metadata.filePath === filePath) {
        return {
          operation: metadata.operation || "write",
          beforeExists: metadata.beforeExists,
          afterHash: metadata.afterHash,
          diff: metadata.diff
        };
      }
    }
  }
  return null;
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
      document.querySelector(".chat-layout")?.style.setProperty("--session-panel-width", `${state.ui.rightPanelWidth}px`);
      document.querySelector(".orchestration-layout--workflow")?.style.setProperty("--workflow-side-width", `${state.ui.workflowSideWidth}px`);
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
  const saveSeq = state.ui.autosaveSeq + 1;
  state.ui.autosaveSeq = saveSeq;
  setAutosaveStatus("saving");
  state.ui.autosaveTimer = window.setTimeout(() => {
    state.ui.autosavePromise = state.ui.autosavePromise
      .catch(() => undefined)
      .then(async () => {
        if (state.ui.autosaveSeq !== saveSeq) {
          return;
        }

        try {
          await persistActiveSessionSetup({ refreshBootstrap: false, saveSeq });
          if (state.ui.autosaveSeq === saveSeq) {
            setAutosaveStatus("saved");
          }
        } catch (error) {
          if (state.ui.autosaveSeq === saveSeq) {
            pushToast(error instanceof Error ? error.message : "Autosave failed", "danger");
            setAutosaveStatus("error");
          }
        }
      });
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

function chooseHypothesisAdvisorName(existingAgents) {
  const used = new Set(
    existingAgents.map((agent) => String(agent.name || "").trim().toLowerCase())
  );

  for (let index = 1; index <= MAX_HYPOTHESIS_ADVISORS; index += 1) {
    const candidate = `Advisor${index}`;
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return `Advisor-${Date.now()}`;
}

function createUiEntityId(prefix) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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

function optimisticallyUnloadModel(providerId, modelKey, instanceId) {
  if (!state.bootstrap) {
    return;
  }

  state.bootstrap.loadedModels = (state.bootstrap.loadedModels ?? []).filter(
    (model) =>
      !(
        model.providerId === providerId &&
        (model.id === modelKey || model.id === instanceId || model.loadedInstanceIds?.includes(instanceId))
      )
  );
  state.bootstrap.allManagedModels = (state.bootstrap.allManagedModels ?? []).map((model) =>
    model.providerId === providerId && model.id === modelKey
      ? { ...model, loaded: false, loadedInstanceIds: [] }
      : model
  );
}

function invalidateSessionModelSelection(providerId, modelKey) {
  // The built-in library survives unloading; its targets must keep their model ID.
  if (providerId === "llamacpp") return;
  if (!state.sessionSettings) {
    return;
  }

  const replacement = getLoadedModelOptions(providerId)[0];
  const replaceTarget = (target) =>
    target?.providerId === providerId && target.model === modelKey
      ? { ...target, model: replacement }
      : target;

  state.sessionSettings = {
    ...state.sessionSettings,
    defaultTarget: replaceTarget(state.sessionSettings.defaultTarget),
    codeAgents: (state.sessionSettings.codeAgents ?? []).map((agent) => replaceTarget(agent)),
    hypothesisAgents: (state.sessionSettings.hypothesisAgents ?? []).map((agent) => replaceTarget(agent)),
    debate: {
      ...state.sessionSettings.debate,
      support: replaceTarget(state.sessionSettings.debate.support),
      attack: replaceTarget(state.sessionSettings.debate.attack),
      judge: replaceTarget(state.sessionSettings.debate.judge)
    }
  };
  scheduleSessionSetupAutosave();
}

async function waitForManagedModelState(providerId, modelKey, loaded) {
  let latest = await api.refreshManagedModels();

  for (let attempt = 0; attempt <= 5; attempt += 1) {
    const model = latest.allManagedModels.find(
      (item) => item.providerId === providerId && item.id === modelKey
    );
    const stillLoaded = latest.loadedModels.some(
      (item) => item.providerId === providerId && item.id === modelKey
    );

    if (Boolean(model?.loaded || stillLoaded) === loaded) {
      return latest;
    }

    if (attempt === 5) break;
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    latest = await api.refreshManagedModels();
  }

  if (!loaded) {
    latest.loadedModels = latest.loadedModels.filter(
      (model) => !(model.providerId === providerId && model.id === modelKey)
    );
    latest.allManagedModels = latest.allManagedModels.map((model) =>
      model.providerId === providerId && model.id === modelKey
        ? { ...model, loaded: false, loadedInstanceIds: [] }
        : model
    );
  } else {
    throw new Error("The loaded model has not appeared in the catalog yet.");
  }

  return latest;
}

async function pollWorkflowProgress() {
  if (workflowPollInFlight || state.route !== "orchestration" || state.loading) return;
  if (!(state.bootstrap?.workflowRuns ?? []).some((run) => ["queued", "running"].includes(run.status))) return;
  workflowPollInFlight = true;
  try {
    const [tasks, runs] = await Promise.all([request("/tasks"), request("/workflow-runs")]);
    state.bootstrap.tasks = tasks;
    state.bootstrap.workflowRuns = runs;
    if (state.activeWorkflowRunId) state.workflowRunDetail = await api.getWorkflowRun(state.activeWorkflowRunId);
    if (state.route !== "orchestration" || state.loading) return;
    workflowEditorHandle?.setNodeRuns(getActiveWorkflowNodeRuns(state.workflowBuilder?.draft?.id));
    if (state.orchestrationTab === "tasks") render();
    else {
      const trace = document.querySelector(".run-trace");
      const run = runs.find((item) => item.id === state.activeWorkflowRunId);
      if (trace && run) {
        // Keep the editor and its unsaved fields mounted while updating the trace.
        const holder = document.createElement("div");
        holder.innerHTML = renderWorkflowRunTrace(run);
        trace.replaceWith(holder.firstElementChild);
        bindWorkflowReviewActions();
      }
    }
  } catch { /* Retry on the next dashboard tick. */ }
  finally { workflowPollInFlight = false; }
}

async function pollSystemMetrics() {
  if (state.route !== "models" || !state.bootstrap) {
    return;
  }

  try {
    state.bootstrap.systemMetrics = await api.getSystemMetrics();
    modelManager.updateLiveView();
  } catch {
    // keep the dashboard usable even if metrics polling fails
  }
}

function syncSystemMetricsPolling() {
  if (systemMetricsPollTimer) {
    window.clearInterval(systemMetricsPollTimer);
    systemMetricsPollTimer = null;
  }

  if (!["models", "orchestration"].includes(state.route)) {
    return;
  }

  systemMetricsPollTimer = window.setInterval(() => {
    void pollSystemMetrics();
    void pollWorkflowProgress();
  }, state.route === "orchestration" ? 1000 : 5000);
}

function buildAppSettingsPayload(form, pluginsOnly) {
  const payload = {};
  // Legacy callers also preserve absent fields; Settings pages use entityPatch.
  const numeric = new Set(["timeoutMs", "maxTokens", "topK", "contextSize", "gpuLayers", "memoryLimitPercent", "loadTimeoutMs", "generationTimeoutMs", "activationThreshold", "chunkCapacity", "initialRadius", "maxRadius"]);
  for (const [name, raw] of form.entries()) {
    let keys = name.split(".");
    if (!["provider", "plugin", "llm", "localModels", "memory", "mcp"].includes(keys[0])) continue;
    if (pluginsOnly && keys[0] !== "plugin") continue;
    if (keys.some(key => ["__proto__", "constructor", "prototype"].includes(key))) continue;
    if (keys[0] === "provider") keys[0] = "providers";
    if (keys[0] === "plugin") { keys[0] = "plugins"; if (keys[2] !== "enabled") keys.splice(2, 0, "values"); }
    const key = keys.at(-1);
    if (key === "apiKey" && !String(raw).trim()) continue;
    let target = payload;
    for (const part of keys.slice(0, -1)) target = target[part] ??= {};
    target[key] = numeric.has(key) ? Number(raw) : ["true", "false"].includes(raw) ? raw === "true" : String(raw).trim();
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
    return true;
  } catch (error) {
    pushToast(error instanceof Error ? error.message : "Action failed", "danger");
    return false;
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
  document.querySelectorAll(".toast[data-toast-id]").forEach((toast) => {
    if (toast.dataset.toastId === id) toast.remove();
  });
}

function routeTitle(route) {
  switch (route) {
    case "orchestration":
      return "Tasks & workflows";
    case "models":
      return "Models";
    case "plugins":
      return "Plugins";
    case "settings":
      return "Settings";
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

function getModelOptions(providerId) {
  const matchesProvider = (model) => !providerId || model.providerId === providerId;
  const fromCatalog = (state.bootstrap?.availableModels ?? [])
    .filter((model) => matchesProvider(model) && model.providerId !== "llamacpp")
    .map((model) => model.id);
  const fromManaged = (state.bootstrap?.allManagedModels ?? [])
    .filter(matchesProvider)
    .map((model) => model.id);
  return [...new Set([...fromCatalog, ...fromManaged])].sort();
}

function getModelDisplayName(providerId, modelId) {
  const model = (state.bootstrap?.allManagedModels ?? []).find((item) => item.providerId === providerId && (item.id === modelId || item.libraryId === modelId));
  return providerId === "llamacpp" && model ? `${model.displayName || model.id}${model.quantization && !(model.displayName || "").includes(model.quantization) ? ` · ${model.quantization}` : ""}` : modelId;
}

function formatLocalModelReferences(value) {
  return String(value ?? "").replace(/\bgguf-[a-z0-9]+\b/g, (modelId) => getModelDisplayName("llamacpp", modelId));
}

function getLoadedModelOptions(providerId) {
  return (state.bootstrap?.loadedModels ?? [])
    .filter((model) => !providerId || model.providerId === providerId)
    .map((model) => model.id);
}

function getProviderSuggestedModels(providerId) {
  const discoveredModels = getModelOptions(providerId);
  let suggestedModels = [];

  switch (providerId) {
    case "openai":
      suggestedModels = [
        "gpt-6-astra",
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
      break;
    case "anthropic":
      suggestedModels = [
        "claude-sonnet-4-5",
        "claude-opus-4-1",
        "claude-haiku-4-5"
      ];
      break;
    case "gemini":
      suggestedModels = [
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite"
      ];
      break;
    case "lmstudio":
    case "ollama":
    case "llamacpp":
      return discoveredModels;
    default:
      return [];
  }

  // The API catalog is scoped to the user's key and includes fine-tuned and
  // newly released models. Keep a short fallback list in case that request is
  // temporarily unavailable.
  return [...new Set([...discoveredModels, ...suggestedModels])].sort();
}

function getRuntimeProviderStatus(providerId) {
  const provider = state.bootstrap?.appSettings?.providers?.[providerId];

  if (!provider?.enabled) {
    return {
      label: "not configured",
      tone: "danger"
    };
  }

  if (providerId === "llamacpp") {
    const runtime = state.bootstrap?.localModels?.runtime;
    if (runtime?.status === "unavailable" || runtime?.status === "error") return { label: "runtime unavailable", tone: "warning" };
    return getModelOptions(providerId).length ? { label: "ready", tone: "success" } : { label: "download a model", tone: "warning" };
  }

  if (!provider.baseUrl || !provider.model) {
    return {
      label: "not configured",
      tone: "danger"
    };
  }

  if (isLocalProvider(providerId)) {
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
    case "llamacpp":
      return "Choose an installed model from the model library. It loads automatically when a chat or workflow needs it.";
    default:
      return "";
  }
}

function defaultProviderTimeoutMs(providerId) {
  return providerId === "llamacpp" ? 600000 : isLocalProvider(providerId) ? 300000 : 60000;
}

function localModelActionTimeoutMs(providerId) {
  if (providerId === "llamacpp") return 0;
  const configured = Number(state.bootstrap?.appSettings?.providers?.[providerId]?.timeoutMs);
  return Math.max(300000, Number.isFinite(configured) ? configured : 0) + 30000;
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
    ? providerId === "llamacpp" ? getModelOptions(providerId) : getLoadedModelOptions(providerId)
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

function getDefaultModelForProvider(providerId) {
  if (!providerId || providerId === "local") {
    return "";
  }

  if (isLocalProvider(providerId)) {
    if (providerId === "llamacpp") {
      const installed = getModelOptions(providerId);
      const configured = getProviderConfiguredModel(providerId);
      return installed.includes(configured) ? configured : installed[0] || "";
    }
    return getLoadedModelOptions(providerId)[0] || getProviderConfiguredModel(providerId) || "";
  }

  return getProviderConfiguredModel(providerId) || getProviderSuggestedModels(providerId)[0] || "";
}

function getProviderSettingsModelOptions(providerId, currentValue = "") {
  return [...new Set([currentValue, ...getProviderSuggestedModels(providerId)].filter(Boolean))];
}

function renderProviderSettingsModelControl(providerId, value) {
  const options = getProviderSettingsModelOptions(providerId, value || getProviderConfiguredModel(providerId));
  const selectedValue = value || getProviderConfiguredModel(providerId) || "";

  if (["openai", "anthropic", "gemini"].includes(providerId)) {
    const unavailable = selectedValue && !options.includes(selectedValue);
    return `
      <select name="provider.${escapeAttr(providerId)}.model">
        <option value="">Select model</option>
        ${unavailable ? `<option value="${escapeAttr(selectedValue)}" selected disabled>${escapeHtml(selectedValue)} · unavailable</option>` : ""}
        ${options.map((modelId) => option(modelId, selectedValue, modelId)).join("")}
      </select>
      ${unavailable ? '<div class="mm-unavailable-target">This saved model is not returned by the provider. Choose an available model or check its access.</div>' : ""}
    `;
  }

  if (!isLocalProvider(providerId)) {
    return `<input name="provider.${escapeAttr(providerId)}.model" value="${escapeAttr(selectedValue)}" list="provider-models-${escapeAttr(providerId)}" placeholder="${escapeAttr(providerModelPlaceholder(providerId))}" /><datalist id="provider-models-${escapeAttr(providerId)}">${renderDatalistOptions(options)}</datalist>`;
  }

  const installed = providerId === "llamacpp" ? getModelOptions(providerId) : options;
  const unavailable = selectedValue && !installed.includes(selectedValue);
  return `
    <select name="provider.${escapeAttr(providerId)}.model">
      <option value="">Select model</option>
      ${unavailable ? `<option value="${escapeAttr(selectedValue)}" selected disabled>${escapeHtml(selectedValue)} · unavailable</option>` : ""}
      ${installed.map((modelId) => option(modelId, selectedValue, getModelDisplayName(providerId, modelId))).join("")}
    </select>
    ${unavailable ? '<div class="mm-unavailable-target">The saved model is unavailable in this library.</div>' : ""}
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
  const message = formatLocalModelReferences(result?.message);

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

function buildChatAttachmentMetadata(attachments, reviewSelection) {
  if (!attachments.length && !reviewSelection) return undefined;
  return {
    ...(attachments.length ? { attachments } : {}),
    ...(reviewSelection ? { reviewSelection } : {})
  };
}

function getTargetModel(target = {}) {
  const providerId = target.providerId || state.bootstrap?.appSettings?.llm?.defaultProvider;
  const modelId = target.model || state.bootstrap?.appSettings?.providers?.[providerId]?.model;
  return [...(state.bootstrap?.allManagedModels || []), ...(state.bootstrap?.availableModels || [])]
    .find((model) => model.providerId === providerId && (model.id === modelId || model.libraryId === modelId));
}

function getImageAttachmentGuidance(attachments, settings) {
  if (!attachments.some((attachment) => attachment.kind === "image")) return { blocked: false, message: "" };
  if (getEffectiveSetupMode(settings || {}) !== "general") {
    return { blocked: false, message: "Images require image-capable agents. Each selected agent's model is checked when it runs." };
  }
  const target = settings?.defaultTarget || {};
  const providerId = target.providerId || state.bootstrap?.appSettings?.llm?.defaultProvider;
  const model = getTargetModel(target);
  if (isLocalProvider(providerId) && model?.vision === false) {
    return { blocked: true, message: "This local model is text only. Choose an image-capable model or add its matching vision adapter in Models before sending images." };
  }
  return model?.vision === true
    ? { blocked: false, message: "Images will be sent to the selected model." }
    : { blocked: false, message: "Images need an image-capable model. Support for this provider's selected model is checked when the request runs." };
}

function updateAttachmentGuidance() {
  const settings = readSessionSetupSnapshot()?.settings || state.sessionSettings;
  const guidance = getImageAttachmentGuidance(getActiveDraftAttachments(), settings);
  const pending = Boolean(state.attachmentImports?.[`chat:${state.activeSessionId}`]);
  const element = document.querySelector("[data-attachment-guidance]");
  if (element) {
    element.textContent = pending ? "Preparing attachments…" : guidance.message;
    element.hidden = !pending && !guidance.message;
    element.classList.toggle("is-blocked", guidance.blocked);
  }
  const submit = document.querySelector("#chat-form button[type='submit']");
  if (submit) submit.disabled = Boolean(state.chatSubmitting || state.accessSaving || pending || guidance.blocked);
  const activityModel = document.querySelector(".chat-activity-bar .activity-model");
  if (activityModel && !state.chatSubmitting && !state.pendingRequest) {
    const target = settings?.defaultTarget || {};
    const model = getTargetModel(target);
    const capability = model?.vision === true ? "Images" : model?.vision === false ? "Text only" : "";
    activityModel.textContent = `${getProviderDisplayName(target.providerId)} ${getModelDisplayName(target.providerId, target.model) || "default"}${capability ? ` · ${capability}` : ""}`;
    activityModel.title = activityModel.textContent;
  }
}

async function addChatAttachments(files, sessionId) {
  const key = `chat:${sessionId}`;
  if (state.attachmentImports[key]) return;
  state.attachmentImports[key] = true;
  render();
  try {
    const attachments = await buildAttachments(files, 5 - (state.draftAttachments[sessionId] || []).length);
    if (state.bootstrap?.sessions && !state.bootstrap.sessions.some((session) => session.id === sessionId)) return;
    state.draftAttachments[sessionId] = [...(state.draftAttachments[sessionId] || []), ...attachments].slice(0, 5);
  } catch (error) {
    pushToast(error instanceof Error ? error.message : "Failed to read attachments", "danger");
  } finally {
    delete state.attachmentImports[key];
    render();
  }
}

async function addTaskAttachments(files, taskId) {
  const key = `task:${taskId || "new"}`;
  const task = (state.bootstrap?.tasks || []).find((item) => item.id === taskId);
  if (state.loading || state.attachmentImports[key] || isTaskAttachmentLocked(task) || (taskId && !task)) return;
  state.attachmentImports[key] = true;
  render();
  try {
    const previous = taskId ? task.attachments || [] : state.taskDraftAttachments;
    const added = await buildAttachments(files, 5 - previous.length);
    if (!added.length) return;
    const attachments = [...previous, ...added];
    if (!taskId) state.taskDraftAttachments = attachments;
    else { await api.updateTask(taskId, { attachments }); await refreshBootstrap(); }
  } catch (error) {
    pushToast(error instanceof Error ? error.message : "Failed to save task attachments", "danger");
  } finally {
    delete state.attachmentImports[key];
    render();
  }
}

async function removeTaskAttachment(taskId, attachmentId) {
  const key = `task:${taskId || "new"}`;
  const task = (state.bootstrap?.tasks || []).find((item) => item.id === taskId);
  if (state.loading || state.attachmentImports[key] || isTaskAttachmentLocked(task) || (taskId && !task)) return;
  const attachments = (taskId ? task.attachments || [] : state.taskDraftAttachments).filter((attachment) => attachment.id !== attachmentId);
  if (!taskId) { state.taskDraftAttachments = attachments; render(); return; }
  state.attachmentImports[key] = true;
  render();
  try {
    await api.updateTask(taskId, { attachments });
    await refreshBootstrap();
  } catch (error) {
    pushToast(error instanceof Error ? error.message : "Failed to remove task attachment", "danger");
  } finally {
    delete state.attachmentImports[key];
    render();
  }
}

function isTaskAttachmentLocked(task) {
  return ["in_progress", "running", "waiting"].includes(task?.status);
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

async function prepareImageAttachment(file) {
  let image;
  let objectUrl;
  try {
    if (typeof createImageBitmap === "function") {
      image = await createImageBitmap(file, { imageOrientation: "from-image" });
    } else {
      objectUrl = URL.createObjectURL(file);
      image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("The image could not be decoded."));
        element.src = objectUrl;
      });
    }
    const originalWidth = image.width || image.naturalWidth;
    const originalHeight = image.height || image.naturalHeight;
    if (!originalWidth || !originalHeight) throw new Error("The image has invalid dimensions.");
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 2048 / Math.max(originalWidth, originalHeight));
    let width = Math.max(1, Math.round(originalWidth * scale));
    let height = Math.max(1, Math.round(originalHeight * scale));
    const encode = (mimeType, quality) => new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("The image could not be encoded.")), mimeType, quality));
    for (let attempt = 0; attempt < 8; attempt++) {
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image processing is unavailable in this browser.");
      context.drawImage(image, 0, 0, width, height);
      if (attempt === 0 && file.type === "image/png") {
        const png = await encode("image/png");
        if (png.size <= 1024 * 1024) return { dataUrl: await fileToDataUrl(png), mimeType: png.type, sizeBytes: png.size };
      }
      for (const quality of [0.9, 0.75, 0.6, 0.45]) {
        const blob = await encode(file.type === "image/jpeg" ? "image/jpeg" : "image/webp", quality);
        if (blob.size <= 1024 * 1024) return { dataUrl: await fileToDataUrl(blob), mimeType: blob.type, sizeBytes: blob.size };
      }
      width = Math.max(1, Math.floor(width * 0.75));
      height = Math.max(1, Math.floor(height * 0.75));
    }
    throw new Error("The image could not be reduced below 1 MB. Choose a smaller image.");
  } finally {
    image?.close?.();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

async function buildAttachments(files, availableSlots = 5) {
  const attachments = [];
  const limit = Math.max(0, Math.min(5, availableSlots));
  if (files.length > limit) pushToast(`Up to 5 files can be attached. ${files.length - limit} additional file(s) were not added.`, "warning");
  for (const file of files.slice(0, limit)) {
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("The input file is larger than 5 MB.");
      const name = file.name.toLowerCase();
      if (name.endsWith(".doc")) throw new Error("Legacy .doc files are not supported. Save the document as DOCX or PDF.");
      const imageType = ["image/png", "image/jpeg", "image/webp"].includes(file.type);
      const documentType = /\.(pdf|docx)$/i.test(name) || ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].includes(file.type);
      if (file.type.startsWith("image/") && !imageType) throw new Error("Images must be PNG, JPEG or WebP.");
      if (!imageType && !documentType && !isTextAttachment(file)) throw new Error("This file type is not supported. Attach an image, text file, PDF or DOCX.");
      const attachment = {
        id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name, mimeType: file.type || (name.endsWith(".pdf") ? "application/pdf" : name.endsWith(".docx") ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "text/plain"), sizeBytes: file.size, kind: imageType ? "image" : "text"
      };
      if (imageType) Object.assign(attachment, await prepareImageAttachment(file));
      else if (documentType) {
        const result = await request("/attachments/extract", { method: "POST", timeoutMs: 60000, body: JSON.stringify({ name: file.name, dataUrl: await fileToDataUrl(file) }) });
        attachment.textContent = String(result?.textContent || "");
        if (result?.truncated) attachment.truncated = true;
        if (result?.warning) attachment.warning = result.warning;
        if (!attachment.textContent.trim()) throw new Error(attachment.warning || "No readable text was found. For scanned documents, attach page images to an image-capable model.");
      } else {
        const text = await file.text();
        if (!text.trim()) throw new Error("This file has no readable text.");
        attachment.textContent = text.slice(0, 12000);
        if (text.length > 12000) { attachment.truncated = true; attachment.warning = "Text was shortened to the first 12,000 characters."; }
      }
      attachments.push(attachment);
    } catch (error) {
      pushToast(`${file.name}: ${error instanceof Error ? error.message : "Could not prepare this attachment."}`, "danger");
    }
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
  const resolveModelValue = (providerFieldName, modelFieldName, fallbackModel, fallbackProviderId) => {
    const providerId = String(formData.get(providerFieldName) || "").trim();

    if (!providerId || providerId === "local") {
      return undefined;
    }

    const value = String(formData.get(modelFieldName) || "").trim();
    const providerMatchesFallback = !fallbackProviderId || providerId === fallbackProviderId;

    return value || (providerMatchesFallback ? fallbackModel : undefined) || getDefaultModelForProvider(providerId) || undefined;
  };
  const codeAgentCards = [...form.querySelectorAll(".code-agent-card")];
  const codeAgents = !form.querySelector(".code-agents:not(.hypothesis-agents)") ? fallbackSettings.codeAgents : codeAgentCards
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
      accessMode: fallbackSettings.defaultAccessMode || "default",
      model:
        resolveModelValue(`codeAgentProvider:${agentIndex}`, `codeAgentModel:${agentIndex}`, existingAgent?.model, existingAgent?.providerId) ||
        getProviderConfiguredModel(providerId)
    };
  }).slice(0, 4);
  const hypothesisAgentCards = [
    ...form.querySelectorAll(".hypothesis-agent-card[data-hypothesis-agent-index]")
  ];
  const hypothesisAgents = !form.querySelector(".hypothesis-agents") ? fallbackSettings.hypothesisAgents : hypothesisAgentCards.map((card, index) => {
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
        resolveModelValue(`hypothesisAgentProvider:${agentIndex}`, `hypothesisAgentModel:${agentIndex}`, existingAgent?.model, existingAgent?.providerId) ||
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
	        model: resolveModelValue("defaultProvider", "defaultModel", fallbackSettings.defaultTarget.model, fallbackSettings.defaultTarget.providerId)
	      },
	      defaultAccessMode: fallbackSettings.defaultAccessMode || "default",
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

  const sessionId = options.sessionId || state.activeSessionId;
  const snapshot = options.snapshot || readSessionSetupSnapshot();
  if (!snapshot) {
    return null;
  }

  const currentSession = state.bootstrap?.sessions?.find((item) => item.id === sessionId);
  if (options.renameSession !== false && snapshot.title && snapshot.title !== currentSession?.title) {
    await api.renameSession(sessionId, snapshot.title);
    if (currentSession) {
      currentSession.title = snapshot.title;
      currentSession.updatedAt = new Date().toISOString();
    }
  }

  const savedSettings = await api.updateSessionSettings(
    sessionId,
    sessionSettingsToPatch(snapshot.settings)
  );

  if (state.activeSessionId === sessionId && (options.saveSeq === undefined || state.ui.autosaveSeq === options.saveSeq)) {
    state.sessionSettings = savedSettings;
  }

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
    behavior: motionEnabled() ? behavior : "auto"
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
    return `<input name="${escapeAttr(name)}" aria-label="${escapeAttr(sessionModelLabel(name))}" value="" placeholder="local judge" disabled />`;
  }

  const resolvedValue = value || getProviderConfiguredModel(providerId) || "";

  if (isLocalProvider(providerId)) {
    const unavailable = resolvedValue && !options.includes(resolvedValue);
    return `
      <select name="${escapeAttr(name)}" aria-label="${escapeAttr(sessionModelLabel(name))}">
        <option value="">${providerId === "llamacpp" && !options.length ? "Download a model in Models" : "Select model"}</option>
        ${unavailable ? `<option value="${escapeAttr(resolvedValue)}" selected disabled>${escapeHtml(resolvedValue)} · unavailable</option>` : ""}
        ${options.map((modelId) => option(modelId, resolvedValue, getModelDisplayName(providerId, modelId))).join("")}
      </select>
      ${unavailable ? '<div class="mm-unavailable-target">This saved model is unavailable. Select a model from the library.</div>' : ""}
    `;
  }

  if (["openai", "anthropic", "gemini"].includes(providerId)) {
    const unavailable = resolvedValue && !options.includes(resolvedValue);
    return `
      <select name="${escapeAttr(name)}" aria-label="${escapeAttr(sessionModelLabel(name))}">
        <option value="">Select model</option>
        ${unavailable ? `<option value="${escapeAttr(resolvedValue)}" selected disabled>${escapeHtml(resolvedValue)} · unavailable</option>` : ""}
        ${options.map((modelId) => option(modelId, resolvedValue, modelId)).join("")}
      </select>
      ${unavailable ? '<div class="mm-unavailable-target">This saved model is not returned by the provider. Choose an available model or check its access.</div>' : ""}
    `;
  }

  return `
    <input
      name="${escapeAttr(name)}"
      aria-label="${escapeAttr(sessionModelLabel(name))}"
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
    <div class="code-agent-card" data-code-agent-index="${index}" data-setup-agent-id="${escapeAttr(agent.id)}">
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
    <div class="code-agent-card hypothesis-agent-card" data-hypothesis-agent-index="${index}" data-setup-agent-id="${escapeAttr(agent.id)}">
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
      ${index >= 3 ? `<div class="field code-agent-delete">
        <label>&nbsp;</label>
        <button class="ghost-button" type="button" data-action="delete-hypothesis-agent" data-hypothesis-agent-index="${index}" data-hypothesis-agent-id="${escapeAttr(agent.id)}">Delete</button>
      </div>` : ""}
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
    voiceInput.cancelSession(sessionId);
    delete state.drafts[sessionId];
    delete state.draftAttachments[sessionId];
    await refreshBootstrap();

    if (deletingActive || (state.activeSessionId && !state.bootstrap.sessions.some(session => session.id === state.activeSessionId))) {
      state.activeSessionId = null;
      state.sessionSettings = null;
      state.messages = [];
      await ensureSession();
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

  const syncField = (providerFieldName, modelFieldName, datalistId, resetModel = false) => {
    const providerField = form.querySelector(`[name="${providerFieldName}"]`);

    if (!providerField) {
      return;
    }

    const providerId = providerField.value;
    const currentValue = resetModel ? "" : form.querySelector(`[name="${modelFieldName}"]`)?.value ?? "";
    const nextValue = resetModel ? getDefaultModelForProvider(providerId) : currentValue;
    const options = getSelectableSessionModels(providerId, nextValue);
    const field = form.querySelector(`.field [name="${modelFieldName}"]`)?.closest(".field");

    if (!field) {
      return;
    }

    field.innerHTML = `
      <label>${escapeHtml(sessionModelLabel(modelFieldName))}</label>
      ${renderSessionModelControl(modelFieldName, providerId, isCloudProvider(providerId) && isLocalCatalogModel(nextValue) ? "" : nextValue, options, datalistId)}
    `;
  };

  mappings.forEach(([providerFieldName, modelFieldName, datalistId]) => {
    const providerField = form.querySelector(`[name="${providerFieldName}"]`);
    if (!providerField) {
      return;
    }

    syncField(providerFieldName, modelFieldName, datalistId);
    providerField.addEventListener("change", () => syncField(providerFieldName, modelFieldName, datalistId, true));
  });

  form.querySelectorAll("[name^='codeAgentProvider:']").forEach((providerField) => {
    providerField.addEventListener("change", () => {
      const index = providerField.getAttribute("name")?.split(":")[1];

      if (!index) {
        return;
      }

      const providerId = providerField.value;
      const nextValue = getDefaultModelForProvider(providerId);
      const options = getSelectableSessionModels(providerId, nextValue);
      const field = form.querySelector(`[data-code-agent-model-index="${index}"]`);

      if (!field) {
        return;
      }

      field.innerHTML = `
        <label>Model</label>
        ${renderSessionModelControl(`codeAgentModel:${index}`, providerId, isCloudProvider(providerId) && isLocalCatalogModel(nextValue) ? "" : nextValue, options, `code-agent-model-options-${index}`)}
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
      const nextValue = getDefaultModelForProvider(providerId);
      const options = getSelectableSessionModels(providerId, nextValue);
      const field = form.querySelector(`[data-hypothesis-agent-model-index="${index}"]`);

      if (!field) {
        return;
      }

      field.innerHTML = `
        <label>Model</label>
        ${renderSessionModelControl(`hypothesisAgentModel:${index}`, providerId, isCloudProvider(providerId) && isLocalCatalogModel(nextValue) ? "" : nextValue, options, `hypothesis-agent-model-options-${index}`)}
      `;
    });
  });
}

function isCloudProvider(providerId) {
  return ["openai", "anthropic", "gemini"].includes(providerId);
}

function isLocalProvider(providerId) {
  return (state.bootstrap?.providers ?? []).find((provider) => provider.id === providerId)?.capabilities?.local ?? ["lmstudio", "ollama", "llamacpp"].includes(providerId);
}

function isLocalCatalogModel(modelId) {
  return (state.bootstrap?.allManagedModels ?? []).some((model) => model.id === modelId && isLocalProvider(model.providerId));
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

function bindWorkflowReviewActions() {
  document.querySelectorAll("[data-action='open-run-folder']").forEach(button => button.addEventListener("click", async () => {
    button.disabled = true;
    try { await api.revealWorkspacePath(button.dataset.rootPath, null, button.dataset.runId); }
    catch (error) { pushToast(error.message, "danger"); }
    finally { button.disabled = false; }
  }));
  document.querySelectorAll("[data-action='resume-workflow-run']").forEach(button => button.addEventListener("click", async () => {
    if (state.loading) return;
    await runAction(async () => {
      await request(`/workflow-runs/${encodeURIComponent(button.dataset.runId)}/resume`, { method: "POST", body: JSON.stringify({ background: true }) });
      await refreshBootstrap();
      state.workflowRunDetail = await api.getWorkflowRun(button.dataset.runId);
    });
  }));
  document.querySelectorAll("[data-agent-trace]").forEach(disclosure => disclosure.addEventListener("toggle", async () => {
    if (!disclosure.open) return;
    const output = disclosure.querySelector("[data-agent-steps]");
    try {
      const trace = await request(`/workflow-runs/${encodeURIComponent(disclosure.dataset.runId)}/agent-runs/${encodeURIComponent(disclosure.dataset.agentTrace)}`);
      const data = trace.run ?? trace;
      const text = Array.isArray(data.turns) ? data.turns.map((turn, index) => `${index + 1}. ${turn.type}\n${turn.content}`).join("\n\n") : JSON.stringify(data, null, 2);
      state.workflowAgentTraces[disclosure.dataset.agentTrace] = text;
      output.textContent = text || "No agent steps yet.";
    } catch (error) { output.textContent = error.message; }
  }));

  document.querySelectorAll("[data-action='review-workflow-run']").forEach((button) => {
    button.addEventListener("click", async () => {
      if (state.loading) return;
      const runId = button.dataset.runId;
      await runAction(async () => {
        await request(`/workflow-runs/${encodeURIComponent(runId)}/review`, {
          method: "POST", body: JSON.stringify({ approved: button.dataset.approved === "true", background: true,
            ...(button.dataset.approvalId ? { approvalId: button.dataset.approvalId } : { waitingNodeRunId: button.dataset.waitingNodeRunId })
          }), timeoutMs: 900000
        });
        await refreshBootstrap();
        state.workflowRunDetail = await api.getWorkflowRun(runId);
      });
    });
  });

}
