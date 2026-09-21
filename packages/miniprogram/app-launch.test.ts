import { afterEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ mode: vi.fn(), me: vi.fn(), wechatLogin: vi.fn() }));
vi.mock("./miniprogram/services/api", () => ({ api }));
vi.mock("./miniprogram/services/session", () => ({ getUser: () => null, getToken: () => "", clearSession: vi.fn(), setSession: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

describe("mini-program launch navigation", () => {
  it.each([true, false])("does not replace a shared-work landing page after bootstrap (debug=%s)", async (debug) => {
    vi.resetModules();
    let app: any;
    vi.stubGlobal("App", (definition: any) => { app = definition; });
    const switchTab = vi.fn();
    vi.stubGlobal("wx", { switchTab });
    api.mode.mockResolvedValue({ debug });
    await import("./miniprogram/app");
    app.tryWechatLogin = vi.fn().mockResolvedValue(true);
    await app.bootstrap();
    expect(switchTab).not.toHaveBeenCalled();
  });
});
