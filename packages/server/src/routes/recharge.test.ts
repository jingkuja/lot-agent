import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createRechargeRoutes } from "./recharge.js";
import type { AgentService } from "../services/agent-service.js";

function mount() {
  const service = {
    managedKeysEnabled: true,
    db: { getUserById: vi.fn().mockResolvedValue({ external_user_id: 7 }) },
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
    },
  } as unknown as AgentService;
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("userId", "local-1"); await next(); });
  app.route("/", createRechargeRoutes(service));
  return { app, service };
}

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

  it("rejects points that cannot map to a whole-yuan payment", async () => {
    const { app, service } = mount();
    const response = await app.request("/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: 150, paymentMethod: "alipay" }),
    });
    expect(response.status).toBe(400);
    expect(service.tokenhub.createManagedRechargeOrder).not.toHaveBeenCalled();
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
});
