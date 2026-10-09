import { createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { loadVirtualPayConfig, loadVirtualPaySales, virtualPaymentParams, WechatVirtualClient } from "./wechat-virtual.js";

const config = { appId: "wx-app", secret: "server-secret", offerId: "offer", appKey: "app-key", env: 0 as const };
afterEach(() => vi.unstubAllEnvs());
it("accepts configured one-point and custom tiers while rejecting invalid point counts", () => {
  vi.stubEnv("WECHAT_VIRTUAL_PAY_ENABLED", "1");
  vi.stubEnv("WECHAT_VIRTUAL_PAY_ENV", "0");
  vi.stubEnv("WECHAT_MP_APPID", "app"); vi.stubEnv("WECHAT_MP_SECRET", "secret");
  vi.stubEnv("WECHAT_VIRTUAL_PAY_OFFER_ID", "offer"); vi.stubEnv("WECHAT_VIRTUAL_PAY_APP_KEY", "key");
  vi.stubEnv("WECHAT_VIRTUAL_PAY_GOODS", JSON.stringify({
    "1": "lot_points_100", "50": "fifty", "10000000": "maximum",
    "0": "zero", "-1": "negative", "0.01": "yuan", "1.5": "fraction", "01": "alias",
    "1e2": "scientific", "10000001": "too-large", "9007199254740993": "unsafe", "foo": "invalid",
    "100": " ", "500": 500,
  }));
  expect(loadVirtualPaySales().goods).toEqual({ "1": "lot_points_100", "50": "fifty", "10000000": "maximum" });
  vi.stubEnv("WECHAT_VIRTUAL_PAY_GOODS", '{"1":"lot_points_100"}');
  expect(loadVirtualPaySales().goods).toEqual({ "1": "lot_points_100" });
});
it("signs the exact original JSON bytes, including quoted/non-ASCII product IDs", () => {
  const p = virtualPaymentParams(config, "LV12345678", '积分"包', 1000, 900);
  expect(p.paySig).toBe(createHmac("sha256", config.appKey).update(`requestVirtualPayment&${p.signData}`).digest("hex"));
  expect(JSON.parse(p.signData)).toMatchObject({ goodsPrice: 1000, activitySellingPrice: 900, buyQuantity: 1 });
  expect(JSON.stringify(p)).not.toContain(config.appKey);
});
it("signs query requests and sends the documented unsigned delivery request with a cached stable token", async () => {
  const f = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token", expires_in: 7200 })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, order: { order_id: "LV12345678" } })))
    .mockResolvedValueOnce(new Response('{"errcode":0}'));
  const client = new WechatVirtualClient(config, f as typeof fetch);
  await client.query("openid", "LV12345678", AbortSignal.timeout(1000));
  await client.deliver("LV12345678", AbortSignal.timeout(1000));
  expect(f).toHaveBeenCalledTimes(3);
  expect(String(f.mock.calls[0][0])).toContain("/cgi-bin/stable_token");
  const [url, init] = f.mock.calls[1] as [string, RequestInit];
  const query = new URL(url).searchParams;
  expect(query.get("pay_sig")).toBe(createHmac("sha256", "app-key").update(`/xpay/query_order&${init.body}`).digest("hex"));
  expect(JSON.parse(String(init.body))).toEqual({ openid: "openid", env: 0, order_id: "LV12345678" });
  expect(new URL(f.mock.calls[2][0]).searchParams.has("pay_sig")).toBe(false);
});
it("sanitizes upstream failures and never retries a write automatically", async () => {
  const f = vi.fn().mockRejectedValue(new Error("https://secret-url?secret=private"));
  await expect(new WechatVirtualClient(config, f).query("o", "LV12345678", AbortSignal.timeout(1000))).rejects.toThrow("virtual_payment_upstream_unavailable");
  expect(f).toHaveBeenCalledTimes(1);
});
it("never substitutes production keys for missing sandbox credentials", () => {
  vi.stubEnv("WECHAT_MP_APPID", "app"); vi.stubEnv("WECHAT_MP_SECRET", "secret");
  vi.stubEnv("WECHAT_VIRTUAL_PAY_OFFER_ID", "offer"); vi.stubEnv("WECHAT_VIRTUAL_PAY_APP_KEY", "production");
  vi.stubEnv("WECHAT_VIRTUAL_PAY_SANDBOX_APP_KEY", "");
  expect(() => loadVirtualPayConfig(1)).toThrow();
  expect(loadVirtualPayConfig(0).appKey).toBe("production");
});

it("does not treat a malformed delivery response as confirmation", async () => {
  const f = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token", expires_in: 7200 })))
    .mockResolvedValueOnce(new Response("{}"));
  await expect(new WechatVirtualClient(config, f).deliver("LV12345678", AbortSignal.timeout(1000))).rejects.toThrow("virtual_payment_response_invalid");
  expect(f).toHaveBeenCalledTimes(2);
});
