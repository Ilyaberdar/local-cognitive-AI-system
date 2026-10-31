const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
const busyStates = ["starting", "registering", "connecting"];

// Remote → This computer: let paired devices (a phone, another computer) use this computer through
// Local Cognitive Cloud. The main process keeps the host's keys; this page gets statuses, the
// one-time connection key it shows, and device names.
export function createRemoteHostUi({ bridge = window.desktopRemoteHost, account, onChange = () => {} } = {}) {
  let status = null, folders = [], loadError = "", pending = "", notice = "", shown = null, waiting = null, ticking = null;

  const call = async (method, ...args) => {
    const result = await bridge[method](...args);
    if (!result?.ok) throw Object.assign(new Error(result?.error?.message || "Hosting failed."), { code: result?.error?.code });
    return result.value;
  };
  const changed = () => { repaint(); onChange(); };
  const adopt = next => {
    status = next;
    // A key belongs to the session that made it: hosting off or paused, it is gone.
    if (next.state !== "online" && shown && !shown.consumed) forgetKey();
  };
  if (bridge) {
    bridge.onChange?.(next => { adopt(next); changed(); });
    void call("status").then(next => { adopt(next); changed(); }, error => { loadError = error.message; changed(); });
    void call("folders").then(list => { folders = list; changed(); }, () => {});
  }

  async function act(name, task) {
    if (pending) return;
    pending = name; notice = ""; changed();
    try { await task(); } catch (error) { notice = error.message; }
    pending = ""; changed();
  }
  function forgetKey() {
    clearInterval(waiting); clearInterval(ticking);
    waiting = ticking = null;
    shown = null;
  }
  // Like pairing two devices: the key shows until a device uses it or it expires.
  function watchKey() {
    waiting = setInterval(async () => {
      if (!shown) return;
      try {
        const used = await call("invitation", shown.invitationId);
        if (used.consumed) { clearInterval(waiting); clearInterval(ticking); shown = { ...shown, consumed: true, deviceName: used.deviceName }; changed(); }
      } catch { /* Asked again in two seconds. */ }
    }, 2000);
    ticking = setInterval(() => {
      if (shown && !shown.consumed && Date.now() >= shown.expiresAt) { forgetKey(); notice = "The key expired before a device used it. Show a new one."; changed(); }
      else document.querySelector("[data-host-key-left]")?.replaceChildren(timeLeft());
    }, 1000);
  }
  const timeLeft = () => {
    const seconds = Math.max(0, Math.round((shown.expiresAt - Date.now()) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };

  function statusCard() {
    const devices = status.devices.length, connected = status.devices.filter(device => device.connected).length;
    const card = (title, text, actions = "", tone = "") =>
      `<div class="account-card remote-status ${tone}" role="status"><div><h2><span class="status-dot"></span>${title}</h2><p>${text}</p></div>${actions ? `<div class="account-actions">${actions}</div>` : ""}</div>`;
    if (!status.available) return card("Not available on this computer", "Remote connections need the app's database and Local Cognitive Cloud; neither is available here.", "", "is-warning");
    if (status.state === "off") {
      const signIn = account?.get?.().state === "signed-out" ? ' Sign in first: it accepts the devices of the account signed in here. <a href="#/settings/account">Open Account settings</a>.' : "";
      return card("Remote connections are off", `Devices cannot connect to ${escape(status.hostName)}.${signIn}`);
    }
    if (status.state === "online") {
      const count = devices ? `${devices} device${devices === 1 ? "" : "s"} paired${connected ? `, ${connected} connected now` : ""}` : "No devices paired yet";
      return card(`${escape(status.hostName)} accepts connections`, `${count}. While the app runs, your devices can use this computer through Local Cognitive Cloud.`, "", "is-online");
    }
    if (busyStates.includes(status.state)) return card("Connecting to Local Cognitive Cloud…", "Devices can connect once this computer is online.", "", "is-busy");
    if (status.state === "offline") return card("Offline", `This computer could not reach Local Cognitive Cloud${status.lastError ? ` (${escape(status.lastError)})` : ""}. It keeps trying.`, "", "is-warning");
    switch (status.reason) {
      case "signed_out": return card("Paused: you are signed out", 'Devices can connect again once you sign in. <a href="#/settings/account">Open Account settings</a>.', "", "is-warning");
      case "other_account": return card("This computer belongs to another account",
        "It was set up for devices of the account signed in here before. To let this account's devices connect, unlink it: every device of the other account loses access.",
        `<button type="button" class="ghost-button" data-host-action="unlink"${pending ? " disabled" : ""}>${pending === "unlink" ? "Unlinking…" : "Unlink this computer"}</button>`, "is-warning");
      default: return card("Not connected", status.lastError ? escape(status.lastError) : "Remote connections could not start.", "", "is-warning");
    }
  }

  const toggle = (name, label, text, checked, disabled = false) =>
    `<div class="settings-row"><div><label for="host-${name}">${label}</label><p>${text}</p></div><div class="settings-control"><input id="host-${name}" type="checkbox" role="switch" data-host-setting="${name}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} /></div></div>`;
  function switches() {
    const off = !status.available || Boolean(pending);
    return `<div class="settings-rows">
      ${toggle("enabled", "Allow remote connections", "Your devices, signed in to the same account, can use this computer's chats and models.", status.enabled, off)}
      ${toggle("keepAwake", "Keep this computer awake", "While connections are allowed, it does not sleep when idle; the screen still turns off. A laptop with its lid closed sleeps anyway, and devices see it offline.", status.keepAwake, off || !status.enabled)}
      ${toggle("allowDeviceCommands", "Devices may approve commands and files", "Off: a device approves only file changes inside its chat's own folder; commands and other files it can only decline. On: your devices approve commands and files anywhere on this computer.", status.allowDeviceCommands, off)}
      ${toggle("openAtLogin", "Open at login", status.openAtLoginAvailable
        ? `Starts without a window, in the menu bar or the tray, when you sign in to this computer, so devices can connect after a restart.${status.openAtLoginNeedsApproval ? " <strong>macOS needs your approval:</strong> System Settings → General → Login Items, then turn on Local Cognitive." : ""}`
        : "Available in the installed app.", status.openAtLogin, off || !status.enabled || !status.openAtLoginAvailable)}
    </div>`;
  }

  function connectDevice() {
    if (status.state !== "online") return "";
    if (shown?.consumed) return `<div class="account-card remote-key-card"><div><h2>${escape(shown.deviceName || "A device")} is connected</h2><p>It can use this computer now, and reconnects by itself later.</p></div><div class="account-actions"><button type="button" class="ghost-button" data-host-action="done">Done</button></div></div>`;
    if (!shown) return `<div class="account-card remote-key-card"><div><h2>Connect a device</h2><p>Show a one-time key: scan it with the Local Cognitive app on your iPhone, or paste it on another computer in Remote → Connect a computer. A key works once and expires after 10 minutes.</p></div>
      <div class="account-actions"><button type="button" class="primary-button" data-host-action="show-key"${pending ? " disabled" : ""}>${pending === "show-key" ? "Making a key…" : "Show connection key"}</button></div></div>`;
    const code = shown.qrSvg ? `<div class="remote-key-qr">${shown.qrSvg}</div>` : "";
    return `<div class="account-card remote-key-card"><div><h2>Connection key</h2><p>${shown.qrSvg ? "On your iPhone: scan this code in the Local Cognitive app (Computers → +). On another computer: Remote, then paste the key into Connect a computer." : "On the other device: Remote, then paste this key into Connect a computer."} Valid for <span data-host-key-left>${timeLeft()}</span>.</p></div>
      ${code}<textarea class="remote-key" rows="3" readonly spellcheck="false" aria-label="Connection key">${escape(shown.key)}</textarea>
      <p class="settings-description" role="status">Waiting for a device to connect…</p>
      <div class="account-actions"><button type="button" class="ghost-button" data-host-action="copy-key">${shown.copied ? "Copied" : "Copy key"}</button><button type="button" class="ghost-button" data-host-action="hide-key">Hide</button></div></div>`;
  }

  const day = value => {
    const date = value ? new Date(value) : undefined;
    return date && !Number.isNaN(date.getTime()) ? escape(date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })) : "";
  };
  function deviceList() {
    if (!status.devices.length) return "";
    return `<section class="remote-section"><div class="remote-section-head"><h2>Devices</h2></div><ul class="remote-devices remote-host-devices">${status.devices.map(device => `<li>
      <span><span class="status-dot ${device.connected ? "is-online" : ""}"></span>${escape(device.name)}</span>
      <span class="subtle">${device.connected ? "Connected now" : device.lastConnectedAt ? `Last seen ${day(device.lastConnectedAt)}` : `Paired ${day(device.grantedAt)}`}</span>
      <button type="button" class="ghost-button" data-host-action="revoke" data-device-id="${escape(device.deviceId)}" data-device-name="${escape(device.name)}"${pending ? " disabled" : ""}>Remove access</button></li>`).join("")}</ul></section>`;
  }

  function folderList() {
    if (!status.available) return "";
    const open = folder => `<button type="button" class="ghost-button" data-host-action="open-folder" data-folder-id="${escape(folder.id)}">Open</button>`;
    const rows = folders.map(folder => `<div class="settings-row"><div><span class="settings-row-label">${escape(folder.label)}</span><p class="remote-folder-location">${escape(folder.location)}${folder.managed ? " · this app's own folder" : ""}</p>
      ${folder.managed ? "" : `<label class="settings-control remote-folder-create"><input type="checkbox" role="switch" data-folder-create="${escape(folder.id)}" ${folder.allowCreate ? "checked" : ""}${pending ? " disabled" : ""} /><span>Devices may make folders here</span></label>`}</div>
      <div class="settings-control remote-folder-actions">${folder.managed ? "" : `<button type="button" class="ghost-button" data-host-action="remove-folder" data-folder-id="${escape(folder.id)}" data-folder-label="${escape(folder.label)}"${pending ? " disabled" : ""}>Stop sharing</button>`}${open(folder)}</div></div>`).join("");
    return `<section class="remote-section"><div class="remote-section-head"><div><h2>Shared folders</h2><p class="subtle remote-section-note">Devices make projects and save their files only in these folders.</p></div>
      <button type="button" class="ghost-button" data-host-action="add-folder"${pending ? " disabled" : ""}>Share a folder…</button></div><div class="settings-rows remote-host-folders">${rows}</div></section>`;
  }

  function inner() {
    if (!bridge) return '<div class="account-card"><div><h2>Available in the desktop app</h2><p>Open the Local Cognitive desktop app to let your devices connect to this computer.</p></div></div>';
    if (!status) return loadError ? `<p class="remote-error" role="alert">${escape(loadError)}</p>` : '<p class="settings-description" role="status">Loading…</p>';
    return `${statusCard()}${notice ? `<p class="remote-error" role="alert">${escape(notice)}</p>` : ""}${switches()}${connectDevice()}${deviceList()}${folderList()}
      <p class="settings-footnote">Traffic between your devices and this computer is end-to-end encrypted; Local Cognitive Cloud only routes it. Devices see this computer's chats (not those of its projects) and models; they never use its MCP tools.</p>`;
  }

  function repaint() {
    const container = document.querySelector("[data-remote-host-root]");
    if (container) container.innerHTML = inner();
  }

  function bind(root) {
    root.addEventListener("change", event => {
      const folderId = event.target.dataset?.folderCreate;
      if (folderId) { const allowCreate = event.target.checked; void act("set-folder", async () => { folders = await call("setFolder", folderId, { allowCreate }); }); return; }
      const name = event.target.dataset?.hostSetting;
      if (!name) return;
      const value = event.target.checked;
      void act("set", async () => { adopt(await call("set", { [name]: value })); });
    });
    root.addEventListener("click", event => {
      const button = event.target.closest("[data-host-action]");
      if (!button) return;
      const action = button.dataset.hostAction;
      if (action === "show-key") void act("show-key", async () => { forgetKey(); shown = await call("connectKey"); watchKey(); });
      if (action === "hide-key" || action === "done") { forgetKey(); changed(); }
      if (action === "copy-key" && shown) void navigator.clipboard.writeText(shown.key).then(() => { shown = { ...shown, copied: true }; changed(); }, () => { notice = "The key could not be copied. Select it and copy it."; changed(); });
      if (action === "revoke" && window.confirm(`Remove ${button.dataset.deviceName || "this device"}'s access to this computer? It is disconnected at once and needs a new key to connect again.`)) {
        void act("revoke", async () => { await call("revokeDevice", button.dataset.deviceId); adopt(await call("status")); });
      }
      if (action === "add-folder") void act("add-folder", async () => { folders = await call("addFolder"); });
      if (action === "open-folder") void call("openFolder", button.dataset.folderId).catch(error => { notice = error.message; changed(); });
      if (action === "remove-folder" && window.confirm(`Stop sharing ${button.dataset.folderLabel || "this folder"}? Devices can no longer use it or the projects in it; nothing in it is deleted.`)) {
        void act("remove-folder", async () => { folders = await call("removeFolder", button.dataset.folderId); });
      }
      if (action === "unlink" && window.confirm("Unlink this computer from the account it was set up for? Every device of that account loses access; this account's devices can then connect.")) {
        void act("unlink", async () => { adopt(await call("unlink")); });
      }
    });
  }

  return { inner, bind, repaint, dispose: forgetKey, status: () => status };
}
