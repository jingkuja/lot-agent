import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearWechatAccessTokenCache,
  consumeWechatTicket,
  exchangeWechatCode,
  exchangeWechatPaymentCode,
  exchangeWechatPhoneCode,
  issueWechatTicket,
  wechatConfigured,
} from "./wechat.js";

describe("wechat mini program auth helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    clearWechatAccessTokenCache();
  });

  it("reports configured only when both appid and secret are set", () => {
    vi.stubEnv("WECHAT_MP_APPID", "");
    vi.stubEnv("WECHAT_MP_SECRET", "s");
    expect(wechatConfigured()).toBe(false);
    vi.stubEnv("WECHAT_MP_APPID", "wxapp");
    vi.stubEnv("WECHAT_MP_SECRET", "secret");
    expect(wechatConfigured()).toBe(true);
  });

  it("exchanges a wx.login code for openid and never returns session_key", async () => {
    vi.stubEnv("WECHAT_MP_APPID", "wxapp");
    vi.stubEnv("WECHAT_MP_SECRET", "secret");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ openid: "o-user", unionid: "u-user", session_key: "DO-NOT-LEAK" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const session = await exchangeWechatCode("code-1");
    expect(session).toEqual({ openid: "o-user", unionid: "u-user" });
    expect(JSON.stringify(session)).not.toContain("DO-NOT-LEAK");
    expect(String(fetchMock.mock.calls[0][0])).toContain("js_code=code-1");
  });

  it("issues a one-time ticket that expires after consume", () => {
    const ticket = issueWechatTicket({ openid: "o1", unionid: "u1" });
    expect(consumeWechatTicket(ticket)).toEqual({ openid: "o1", unionid: "u1" });
    expect(consumeWechatTicket(ticket)).toBeNull();
  });

  it("exchanges a getPhoneNumber code for a mainland phone", async () => {
    vi.stubEnv("WECHAT_MP_APPID", "wxapp");
    vi.stubEnv("WECHAT_MP_SECRET", "secret");
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("cgi-bin/token")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "at-1", expires_in: 7200 }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ phone_info: { purePhoneNumber: "13800138000", phoneNumber: "+8613800138000" } }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(exchangeWechatPhoneCode("phone-code")).resolves.toBe("13800138000");
    expect(JSON.stringify(fetchMock.mock.calls)).toContain("getuserphonenumber");
    expect(JSON.stringify(fetchMock.mock.calls)).toContain("phone-code");
  });
});

it("uses session_key only in the payment exchange and rejects a missing key", async () => {
  vi.stubEnv("WECHAT_MP_APPID", "wxapp"); vi.stubEnv("WECHAT_MP_SECRET", "secret");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ openid: "o", session_key: "key" })).mockResolvedValueOnce(Response.json({ openid: "o" })));
  await expect(exchangeWechatPaymentCode("first")).resolves.toMatchObject({ openid: "o", sessionKey: "key" });
  await expect(exchangeWechatPaymentCode("second")).rejects.toThrow("payment session unavailable");
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
});
