const { app, BrowserWindow, dialog, ipcMain, nativeTheme, systemPreferences, shell, powerMonitor, safeStorage } = require("electron");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { windowChromeOptions, windowsTitleBarOverlay } = require("./window-chrome.cjs");
// First: the native crash handler starts before the app is ready (reports only with consent).
const sentry = require("./sentry.cjs").startSentry();

let mainWindow;
let backendHandle;
let voiceInput;
let shutdownComplete = false;
let applicationDataRoot;
let applicationOrigin;
if (process.env.LOCAL_COGNITIVE_TEST_DATA_DIR) app.setPath("userData", path.resolve(process.env.LOCAL_COGNITIVE_TEST_DATA_DIR));
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();
let account;
let remote;
const pendingDeepLinks = [];
// Deep links can arrive before the window and account service exist (cold start on macOS).
const deliverDeepLink = raw => {
  if (account && mainWindow) account.handleDeepLink(raw);
  else if (pendingDeepLinks.length < 4) pendingDeepLinks.push(raw);
};
if (hasInstanceLock) {
  require("./account.cjs").registerProtocol(app);
  app.on("open-url", (event, url) => { event.preventDefault(); deliverDeepLink(url); });
}

const findFreePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 3000;
      server.close(() => resolve(port));
    });
  });

const waitForServer = async (url, attempts = 80) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Local server did not become ready at ${url}`);
};

const configureRuntimeEnvironment = async () => {
  const appRoot = app.getAppPath();
  const dataRoot = process.env.LOCAL_COGNITIVE_TEST_DATA_DIR || app.getPath("userData");
  const port = await findFreePort();

  process.chdir(appRoot);
  process.env.HTTP_ENABLED = "true";
  process.env.HOST = "127.0.0.1";
  process.env.PORT = String(port);
  const resourceRoot = app.isPackaged ? process.resourcesPath : path.join(appRoot, "resources");
  process.env.LLAMA_RUNTIME_DIR = path.join(resourceRoot, "llama", `${process.platform}-${process.arch}`);
  process.env.LOCAL_MODEL_CATALOG_PATH = path.join(resourceRoot, "models", "recommended.json");
  process.env.LOCAL_MODELS_DIR = path.join(dataRoot, "models");
  process.env.APP_DATA_DIR = path.join(dataRoot, "app");
  process.env.MEMORY_DIR = path.join(dataRoot, "memory");
  process.env.SESSION_DIR = path.join(dataRoot, "sessions");
  process.env.OUTPUT_DIR = path.join(dataRoot, "output");
  process.env.PLUGINS_DIR = path.join(appRoot, "plugins");
  process.env.UI_PUBLIC_DIR = path.join(appRoot, "public");

  return {
    appRoot,
    dataRoot,
    resourceRoot,
    url: `http://127.0.0.1:${port}`
  };
};

// One protected vault for plugin credentials and the account session (separate key namespaces).
const createVault = (appRoot) => {
  const { EncryptedCredentialVault } = require(path.join(appRoot, "dist", "src", "plugins", "EncryptedCredentialVault.js"));
  return new EncryptedCredentialVault(path.join(process.env.APP_DATA_DIR, "integrations", "vault"), {
    available: () => safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
    encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value)
  });
};

const focusWindow = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (process.platform === "darwin") app.focus({ steal: true });
};

// Model calls are recorded for the account signed in when they run; none signed in, they stay on this computer.
const usageAccount = () => { const status = account?.service.status(); return status?.state === "signed-in" ? status.profile.accountId : undefined; };

// Error reports: the user's consent (Settings → Data & Privacy) and a window's uncaught errors.
const registerDiagnostics = () => {
  ipcMain.handle("diagnostics:consent", event => { assertAppSender(event); return sentry.consent(); });
  ipcMain.handle("diagnostics:set-consent", (event, value) => { assertAppSender(event); return sentry.setConsent(value === true); });
  ipcMain.on("diagnostics:renderer-error", (event, report) => {
    try { assertAppSender(event); } catch { return; }
    sentry.rendererError(report, backendHandle?.diagnosticLog);
  });
};

const startBackend = async (appRoot, vault) => {
  const entry = path.join(appRoot, "dist", "src", "index.js");
  const { loadOAuthClientRegistrations } = require(path.join(appRoot, "dist", "src", "plugins", "OAuthConnections.js"));
  // Registrations are never packaged: a release reads them from user data, while a
  // development checkout may keep the git-ignored copy next to this file.
  const userDataClients = path.join(app.getPath("userData"), "plugin-oauth-clients.json");
  const oauthClientsFile = process.env.LOCAL_COGNITIVE_OAUTH_CLIENTS_FILE ||
    [userDataClients, ...(app.isPackaged ? [] : [path.join(appRoot, "electron", "plugin-oauth-clients.json")])].find(file => fs.existsSync(file)) ||
    userDataClients;
  let oauthClients = {};
  try { oauthClients = await loadOAuthClientRegistrations(oauthClientsFile); }
  catch { console.warn("[plugins] Application OAuth registrations could not be loaded. Affected sign-ins are unavailable."); }
  return require(entry).startBackend(undefined, { vault, oauthClients, openExternal: url => shell.openExternal(url) }, { runtimeKind: "desktop", usageAccount });
};

const createWindow = async (url) => {
  const isMac = process.platform === "darwin";
  let liquidGlass = null;
  if (isMac) {
    try {
      const module = require("electron-liquid-glass");
      const candidate = module.default || module;
      if (candidate.isGlassSupported()) liquidGlass = candidate;
    } catch {
      // The optional macOS addon must never prevent the application from starting.
    }
  }
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    title: "Local Cognitive AI System",
    show: false,
    backgroundColor: isMac ? "#00000000" : windowsTitleBarOverlay(nativeTheme.shouldUseDarkColors).color,
    ...windowChromeOptions(process.platform, nativeTheme.shouldUseDarkColors),
    ...(isMac ? {
      transparent: true,
      ...(liquidGlass ? {} : { vibrancy: "sidebar", visualEffectState: "followWindow" })
    } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs")
    }
  });

  voiceInput?.attach(mainWindow);
  // The window's only frames are Synthesis previews: they stay on the application's own pages.
  mainWindow.webContents.on("will-frame-navigate", event => {
    if (event.isMainFrame || ["about:blank", "about:srcdoc"].includes(event.url)) return;
    try { if (new URL(event.url).origin === applicationOrigin) return; } catch { /* Not a URL: refused. */ }
    event.preventDefault();
  });
  await mainWindow.loadURL(url);
  if (isMac) mainWindow.setWindowButtonVisibility(true);
  if (liquidGlass) {
    try {
      const glassId = liquidGlass.addView(mainWindow.getNativeWindowHandle(), { cornerRadius: 14, opaque: false });
      if (glassId < 0) throw new Error("Native material unavailable");
      console.info("[appearance] Native Liquid Glass active");
    } catch {
      mainWindow.setVibrancy("sidebar");
    }
  }
  mainWindow.show();

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
};

ipcMain.on("appearance:set-theme", (event, theme) => {
  if (event.sender === mainWindow?.webContents && ["dark", "light"].includes(theme)) {
    nativeTheme.themeSource = theme;
  }
});

// Keep the native Windows caption buttons in step with light/dark app themes.
nativeTheme.on("updated", () => {
  if (process.platform === "win32" && mainWindow && !mainWindow.isDestroyed()) {
    const overlay = windowsTitleBarOverlay(nativeTheme.shouldUseDarkColors);
    mainWindow.setTitleBarOverlay(overlay);
    mainWindow.setBackgroundColor(overlay.color);
  }
});

if (hasInstanceLock) app.whenReady().then(async () => {
  try {
    const runtime = await configureRuntimeEnvironment();
    applicationDataRoot = runtime.dataRoot;
    applicationOrigin = runtime.url;
    const vault = createVault(runtime.appRoot);
    account = require("./account.cjs").registerAccount({ app, ipcMain, shell, vault, assertSender: assertAppSender,
      getWindow: () => mainWindow, focusWindow });
    await account.init();
    remote = require("./remote.cjs").registerRemote({ app, ipcMain, vault, accountService: account.service, assertSender: assertAppSender,
      getWindow: () => mainWindow });
    voiceInput = require("./voice-input.cjs").registerVoiceInput({ app, ipcMain, systemPreferences, shell, powerMonitor,
      getWindow: () => mainWindow, origin: runtime.url,
      root: path.join(runtime.dataRoot, "speech"),
      runtimeDir: path.join(runtime.resourceRoot, "speech", `${process.platform}-${process.arch}`) });
    backendHandle = await startBackend(runtime.appRoot, vault);
    require("./usage.cjs").registerUsage({ app, ipcMain, assertSender: assertAppSender, accountService: account.service, backend: backendHandle });
    sentry.attachLog(backendHandle.diagnosticLog);
    registerDiagnostics();
    // A window's or helper process's crash, as codes in the technical log (never a dump of its memory here).
    const crashed = (process, details) => { if (details.reason !== "clean-exit") backendHandle.diagnosticLog.record("app.crash", { process, reason: details.reason, exitCode: details.exitCode }); };
    app.on("render-process-gone", (_event, _contents, details) => crashed("renderer", details));
    app.on("child-process-gone", (_event, details) => crashed(details.type === "GPU" ? "gpu" : details.type === "Utility" ? "utility" : "other", details));
    await waitForServer(runtime.url);
    await createWindow(runtime.url);
    const { isDeepLinkArgument } = require("./account.cjs");
    for (const link of [...pendingDeepLinks.splice(0), ...process.argv.filter(isDeepLinkArgument)]) account.handleDeepLink(link);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown startup error";
    dialog.showErrorBox("Startup failed", message);
    app.quit();
  }
});

app.on("activate", () => {
  if (!mainWindow) {
    const host = process.env.HOST ?? "127.0.0.1";
    const port = process.env.PORT ?? "3000";
    void createWindow(`http://${host}:${port}`);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("second-instance", (_event, argv) => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  const link = argv.find(argument => require("./account.cjs").isDeepLinkArgument(argument));
  if (link) deliverDeepLink(link);
});
app.on("before-quit", (event) => {
  if (shutdownComplete || !backendHandle) return;
  event.preventDefault();
  account?.dispose();
  remote?.dispose();
  void Promise.all([backendHandle.dispose(), voiceInput?.dispose()]).catch(error => console.error("Shutdown failed", error)).finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});
ipcMain.handle("models:select-files", async (event) => {
  if (event.sender !== mainWindow?.webContents) return [];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Import a model and optional vision adapter", message: "Select the main GGUF weights (all shards) and, optionally, one matching mmproj GGUF.", properties: ["openFile", "multiSelections"],
    filters: [{ name: "GGUF models", extensions: ["gguf"] }]
  });
  if (result.canceled || !result.filePaths.length) return null;
  // The renderer never supplies arbitrary filesystem paths to the backend.
  return backendHandle.runtimeManager.getRuntime().localModelService.importModel(result.filePaths);
});
ipcMain.handle("models:select-projector", async (event, modelId) => {
  if (event.sender !== mainWindow?.webContents) return null;
  if (typeof modelId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,95}$/i.test(modelId)) throw new Error("Invalid local model identifier.");
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Attach vision adapter", message: "Select the mmproj GGUF made for this exact model. Changing the adapter unloads the model.",
    properties: ["openFile"], filters: [{ name: "Vision adapter GGUF", extensions: ["gguf"] }]
  });
  if (result.canceled || result.filePaths.length !== 1) return null;
  return backendHandle.runtimeManager.getRuntime().localModelService.attachProjector(modelId, result.filePaths[0]);
});
ipcMain.handle("models:select-directory", async (event) => {
  if (event.sender !== mainWindow?.webContents) return null;
  const result = await dialog.showOpenDialog(mainWindow, { title: "Model storage", properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? null : result.filePaths[0];
});

function assertAppSender(event) {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow?.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== applicationOrigin) throw new Error("Unknown application window.");
}
ipcMain.handle("projects:select-directory", async event => {
  assertAppSender(event);
  const result = await dialog.showOpenDialog(mainWindow, { title: "Project folder", properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? null : result.filePaths[0] ?? null;
});

ipcMain.handle("app:open-data-folder", async event => {
  assertAppSender(event);
  if (!applicationDataRoot) throw new Error("Application data folder is not ready.");
  const error = await shell.openPath(applicationDataRoot);
  if (error) throw new Error(error);
  return { opened: true };
});
ipcMain.handle("app:info", event => {
  assertAppSender(event);
  const metadata = require(path.join(app.getAppPath(), "package.json"));
  return { name: metadata.build?.productName || app.getName(), version: app.getVersion(),
    platform: `${process.platform} ${process.arch}`, electron: process.versions.electron,
    license: metadata.license || "Not declared in application metadata" };
});
