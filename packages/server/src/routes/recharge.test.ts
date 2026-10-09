import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createRechargeRoutes } from "./recharge.js";
import type { MiniPaymentService } from "../payments/service.js";
import type { AgentService } from "../services/agent-service.js";
import { exchangeWechatPaymentCode, wechatConfigured } from "../auth/wechat.js";

vi.mock("../auth/wechat.js", () => ({
  exchangeWechatPaymentCode: vi.fn(),
  wechatConfigured: vi.fn(),
}));

const mockedExchange = vi.mocked(exchangeWechatPaymentCode);
const mockedConfigured = vi.mocked(wechatConfigured);

function mount() {
  const service = {
    managedKeysEnabled: true,
    db: { getUserById: vi.fn().mockResolvedValue({ external_user_id: 7, wechat_openid: "oMiniUser123" }) },
    tokenhub: {
      getManagedRechargeInfo: vi.fn().mockResolvedValue({
        enabled: true,
        paymentMethods: [{ name: "支付宝", type: "alipay" }],
        amountDiscount: { "1000": 0.9 },
      }),
      createManagedRechargeOrder: vi.fn().mockResolvedValue({
        transactionId: "LOT7abc",
        status: "pending",
        amount: 10,
        points: 1_000,
        paymentMethod: "wxpay",
        paymentKind: "qrcode",
        codeUrl: "weixin://wxpay/bizpayurl?pr=test",
      }),
      getManagedRechargeOrder: vi.fn().mockResolvedValue({ transactionId: "LOT7abc", status: "credited" }),
      getManagedRechargeHistory: vi.fn().mockResolvedValue({
        records: [
          {
            transactionId: "LOT-success",
            rechargedAt: "2026-08-28T04:30:00.000Z",
            paymentMethod: "alipay",
            amount: 10,
            currency: "CNY",
          },
        ],
        page: 2,
        pageSize: 20,
        total: 21,
      }),
    },
  } as unknown as AgentService;
  const payments = {
    info: vi.fn().mockResolvedValue({ enabled: true, offers: [], paymentMethods: [], amountDiscount: {} }),
    create: vi.fn().mockResolvedValue({ transactionId: "LV123456", status: "pending", paymentKind: "virtual", virtualPay: { mode: "short_series_goods", signData: '{"env":0}', paySig: "payment-signature" } }),
    status: vi.fn().mockResolvedValue(null),
  } satisfies MiniPaymentService;
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("userId", "local-1"); await next(); });
  app.route("/", createRechargeRoutes(service, payments));
  return { app, service, payments };
}

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("managed recharge routes", () => {
  it("creates an order with the selected New API payment method", async () => {
    const { app, service } = mount();
    const response = await app.request("/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: 1_000, paymentMethod: "alipay" }),
    });
    expect(response.status).toBe(200);
    expect(service.tokenhub.createManagedRechargeOrder).toHaveBeenCalledWith({
      userId: 7,
      points: 1_000,
      paymentMethod: "alipay",
    });
  });

  it("rejects non-integer or out-of-range points", async () => {
    const { app, service } = mount();
    for (const points of [0, -100, 1.5, 10_000_001]) {
      const response = await app.request("/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points, paymentMethod: "alipay" }),
      });
      expect(response.status).toBe(400);
    }
    expect(service.tokenhub.createManagedRechargeOrder).not.toHaveBeenCalled();
  });

  it("accepts a single point for smoke-test payments", async () => {
    const { app, service } = mount();
    const response = await app.request("/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: 1, paymentMethod: "alipay" }),
    });
    expect(response.status).toBe(200);
    expect(service.tokenhub.createManagedRechargeOrder).toHaveBeenCalledWith({
      userId: 7,
      points: 1,
      paymentMethod: "alipay",
    });
  });

  it("requires an explicit payment method", async () => {
    const { app, service } = mount();
    const response = await app.request("/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: 1_000 }),
    });
    expect(response.status).toBe(400);
    expect(service.tokenhub.createManagedRechargeOrder).not.toHaveBeenCalled();
  });

  it("returns the payment methods configured by New API", async () => {
    const { app } = mount();
    const response = await app.request("/info");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      enabled: true,
      paymentMethods: [{ name: "支付宝", type: "alipay" }],
      amountDiscount: { "1000": 0.9 },
    });
  });

  it("loads only the authenticated user's successful recharge history", async () => {
    const { app, service } = mount();
    const response = await app.request("/orders?page=2");
    expect(response.status).toBe(200);
    expect(service.tokenhub.getManagedRechargeHistory).toHaveBeenCalledWith(7, 2, 20);
    await expect(response.json()).resolves.toEqual({
      records: [
        {
          transactionId: "LOT-success",
          rechargedAt: "2026-08-28T04:30:00.000Z",
          paymentMethod: "alipay",
          amount: 10,
          currency: "CNY",
        },
      ],
      page: 2,
      pageSize: 20,
      total: 21,
    });
  });

  it("signs the exact virtual payment payload with the server-only session key", async () => {
    mockedConfigured.mockReturnValue(true);
    mockedExchange.mockResolvedValue({ openid: "oMiniUser123", sessionKey: "private-session" });
    vi.stubEnv("WECHAT_MP_APPID", "wxapp");
    const { app, service, payments } = mount();
    vi.mocked(payments.create).mockResolvedValue({ transactionId: "LOT7abc", status: "pending", paymentKind: "virtual", virtualPay: { mode: "short_series_goods", signData: '{"outTradeNo":"LOT7abc", "env":0}', paySig: "payment-signature" } });
    const response = await app.request("/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: 1_000, paymentMethod: "wxpay", client: "miniprogram", wxCode: "wxcode-1", expectedAmountFen: 1000 }),
    });
    expect(response.status).toBe(200);
    expect(mockedExchange).toHaveBeenCalledWith("wxcode-1");
    expect(payments.create).toHaveBeenCalledWith({ userId: "local-1", externalUserId: 7, points: 1000, openid: "oMiniUser123", platform: "other", expectedAmountFen: 1000 });
    expect(service.tokenhub.createManagedRechargeOrder).not.toHaveBeenCalled();
    const data = await response.json();
    expect(data.virtualPay.signature).toBe(createHmac("sha256", "private-session").update(data.virtualPay.signData).digest("hex"));
    expect(JSON.stringify(data)).not.toContain("private-session");
  });

  it("rejects miniprogram orders without a wxCode", async () => {
    mockedConfigured.mockReturnValue(true);
    const { app, service } = mount();
    const response = await app.request("/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: 1_000, paymentMethod: "wxpay", client: "miniprogram" }),
    });
    expect(response.status).toBe(400);
    expect(service.tokenhub.createManagedRechargeOrder).not.toHaveBeenCalled();
  });

  it("rejects miniprogram orders that do not use wxpay", async () => {
    mockedConfigured.mockReturnValue(true);
    const { app, service } = mount();
    const response = await app.request("/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: 1_000, paymentMethod: "alipay", client: "miniprogram", wxCode: "wxcode-1" }),
    });
    expect(response.status).toBe(400);
    expect(service.tokenhub.createManagedRechargeOrder).not.toHaveBeenCalled();
  });
});

describe("mini-program payer and recharge account", () => {
  it.each([undefined, null, "", "previous-wechat-binding"])("creates a recharge for the signed-in account when its stored WeChat binding is %j", async (wechatOpenid) => {
    mockedConfigured.mockReturnValue(true);
    mockedExchange.mockResolvedValue({ openid: "current-payer", sessionKey: "payer-session-key" });
    const { app, service, payments } = mount();
    vi.mocked(service.db.getUserById).mockResolvedValue({
      external_user_id: 7, wechat_openid: wechatOpenid,
    } as Awaited<ReturnType<AgentService["db"]["getUserById"]>>);
    const response = await app.request("/orders", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: 1, paymentMethod: "wxpay_virtual", client: "miniprogram", wxCode: "fresh-code", expectedAmountFen: 1,
        // Neither the credit recipient nor payer credentials come from these client fields.
        userId: "other-local-user", externalUserId: 999, openid: "forged-payer", sessionKey: "forged-key",
      }),
    });
    expect(response.status).toBe(200);
    expect(service.db.getUserById).toHaveBeenCalledWith("local-1");
    expect(mockedExchange).toHaveBeenCalledWith("fresh-code");
    expect(payments.create).toHaveBeenCalledWith({
      userId: "local-1", externalUserId: 7, points: 1, openid: "current-payer", platform: "other", expectedAmountFen: 1,
    });
    const data = await response.json();
    expect(data.virtualPay.signature).toBe(createHmac("sha256", "payer-session-key").update(data.virtualPay.signData).digest("hex"));
    expect(JSON.stringify(data)).not.toContain("payer-session-key");
    expect(service.tokenhub.createManagedRechargeOrder).not.toHaveBeenCalled();
  });

  it("rejects an invalid payment login code before creating an order", async () => {
    mockedConfigured.mockReturnValue(true);
    mockedExchange.mockRejectedValueOnce(new Error("invalid payment code"));
    const { app, payments } = mount();
    const response = await app.request("/orders", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: 1, paymentMethod: "wxpay_virtual", wxCode: "expired-code", expectedAmountFen: 1 }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "微信登录凭证失效，请重试" });
    expect(payments.create).not.toHaveBeenCalled();
  });

  it.each([null, { external_user_id: null }])("rejects an unavailable recharge account %j", async (user) => {
    const { app, service, payments } = mount();
    vi.mocked(service.db.getUserById).mockResolvedValue(user as Awaited<ReturnType<AgentService["db"]["getUserById"]>>);
    const response = await app.request("/orders", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: 1, paymentMethod: "wxpay_virtual", wxCode: "code", expectedAmountFen: 1, externalUserId: 999 }),
    });
    expect(response.status).toBe(409);
    expect(mockedExchange).not.toHaveBeenCalled();
    expect(payments.create).not.toHaveBeenCalled();
  });
});
  it("never returns ordinary gateway parameters for a mini-program order", async () => {
    mockedConfigured.mockReturnValue(true);
    mockedExchange.mockResolvedValue({ openid: "oMiniUser123", sessionKey: "secret" });
    const { app, payments } = mount();
    payments.create.mockResolvedValueOnce({ transactionId: "LV123456", status: "pending", paymentKind: "qrcode" } as never);
    const response = await app.request("/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ points: 1000, paymentMethod: "wxpay_virtual", client: "miniprogram", wxCode: "code", expectedAmountFen: 1000 }) });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("weixin://");
  });
  it("requests platform-specific virtual offers", async () => {
    const { app, service, payments } = mount();
    await app.request("/info?client=miniprogram&platform=ios");
    expect(payments.info).toHaveBeenCalledWith(7, "ios");
    expect(service.tokenhub.getManagedRechargeInfo).not.toHaveBeenCalled();
  });

it("returns 404 for an unowned Agent payment without querying New API", async () => {
  const { app, service, payments } = mount();
  const response = await app.request("/orders/LVsomeoneelsesorder");
  expect(response.status).toBe(404);
  expect(payments.status).toHaveBeenCalledWith("local-1", "LVsomeoneelsesorder");
  expect(service.tokenhub.getManagedRechargeOrder).not.toHaveBeenCalled();
});

it("asks the user to refresh when the quoted price changes before payment", async () => {
  mockedConfigured.mockReturnValue(true);
  mockedExchange.mockResolvedValue({ openid: "oMiniUser123", sessionKey: "private-session" });
  const { app, payments, service } = mount();
  payments.create.mockRejectedValueOnce(new Error("virtual_payment_quote_changed"));
  const response = await app.request("/orders", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ points: 1000, paymentMethod: "wxpay_virtual", client: "miniprogram", wxCode: "code", expectedAmountFen: 900 }) });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "充值价格已更新，请刷新档位后重试" });
  expect(service.tokenhub.createManagedRechargeOrder).not.toHaveBeenCalled();
});
