/**
 * Preload bridge exposing `window.lotDesktop` to the renderer. Must stay CJS
 * (sandboxed preload) and may only require `electron`. The shape is defined
 * in `packages/web/src/types/desktop.ts` — keep the two in sync.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

function subscribe<T>(channel: string) {
  return (cb: (value: T) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, value: T) => cb(value);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld("lotDesktop", {
  platform: process.platform,
  appVersion: ipcRenderer.sendSync("lot:app-version"),

  getToken: () => ipcRenderer.sendSync("lot:token:get"),
  setToken: (token: string | null) => ipcRenderer.send("lot:token:set", token),

  getServerUrl: () => ipcRenderer.sendSync("lot:server:get"),
  setServerUrl: (url: string) => ipcRenderer.invoke("lot:server:set", url),

  windowMinimize: () => ipcRenderer.send("lot:win:minimize"),
  windowToggleMaximize: () => ipcRenderer.send("lot:win:toggle-maximize"),
  windowClose: () => ipcRenderer.send("lot:win:close"),
  onWindowMaximizedChange: subscribe<boolean>("lot:win:maximized"),

  notify: (title: string, body?: string) =>
    ipcRenderer.send("lot:notify", title, body),
  setAttention: (count: number) => ipcRenderer.send("lot:attention", count),

  onDownloadEvent: subscribe("lot:download"),
  showInFolder: (target: string) => ipcRenderer.send("lot:show-in-folder", target),
  openPath: (target: string) => ipcRenderer.send("lot:open-path", target),

  showAlert: (message: string) => ipcRenderer.invoke("lot:show-alert", message),
});
