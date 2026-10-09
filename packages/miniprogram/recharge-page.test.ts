import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ rechargeInfo: vi.fn(), balance: vi.fn(), createRechargeOrder: vi.fn(), getRechargeOrder: vi.fn() }));
vi.mock("./miniprogram/services/api.js", () => ({ api }));
let page: any;
let app: any;
let saved: Record<string, any>;
const payment = { transactionId: "LOT12345678", status: "pending", paymentKind: "virtual", virtualPay: { mode: "short_series_goods", signData: '{"env":0, "outTradeNo":"LOT12345678"}', paySig: "pay", signature: "user" } };
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  saved = {};
  app = { ensureSession: vi.fn().mockResolvedValue(true), globalData: { user: { id: "owner" } } };
  vi.stubGlobal("getApp", () => app);
  vi.stubGlobal("wx", {
    getStorageSync: vi.fn(key => saved[key]), setStorageSync: vi.fn((key, value) => { saved[key] = value; }),
    showToast: vi.fn(), showModal: vi.fn(), canIUse: vi.fn().mockReturnValue(true), getSystemInfoSync: vi.fn().mockReturnValue({ platform: "ios" }),
    login: vi.fn(({ success }) => success({ code: "wx-code" })),
    requestVirtualPayment: vi.fn(({ success }) => success({ errMsg: "ok" })), requestPayment: vi.fn(),
  });
  vi.stubGlobal("Page", (definition: any) => { page = { ...definition, data: structuredClone(definition.data), setData(data: any) { Object.assign(this.data, data); } }; });
  api.rechargeInfo.mockResolvedValue({ enabled: true, offers: [{ points: 1000, amountFen: 900, productId: "points_1000" }] });
  api.balance.mockResolvedValue({ balance: 0 });
  api.createRechargeOrder.mockResolvedValue(structuredClone(payment));
  api.getRechargeOrder.mockResolvedValue({ status: "pending" });
  await import("./miniprogram/pages/recharge/index.js");
  page.visible = true;
  await page.init();
  page.selectTier({ currentTarget: { dataset: { points: 1000 } } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("virtual recharge", () => {
  it("previews prices in the simulator without creating a payment order", async () => {
    vi.mocked(wx.getSystemInfoSync).mockReturnValue({ platform: "devtools" });
    await page.init();
    expect(page.data.simulator).toBe(true);
    expect(page.data.tiers).toHaveLength(1);
    expect(page.data.enabled).toBe(false);
    await page.pay();
    expect(wx.login).not.toHaveBeenCalled();
    expect(api.createRechargeOrder).not.toHaveBeenCalled();
    expect(wx.requestVirtualPayment).not.toHaveBeenCalled();
  });
  it("keeps the provider error code and reason visible while checking an uncertain payment", async () => {
    vi.mocked(wx.requestVirtualPayment).mockImplementation(({ fail }) => fail?.({ errMsg: "requestVirtualPayment:fail goodsPrice error", errCode: -15013 }));
    await page.pay();
    expect(wx.showModal).toHaveBeenCalledWith(expect.objectContaining({
      title: "支付未完成", showCancel: false, content: expect.stringContaining("-15013"),
    }));
    expect(page.data.paymentError).toContain("商品价格");
    expect(page.data.paymentError).toContain("微信后台");
    expect(saved["lot:recharge:pending:owner"]).toEqual([payment.transactionId]);
    await page.init();
    await vi.advanceTimersByTimeAsync(0);
    expect(page.data.paymentError).toContain("-15013");
    api.getRechargeOrder.mockResolvedValue({ status: "credited" });
    page.pollOrders("owner"); await vi.advanceTimersByTimeAsync(0);
    expect(page.data.paymentError).toBe("");
    expect(page.data.status).toBe("积分已到账");
  });
  it("shows an unrecognized native error message instead of hiding it in a generic toast", async () => {
    vi.mocked(wx.requestVirtualPayment).mockImplementation(({ fail }) => fail?.({ errMsg: "requestVirtualPayment:fail unsupported platform", errCode: -99999 }));
    await page.pay();
    expect(page.data.paymentError).toContain("unsupported platform");
    expect(page.data.paymentError).toContain("-99999");
    expect(wx.showModal).toHaveBeenCalledOnce();
    expect(api.createRechargeOrder).toHaveBeenCalledOnce();
  });
  it("preserves the exact parameter failure reason for error -15001", async () => {
    vi.mocked(wx.requestVirtualPayment).mockImplementation(({ fail }) => fail?.({
      errMsg: "requestVirtualPayment:fail invalid offerId", errCode: -15001,
    }));
    await page.pay();
    expect(page.data.paymentError).toContain("参数");
    expect(page.data.paymentError).toContain("-15001");
    expect(page.data.paymentError).toContain("invalid offerId");
    expect(wx.showModal).toHaveBeenCalledWith(expect.objectContaining({ content: page.data.paymentError }));
  });
  it("preserves a separate native err_msg even when errMsg only says fail", async () => {
    vi.mocked(wx.requestVirtualPayment).mockImplementation(({ fail }) => fail?.({
      errMsg: "requestVirtualPayment:fail", err_code: "-15001", err_msg: "invalid buyQuantity",
    } as never));
    await page.pay();
    expect(page.data.paymentError).toContain("-15001");
    expect(page.data.paymentError).toContain("invalid buyQuantity");
  });
  it("states explicitly when WeChat returns -15001 without a parameter reason", async () => {
    vi.mocked(wx.requestVirtualPayment).mockImplementation(({ fail }) => fail?.({
      errMsg: "requestVirtualPayment:fail", errCode: -15001,
    }));
    await page.pay();
    expect(page.data.paymentError).toContain("-15001");
    expect(page.data.paymentError).toContain("微信未提供具体错误原因");
    expect(saved["lot:recharge:pending:owner"]).toEqual([payment.transactionId]);
  });
  it("explains an iOS merchant eligibility rejection instead of calling it invalid parameters", async () => {
    vi.mocked(wx.requestVirtualPayment).mockImplementation(({ fail }) => fail?.({
      errMsg: "requestVirtualPayment:fail 当前商户尚未开启iOS支付", errCode: -15001,
    }));
    await page.pay();
    expect(page.data.paymentError).toContain("苹果支付暂不可用");
    expect(page.data.paymentError).toContain("微信返回：当前商户尚未开启iOS支付");
    expect(page.data.paymentError).toContain("-15001");
    expect(page.data.paymentError).not.toContain("参数有误");
    expect(wx.requestPayment).not.toHaveBeenCalled();
    expect(saved["lot:recharge:pending:owner"]).toEqual([payment.transactionId]);
  });
  it.each([-15001, -15010, undefined])("explains product_id_not_publish when the code is %s", async (code) => {
    vi.mocked(wx.requestVirtualPayment).mockImplementation(({ fail }) => fail?.({
      errMsg: "requestVirtualPayment:fail product_id_not_publish", errCode: code,
    }));
    await page.pay();
    expect(page.data.paymentError).toContain("充值商品尚未在微信后台发布");
    expect(page.data.paymentError).toContain("微信返回：product_id_not_publish");
    expect(page.data.paymentError).not.toContain("参数有误");
    expect(page.data.status).not.toBe("积分已到账");
    expect(wx.requestPayment).not.toHaveBeenCalled();
    expect(saved["lot:recharge:pending:owner"]).toEqual([payment.transactionId]);
  });
  it.each([-15001, -15014, undefined])("explains the product activation delay when the code is %s", async (code) => {
    vi.mocked(wx.requestVirtualPayment).mockImplementation(({ fail }) => fail?.({
      errMsg: "requestVirtualPayment:fail coin_or_product_id_created_in_recently", errCode: code,
    }));
    await page.pay();
    expect(page.data.paymentError).toContain("发布尚未生效");
    expect(page.data.paymentError).toContain("发布后约 10 分钟");
    expect(page.data.paymentError).toContain("coin_or_product_id_created_in_recently");
    expect(page.data.paymentError).not.toContain("参数有误");
    expect(api.createRechargeOrder).toHaveBeenCalledOnce();
    expect(wx.requestVirtualPayment).toHaveBeenCalledOnce();
    expect(page.data.status).not.toBe("积分已到账");
    expect(saved["lot:recharge:pending:owner"]).toEqual([payment.transactionId]);
  });
  it("redacts credentials and signed URLs from native failure details", async () => {
    vi.mocked(wx.requestVirtualPayment).mockImplementation(({ fail }) => fail?.({
      errMsg: "requestVirtualPayment:fail signature=PRIVATE-SIGN session_key='PRIVATE-KEY' https://example.test/?access_token=PRIVATE-TOKEN",
      errCode: -99999,
    }));
    await page.pay();
    expect(page.data.paymentError).toContain("已隐藏");
    expect(page.data.paymentError).not.toContain("PRIVATE");
    expect(page.data.paymentError).not.toContain("example.test");
  });
  it("redacts quoted credentials while preserving known parameter error details", async () => {
    vi.mocked(wx.requestVirtualPayment).mockImplementation(({ fail }) => fail?.({
      errMsg: 'requestVirtualPayment:fail invalid signData {"signature":"PRIVATE-SIGN","session_key":"PRIVATE-KEY","openid":"PRIVATE-USER"}',
      errCode: -15001,
    }));
    await page.pay();
    expect(page.data.paymentError).toContain("invalid signData");
    expect(page.data.paymentError).not.toContain("PRIVATE");
  });
  it("handles a failure callback without details and still queries the order", async () => {
    vi.mocked(wx.requestVirtualPayment).mockImplementation(({ fail }) => fail?.(null as never));
    await page.pay();
    expect(page.data.paymentError).toContain("微信未返回支付结果");
    expect(page.data.paying).toBe(false);
    expect(saved["lot:recharge:pending:owner"]).toEqual([payment.transactionId]);
  });
  it("displays and submits the configured one-fen tier on Android", async () => {
    vi.mocked(wx.getSystemInfoSync).mockReturnValue({ platform: "android" });
    api.rechargeInfo.mockResolvedValue({ enabled: true, offers: [{ points: 1, amountFen: 1, productId: "lot_points_100" }] });
    await page.init();
    page.selectTier({ currentTarget: { dataset: { points: 1 } } });
    expect(page.data.tiers).toEqual([{ points: 1, amountFen: 1, priceText: "0.01", discountText: "" }]);
    expect(page.data.currentPriceText).toBe("0.01");
    await page.pay();
    expect(api.createRechargeOrder).toHaveBeenCalledWith({ points: 1, paymentMethod: "wxpay_virtual", client: "miniprogram", wxCode: "wx-code", platform: "other", expectedAmountFen: 1 });
    expect(wx.requestVirtualPayment).toHaveBeenCalledTimes(1);
  });
  it("uses the server quote and forwards the exact signed bytes only once for rapid taps", async () => {
    await Promise.all([page.pay(), page.pay(), page.pay()]);
    expect(api.createRechargeOrder).toHaveBeenCalledTimes(1);
    expect(api.createRechargeOrder).toHaveBeenCalledWith({ points: 1000, paymentMethod: "wxpay_virtual", client: "miniprogram", wxCode: "wx-code", platform: "ios", expectedAmountFen: 900 });
    expect(wx.requestVirtualPayment).toHaveBeenCalledWith(expect.objectContaining(payment.virtualPay));
    expect(wx.requestPayment).not.toHaveBeenCalled();
    expect(saved["lot:recharge:pending:owner"]).toEqual([payment.transactionId]);
    expect(page.data.status).not.toBe("积分已到账");
  });
  it("restores unfinished orders and waits for new-api credit before updating balance", async () => {
    saved["lot:recharge:pending:owner"] = [payment.transactionId];
    api.getRechargeOrder.mockResolvedValue({ status: "credited" });
    api.balance.mockResolvedValue({ balance: 10 });
    page.pollOrders("owner"); await vi.advanceTimersByTimeAsync(0);
    expect(saved["lot:recharge:pending:owner"]).toEqual([]);
    expect(page.data.status).toBe("积分已到账");
    expect(page.data.balanceText).toBe("1,000");
    expect(wx.requestVirtualPayment).not.toHaveBeenCalled();
  });
  it("does not fall back to ordinary payment when unsupported or misconfigured", async () => {
    vi.mocked(wx.canIUse).mockReturnValue(false);
    await page.init(); await page.pay();
    expect(page.data.enabled).toBe(false); expect(api.createRechargeOrder).not.toHaveBeenCalled();
    expect(wx.requestPayment).not.toHaveBeenCalled();
  });
  it("stops polling on unload, including an in-flight query", async () => {
    let resolve: (value: any) => void = () => {};
    saved["lot:recharge:pending:owner"] = [payment.transactionId];
    api.getRechargeOrder.mockImplementation(() => new Promise(done => { resolve = done; }));
    page.pollOrders("owner"); page.onUnload(); resolve({ status: "credited" });
    await vi.advanceTimersByTimeAsync(0);
    expect(saved["lot:recharge:pending:owner"]).toEqual([payment.transactionId]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not start payment after switching accounts during order creation", async () => {
    let resolve: (value: any) => void = () => {};
    api.createRechargeOrder.mockImplementation(() => new Promise(done => { resolve = done; }));
    const paying = page.pay(); await vi.advanceTimersByTimeAsync(0);
    app.globalData.user = { id: "other" }; resolve(payment); await paying;
    expect(wx.requestVirtualPayment).not.toHaveBeenCalled();
    expect(saved["lot:recharge:pending:other"]).toBeUndefined();
  });
  it("disables purchases when offers fail to load instead of assuming full price", async () => {
    api.rechargeInfo.mockRejectedValue(new Error("offline"));
    await page.init(); await page.pay();
    expect(page.data.enabled).toBe(false); expect(page.data.tiers).toEqual([]);
    expect(api.createRechargeOrder).not.toHaveBeenCalled();
  });
  it("handles numeric cancellation and keeps unknown outcomes recoverable", async () => {
    vi.mocked(wx.requestVirtualPayment).mockImplementation(({ fail }) => fail?.({ errMsg: "cancelled", errCode: -2 }));
    await page.pay(); expect(saved["lot:recharge:pending:owner"]).toEqual([]);
    expect(wx.showModal).not.toHaveBeenCalled();
    expect(page.data.paymentError).toBe("");
    vi.mocked(wx.requestVirtualPayment).mockImplementation(({ fail }) => fail?.({ errMsg: "unknown", errCode: -1 }));
    await page.pay(); expect(saved["lot:recharge:pending:owner"]).toEqual([payment.transactionId]);
  });
  it("shows sandbox completion without claiming a real credit", async () => {
    saved["lot:recharge:pending:owner"] = [payment.transactionId];
    api.getRechargeOrder.mockResolvedValue({ status: "sandbox_paid" });
    page.pollOrders("owner"); await vi.advanceTimersByTimeAsync(0);
    expect(page.data.status).toContain("不增加正式积分");
  });
});
