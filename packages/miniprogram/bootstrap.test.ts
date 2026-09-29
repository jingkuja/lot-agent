import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { mode, wechatLogin } = vi.hoisted(() => ({ mode: vi.fn(), wechatLogin: vi.fn() }));
vi.mock("./miniprogram/services/api", () => ({ api: { mode, wechatLogin } }));
let app: any;
let storage: Map<string, unknown>;
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  storage = new Map();
  vi.stubGlobal("App", (options: unknown) => { app = options; });
  vi.stubGlobal("getApp", () => app);
  vi.stubGlobal("wx", {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.delete(key),
    login: vi.fn(({ success }) => success({ code: "private-code" })),
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await import("./miniprogram/app");
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("keeps a mode request failure for the boot page without attempting login", async () => {
  mode.mockRejectedValue({ status: 0, message: "request:fail url not in domain list" });
  await app.bootstrap();
  expect(app.globalData.loginError).toContain("合法域名");
  expect(wechatLogin).not.toHaveBeenCalled();
  expect(console.warn).toHaveBeenCalledWith("[lot-login]", app.globalData.loginError);
});

it("reports wx.login failure without sending an empty code", async () => {
  mode.mockResolvedValue({});
  vi.mocked(wx.login).mockImplementation(({ fail }: any) => fail({ errMsg: "private-error" }));
  await app.bootstrap();
  expect(app.globalData.loginError).toContain("AppID");
  expect(wechatLogin).not.toHaveBeenCalled();
});

it("clears the failed attempt diagnostic on successful retry and stores the session", async () => {
  mode.mockResolvedValue({});
  wechatLogin.mockRejectedValueOnce({ status: 502, message: "private-response" });
  await app.bootstrap();
  expect(app.globalData.loginError).toContain("HTTP 502");
  wechatLogin.mockResolvedValue({ token: "token", user: { id: "u1" } });
  await app.bootstrap();
  expect(app.globalData.loginError).toBe("");
  expect(storage.get("lot:token")).toBe("token");
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/private-/);
});
