import { afterEach, describe, expect, it, vi } from "vitest";
import type { VirtualPaymentOrder, VirtualPaymentRepository } from "@lot-agent/core";
import { discountedFen, VirtualPaymentService } from "./service.js";

class MemoryRepository implements VirtualPaymentRepository {
  orders = new Map<string, VirtualPaymentOrder>();
  leased = new Set<string>();
  delays: number[] = [];
  async create(order: VirtualPaymentOrder) { this.orders.set(order.orderNo, structuredClone(order)); }
  async findForUser(id: string, user: string) { const order = this.orders.get(id); return order?.userId === user ? structuredClone(order) : null; }
  async due() { return [...this.orders.keys()]; }
  async claim(id: string) {
    const order = this.orders.get(id);
    if (!order || this.leased.has(id) || ["payment_failed", "refunded"].includes(order.status)) return null;
    this.leased.add(id); return { order: structuredClone(order), leaseId: id };
  }
  async finish(order: VirtualPaymentOrder, _lease: string, delay: number) {
    this.orders.set(order.orderNo, structuredClone(order)); this.leased.delete(order.orderNo); this.delays.push(delay);
  }
}
function configure(env = "0") {
  for (const [key, value] of Object.entries({ WECHAT_VIRTUAL_PAY_ENABLED: "1", WECHAT_MP_APPID: "wx-app", WECHAT_MP_SECRET: "secret",
    WECHAT_VIRTUAL_PAY_OFFER_ID: "offer", WECHAT_VIRTUAL_PAY_APP_KEY: "app-key", WECHAT_VIRTUAL_PAY_SANDBOX_APP_KEY: "sandbox-key",
    WECHAT_VIRTUAL_PAY_ENV: env, WECHAT_VIRTUAL_PAY_GOODS: '{"100":"one","1000":"ten"}' })) vi.stubEnv(key, value);
}
async function fixture(env = "0") {
  configure(env);
  const repo = new MemoryRepository();
  const trace: string[] = [];
  const accounting = {
    getManagedRechargeInfo: vi.fn().mockResolvedValue({ enabled: false, amountDiscount: { "100": 0.9 }, paymentMethods: [] }),
    reportManagedRecharge: vi.fn().mockImplementation(async (r) => { trace.push("receipt"); return { transactionId: r.transactionId, status: r.refundedFen === r.paidAmountFen ? "refunded" : "success", refundedFen: r.refundedFen }; }),
  };
  const api = { query: vi.fn(), deliver: vi.fn().mockImplementation(async () => { trace.push("deliver"); }) };
  const service = new VirtualPaymentService(repo, accounting, () => api);
  const order = await service.create({ userId: "u1", externalUserId: 7, openid: "openid", points: 1000, platform: "other", expectedAmountFen: 900 });
  const remote = { order_id: order.transactionId, env_type: Number(env) + 1, order_type: 0, status: 2, paid_fee: 900, left_fee: 900, wx_order_id: "wx-order", paid_time: 123 };
  api.query.mockImplementation(async () => ({ ...remote }));
  return { repo, accounting, api, service, order, remote, trace };
}
afterEach(() => vi.unstubAllEnvs());
describe("Agent virtual payment settlement", () => {
  it("quotes, signs, credits and refunds a configured one-fen purchase", async () => {
    const f = await fixture();
    vi.stubEnv("WECHAT_VIRTUAL_PAY_GOODS", '{"1":"lot_points_100","500":"lot_points_500","1000":"lot_points_1000","2000":"lot_points_2000","5000":"lot_points_5000","10000":"lot_points_10000"}');
    const offers = (await f.service.info(7, "other")).offers!;
    expect(offers.map((offer) => offer.points)).toEqual([1, 500, 1000, 2000, 5000, 10000]);
    expect(offers[0]).toEqual({ points: 1, productId: "lot_points_100", amountFen: 1 });
    const order = await f.service.create({ userId: "u1", externalUserId: 7, openid: "current-payer", points: 1, platform: "other", expectedAmountFen: 1 });
    expect(order).toMatchObject({ points: 1, amount: 0.01 });
    expect(JSON.parse(order.virtualPay!.signData)).toMatchObject({ productId: "lot_points_100", goodsPrice: 1, buyQuantity: 1 });
    Object.assign(f.remote, { order_id: order.transactionId, paid_fee: 1, left_fee: 1 });
    await f.service.reconcile(order.transactionId);
    expect(f.api.query).toHaveBeenCalledWith("current-payer", order.transactionId, expect.any(AbortSignal));
    expect(f.repo.orders.get(order.transactionId)?.status).toBe("credited");
    expect(f.accounting.reportManagedRecharge.mock.calls[0][0]).toEqual({
      userId: 7, transactionId: order.transactionId, points: 1, paidAmountFen: 1, refundedFen: 0, providerTradeNo: "wx-order", paidAt: 123,
    });
    Object.assign(f.remote, { status: 8, left_fee: 0 });
    await f.service.reconcile(order.transactionId);
    expect(f.accounting.reportManagedRecharge.mock.calls[1][0]).toEqual({
      userId: 7, transactionId: order.transactionId, points: 1, paidAmountFen: 1, refundedFen: 1, providerTradeNo: "wx-order", paidAt: 123,
    });
    expect(f.repo.orders.get(order.transactionId)?.status).toBe("refunded");
  });
  it("does not offer or create a one-fen purchase on iOS", async () => {
    const f = await fixture();
    vi.stubEnv("WECHAT_VIRTUAL_PAY_GOODS", '{"1":"lot_points_1","1000":"lot_points_1000"}');
    expect((await f.service.info(7, "ios")).offers?.map((offer) => offer.points)).toEqual([1000]);
    await expect(f.service.create({ userId: "u1", externalUserId: 7, openid: "openid", points: 1, platform: "ios", expectedAmountFen: 1 })).rejects.toThrow("quote_changed");
  });
  it("sorts other configured tiers and requires an exact server-side whitelist match", async () => {
    const f = await fixture();
    vi.stubEnv("WECHAT_VIRTUAL_PAY_GOODS", '{"1250":"custom-1250","50":"custom-50","1":"custom-1"}');
    expect((await f.service.info(7, "other")).offers).toEqual([
      { points: 1, productId: "custom-1", amountFen: 1 },
      { points: 50, productId: "custom-50", amountFen: 50 },
      { points: 1250, productId: "custom-1250", amountFen: 1125 },
    ]);
    await expect(f.service.create({ userId: "u1", externalUserId: 7, openid: "openid", points: 100, platform: "other", expectedAmountFen: 90 })).rejects.toThrow("quote_changed");
  });
  it("matches decimal rounding at exact half-fen and just below it", () => {
    expect(discountedFen(100, 0.995)).toBe(100);
    expect(discountedFen(100, 0.9949999999999999)).toBe(99);
    expect(discountedFen(10000, 1e-4)).toBe(1);
  });
  it("quotes shared discounts, hides sub-yuan iOS offers, and persists before returning a signature", async () => {
    const f = await fixture();
    expect((await f.service.info(7, "ios")).offers).toEqual([{ points: 1000, amountFen: 900, productId: "ten" }]);
    expect(f.accounting.getManagedRechargeInfo).toHaveBeenCalledWith(7);
    expect(f.repo.orders.get(f.order.transactionId)).toMatchObject({ points: 1000, amountFen: 900, status: "pending" });
    expect(f.order.transactionId).toHaveLength(32);
    expect(f.order.virtualPay?.signData).toContain('"activitySellingPrice":900');
    expect(f.accounting.reportManagedRecharge).not.toHaveBeenCalled();
    await expect(f.service.create({ userId: "u1", externalUserId: 7, openid: "openid", points: 1000, platform: "other", expectedAmountFen: 1000 })).rejects.toThrow("quote_changed");
  });
  it("acknowledges delivery only after New API accepts accounting facts", async () => {
    const f = await fixture();
    expect(await f.service.status("u1", f.order.transactionId)).toMatchObject({ status: "credited" });
    expect(f.trace).toEqual(["receipt", "deliver"]);
    expect(f.accounting.reportManagedRecharge.mock.calls[0][0]).toEqual({ userId: 7, transactionId: f.order.transactionId, points: 1000, paidAmountFen: 900, refundedFen: 0, providerTradeNo: "wx-order", paidAt: 123 });
    expect(f.repo.delays).toEqual([3600]);
  });
  it("retains a durable pending order when accounting fails, then retries after service restart", async () => {
    const f = await fixture();
    f.accounting.reportManagedRecharge.mockRejectedValueOnce(new Error("offline"));
    await f.service.reconcile(f.order.transactionId);
    expect(f.repo.orders.get(f.order.transactionId)?.status).toBe("pending");
    expect(f.api.deliver).not.toHaveBeenCalled();
    const restarted = new VirtualPaymentService(f.repo, f.accounting, () => f.api);
    await restarted.reconcile(f.order.transactionId);
    expect(f.repo.orders.get(f.order.transactionId)?.status).toBe("credited");
    expect(f.accounting.reportManagedRecharge).toHaveBeenCalledTimes(2);
  });
  it("rechecks delivery failures and resends the same idempotent accounting receipt", async () => {
    const f = await fixture(); f.api.deliver.mockRejectedValueOnce(new Error("response lost"));
    await f.service.reconcile(f.order.transactionId);
    expect(f.repo.orders.get(f.order.transactionId)).toMatchObject({ status: "credited", delivered: false });
    await f.service.reconcile(f.order.transactionId);
    expect(f.repo.orders.get(f.order.transactionId)?.delivered).toBe(true);
    expect(f.accounting.reportManagedRecharge.mock.calls[0][0]).toEqual(f.accounting.reportManagedRecharge.mock.calls[1][0]);
  });
  it("serializes workers and never queries an unowned order", async () => {
    const f = await fixture();
    expect(await f.service.status("u2", f.order.transactionId)).toBeNull();
    expect(f.api.query).not.toHaveBeenCalled();
    await Promise.all([f.service.reconcile(f.order.transactionId), f.service.reconcile(f.order.transactionId)]);
    expect(f.accounting.reportManagedRecharge).toHaveBeenCalledTimes(1);
  });
  it.each([{ paid_fee: 899 }, { env_type: 2 }, { order_type: 1 }, { order_id: "other" }, { status: 12 }, { status: 8, left_fee: 900 }, { left_fee: -1 }])("rejects unverified cash/identity/refund facts %j", async (bad) => {
    const f = await fixture(); Object.assign(f.remote, bad);
    await f.service.reconcile(f.order.transactionId);
    expect(f.accounting.reportManagedRecharge).not.toHaveBeenCalled();
    expect(f.api.deliver).not.toHaveBeenCalled();
    expect(f.repo.orders.get(f.order.transactionId)?.status).toBe("pending");
  });
  it("isolates sandbox accounting and continues old orders after sales are disabled", async () => {
    const f = await fixture("1");
    expect((await f.service.info(7, "ios")).offers).toEqual([]);
    vi.stubEnv("WECHAT_VIRTUAL_PAY_ENABLED", "0");
    expect((await f.service.info(7, "other")).enabled).toBe(false);
    await f.service.reconcile(f.order.transactionId);
    expect(f.accounting.reportManagedRecharge).not.toHaveBeenCalled();
    expect(f.repo.orders.get(f.order.transactionId)?.status).toBe("sandbox_paid");
    expect(f.api.deliver).toHaveBeenCalledTimes(1);
  });
  it("reports partial and full cumulative refunds, never decreasing a previous observation", async () => {
    const f = await fixture();
    for (const left of [900, 600, 700, 0]) {
      f.remote.left_fee = left; f.remote.status = left < 900 ? 8 : 4;
      await f.service.reconcile(f.order.transactionId);
    }
    expect(f.accounting.reportManagedRecharge.mock.calls.map((call) => call[0].refundedFen)).toEqual([0, 300, 300, 900]);
    expect(f.repo.orders.get(f.order.transactionId)?.status).toBe("refunded");
    expect(f.api.deliver).not.toHaveBeenCalled();
  });
  it("sends an already fully refunded payment as one atomic accounting receipt", async () => {
    const f = await fixture(); f.remote.left_fee = 0; f.remote.status = 8;
    await f.service.reconcile(f.order.transactionId);
    expect(f.accounting.reportManagedRecharge.mock.calls[0][0].refundedFen).toBe(900);
    expect(f.repo.orders.get(f.order.transactionId)?.status).toBe("refunded");
    expect(f.api.deliver).not.toHaveBeenCalled();
  });
  it("only closes an unpaid order on an explicit provider close", async () => {
    const f = await fixture(); f.api.query.mockRejectedValueOnce(new Error("not found"));
    await f.service.reconcile(f.order.transactionId);
    expect(f.repo.orders.get(f.order.transactionId)?.status).toBe("pending");
    f.remote.status = 6; await f.service.reconcile(f.order.transactionId);
    expect(f.repo.orders.get(f.order.transactionId)?.status).toBe("payment_failed");
  });
});
