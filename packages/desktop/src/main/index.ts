import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  nativeImage,
  safeStorage,
  Tray,
} from "electron";
import { normalizeServerUrl, readConfig, writeConfig } from "./config-store.js";
import { setupDownloadManager } from "./download-manager.js";
import { registerIpc } from "./ipc.js";
import { probeServer, startLocalServer } from "./local-server.js";
import { SecureTokenStore, type TokenCipher } from "./secure-token.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
/** Dev mode loads the vite dev server (HMR); prod loads the loopback server. */
const isDev = process.env.LOT_DESKTOP_DEV === "1";
const DEV_SERVER_URL = process.env.LOT_DEV_SERVER_URL ?? "http://localhost:5173";

// Unpackaged dev runs would otherwise derive the userData dir from the scoped
// package name ("@lot-agent/desktop"); pin it so dev and packaged builds share
// config/token — and so the vite dev proxy can find config.json (see
// packages/web/vite.config.ts).
app.setName("Lot Agent");

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** Distinguishes "user closed the window" (hide to tray) from a real quit. */
let isQuitting = false;

// ── Single instance ───────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  void app.whenReady().then(main);
}

function tokenCipher(): TokenCipher {
  if (safeStorage.isEncryptionAvailable()) {
    return {
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (encrypted) => safeStorage.decryptString(encrypted),
    };
  }
  // Linux without a keyring etc. — base64 is NOT encryption, just framing;
  // the token file is still 0600 in the user's own profile dir.
  console.warn("[lot-agent] safeStorage unavailable, token stored obfuscated only");
  return {
    encrypt: (plain) => Buffer.from(plain, "utf8"),
    decrypt: (encrypted) => encrypted.toString("utf8"),
  };
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [];
  if (process.platform === "darwin") {
    template.push({
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }
  template.push(
    { role: "editMenu" },
    {
      label: "视图",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" }
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setupTray(): void {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "icons", "tray-icon.png")
    : path.resolve(moduleDir, "../../build/tray-icon.png");
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    console.warn("[lot-agent] tray icon missing:", iconPath);
    return;
  }
  tray = new Tray(icon);
  tray.setToolTip("Lot Agent");

  const showWindow = () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };
  tray.on("click", showWindow);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示窗口", click: showWindow },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ])
  );
}

async function main(): Promise<void> {
  const userData = app.getPath("userData");
  const configFile = path.join(userData, "config.json");
  let config = readConfig(configFile);
  const tokenStore = new SecureTokenStore(
    path.join(userData, "session-token"),
    tokenCipher()
  );

  const setServerUrl = async (
    raw: string
  ): Promise<{ ok: boolean; error?: string }> => {
    let url: string;
    try {
      url = normalizeServerUrl(raw);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const probe = await probeServer(url);
    if (!probe.ok) return probe;
    config = { ...config, serverUrl: url };
    writeConfig(configFile, config);
    return { ok: true };
  };

  registerIpc({
    getWindow: () => mainWindow,
    tokenStore,
    getServerUrl: () => config.serverUrl ?? null,
    setServerUrl,
  });

  setupDownloadManager(() => mainWindow);

  buildMenu();

  // ── Loopback server (prod): static web app + reverse proxy ─────────────────
  let serverPort = 0;
  if (!isDev) {
    const webDistDir = app.isPackaged
      ? path.join(process.resourcesPath, "web-dist")
      : path.resolve(moduleDir, "../../../web/dist");
    const server = await startLocalServer({
      webDistDir,
      getServerUrl: () => config.serverUrl ?? null,
      onServerUrlChange: setServerUrl,
    });
    serverPort = server.port;
    app.on("quit", () => void server.close());
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 700,
    title: "Lot Agent",
    show: false,
    // Matches the web light-theme --bg so the pre-paint flash is themed.
    backgroundColor: "#f0f0f5",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const }
      : {}),
    ...(process.platform === "win32" ? { frame: false } : {}),
    webPreferences: {
      preload: path.join(moduleDir, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  // Close hides to the tray by default (config.minimizeToTray !== false);
  // the tray menu / Cmd+Q performs the real quit.
  mainWindow.on("close", (event) => {
    if (!isQuitting && config.minimizeToTray !== false) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on("maximize", () =>
    mainWindow?.webContents.send("lot:win:maximized", true)
  );
  mainWindow.on("unmaximize", () =>
    mainWindow?.webContents.send("lot:win:maximized", false)
  );
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  // Refocusing the window clears the attention indicator (badge/flashFrame).
  mainWindow.on("focus", () => {
    if (process.platform === "darwin") app.dock?.setBadge("");
    else mainWindow?.flashFrame(false);
  });

  const loadUrl = isDev ? DEV_SERVER_URL : `http://127.0.0.1:${serverPort}/`;
  console.log(`[lot-agent] loading ${loadUrl} (server: ${config.serverUrl ?? "未配置"})`);
  await mainWindow.loadURL(loadUrl);

  setupTray();
}

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void main();
  else mainWindow?.show(); // dock click after hide-to-tray
});
