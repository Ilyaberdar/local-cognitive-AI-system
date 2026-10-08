import { icon } from "./ui-primitives.js";

const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
const busyStates = ["connecting", "reconnecting"];

// Remote → Connect (spec §6, R3): pair this computer with a server by its one-time key,
// reconnect to paired servers, and manage which computers may connect. Keys, tickets and
// tokens never reach this page; the desktop bridge returns statuses only.
export function createRemoteUi({ bridge = window.desktopRemote, account, onChange = () => {} }) {
  let status = { state: bridge ? "idle" : "unavailable" };
  let hosts = [], hostsLoaded = false, hostsError = "", hostStatus = null, keyDraft = "", pending = "", notice = "", root;

  const call = async (method, ...args) => {
    const result = await bridge[method](...args);
    if (!result?.ok) throw Object.assign(new Error(result?.error?.message || "Remote failed."), { code: result?.error?.code });
    return result.value;
  };
  const changed = () => { repaint(); onChange(); };
  // Call results and change events both report the status; either may arrive first.
  const adopt = next => {
    const sameSession = status.state === "online" && status.hostId === next.hostId;
    status = next;
    if (next.state === "online" && (!sameSession || !hostStatus)) { void loadHostStatus(); void loadHosts(); }
    if (next.state !== "online") hostStatus = null;
  };

  if (bridge) {
    bridge.onChange?.(next => { adopt(next); changed(); });
    void call("status").then(next => { adopt(next); changed(); }, () => {});
    account?.subscribe?.(view => { if (view.state === "signed-in") void loadHosts(); else { hosts = []; hostsLoaded = false; } changed(); });
  }

  async function loadHosts() {
    if (!bridge || account?.get?.().state !== "signed-in") return;
    try { hosts = await call("hosts"); hostsError = ""; } catch (error) { hostsError = error.message; }
    hostsLoaded = true;
    changed();
  }
  async function loadHostStatus() {
    try { hostStatus = await call("hostStatus"); } catch { hostStatus = null; }
    changed();
  }
  async function act(name, task) {
    if (pending) return;
    pending = name; notice = ""; changed();
    try { await task(); } catch (error) { notice = error.message; }
    pending = ""; changed();
  }

  function statusCard() {
    const host = escape(status.hostName || "the server");
    const disconnect = `<button type="button" class="ghost-button" data-remote-action="disconnect"${pending ? " disabled" : ""}>Disconnect</button>`;
    const forget = status.hostId ? `<button type="button" class="ghost-button" data-remote-action="forget" data-host-id="${escape(status.hostId)}"${pending ? " disabled" : ""}>Forget server</button>` : "";
    const error = status.error ? `<p class="remote-error" role="alert">${escape(status.error.message)}</p>` : "";
    const card = (title, text, actions = "", tone = "") =>
      `<div class="account-card remote-status ${tone}" role="status"><div><h2><span class="status-dot"></span>${title}</h2><p>${text}</p>${error}</div>${actions ? `<div class="account-actions">${actions}</div>` : ""}</div>`;
    switch (status.state) {
      case "online": return card(`Connected to ${host}`, `Local Cognitive ${escape(status.serverVersion || "")} on the server. This computer stays paired: Connect works again without a key.`, disconnect, "is-online");
      case "connecting": return card(`Connecting to ${host}…`, "Setting up an end-to-end encrypted connection through Local Cognitive Cloud.", disconnect, "is-busy");
      case "reconnecting": case "offline": return card(`Reconnecting to ${host}…`, "The connection dropped. Local Cognitive keeps trying in the background.", disconnect, "is-busy");
      case "revoked": return card("Access removed", "This computer can no longer connect to the server. Ask for a new key on the server to connect again.", forget, "is-warning");
      case "identity_changed": return card("The server's identity changed", "The server answered with a different key than when you paired. If it was reinstalled, forget it and connect with a new key; otherwise the connection may be intercepted.", forget, "is-warning");
      case "error": return card("Not connected", "Everything runs on this computer.", "", "is-warning");
      default: return card("This computer", "Everything runs on this computer. Connect a server to use its GPU and models.");
    }
  }

  function serverStatus() {
    if (status.state !== "online" || !hostStatus) return "";
    const work = hostStatus.activeWork?.total ?? 0;
    const inference = hostStatus.inference || {};
    const backend = inference.active || inference.backend || "unknown";
    const rows = [
      ["State", hostStatus.phase === "draining" ? "Finishing work, then stopping" : "Running"],
      ["Inference", `${escape(backend)}${inference.fallbackReason ? ` · ${escape(inference.fallbackReason)}` : ""}`],
      ["Loaded models", hostStatus.loadedModels?.length ? hostStatus.loadedModels.map(escape).join(", ") : "None"],
      ["Active work", work ? `${work} task${work === 1 ? "" : "s"}` : "Idle"]
    ];
    return `<div class="settings-rows remote-server-status">${rows.map(([label, value]) => `<div class="settings-row"><div><label>${label}</label></div><div class="settings-control">${value}</div></div>`).join("")}</div>`;
  }

  function connectForm() {
    const disabled = pending || busyStates.includes(status.state) ? " disabled" : "";
    return `<form class="account-card remote-connect" data-remote-form>
      <div><h2>Connect a server</h2><p>On the server, run <code>local-cognitive-server connect-key</code> and paste the key here. A key works once and expires after 10 minutes.</p></div>
      <textarea class="remote-key" data-remote-key rows="3" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="LCR1-…" aria-label="Connection key"${disabled}>${escape(keyDraft)}</textarea>
      <div class="account-actions"><button type="submit" class="primary-button"${disabled || !keyDraft.trim() ? " disabled" : ""}>${pending === "pair" ? "Connecting…" : "Connect"}</button></div>
    </form>`;
  }

  function serverList() {
    if (!hostsLoaded) return '<p class="settings-description" role="status">Loading your servers…</p>';
    if (hostsError) return `<p class="remote-error" role="alert">${escape(hostsError)} <button type="button" class="ghost-button" data-remote-action="reload">Try again</button></p>`;
    if (!hosts.length) return '<p class="settings-description">No servers yet. The first key you use links its server to your account.</p>';
    return `<div class="remote-hosts">${hosts.map(host => {
      const current = status.hostId === host.hostId && status.state === "online";
      const actions = [
        host.paired && !current ? `<button type="button" class="ghost-button" data-remote-action="connect" data-host-id="${escape(host.hostId)}"${pending || !host.online ? " disabled" : ""}>Connect</button>` : "",
        host.paired ? `<button type="button" class="ghost-button" data-remote-action="forget" data-host-id="${escape(host.hostId)}"${pending ? " disabled" : ""}>Forget</button>` : ""
      ].join("");
      const devices = host.devices.map(device => `<li><span>${escape(device.name)}${device.current ? ' <span class="account-badge">This computer</span>' : ""}</span><span class="subtle">${escape(device.platform)}</span><button type="button" class="ghost-button" data-remote-action="revoke" data-host-id="${escape(host.hostId)}" data-device-id="${escape(device.deviceId)}"${pending ? " disabled" : ""}>Remove access</button></li>`).join("");
      return `<div class="remote-host"><div class="remote-host-head"><div><strong>${escape(host.name)}</strong><span class="subtle"><span class="status-dot ${host.online ? "is-online" : ""}"></span>${host.online ? "Online" : "Offline"} · ${escape(host.appVersion)}${current ? " · connected" : ""}${!host.paired ? " · not paired with this computer" : ""}</span></div><div class="account-actions">${actions}</div></div>${devices ? `<ul class="remote-devices">${devices}</ul>` : ""}</div>`;
    }).join("")}</div>`;
  }

  function inner() {
    if (status.state === "unavailable") return note("Remote is available in the desktop app", "Open the Local Cognitive desktop app to connect to a server.");
    const view = account?.get?.() || { state: "signed-out" };
    if (view.state === "loading") return '<p class="settings-description" role="status">Checking your account…</p>';
    if (view.state !== "signed-in") return note("Sign in to use Remote", 'Remote connects this app to Local Cognitive on another computer you own, through your account. <a href="#/settings/account">Open Account settings</a>.');
    const unverified = view.profile && !view.profile.emailVerified ? `<p class="remote-error" role="status">${icon("info")}<span>Verify your email address to connect servers, then choose Check again in Account settings.</span></p>` : "";
    return `${unverified}${statusCard()}${serverStatus()}${notice ? `<p class="remote-error" role="alert">${escape(notice)}</p>` : ""}${connectForm()}
      <section class="remote-section"><div class="remote-section-head"><h2>Your servers</h2><button type="button" class="ghost-button" data-remote-action="reload"${pending ? " disabled" : ""}>Refresh</button></div>${serverList()}</section>
      <p class="settings-footnote">Traffic between this computer and the server is end-to-end encrypted; Local Cognitive Cloud only routes it. To chat on a server, choose it in the switch at the top of the chat screen; its answers continue even when this app is closed.</p>`;
  }
  const note = (title, text) => `<div class="account-card"><div><h2>${escape(title)}</h2><p>${text}</p></div></div>`;

  function render() {
    return `<div class="remote-page"><header class="remote-header"><h1>${icon("remote")}<span>Remote</span></h1><p class="subtle">Use Local Cognitive on another computer — for example a server with a GPU.</p></header><div data-remote-root>${inner()}</div></div>`;
  }

  function repaint() {
    const container = document.querySelector("[data-remote-root]");
    if (!container) return;
    const focused = document.activeElement?.matches?.("[data-remote-key]");
    const caret = focused ? document.activeElement.selectionStart : 0;
    container.innerHTML = inner();
    if (focused) { const field = container.querySelector("[data-remote-key]"); field?.focus(); field?.setSelectionRange(caret, caret); }
  }

  function bind(element) {
    if (!element || element === root) return;
    root = element;
    root.addEventListener("input", event => {
      if (!event.target.matches("[data-remote-key]")) return;
      keyDraft = event.target.value;
      const submit = root.querySelector("[data-remote-form] button[type=submit]");
      if (submit) submit.disabled = Boolean(pending) || !keyDraft.trim();
    });
    root.addEventListener("submit", event => {
      if (!event.target.matches("[data-remote-form]")) return;
      event.preventDefault();
      const key = keyDraft.trim();
      if (!key) return;
      void act("pair", async () => {
        const next = await call("pair", key);
        adopt(next);
        // The key is single-use: clear it once accepted or refused for good; a typo stays editable.
        if (next.state === "online" || /^(invitation_|host_owned|key_expired)/.test(next.error?.code || "")) keyDraft = "";
        if (next.error) notice = next.error.message;
        await loadHosts();
      });
    });
    root.addEventListener("click", event => {
      const button = event.target.closest("[data-remote-action]");
      if (!button) return;
      const { remoteAction: action, hostId, deviceId } = button.dataset;
      if (action === "reload") void loadHosts();
      if (action === "disconnect") void act("disconnect", async () => { adopt(await call("disconnect")); });
      if (action === "connect") void act("connect", async () => { adopt(await call("connect", hostId)); if (status.error) notice = status.error.message; });
      if (action === "forget") void act("forget", async () => { adopt(await call("forget", hostId)); await loadHosts(); });
      if (action === "revoke") void act("revoke", async () => { await call("revokeDevice", hostId, deviceId); await loadHosts(); });
    });
  }

  return { render, bind, repaint, refresh: loadHosts, status: () => status };
}
