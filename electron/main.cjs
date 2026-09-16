const { app, BrowserWindow, dialog, ipcMain, nativeTheme, systemPreferences, shell, powerMonitor } = require("electron");
const net = require("net");
const path = require("path");

let mainWindow;
let backendHandle;
let voiceInput;
let shutdownComplete = false;
if (process.env.LOCAL_COGNITIVE_TEST_DATA_DIR) app.setPath("userData", path.resolve(process.env.LOCAL_COGNITIVE_TEST_DATA_DIR));
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();

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

const startBackend = (appRoot) => {
  const entry = path.join(appRoot, "dist", "src", "index.js");
  return require(entry).startBackend();
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
    backgroundColor: isMac ? "#00000000" : "#181a1d",
    ...(isMac ? {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 18, y: 18 },
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

if (hasInstanceLock) app.whenReady().then(async () => {
  try {
    const runtime = await configureRuntimeEnvironment();
    voiceInput = require("./voice-input.cjs").registerVoiceInput({ app, ipcMain, systemPreferences, shell, powerMonitor,
      getWindow: () => mainWindow, origin: runtime.url,
      root: path.join(runtime.dataRoot, "speech"),
      runtimeDir: path.join(runtime.resourceRoot, "speech", `${process.platform}-${process.arch}`) });
    backendHandle = await startBackend(runtime.appRoot);
    await waitForServer(runtime.url);
    await createWindow(runtime.url);
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

app.on("second-instance", () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});
app.on("before-quit", (event) => {
  if (shutdownComplete || !backendHandle) return;
  event.preventDefault();
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
