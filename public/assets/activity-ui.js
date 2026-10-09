const toolLabels = {
  "file.read": "Reading file", "file.write": "Writing file", "file.replace": "Editing file",
  "file.list": "Listing files", "file.search": "Searching files", "command.run": "Running command",
  "web.fetch": "Reading webpage", "web.search": "Searching the web", "mcp.list": "Discovering tools",
  "mcp.call": "Calling external tool", "plugins.call": "Calling plugin", "plugins.list": "Discovering plugins"
};

export function activityLabel(event = {}) {
  const label = String(event.label || event.message || "");
  if (/^Step started$/i.test(label)) return "Starting";
  if (/^Step completed$/i.test(label)) return "Completed";
  const tool = label.replace(/ (completed|failed)$/, "");
  if (toolLabels[tool]) return `${toolLabels[tool]}${/ failed$/.test(label) ? " · failed" : / completed$/.test(label) ? " · done" : ""}`;
  if (label && !/^(Step \d+|Step start|Working|Working in project|Generating|Generating response)$/i.test(label)) return label;
  const phase = String(event.phase || "").toLowerCase();
  return ({ queued: "Waiting in queue", loading: "Loading model", thinking: "Thinking", answer: "Writing response",
    responding: "Writing response", generating: "Waiting for model", waiting: "Waiting for model",
    approval: "Waiting for approval", complete: "Response ready", failed: "Request failed", cancelled: "Interrupted" })[phase] || "Preparing request";
}

const escape = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const duration = milliseconds => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000)) || 0;
  return seconds === 0 ? "<1s" : seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

export function renderChatActivity({ activity = [], pending = false, progress, createdAt, agents = "", format = String } = {}) {
  if (!pending && !activity.length) return "";
  const last = activity.at(-1);
  // A turn began when it was sent, or at its first recorded step if that is earlier.
  const first = Date.parse(activity[0]?.at), sent = Date.parse(createdAt);
  const start = pending && Number.isFinite(sent) && !(first < sent) ? createdAt : activity[0]?.at || createdAt;
  const end = pending ? Date.now() : Date.parse(last?.updatedAt || createdAt);
  const failed = last?.status === "error";
  const label = pending ? activityLabel(progress || last) : failed ? "Activity interrupted" : "Activity";
  const rows = activity.map(entry => {
    const elapsed = (pending && entry.status === "active" ? end : Date.parse(entry.updatedAt)) - Date.parse(entry.at);
    return `<li class="activity-trace__event is-${escape(entry.status)}">
    <span class="activity-trace__marker" aria-hidden="true"></span><div><span class="activity-trace__label">${escape(activityLabel(entry))}</span>
    ${entry.detail ? `<p title="${escape(format(entry.detail))}">${escape(format(entry.detail))}</p>` : ""}
    ${entry.note ? `<details class="activity-trace__note" data-activity-key="note-${escape(entry.id)}"><summary>Model notes</summary><pre>${escape(entry.note)}</pre></details>` : ""}</div>
    <time>${elapsed >= 1000 ? escape(duration(elapsed)) : ""}</time></li>`;
  }).join("");
  return `<details class="activity-trace ${pending ? "is-live" : ""} ${failed ? "is-error" : ""}" data-activity-key="trace">
    <summary><span class="activity-trace__dot" aria-hidden="true"></span><span class="activity-trace__current" role="status">${escape(label)}</span>
    <time>${escape(duration(end - Date.parse(start)))}</time><span class="activity-trace__chevron" aria-hidden="true">›</span></summary>
    <div class="activity-trace__body">${rows ? `<ol>${rows}</ol>` : '<p class="activity-trace__empty">Sending your request to the model…</p>'}${agents}
    <small>Actual actions and model-provided notes. Some providers do not share intermediate activity.</small></div></details>`;
}

/** Keep disclosure, focus and scroll state while the live data changes. */
export function patchChatActivity(root, html) {
  if (!root || root.dataset.html === html) return;
  const opened = new Set([...root.querySelectorAll("details[open]")].map(el => el.dataset.activityKey || el.dataset.agentId));
  const scrolls = [...root.querySelectorAll("pre,.activity-trace__body")].map(el => ({ key: el.closest("[data-activity-key]")?.dataset.activityKey, top: el.scrollTop, tag: el.tagName }));
  const focus = root.contains(document.activeElement) ? document.activeElement.closest("[data-activity-key]")?.dataset.activityKey : undefined;
  root.innerHTML = html;
  root.querySelectorAll("details").forEach(el => { el.open = opened.has(el.dataset.activityKey || el.dataset.agentId); });
  root.querySelectorAll("pre,.activity-trace__body").forEach(el => { const saved = scrolls.find(item => item.key === el.closest("[data-activity-key]")?.dataset.activityKey && item.tag === el.tagName); if (saved) el.scrollTop = saved.top; });
  if (focus) [...root.querySelectorAll("[data-activity-key]")].find(el => el.dataset.activityKey === focus)?.querySelector("summary")?.focus({ preventScroll: true });
  root.dataset.html = html;
}
