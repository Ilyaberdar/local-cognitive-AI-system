const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopAppearance", {
  platform: process.platform,
  setTheme: (theme) => {
    if (theme === "dark" || theme === "light") ipcRenderer.send("appearance:set-theme", theme);
  }
});

contextBridge.exposeInMainWorld("desktopModels", {
  importModel: () => ipcRenderer.invoke("models:select-files"),
  importProjector: modelId => ipcRenderer.invoke("models:select-projector", modelId),
  selectDirectory: () => ipcRenderer.invoke("models:select-directory")
});

contextBridge.exposeInMainWorld("desktopProjects", {
  selectDirectory: () => ipcRenderer.invoke("projects:select-directory")
});

contextBridge.exposeInMainWorld("desktopVoice", {
  status: () => ipcRenderer.invoke("voice:status"),
  install: () => ipcRenderer.invoke("voice:install"),
  cancelDownload: () => ipcRenderer.invoke("voice:cancel-download"),
  removeModel: () => ipcRenderer.invoke("voice:remove-model"),
  updateSettings: value => ipcRenderer.invoke("voice:settings", value),
  requestMicrophone: id => ipcRenderer.invoke("voice:microphone", id),
  releaseMicrophone: id => ipcRenderer.invoke("voice:release-microphone", id),
  openMicrophoneSettings: () => ipcRenderer.invoke("voice:open-settings"),
  transcribe: value => ipcRenderer.invoke("voice:transcribe", value),
  cancel: id => ipcRenderer.invoke("voice:cancel", id),
  onStopCapture: callback => {
    const listener = () => callback();
    ipcRenderer.on("voice:stop-capture", listener);
    return () => ipcRenderer.removeListener("voice:stop-capture", listener);
  }
});

// Account status only; tokens stay in the main process.
contextBridge.exposeInMainWorld("desktopAccount", {
  status: () => ipcRenderer.invoke("account:status"),
  signIn: method => ipcRenderer.invoke("account:sign-in", method),
  cancelSignIn: () => ipcRenderer.invoke("account:cancel-sign-in"),
  signOut: () => ipcRenderer.invoke("account:sign-out"),
  onChange: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("account:changed", listener);
    return () => ipcRenderer.removeListener("account:changed", listener);
  }
});

// Error reports: the user's consent, and this window's uncaught errors (the main process decides
// what may leave; nothing does without consent).
contextBridge.exposeInMainWorld("desktopDiagnostics", {
  consent: () => ipcRenderer.invoke("diagnostics:consent"),
  setConsent: value => ipcRenderer.invoke("diagnostics:set-consent", value === true),
  reportError: report => ipcRenderer.send("diagnostics:renderer-error", report && { name: String(report.name || "").slice(0, 40), message: String(report.message || "").slice(0, 1000), stack: String(report.stack || "").slice(0, 8000) })
});

// Report a bug: previews here, the screenshot and the server's diagnostics stay in the main process.
contextBridge.exposeInMainWorld("desktopBugReport", {
  capture: () => ipcRenderer.invoke("bugReport:capture"),
  prepare: request => ipcRenderer.invoke("bugReport:prepare", request),
  submit: form => ipcRenderer.invoke("bugReport:submit", form),
  export: form => ipcRenderer.invoke("bugReport:export", form)
});

// The Usage page's numbers, put together in the main process with the account token.
contextBridge.exposeInMainWorld("desktopUsage", {
  overview: request => ipcRenderer.invoke("usage:overview", request)
});

// Remote statuses and host summaries; keys, tickets and tokens stay in the main process.
// Each call resolves with { ok, value } or { ok: false, error: { code, message } }.
contextBridge.exposeInMainWorld("desktopRemote", {
  status: () => ipcRenderer.invoke("remote:status"),
  hosts: () => ipcRenderer.invoke("remote:hosts"),
  pair: key => ipcRenderer.invoke("remote:pair", key),
  connect: hostId => ipcRenderer.invoke("remote:connect", hostId),
  disconnect: () => ipcRenderer.invoke("remote:disconnect"),
  forget: hostId => ipcRenderer.invoke("remote:forget", hostId),
  revokeDevice: (hostId, deviceId) => ipcRenderer.invoke("remote:revoke-device", hostId, deviceId),
  hostStatus: () => ipcRenderer.invoke("remote:host-status"),
  onChange: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("remote:changed", listener);
    return () => ipcRenderer.removeListener("remote:changed", listener);
  },
  // Screens on the selected server: allowlisted operations, safe resends, event streams and
  // state watches. `hostId` is the server the screen shows; a call for another one is refused.
  runtime: {
    request: (op, payload, hostId) => ipcRenderer.invoke("remote:runtime-request", op, payload, hostId),
    send: (op, payload, hostId) => ipcRenderer.invoke("remote:runtime-send", op, payload, hostId),
    subscribe: (cursor, hostId) => ipcRenderer.invoke("remote:runtime-subscribe", cursor, hostId),
    unsubscribe: streamId => ipcRenderer.invoke("remote:runtime-unsubscribe", streamId),
    watch: (streamId, hostId) => ipcRenderer.invoke("remote:runtime-watch", streamId, hostId),
    unwatch: streamId => ipcRenderer.invoke("remote:runtime-unwatch", streamId),
    onEvent: callback => {
      const listener = (_event, update) => callback(update);
      ipcRenderer.on("remote:runtime-event", listener);
      return () => ipcRenderer.removeListener("remote:runtime-event", listener);
    }
  }
});

// Fixed application actions: the renderer cannot supply a path or command.
contextBridge.exposeInMainWorld("desktopApp", {
  openDataFolder: () => ipcRenderer.invoke("app:open-data-folder"),
  getInfo: () => ipcRenderer.invoke("app:info")
});
