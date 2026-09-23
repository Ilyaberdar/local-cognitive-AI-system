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

// Fixed application actions: the renderer cannot supply a path or command.
contextBridge.exposeInMainWorld("desktopApp", {
  openDataFolder: () => ipcRenderer.invoke("app:open-data-folder"),
  getInfo: () => ipcRenderer.invoke("app:info")
});
