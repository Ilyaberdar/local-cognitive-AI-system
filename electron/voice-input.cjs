const { SpeechService } = require("../dist/src/speech/SpeechService.js");

function registerVoiceInput({ app, ipcMain, systemPreferences, shell, powerMonitor, getWindow, root, runtimeDir, origin }) {
  const service = new SpeechService(root, runtimeDir);
  let captureAllowed = false;
  let captureId;
  const release = id => { if (!id || captureId === id) { captureAllowed = false; captureId = undefined; } };
  const trusted = (event) => event.sender === getWindow()?.webContents && event.senderFrame === event.sender.mainFrame && event.senderFrame?.origin === origin;
  const handle = (name, action) => ipcMain.handle(`voice:${name}`, async (event, value) => {
    if (!trusted(event)) throw new Error("Voice input is only available in the application window.");
    return action(value);
  });
  handle("status", () => service.status());
  handle("install", () => service.install());
  handle("cancel-download", () => service.cancelDownload());
  handle("remove-model", () => service.removeModel());
  handle("settings", value => service.updateSettings(value));
  handle("transcribe", value => service.transcribe(value));
  handle("cancel", value => { release(value); return service.cancel(typeof value === "string" ? value : undefined); });
  handle("release-microphone", id => { release(id); });
  handle("microphone", async id => {
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error("Invalid recording identity.");
    captureId = id;
    captureAllowed = false;
    const status = await service.status();
    if (captureId !== id) throw new Error("Dictation cancelled.");
    if (!status.installed || !status.available) throw new Error("Prepare the voice model before recording.");
    if (process.platform === "darwin" && !await systemPreferences.askForMediaAccess("microphone")) {
      throw new Error("Microphone access is blocked. Allow it in System Settings → Privacy & Security → Microphone, then restart the app.");
    }
    if (captureId !== id) throw new Error("Dictation cancelled.");
    captureAllowed = true;
    return true;
  });
  handle("open-settings", () => {
    if (process.platform === "darwin") return shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
    if (process.platform === "win32") return shell.openExternal("ms-settings:privacy-microphone");
  });
  const isApp = (contents, url) => {
    try { return contents === getWindow()?.webContents && new URL(url).origin === origin; } catch { return false; }
  };
  function attach(window) {
    const session = window.webContents.session;
    session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      if (permission === "media") return captureAllowed && isApp(contents, requestingOrigin) && details.mediaType === "audio";
      return isApp(contents, requestingOrigin) && ["clipboard-sanitized-write", "fullscreen"].includes(permission);
    });
    session.setPermissionRequestHandler((contents, permission, callback, details) => {
      const own = isApp(contents, details.requestingUrl) && details.isMainFrame !== false;
      callback(permission === "media"
        ? own && captureAllowed && details.mediaTypes?.length === 1 && details.mediaTypes[0] === "audio"
        : own && ["clipboard-sanitized-write", "fullscreen"].includes(permission));
    });
    const stopCapture = () => { release(); if (!window.isDestroyed()) window.webContents.send("voice:stop-capture"); };
    window.on("minimize", stopCapture);
    window.on("hide", stopCapture);
    window.webContents.on("render-process-gone", () => { release(); void service.cancel(); });
    window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) { release(); void service.cancel(); }
    });
    window.on("closed", () => { release(); void service.cancel(); });
  }
  powerMonitor.on("suspend", () => { release(); getWindow()?.webContents.send("voice:stop-capture"); });
  return { attach, dispose: () => { release(); return service.dispose(); } };
}
module.exports = { registerVoiceInput };
