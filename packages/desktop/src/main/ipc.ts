import type { DesktopToolHost } from "./tool-host.js";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import type { SecureTokenStore } from "./secure-token.js";

export interface IpcContext {
  getWindow: () => BrowserWindow | null;
  tokenStore: SecureTokenStore;
  toolHost: DesktopToolHost;
  getServerUrl: () => string | null;
  setServerUrl: (url: string) => Promise<{ ok: boolean; error?: string }>;
}

/** Dock badge on macOS, taskbar flash on Windows; 0 clears. */
function setAttention(ctx: IpcContext, count: number): void {
  if (process.platform === "darwin") {
    app.dock?.setBadge(count > 0 ? String(count) : "");
  } else {
    ctx.getWindow()?.flashFrame(count > 0);
  }
}

/**
 * Registers every `lot:*` channel the preload bridge (`window.lotDesktop`)
 * talks to. Keep channel names in sync with `src/preload/index.ts`.
 */
export function registerIpc(ctx: IpcContext): void {
  // All privileged channels share the same origin/window/frame boundary,
  // including secure-token access used to authorize local tool sessions.
  const on = (channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void) => {
    ipcMain.on(channel, (event, ...args) => {
      try { ctx.toolHost.assertSender(event); } catch { event.returnValue = null; return; }
      listener(event, ...args);
    });
  };
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      ctx.toolHost.assertSender(event);
      return listener(event, ...args);
    });
  };
  handle("lot:local:state", () => ctx.toolHost.state());
  handle("lot:local:choose", () => ctx.toolHost.choose());
  handle("lot:local:disable", () => { ctx.toolHost.reset(); return ctx.toolHost.state(); });
  handle("lot:local:prepare", (_event, id: string) => ctx.toolHost.prepare(id));
  handle("lot:local:finish", (_event, id: string) => ctx.toolHost.finish(id));

  // ── App meta ───────────────────────────────────────────────────────────────
  on("lot:app-version", (event) => {
    event.returnValue = app.getVersion();
  });

  // ── Token (sync read at startup; fire-and-forget writes) ───────────────────
  on("lot:token:get", (event) => {
    event.returnValue = ctx.tokenStore.get();
  });
  on("lot:token:set", (_event, token: string | null) => {
    ctx.toolHost.reset();
    ctx.tokenStore.set(typeof token === "string" ? token : null);
  });

  // ── Server endpoint ─────────────────────────────────────────────────────────
  on("lot:server:get", (event) => {
    event.returnValue = ctx.getServerUrl();
  });
  handle("lot:server:set", (_event, url: string) =>
    ctx.setServerUrl(String(url ?? ""))
  );

  // ── Window controls (custom frameless titlebar on Windows) ──────────────────
  on("lot:win:minimize", () => ctx.getWindow()?.minimize());
  on("lot:win:toggle-maximize", () => {
    const win = ctx.getWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  on("lot:win:close", () => ctx.getWindow()?.close());

  // ── Notifications / attention ───────────────────────────────────────────────
  on("lot:notify", (_event, title: string, body?: string) => {
    const win = ctx.getWindow();
    if (win?.isFocused()) return; // user is already looking at the app
    const notification = new Notification({
      title: String(title),
      body: body ? String(body) : undefined,
    });
    notification.on("click", () => {
      win?.show();
      win?.focus();
    });
    notification.show();
    setAttention(ctx, 1);
  });
  on("lot:attention", (_event, count: number) => {
    setAttention(ctx, Number(count) || 0);
  });

  // ── Native shell helpers ────────────────────────────────────────────────────
  on("lot:show-in-folder", (_event, target: string) => {
    if (typeof target === "string" && target) shell.showItemInFolder(target);
  });
  on("lot:open-path", (_event, target: string) => {
    if (typeof target === "string" && target) void shell.openPath(target);
  });
  handle("lot:show-alert", async (_event, message: string) => {
    const win = ctx.getWindow();
    const options = {
      message: String(message),
      buttons: ["确定"],
      defaultId: 0,
    };
    if (win) await dialog.showMessageBox(win, options);
    else await dialog.showMessageBox(options);
  });
}
