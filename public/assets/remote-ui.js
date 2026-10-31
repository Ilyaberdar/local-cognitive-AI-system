import { icon } from "./ui-primitives.js";

const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
const busyStates = ["connecting", "reconnecting"];

// Remote → Connect (spec §6, R3): pair this computer with a server by its one-time key,
// reconnect to paired servers, and manage which computers may connect. Keys, tickets and
// tokens never reach this page; the desktop bridge returns statuses only.
// With `hostUi`, a second tab, This computer, lets devices connect to this computer (remote-host-ui.js).
export function createRemoteUi({ bridge = window.desktopRemote, account, hostUi, onChange = () => {} }) {
  let status = { state: bridge ? "idle" : "unavailable" };
  let tab = "connect";
  try { if (hostUi && localStorage.getItem("lcai.remoteTab") === "host") tab = "host"; } catch { /* No storage: the first tab. */ }
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
    const host = escape(status.hostName || "the other computer");
    const disconnect = `<button type="button" class="ghost-button" data-remote-action="disconnect"${pending ? " disabled" : ""}>Disconnect</button>`;
    const forget = status.hostId ? `<button type="button" class="ghost-button" data-remote-action="forget" data-host-id="${escape(status.hostId)}"${pending ? " disabled" : ""}>Forget</button>` : "";
    const error = status.error ? `<p class="remote-error" role="alert">${escape(status.error.message)}</p>` : "";
    const card = (title, text, actions = "", tone = "") =>
      `<div class="account-card remote-status ${tone}" role="status"><div><h2><span class="status-dot"></span>${title}</h2><p>${text}</p>${error}</div>${actions ? `<div class="account-actions">${actions}</div>` : ""}</div>`;
    switch (status.state) {
      case "online": return card(`Connected to ${host}`, `Local Cognitive ${escape(status.serverVersion || "")} there. This computer stays paired: Connect works again without a key.`, disconnect, "is-online");
      case "connecting": return card(`Connecting to ${host}…`, "Setting up an end-to-end encrypted connection through Local Cognitive Cloud.", disconnect, "is-busy");
      case "reconnecting": case "offline": return card(`Reconnecting to ${host}…`, "The connection dropped. Local Cognitive keeps trying in the background.", disconnect, "is-busy");
      case "revoked": return card("Access removed", `This computer can no longer connect to ${host}. Get a new connection key from ${host} to connect again.`, forget, "is-warning");
      case "identity_changed": return card(`${host} has a different identity`, `${host} answered with a different key than when you paired. If it was reinstalled, forget it and connect with a new key; otherwise the connection may be intercepted.`, forget, "is-warning");
      case "error": return card("Not connected", "Everything runs on this computer.", "", "is-warning");
      default: return card("This computer", "Everything runs on this computer. Connect another one, such as a server with a GPU, to use its models.");
    }
  }

  function serverStatus() {
    if (status.state !== "online" || !hostStatus) return "";
    const work = hostStatus.activeWork?.total ?? 0;
    const inference = hostStatus.inference || {};
    const backend = inference.active || inference.backend || "unknown";
    const update = hostStatus.update?.available;
    // A computer that hosts (kind "desktop") reports what its models run on, without a preference: it has no admin flags.
    const rows = [
      ["Version", `${escape(hostStatus.version || status.serverVersion || "")}${update ? ` · <strong>${escape(update.version)} available</strong>` : ""}`],
      ["State", hostStatus.phase === "draining" ? "Finishing work, then stopping" : "Running"],
      ...(hostStatus.inference ? [["Inference", `${escape(backend)}${inference.fallbackReason ? ` · ${escape(inference.fallbackReason)}` : ""}`]] : []),
      ["Loaded models", hostStatus.loadedModels?.length ? hostStatus.loadedModels.map(escape).join(", ") : "None"],
      ["Active work", work ? `${work} task${work === 1 ? "" : "s"}` : "Idle"]
    ];
    // A newer release is installed by the server's administrator: the server cannot update itself.
    const notice = update ? `<div class="account-card remote-update" role="status"><div><h2>Local Cognitive ${escape(update.version)} is available for ${escape(status.hostName || "the server")}</h2>
      <p>On the server, run <code>sudo local-cognitive-server update</code>. It backs the data up, installs the release beside the running one, and goes back if the new one does not start.</p>
      ${update.notes ? `<details><summary>What's new</summary><pre class="remote-update-notes">${escape(update.notes)}</pre></details>` : ""}</div></div>` : "";
    return `<div class="settings-rows remote-server-status">${rows.map(([label, value]) => `<div class="settings-row"><div><label>${label}</label></div><div class="settings-control">${value}</div></div>`).join("")}</div>${notice}`;
  }

  function connectForm() {
    const disabled = pending || busyStates.includes(status.state) ? " disabled" : "";
    return `<form class="account-card remote-connect" data-remote-form>
      <div><h2>Connect a computer</h2><p>On a computer with Local Cognitive, open Remote → This computer → Show connection key; on a server, run <code>sudo local-cognitive-server pair</code>. Paste the key here. A key works once and expires after 10 minutes.</p></div>
      <textarea class="remote-key" data-remote-key rows="3" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="LCR1-…" aria-label="Connection key"${disabled}>${escape(keyDraft)}</textarea>
      <div class="account-actions"><button type="submit" class="primary-button"${disabled || !keyDraft.trim() ? " disabled" : ""}>${pending === "pair" ? "Connecting…" : "Connect"}</button></div>
    </form>`;
  }

  // Two computers can have one name (a Mac paired again from another profile): the day each was paired tells them apart.
  const pairedOn = value => {
    const date = value ? new Date(value) : undefined;
    return date && !Number.isNaN(date.getTime()) ? ` · paired ${escape(date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }))}` : "";
  };

  // What kind of computer a host is, when the Cloud knows: a sleeping laptop is not a broken server.
  const kindOf = host => host.kind === "server" ? "Server · " : host.kind === "desktop" ? (host.platform === "macos" ? "Mac · " : host.platform === "windows" ? "PC · " : "Computer · ") : "";
  const offlineSince = value => {
    const date = value ? new Date(value) : undefined;
    if (!date || Number.isNaN(date.getTime())) return "Offline";
    const sameDay = date.toDateString() === new Date().toDateString();
    return `Offline since ${escape(sameDay ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : date.toLocaleDateString(undefined, { day: "numeric", month: "short" }))}`;
  };

  function serverList() {
    if (!hostsLoaded) return '<p class="settings-description" role="status">Loading your computers…</p>';
    if (hostsError) return `<p class="remote-error" role="alert">${escape(hostsError)} <button type="button" class="ghost-button" data-remote-action="reload">Try again</button></p>`;
    if (!hosts.length) return '<p class="settings-description">No computers yet. The first key you use links its computer to your account.</p>';
    return `<div class="remote-hosts">${hosts.map(host => {
      const current = status.hostId === host.hostId && status.state === "online";
      // This computer is listed when it hosts devices: nothing to connect to or forget, only its devices.
      const actions = host.self ? "" : [
        host.paired && !current ? `<button type="button" class="ghost-button" data-remote-action="connect" data-host-id="${escape(host.hostId)}"${pending || !host.online ? " disabled" : ""}>Connect</button>` : "",
        host.paired ? `<button type="button" class="ghost-button" data-remote-action="forget" data-host-id="${escape(host.hostId)}"${pending ? " disabled" : ""}>Forget</button>` : "",
        // A server that is gone (reinstalled, say) stays listed until it is removed from the account.
        !host.online && !current ? `<button type="button" class="ghost-button" data-remote-action="remove-host" data-host-id="${escape(host.hostId)}" data-host-name="${escape(host.name)}"${pending ? " disabled" : ""}>Remove from account</button>` : ""
      ].join("");
      const devices = host.devices.map(device => `<li><span>${escape(device.name)}${device.current ? ' <span class="account-badge">This computer</span>' : ""}</span><span class="subtle">${escape(device.platform)}${pairedOn(device.grantedAt)}</span><button type="button" class="ghost-button" data-remote-action="revoke" data-host-id="${escape(host.hostId)}" data-device-id="${escape(device.deviceId)}"${pending ? " disabled" : ""}>Remove access</button></li>`).join("");
      const badge = host.self ? ' <span class="account-badge">This computer</span>' : "";
      return `<div class="remote-host"><div class="remote-host-head"><div><strong>${escape(host.name)}</strong>${badge}<span class="subtle"><span class="status-dot ${host.online ? "is-online" : ""}"></span>${kindOf(host)}${host.online ? "Online" : offlineSince(host.lastSeenAt)} · ${escape(host.appVersion)}${current ? " · connected" : ""}${!host.paired && !host.self ? " · not paired with this computer" : ""}</span></div><div class="account-actions">${actions}</div></div>${devices ? `<ul class="remote-devices">${devices}</ul>` : ""}</div>`;
    }).join("")}</div>`;
  }

  function inner() {
    if (status.state === "unavailable") return note("Remote is available in the desktop app", "Open the Local Cognitive desktop app to connect to another computer.");
    const view = account?.get?.() || { state: "signed-out" };
    if (view.state === "loading") return '<p class="settings-description" role="status">Checking your account…</p>';
    if (view.state !== "signed-in") return note("Sign in to use Remote", 'Remote connects this app to Local Cognitive on another computer you own, through your account. <a href="#/settings/account">Open Account settings</a>.');
    const unverified = view.profile && !view.profile.emailVerified ? `<p class="remote-error" role="status">${icon("info")}<span>Verify your email address to connect computers, then choose Check again in Account settings.</span></p>` : "";
    return `${unverified}${statusCard()}${serverStatus()}${notice ? `<p class="remote-error" role="alert">${escape(notice)}</p>` : ""}${connectForm()}
      <section class="remote-section"><div class="remote-section-head"><h2>Your computers</h2><button type="button" class="ghost-button" data-remote-action="reload"${pending ? " disabled" : ""}>Refresh</button></div>${serverList()}</section>
      <p class="settings-footnote">Traffic between this computer and the other one is end-to-end encrypted; Local Cognitive Cloud only routes it. To chat on another computer, choose it in the switch at the top of the chat screen; its answers continue even when this app is closed.</p>`;
  }
  const note = (title, text) => `<div class="account-card"><div><h2>${escape(title)}</h2><p>${text}</p></div></div>`;

  function render() {
    const tabButton = (id, label) => `<button type="button" role="tab" class="orchestration-tab remote-tab ${tab === id ? "active" : ""}" aria-selected="${tab === id}" data-remote-tab="${id}">${label}</button>`;
    const tabs = hostUi ? `<div class="segmented-control remote-tabs" role="tablist" aria-label="Remote">${tabButton("connect", "Other computers")}${tabButton("host", "This computer")}</div>` : "";
    const subtitle = hostUi && tab === "host" ? "Let your phone or another computer use this one." : "Use Local Cognitive on another computer — for example a server with a GPU.";
    const body = hostUi && tab === "host" ? `<div data-remote-host-root>${hostUi.inner()}</div>` : `<div data-remote-root>${inner()}</div>`;
    return `<div class="remote-page"><header class="remote-header"><h1>${icon("remote")}<span>Remote</span></h1><p class="subtle">${subtitle}</p></header>${tabs}${body}</div>`;
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
    hostUi?.bind(root);
    root.addEventListener("click", event => {
      const choice = event.target.closest("[data-remote-tab]")?.dataset.remoteTab;
      if (!choice || choice === tab) return;
      tab = choice;
      try { localStorage.setItem("lcai.remoteTab", tab); } catch { /* Remembered for this window only. */ }
      root.innerHTML = render();
      onChange();
    });
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
      if (action === "remove-host" && window.confirm(`Remove ${button.dataset.hostName || "it"} from your account? Every device loses access to it; to use it again, connect it with a new key.`)) {
        void act("remove-host", async () => { await call("removeHost", hostId); await loadHosts(); });
      }
    });
  }

  function showTab(name) {
    if (!hostUi || !["connect", "host"].includes(name) || name === tab) return;
    tab = name;
    try { localStorage.setItem("lcai.remoteTab", tab); } catch { /* Remembered for this window only. */ }
    if (root) root.innerHTML = render();
  }

  return { render, bind, repaint, showTab, refresh: loadHosts, status: () => status };
}
