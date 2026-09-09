const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopAppearance", {
  platform: process.platform,
  setTheme: (theme) => {
    if (theme === "dark" || theme === "light") ipcRenderer.send("appearance:set-theme", theme);
  }
});
