import { icon } from "./ui-primitives.js";

const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
const ALLOWED_SETTINGS = ["mode", "language", "outputStyle", "reasoningEffort", "defaultTarget"];
// Agents and debate, for a server that offers them (R5-4: `sessions.setup.get`).
const AGENT_SETTINGS = ["codeAgents", "hypothesisAgents", "debate"];
const DEBATE_PROFILES = ["general", "technical", "product", "research", "security"];
const MAX_SUBAGENTS = 4, MAX_HYPOTHESIS_AGENTS = 8;
const remoteTarget = value => value?.providerId ? { providerId: value.providerId, ...(value.model && value.providerId !== "local" ? { model: value.model } : {}) } : undefined;
/** An agent as a server takes it: no access mode (agents use the chat's), no empty model. */
const remoteAgent = (agent, withRole) => ({ id: String(agent.id ?? ""), name: String(agent.name ?? "").trim(), ...(withRole ? { role: agent.role } : {}), ...remoteTarget(agent) });
const remoteAgentSetting = (key, value) => {
  if (key === "codeAgents") return Array.isArray(value) ? value.map(agent => remoteAgent(agent, false)) : undefined;
  if (key === "hypothesisAgents") return Array.isArray(value) ? value.map(agent => remoteAgent(agent, true)) : undefined;
  if (!value || typeof value !== "object") return undefined;
  // Whether a chat debates follows its type (`mode`): `enabled` is never sent.
  const debate = { ...(value.profile ? { profile: value.profile } : {}) };
  for (const role of ["support", "attack", "judge"]) if (remoteTarget(value[role])) debate[role] = remoteTarget(value[role]);
  return debate;
};
const TERMINAL = { "run.completed": "completed", "run.failed": "failed", "run.cancelled": "cancelled", "run.interrupted": "interrupted", "run.needs_review": "needs_review" };

/** The settings a server chat may change, and only those that differ from the server's copy.
 * Agents and debate go only to a server that offers them (`agents`). */
export function remoteSettingsPatch(patch, current, { agents = false } = {}) {
  const result = {};
  if (agents) {
    // Ask or approve-for-me; full access is given only on the server itself.
    if (["ask", "default"].includes(patch?.defaultAccessMode) && patch.defaultAccessMode !== current?.defaultAccessMode) result.defaultAccessMode = patch.defaultAccessMode;
    for (const key of AGENT_SETTINGS) {
      const value = remoteAgentSetting(key, patch?.[key]);
      if (value === undefined) continue;
      const before = remoteAgentSetting(key, current?.[key]);
      const same = key === "debate" ? Object.entries(value).every(([name, item]) => JSON.stringify(item) === JSON.stringify(before?.[name])) : JSON.stringify(value) === JSON.stringify(before);
      if (!same) result[key] = value;
    }
  }
  for (const key of ALLOWED_SETTINGS) {
    const value = patch?.[key];
    if (value === undefined || value === null) continue;
    if (key === "defaultTarget") {
      if (!value.providerId) continue;
      const target = { providerId: value.providerId, ...(value.model ? { model: value.model } : {}) };
      if (current?.defaultTarget?.providerId === target.providerId && (current.defaultTarget.model || undefined) === target.model) continue;
      result.defaultTarget = target;
    } else if (value !== current?.[key]) result[key] = value;
  }
  return result;
}

/** Applies a batch of stream events to the view of one server chat: `{ lastSeq, run }`, where
 * `run` is the turn in progress (`runId, input, startedAt, answer, progress, approval`).
 * Returns what changed so the screen can patch instead of re-rendering. */
export function reduceSessionEvents(view, events) {
  const effects = new Set();
  let terminal;
  for (const event of events) {
    if (event.seq <= (view.lastSeq ?? 0)) continue;
    view.lastSeq = event.seq;
    const payload = event.payload || {};
    const own = view.run && view.run.runId === payload.runId;
    switch (event.type) {
      case "message.accepted":
        // A turn this window did not send (another device, or before a reload) appears too.
        if (!own) { view.run = { runId: payload.runId, input: payload.message?.content ?? "", startedAt: payload.message?.createdAt ?? event.occurredAt, answer: "" }; effects.add("render"); }
        break;
      case "run.started":
        if (!view.run) { view.run = { runId: payload.runId, input: "", startedAt: event.occurredAt, answer: "" }; effects.add("render"); }
        break;
      case "message.delta": {
        if (!own) break;
        const answer = view.run.answer || "";
        const offset = Number(payload.offset) || 0, text = String(payload.text ?? "");
        if (payload.replace) view.run.answer = text;
        else if (offset > answer.length) { effects.add("resync"); break; }
        else view.run.answer = answer.slice(0, offset) + text;
        effects.add("progress");
        break;
      }
      case "run.progress":
        if (own) { view.run.progress = payload.progress; effects.add("progress"); }
        break;
      case "approval.requested":
        if (own) { view.run.approval = { id: payload.approvalId, tool: payload.tool, operation: payload.operation, summary: payload.summary, details: payload.details }; effects.add("approval"); }
        break;
      case "approval.resolved":
        if (own) { view.run.approval = undefined; effects.add("approval"); }
        break;
      default:
        if (TERMINAL[event.type]) {
          if (own) { terminal = { runId: payload.runId, status: TERMINAL[event.type], error: payload.error }; view.run = undefined; }
          effects.add("reload");
        }
    }
  }
  return { effects, terminal };
}

/** Progress in the shape the chat screen renders for a local run. */
export const runProgress = run => ({ phase: "generating", label: run.answer ? "Writing response" : "Preparing request", at: new Date().toISOString(),
  ...(run.progress || {}), answer: run.answer || "" });

/** Model choices of a server for one provider: its library models first, then the catalog. */
export function remoteModelOptions(models, providerId) {
  const managed = (models?.allManagedModels ?? []).filter(model => model.providerId === providerId && model.filesAvailable !== false && model.compatibility?.canLoad !== false)
    .map(model => ({ id: model.libraryId || model.id, label: `${model.displayName || model.id}${model.quantization ? ` · ${model.quantization}` : ""}`,
      loaded: Boolean(model.loaded || model.loadedInstanceIds?.length || model.state === "ready") }));
  const catalog = (models?.availableModels ?? []).filter(model => model.providerId === providerId && !managed.some(item => item.id === model.id))
    .map(model => ({ id: model.id, label: model.id, loaded: (models?.loadedModels ?? []).some(item => item.providerId === providerId && item.id === model.id) }));
  return [...managed, ...catalog].sort((left, right) => Number(right.loaded) - Number(left.loaded));
}

export function createChatTarget({ bridge = window.desktopRemote, account, onChange = () => {}, onEvent = () => {} } = {}) {
  const runtime = bridge?.runtime;
  let target = "local", status = { state: runtime ? "idle" : "unavailable" }, hosts = [], sessions = [], sessionsLoaded = false, models;
  const refs = new Map(), keysByRef = new Map(), settings = new Map(), setups = new Map(), views = new Map(), lastSession = new Map();
  let subscribed, generation = 0, modelsStale = false;

  // Every call names its server (the selected one, or the one a chat lives on): the main process
  // refuses it once another server is connected.
  const call = async (op, payload, host = target) => {
    const result = await runtime.request(op, payload, host);
    if (!result?.ok) throw Object.assign(new Error(result?.error?.message || "The server did not answer."), { code: result?.error?.code });
    return result.value;
  };
  const serverId = key => refs.get(key)?.sessionId;
  const hostOf = key => refs.get(key)?.hostId;
  /** Whether the server a chat lives on offers agents and debate (and says when a chat is its own). */
  const agentsOn = host => status.hostId === host && (status.capabilities ?? []).includes("sessions.setup.get");
  /** A screen key for a server chat: one key per server and chat, in the alphabet voice input accepts. */
  const keyFor = (sessionId, hostId = target) => {
    const ref = `${hostId}:${sessionId}`;
    let key = keysByRef.get(ref);
    if (!key) {
      key = `remote-${String(hostId).replace(/[^a-zA-Z0-9]/g, "").slice(0, 32)}-${String(sessionId).replace(/[^a-zA-Z0-9]/g, "").slice(0, 48)}-${refs.size}`;
      refs.set(key, { hostId, sessionId }); keysByRef.set(ref, key);
    }
    return key;
  };
  const changed = () => onChange({});

  if (runtime) {
    bridge.onChange?.(next => {
      const wasOnline = api.online();
      status = next;
      // A server paired in the Remote tab joins the switch at once.
      if (next.hostId && next.state === "online" && !hosts.some(host => host.hostId === next.hostId && host.paired)) void api.refreshHosts();
      onChange({ cameOnline: !wasOnline && api.online() });
    });
    runtime.onEvent?.(update => {
      if (!subscribed || update.streamId !== subscribed.streamId) return;
      onEvent(subscribed.key, update);
    });
    void bridge.status?.().then(result => { if (result?.ok) { status = result.value; changed(); } }, () => {});
    account?.subscribe?.(() => { void api.refreshHosts(); });
  }

  const api = {
    available: () => Boolean(runtime),
    isRemote: () => target !== "local",
    hostId: () => (target === "local" ? undefined : target),
    hostName: () => hosts.find(host => host.hostId === target)?.name || (status.hostId === target ? status.hostName : "") || "server",
    status: () => status,
    online: () => target !== "local" && status.state === "online" && status.hostId === target,
    /** Remote and not connected: nothing may be sent, approved or cancelled. */
    blocksSend: () => target !== "local" && !(status.state === "online" && status.hostId === target),
    canChat: () => (status.capabilities ?? []).includes("chat.runs.start"),
    /** Whether the connected server offers an operation (known once it is online). */
    supports: op => target !== "local" && status.hostId === target && (status.capabilities ?? []).includes(op),
    generation: () => generation,
    owns: key => typeof key === "string" && refs.has(key),
    serverSessionId: serverId,
    pairedHosts: () => hosts.filter(host => host.paired),
    /** The switch is offered once a server is paired, and always while one is selected. */
    visible: () => Boolean(runtime) && account?.get?.().state === "signed-in" && (hosts.some(host => host.paired) || target !== "local"),
    async refreshHosts() {
      if (!runtime || account?.get?.().state !== "signed-in") { hosts = []; changed(); return; }
      try { const result = await bridge.hosts(); if (result?.ok) hosts = result.value; } catch { /* Keep the last list. */ }
      changed();
    },
    async select(next) {
      api.release();
      target = next || "local";
      generation++;
      sessions = []; sessionsLoaded = false; models = undefined; modelsStale = false;
      if (target !== "local" && !(status.state === "online" && status.hostId === target)) {
        const result = await bridge.connect(target).catch(() => undefined);
        if (result?.ok) status = result.value;
      }
      changed();
    },
    reconnect: async () => { if (target !== "local") { const result = await bridge.connect(target); if (result?.ok) status = result.value; changed(); } },
    sessionList: () => sessions,
    sessionsLoaded: () => sessionsLoaded,
    lastSessionKey: () => lastSession.get(target),
    rememberSession: key => { if (api.owns(key)) lastSession.set(refs.get(key).hostId, key); },
    async refreshSessions() {
      const host = target;
      const list = await call("sessions.list");
      if (host !== target) return sessions;
      sessions = list.map(session => ({ ...session, id: keyFor(session.id, host), serverId: session.id, running: Boolean(session.activeRunId) }));
      sessionsLoaded = true;
      return sessions;
    },
    /** Renames a server chat; the list shows the new title at once. */
    async rename(key, title) {
      const session = await call("sessions.rename", { sessionId: serverId(key), title }, hostOf(key));
      const listed = sessions.find(item => item.id === key);
      if (listed) Object.assign(listed, { title: session.title, updatedAt: session.updatedAt });
      return { ...session, id: key, serverId: session.id };
    },
    /** Deletes a server chat there, for every device; what this window kept of it goes too. */
    async remove(key) {
      await call("sessions.delete", { sessionId: serverId(key) }, hostOf(key));
      sessions = sessions.filter(item => item.id !== key);
      settings.delete(key); setups.delete(key); views.delete(key);
      if (subscribed?.key === key) api.release();
      for (const [host, last] of lastSession) if (last === key) lastSession.delete(host);
    },
    async createSession(title = "New chat") {
      const session = await call("sessions.create", { title });
      return { ...session, id: keyFor(session.id), serverId: session.id };
    },
    /** History, the turn in progress and the cursor to follow the chat from. */
    async load(key) {
      const sessionId = serverId(key), host = hostOf(key), agents = agentsOn(host);
      const [snapshot, setup] = await Promise.all([call("sessions.messages.list", { sessionId }, host),
        agents ? call("sessions.setup.get", { sessionId }, host) : call("sessions.settings.get", { sessionId }, host).then(value => ({ settings: value }))]);
      const sessionSettings = setup.settings;
      settings.set(key, sessionSettings);
      setups.set(key, { agents, hostOnly: setup.access?.hostOnly, modes: setup.access?.modes ?? [], limits: setup.limits });
      const run = snapshot.activeRun;
      const runMessages = run ? snapshot.messages.filter(message => message.runId === run.runId) : [];
      const view = { lastSeq: snapshot.cursor.after, run: run ? { runId: run.runId, input: runMessages.find(message => message.role === "user")?.content ?? "",
        startedAt: run.createdAt, answer: run.partialText || "", progress: run.progress,
        approval: run.pendingApproval ? { id: run.pendingApproval.approvalId, tool: run.pendingApproval.tool, operation: run.pendingApproval.operation,
          summary: run.pendingApproval.summary, details: run.pendingApproval.details } : undefined } : undefined };
      views.set(key, view);
      return { messages: run ? snapshot.messages.filter(message => message.runId !== run.runId) : snapshot.messages, settings: sessionSettings, view, cursor: snapshot.cursor };
    },
    view: key => views.get(key),
    /** What a server chat's setup offers: agents (`agents`), and why it is the server's alone (`hostOnly`). */
    setup: key => setups.get(key) ?? { agents: false, modes: [] },
    async updateSettings(key, patch) {
      const current = settings.get(key);
      const changes = remoteSettingsPatch(patch, current, { agents: Boolean(setups.get(key)?.agents) });
      if (!Object.keys(changes).length && current) return current;
      const saved = await call("sessions.settings.update", { sessionId: serverId(key), patch: changes }, hostOf(key));
      settings.set(key, saved);
      return saved;
    },
    /** Sends a chat's prepared attachments to its server in chunks and answers their ids for the
     * turn. An attachment remembers its upload, so sending the message again resumes or reuses it. */
    async upload(key, attachments) {
      const host = hostOf(key), sessionId = serverId(key), ids = [];
      for (const attachment of attachments) {
        const content = attachment.kind === "image" ? attachment.dataUrl : attachment.textContent;
        if (!["image", "text"].includes(attachment.kind) || typeof content !== "string" || !content) throw new Error(`${attachment.name} cannot be sent to the server.`);
        const sent = attachment.remoteUpload?.host === host && attachment.remoteUpload.sessionId === sessionId ? attachment.remoteUpload : undefined;
        const uploadId = sent?.uploadId ?? crypto.randomUUID();
        const sha256 = sent?.sha256 ?? [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)))]
          .map(byte => byte.toString(16).padStart(2, "0")).join("");
        attachment.remoteUpload = { host, sessionId, uploadId, sha256 };
        const begun = await call("uploads.begin", { uploadId, sessionId, name: attachment.name, mimeType: attachment.mimeType, kind: attachment.kind,
          sizeBytes: attachment.sizeBytes, length: content.length, sha256, ...(attachment.truncated ? { truncated: true } : {}), ...(attachment.warning ? { warning: attachment.warning } : {}) }, host);
        const size = begun.chunkChars;
        for (let index = 0; index < Math.ceil(content.length / size); index++) {
          if (!begun.received.includes(index)) await call("uploads.chunk", { uploadId, index, data: content.slice(index * size, (index + 1) * size) }, host);
        }
        await call("uploads.commit", { uploadId }, host);
        ids.push(uploadId);
      }
      return ids;
    },
    async send(key, input, attachmentIds = []) {
      const result = await runtime.send("chat.runs.start", { sessionId: serverId(key), input, ...(attachmentIds.length ? { attachmentIds } : {}) }, hostOf(key));
      if (!result?.ok) throw Object.assign(new Error(result?.error?.message || "The message was not sent."), { code: result?.error?.code });
      return result.value;
    },
    cancel: runId => call("chat.runs.cancel", { runId }),
    resolveApproval: (runId, approvalId, approved) => call("chat.approvals.resolve", { runId, approvalId, approved }),
    async models(refresh = false) {
      if (!models || refresh) {
        const host = target;
        modelsStale = false;
        const value = await call("models.available");
        if (host === target) models = value;
      }
      return models;
    },
    cachedModels: () => models,
    /** The server's library changed (Models tab): the chat's model choices are fetched again. */
    invalidateModels: () => { if (target !== "local") modelsStale = true; },
    modelsStale: () => modelsStale,
    subscribe(key, cursor) {
      if (subscribed && subscribed.streamId !== cursor.streamId) void runtime.unsubscribe(subscribed.streamId);
      subscribed = { key, streamId: cursor.streamId };
      void runtime.subscribe(cursor, hostOf(key));
    },
    release() {
      if (subscribed) void runtime?.unsubscribe(subscribed.streamId);
      subscribed = undefined;
    }
  };
  return api;
}

const STATE_LABEL = { online: "Online", connecting: "Connecting…", reconnecting: "Reconnecting…", offline: "Offline", revoked: "Access removed", identity_changed: "Identity changed", error: "Not connected", idle: "Not connected" };

/** The window's "This computer / <server>" switch for the top bar: chats and models follow it. */
export function renderTargetSwitch(target) {
  const status = target.status(), remote = target.isRemote();
  const tone = !remote ? "is-local" : target.online() ? "is-online" : ["connecting", "reconnecting"].includes(status.state) ? "is-busy" : "is-warning";
  const label = remote ? target.hostName() : "This computer";
  const rows = target.pairedHosts().map(host => {
    const current = status.hostId === host.hostId ? status.state : "idle";
    const note = !host.online ? "Offline" : current === "online" ? (status.capabilities?.includes("chat.runs.start") ? "Online" : "Update the server to chat") : STATE_LABEL[current] || "";
    return `<button type="button" class="chat-target-option" data-chat-target="${escape(host.hostId)}" aria-pressed="${target.hostId() === host.hostId}">
      ${icon("remote")}<span><strong>${escape(host.name)}</strong><small>${escape(note)}</small></span><span class="chat-target-option__check">${target.hostId() === host.hostId ? icon("check") : ""}</span></button>`;
  }).join("");
  return `<span class="chat-target"><button type="button" class="chat-target-trigger ${tone}" popovertarget="chat-target-menu" aria-label="Runs on: ${escape(label)}" title="Where chats and models run">
      <span class="status-dot"></span><span class="chat-target-label">${escape(label)}</span>${icon("chevronDown")}</button>
    <div id="chat-target-menu" class="chat-target-menu access-menu" popover="auto" role="group" aria-label="Where chats and models run">
      <div class="access-menu__heading">Where should chats and models run?</div>
      <button type="button" class="chat-target-option" data-chat-target="local" aria-pressed="${!remote}">${icon("chat")}<span><strong>This computer</strong><small>Chats and models on this Mac</small></span><span class="chat-target-option__check">${!remote ? icon("check") : ""}</span></button>
      ${rows}
      <a class="access-menu__footer chat-target-manage" href="#/remote">Manage servers</a>
    </div></span>`;
}

/** Whether a server chat's images can be read: refused when the server says the chat's model sees text only. */
export function remoteImageGuidance(attachments, settings, models, hostName) {
  if (!attachments?.some(attachment => attachment.kind === "image")) return { blocked: false, message: "" };
  const target = settings?.defaultTarget ?? {};
  const model = (models?.allManagedModels ?? []).find(item => item.providerId === target.providerId && (item.libraryId || item.id) === target.model);
  return model?.vision === false
    ? { blocked: true, message: `${model.displayName || target.model} on ${hostName} reads text only. Remove the image or choose a model that can see images.` }
    : { blocked: false, message: "" };
}

/** Shown above the composer while a selected server is not connected, or when the chat on screen
 * (`key`) is the server's alone. */
export function renderTargetBanner(target, key) {
  const hostOnly = key && target.online() ? target.setup(key).hostOnly : "";
  if (hostOnly) return `<section class="chat-approval chat-target-banner" role="status"><div class="chat-approval__heading">${icon("shieldAlert")}<strong>${escape(hostOnly)}</strong></div></section>`;
  if (!target.isRemote() || target.online()) return "";
  const status = target.status();
  const name = escape(target.hostName());
  const reason = status.state === "revoked" ? `This computer's access to ${name} was removed. Nothing is sent.`
    : status.state === "identity_changed" ? `${name} answered with a different identity. Nothing is sent until you check it in Remote.`
    : ["connecting", "reconnecting", "offline"].includes(status.state) ? `${name} is reconnecting. Nothing is sent; your draft is kept.`
    : `${name} is not connected. Nothing is sent; your draft is kept.`;
  return `<section class="chat-approval chat-target-banner" role="status"><div class="chat-approval__heading">${icon("info")}<strong>${reason}</strong></div>
    <div class="chat-approval__actions"><button type="button" class="ghost-button" data-chat-target-action="reconnect">Retry</button>
    <button type="button" class="primary-button" data-chat-target="local">Use This computer</button></div></section>`;
}

/** A model choice of the server for one provider, the saved one kept when the server no longer lists it. */
export function remoteModelSelect(name, providerId, model, models) {
  const option = (value, current, label = value) => `<option value="${escape(value)}" ${String(value) === String(current ?? "") ? "selected" : ""}>${escape(label)}</option>`;
  if (providerId === "local") return `<select name="${escape(name)}" data-remote-model disabled><option value="">Built-in judge</option></select>`;
  const choices = remoteModelOptions(models, providerId);
  const unknown = model && !choices.some(choice => choice.id === model);
  return `<select name="${escape(name)}" data-remote-model>
    <option value="">${models ? (choices.length ? "Server default" : "No models on the server") : "Loading models…"}</option>
    ${unknown ? `<option value="${escape(model)}" selected>${escape(model)}</option>` : ""}
    ${choices.map(choice => option(choice.id, model, `${choice.label}${choice.loaded ? " · Loaded" : ""}`)).join("")}
  </select>`;
}

/** The subagents or debate agents of a server chat, in the markup of this computer's setup so the
 * same handlers add, delete and save them; every model choice is the server's. */
function renderRemoteAgents({ mode, settings, providers, models, hostName }) {
  const option = (value, current, label = value) => `<option value="${escape(value)}" ${String(value) === String(current ?? "") ? "selected" : ""}>${escape(label)}</option>`;
  const providerSelect = (name, modelName, current, list) => `<select name="${escape(name)}" data-remote-provider="${escape(modelName)}">${list.map(provider => option(provider.id, current, provider.name)).join("")}${current && !list.some(provider => provider.id === current) ? option(current, current) : ""}</select>`;
  if (mode !== "hypothesis") {
    const agents = settings.codeAgents ?? [];
    const cards = agents.map((agent, index) => `<div class="code-agent-card" data-code-agent-index="${index}" data-setup-agent-id="${escape(agent.id)}">
        <input type="hidden" name="codeAgentId:${index}" value="${escape(agent.id)}" />
        <div class="field"><label>Name</label><input name="codeAgentName:${index}" value="${escape(agent.name)}" maxlength="60" /></div>
        <div class="field"><label>Provider</label>${providerSelect(`codeAgentProvider:${index}`, `codeAgentModel:${index}`, agent.providerId, providers)}</div>
        <div class="field code-agent-model-field" data-code-agent-model-index="${index}"><label>Model</label>${remoteModelSelect(`codeAgentModel:${index}`, agent.providerId, agent.model ?? "", models)}</div>
        <div class="field code-agent-delete"><label>&nbsp;</label><button class="ghost-button" type="button" data-action="delete-code-agent" data-code-agent-index="${index}">Delete</button></div>
      </div>`).join("");
    return `<section class="setup-section">
        <div class="row-between"><div><div class="section-label">Subagents · on ${escape(hostName)}</div><div class="subtle">Use @name in chat or ask to spawn a subagent. Max ${MAX_SUBAGENTS} active.</div></div>
          <button class="ghost-button" type="button" data-action="add-code-agent" aria-label="Add subagent" title="Add subagent" ${agents.length >= MAX_SUBAGENTS ? "disabled" : ""}>${icon("plus")}</button></div>
        <div class="code-agents">${cards || `<div class="empty compact-empty">No configured subagents. Spawn uses the main model.</div>`}</div>
      </section>`;
  }
  // A chat saved before it had debate agents debates with its three debate targets.
  const agents = settings.hypothesisAgents?.length ? settings.hypothesisAgents : ["support", "attack", "judge"].map(role => ({ id: `hypothesis-${role}`,
    name: role[0].toUpperCase() + role.slice(1), role, ...remoteTarget(settings.debate?.[role] ?? { providerId: role === "judge" ? "local" : settings.defaultTarget?.providerId }) }));
  const judges = [...providers, { id: "local", name: "local" }];
  const cards = agents.map((agent, index) => `<div class="code-agent-card hypothesis-agent-card" data-hypothesis-agent-index="${index}" data-setup-agent-id="${escape(agent.id)}">
      <input type="hidden" name="hypothesisAgentId:${index}" value="${escape(agent.id)}" />
      <div class="field"><label>Name</label><input name="hypothesisAgentName:${index}" value="${escape(agent.name)}" maxlength="60" /></div>
      <div class="field"><label>Role</label><select name="hypothesisAgentRole:${index}" ${index < 3 ? "disabled" : ""}>${(index < 3 ? ["support", "attack", "judge", "advisor"] : ["advisor"]).map(value => option(value, agent.role)).join("")}</select>
        ${index < 3 ? `<input type="hidden" name="hypothesisAgentRole:${index}" value="${escape(agent.role)}" />` : ""}</div>
      <div class="field"><label>Provider</label>${providerSelect(`hypothesisAgentProvider:${index}`, `hypothesisAgentModel:${index}`, agent.providerId, agent.role === "judge" ? judges : providers)}</div>
      <div class="field hypothesis-agent-model-field" data-hypothesis-agent-model-index="${index}"><label>Model</label>${remoteModelSelect(`hypothesisAgentModel:${index}`, agent.providerId, agent.model ?? "", models)}</div>
      ${index >= 3 ? `<div class="field code-agent-delete"><label>&nbsp;</label><button class="ghost-button" type="button" data-action="delete-hypothesis-agent" data-hypothesis-agent-index="${index}" data-hypothesis-agent-id="${escape(agent.id)}">Delete</button></div>` : ""}
    </div>`).join("");
  return `<section class="setup-section">
      <div class="chat-settings__grid compact"><div class="field"><label>Profile</label><select name="debateProfile">${DEBATE_PROFILES.map(value => option(value, settings.debate?.profile)).join("")}</select></div></div>
      <div class="row-between"><div><div class="section-label">Hypothesis models · on ${escape(hostName)}</div><div class="subtle">Support, attack, and judge are used now. Add up to 5 advisors for expanded debate flow.</div></div>
        <button class="ghost-button" type="button" data-action="add-hypothesis-agent" aria-label="Add advisor" title="Add advisor" ${agents.length >= MAX_HYPOTHESIS_AGENTS ? "disabled" : ""}>${icon("plus")}</button></div>
      <div class="code-agents hypothesis-agents">${cards}</div>
    </section>`;
}

/** Session setup for a server chat: chat type, language, the server's model and, on a server that
 * offers them (`agents`), its subagents or debate agents. `hostOnly`: why only the server may change it. */
export function renderRemoteSetupPanel({ settings, sessionKey, title, hostName, models, collapsed, autosaveLabel, reviewTabs = "", agents = false, hostOnly = "", renamable = false }) {
  const option = (value, current, label = value) => `<option value="${escape(value)}" ${String(value) === String(current ?? "") ? "selected" : ""}>${escape(label)}</option>`;
  const mode = settings.debate?.enabled || settings.mode === "hypothesis" ? "hypothesis" : settings.mode === "code" ? "code" : "general";
  const providers = (models?.providers ?? []).filter(provider => provider.id !== "local");
  const providerId = settings.defaultTarget?.providerId;
  const model = settings.defaultTarget?.model ?? "";
  const note = hostOnly || (agents ? "" : `Update Local Cognitive on ${hostName} to add subagents and debate agents to its chats.`);
  return `<form class="panel chat-settings form-grid ${collapsed ? "chat-settings--collapsed" : ""}" id="session-settings-form" data-session-id="${escape(sessionKey)}" data-remote-setup="true" data-setup-mode="${escape(mode)}">
      <div class="session-resize-handle" data-action="resize-right-panel" title="Resize panel"></div>
      ${reviewTabs}
      <div id="session-setup-body" class="chat-settings__body">
        ${hostOnly ? `<p class="subtle remote-setup-note remote-setup-note--host" role="note">${escape(hostOnly)}</p>` : ""}
        <fieldset class="remote-setup-fields" ${hostOnly ? "disabled" : ""}>
        <div class="chat-type-bar">${["general", "code", "hypothesis"].map(type => `<button class="chat-type-button ${mode === type ? "active" : ""}" type="button" data-action="set-chat-type" data-chat-type="${type}">${escape(type[0].toUpperCase() + type.slice(1))}</button>`).join("")}</div>
        <div class="chat-settings__grid compact session-metadata-grid">
          <div class="field session-title-field"><label>Title</label>${renamable
            ? `<input name="remoteTitle" value="${escape(title)}" maxlength="200" data-remote-title />`
            : `<input value="${escape(title)}" readonly aria-readonly="true" title="Update Local Cognitive on ${escape(hostName)} to rename its chats here" />`}</div>
          <div class="field"><label>Language</label><select name="language">${["auto", "ru", "en"].map(value => option(value, settings.language)).join("")}</select></div>
          <input type="hidden" name="mode" value="${escape(mode)}" />
        </div>
        <section class="setup-section">
          <div class="section-label">Main model · on ${escape(hostName)}</div>
          <div class="chat-settings__grid compact">
            <div class="field"><label>Provider</label><select name="defaultProvider" data-remote-provider="defaultModel">${providers.map(provider => option(provider.id, providerId, provider.name)).join("")}${providerId && !providers.some(provider => provider.id === providerId) ? option(providerId, providerId) : ""}</select></div>
            <div class="field"><label>Model</label>${remoteModelSelect("defaultModel", providerId, model, models)}</div>
          </div>
        </section>
        ${agents ? renderRemoteAgents({ mode, settings, providers, models, hostName }) : ""}
        </fieldset>
        ${hostOnly || !note ? "" : `<p class="subtle remote-setup-note">${escape(note)}</p>`}
        <div class="subtle setup-save-status" data-autosave-status aria-live="polite">${escape(autosaveLabel)}</div>
      </div>
    </form>`;
}

/** Reads the server chat's setup form; nothing is resolved against this computer's models. */
export function readRemoteSetup(form, settings) {
  // A chat that is the server's alone shows its setup read-only: nothing on it is read back.
  if (form.querySelector("fieldset.remote-setup-fields")?.disabled) return settings;
  const data = new FormData(form);
  const text = name => String(data.get(name) ?? "").trim();
  const providerId = String(data.get("defaultProvider") || settings.defaultTarget?.providerId || "");
  const model = String(data.get("defaultModel") || "");
  const mode = String(data.get("mode") || settings.mode || "general");
  const targetOf = (prefix, index, fallback) => {
    const provider = text(`${prefix}Provider:${index}`) || fallback?.providerId || providerId;
    const chosen = provider === "local" ? "" : text(`${prefix}Model:${index}`);
    return { providerId: provider, ...(chosen ? { model: chosen } : {}) };
  };
  const result = { ...settings, mode, language: String(data.get("language") || settings.language), debate: { ...settings.debate, enabled: mode === "hypothesis" },
    defaultTarget: { providerId, ...(model ? { model } : {}) } };
  if (form.querySelector(".code-agents:not(.hypothesis-agents)")) {
    result.codeAgents = [...form.querySelectorAll(".code-agent-card[data-code-agent-index]")].slice(0, MAX_SUBAGENTS).map((card, position) => {
      const index = card.dataset.codeAgentIndex, existing = settings.codeAgents?.[position];
      return { id: text(`codeAgentId:${index}`) || existing?.id || `agent-${position + 1}`, name: text(`codeAgentName:${index}`) || existing?.name || `Agent${position + 1}`,
        accessMode: settings.defaultAccessMode || "default", ...targetOf("codeAgent", index, existing) };
    });
  }
  if (form.querySelector(".hypothesis-agents")) {
    result.hypothesisAgents = [...form.querySelectorAll(".hypothesis-agent-card[data-hypothesis-agent-index]")].slice(0, MAX_HYPOTHESIS_AGENTS).map((card, position) => {
      const index = card.dataset.hypothesisAgentIndex, existing = settings.hypothesisAgents?.[position];
      const role = text(`hypothesisAgentRole:${index}`) || existing?.role || "advisor";
      return { id: text(`hypothesisAgentId:${index}`) || existing?.id || `hypothesis-${position + 1}`, name: text(`hypothesisAgentName:${index}`) || existing?.name || `Advisor${position}`,
        role: ["support", "attack", "judge", "advisor"].includes(role) ? role : "advisor", ...targetOf("hypothesisAgent", index, existing) };
    });
    const byRole = role => result.hypothesisAgents.find(agent => agent.role === role);
    result.debate = { ...result.debate, profile: text("debateProfile") || settings.debate?.profile || "general" };
    for (const role of ["support", "attack", "judge"]) if (byRole(role)) result.debate[role] = { providerId: byRole(role).providerId, ...(byRole(role).model ? { model: byRole(role).model } : {}) };
  }
  return result;
}
