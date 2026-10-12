import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (...args: any[]) => any>(),
  handlers: new Map<string, (...args: any[]) => any>(),
}));
vi.mock("electron", () => ({
  app: { getVersion: () => "test" }, BrowserWindow: class {}, Notification: class {},
  dialog: {}, shell: {},
  ipcMain: {
    on: (name: string, callback: (...args: any[]) => any) => mocks.listeners.set(name, callback),
    handle: (name: string, callback: (...args: any[]) => any) => mocks.handlers.set(name, callback),
  },
}));
import { registerIpc } from "./ipc.js";
beforeEach(() => { mocks.listeners.clear(); mocks.handlers.clear(); });
describe("desktop privileged IPC", () => {
  function setup() {
    const tokenStore = { get: vi.fn(() => "private-token"), set: vi.fn() };
    const toolHost = {
      assertSender: vi.fn((event: { trusted: boolean }) => { if (!event.trusted) throw new Error("Untrusted desktop sender"); }),
      state: vi.fn(() => ({ directory: null })), reset: vi.fn(), prepare: vi.fn(), choose: vi.fn(), finish: vi.fn(),
    };
    registerIpc({ getWindow: () => null, tokenStore, toolHost, getServerUrl: () => null, setServerUrl: vi.fn() } as any);
    return { tokenStore, toolHost };
  }
  it("does not expose credentials or local operations to an untrusted frame", () => {
    const { tokenStore, toolHost } = setup();
    const event = { trusted: false, returnValue: undefined };
    mocks.listeners.get("lot:token:get")!(event);
    expect(event.returnValue).toBeNull();
    expect(tokenStore.get).not.toHaveBeenCalled();
    mocks.listeners.get("lot:token:set")!(event, "forged");
    expect(tokenStore.set).not.toHaveBeenCalled();
    expect(() => mocks.handlers.get("lot:local:prepare")!(event, "chat")).toThrow("Untrusted");
    expect(toolHost.prepare).not.toHaveBeenCalled();
  });
  it("retains trusted preload startup and revokes tools on account changes", () => {
    const { tokenStore, toolHost } = setup();
    const event = { trusted: true, returnValue: undefined };
    mocks.listeners.get("lot:token:get")!(event);
    expect(event.returnValue).toBe("private-token");
    mocks.listeners.get("lot:token:set")!(event, null);
    expect(toolHost.reset).toHaveBeenCalledOnce();
    expect(tokenStore.set).toHaveBeenCalledWith(null);
  });
});
