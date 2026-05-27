const { app, BrowserWindow, dialog } = require("electron");
const net = require("net");
const path = require("path");

let mainWindow;

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
  const dataRoot = app.getPath("userData");
  const port = await findFreePort();

  process.chdir(appRoot);
  process.env.HTTP_ENABLED = "true";
  process.env.HOST = "127.0.0.1";
  process.env.PORT = String(port);
  process.env.APP_DATA_DIR = path.join(dataRoot, "app");
  process.env.MEMORY_DIR = path.join(dataRoot, "memory");
  process.env.SESSION_DIR = path.join(dataRoot, "sessions");
  process.env.OUTPUT_DIR = path.join(dataRoot, "output");
  process.env.PLUGINS_DIR = path.join(appRoot, "plugins");
  process.env.UI_PUBLIC_DIR = path.join(appRoot, "public");

  return {
    appRoot,
    url: `http://127.0.0.1:${port}`
  };
};

const startBackend = (appRoot) => {
  const entry = path.join(appRoot, "dist", "src", "index.js");
  require(entry);
};

const createWindow = async (url) => {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    title: "Local Cognitive AI System",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await mainWindow.loadURL(url);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
};

app.whenReady().then(async () => {
  try {
    const runtime = await configureRuntimeEnvironment();
    startBackend(runtime.appRoot);
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
