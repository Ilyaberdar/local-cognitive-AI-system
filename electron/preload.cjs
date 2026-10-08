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
  // The chat screen on the selected server: allowlisted operations, safe resends, event streams.
  runtime: {
    request: (op, payload) => ipcRenderer.invoke("remote:runtime-request", op, payload),
    send: (op, payload) => ipcRenderer.invoke("remote:runtime-send", op, payload),
    subscribe: cursor => ipcRenderer.invoke("remote:runtime-subscribe", cursor),
    unsubscribe: streamId => ipcRenderer.invoke("remote:runtime-unsubscribe", streamId),
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
