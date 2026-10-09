import { pageShare } from "../../lib/page-share.js";
import { api, type RechargeOrder } from "../../services/api.js";
import { formatPoints, yuanToPoints } from "../../lib/points.js";
import { virtualPaymentFailure } from "../../lib/virtual-payment-error.js";

interface Tier {
  points: number;
  amountFen: number;
  priceText: string;
  discountText: string;
}

const pendingKey = (owner: string) => `lot:recharge:pending:${owner}`;
function pendingOrders(owner: string): string[] {
  const value = wx.getStorageSync(pendingKey(owner));
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.length <= 128).slice(-20) : [];
}

Page({
  ...pageShare("美图海报 · 充值积分，继续创作", "/pages/recharge/index"),
  data: {
    balanceText: "—",
    tiers: [] as Tier[],
    selected: 0,
    currentPriceText: "0.00",
    paying: false,
    enabled: false,
    simulator: false,
    paymentError: "",
    status: "正在加载充值档位…",
  },
  visible: false,
  unloaded: false,
  owner: "",
  failedOrder: "",
  initVersion: 0,
  pollVersion: 0,
  pollTimer: 0 as number,

  onShow() {
    this.visible = true;
    void this.init();
  },
  onHide() { this.visible = false; this.stopPolling(); },
  onUnload() { this.unloaded = true; this.visible = false; this.initVersion++; this.stopPolling(); },
  sameOwner(owner: string): boolean {
    return !this.unloaded && !!owner && getApp().globalData.user?.id === owner;
  },
  platform(): string {
    return wx.getSystemInfoSync().platform === "ios" ? "ios" : "other";
  },
  async init() {
    const version = ++this.initVersion;
    this.setData({ enabled: false, simulator: wx.getSystemInfoSync().platform === "devtools" });
    if (!(await getApp().ensureSession()) || this.unloaded || version !== this.initVersion) return;
    const owner = getApp().globalData.user?.id ?? "";
    if (owner !== this.owner) {
      this.stopPolling();
      this.owner = owner;
      this.failedOrder = "";
      this.setData({ balanceText: "—", tiers: [], selected: 0, paying: false, currentPriceText: "0.00", paymentError: "" });
    }
    void this.loadBalance(owner);
    this.pollOrders(owner);
    if (typeof wx.requestVirtualPayment !== "function" || !wx.canIUse("requestVirtualPayment")) {
      this.setData({ tiers: [], status: "当前微信版本不支持虚拟支付，请升级微信后重试" });
      return;
    }
    try {
      const info = await api.rechargeInfo(this.platform());
      if (!this.sameOwner(owner) || version !== this.initVersion) return;
      const tiers: Tier[] = (info.offers ?? []).map((offer) => ({
        points: offer.points,
        amountFen: offer.amountFen,
        priceText: (offer.amountFen / 100).toFixed(2),
        discountText: offer.amountFen < offer.points ? `${(offer.amountFen / offer.points * 10).toFixed(1)}折` : "",
      }));
      const enabled = info.enabled && tiers.length > 0;
      const selected = tiers.some((tier) => tier.points === this.data.selected) ? this.data.selected : 0;
      this.setData({ tiers, selected, enabled: enabled && !this.data.simulator, status: enabled ? "" : "充值暂不可用，请稍后重试" });
      this.refreshCurrentPrice();
    } catch {
      if (this.sameOwner(owner) && version === this.initVersion) {
        this.setData({ tiers: [], enabled: false, status: "充值档位加载失败，请重新进入页面" });
      }
    }
  },
  async loadBalance(owner: string) {
    try {
      const bal = await api.balance();
      if (this.sameOwner(owner)) this.setData({ balanceText: formatPoints(yuanToPoints(Number(bal.balance))) });
    } catch { /* Keep the last confirmed balance. */ }
  },
  selectTier(e: { currentTarget: { dataset: { points: number } } }) {
    if (this.data.paying) return;
    const points = Number(e.currentTarget.dataset.points);
    if (!this.data.tiers.some((tier: Tier) => tier.points === points)) return;
    this.setData({ selected: points });
    this.refreshCurrentPrice();
  },
  refreshCurrentPrice() {
    const tier = this.data.tiers.find((t: Tier) => t.points === this.data.selected);
    this.setData({ currentPriceText: tier ? tier.priceText : "0.00" });
  },
  loginCode(): Promise<string> {
    return new Promise((resolve, reject) => {
      wx.login({
        success: (res) => res.code ? resolve(res.code) : reject(new Error("微信登录失败")),
        fail: () => reject(new Error("微信登录失败")),
      });
    });
  },
  requestVirtualPayment(pay: NonNullable<RechargeOrder["virtualPay"]>): Promise<void> {
    return new Promise((resolve, reject) => {
      wx.requestVirtualPayment({ ...pay, success: () => resolve(), fail: reject });
    });
  },
  async pay() {
    if (wx.getSystemInfoSync().platform === "devtools") {
      this.setData({ simulator: true, enabled: false });
      return;
    }
    if (this.data.paying || !this.data.enabled || !this.data.selected) return;
    // Lock before the first await so rapid taps cannot create duplicate orders.
    this.setData({ paying: true, paymentError: "" });
    this.failedOrder = "";
    const owner = this.owner;
    const tier = this.data.tiers.find((t: Tier) => t.points === this.data.selected) as Tier | undefined;
    let transactionId = "";
    try {
      if (!tier || !(await getApp().ensureSession()) || !this.sameOwner(owner)) return;
      const wxCode = await this.loginCode();
      if (!this.sameOwner(owner)) return;
      const order = await api.createRechargeOrder({
        points: tier.points, paymentMethod: "wxpay_virtual", client: "miniprogram", wxCode,
        platform: this.platform(), expectedAmountFen: tier.amountFen,
      });
      if (!this.sameOwner(owner)) return;
      const pay = order.virtualPay;
      if (order.paymentKind !== "virtual" || !pay?.signData || !pay.paySig || !pay.signature) {
        throw new Error("虚拟支付参数缺失，请刷新页面重试");
      }
      transactionId = order.transactionId;
      wx.setStorageSync(pendingKey(owner), [...pendingOrders(owner), transactionId].slice(-20));
      await this.requestVirtualPayment(pay);
      if (this.sameOwner(owner)) this.setData({ status: "正在确认支付和积分到账…" });
    } catch (err) {
      if (!this.sameOwner(owner)) return;
      const failure = virtualPaymentFailure(err);
      if (failure.cancelled) {
        if (transactionId) this.forgetOrder(owner, transactionId);
        wx.showToast({ title: failure.message, icon: "none" });
      } else {
        this.failedOrder = transactionId;
        this.setData({ paymentError: failure.message });
        const device = wx.getSystemInfoSync();
        console.warn("virtual payment failed", {
          transactionId, code: failure.code, detail: failure.detail,
          platform: device.platform, wechatVersion: device.version, system: device.system,
        });
        wx.showModal({ title: "支付未完成", content: failure.message, showCancel: false });
      }
    } finally {
      if (this.sameOwner(owner)) {
        this.setData({ paying: false });
        this.pollOrders(owner);
      }
    }
  },
  forgetOrder(owner: string, id: string) {
    wx.setStorageSync(pendingKey(owner), pendingOrders(owner).filter((orderId) => orderId !== id));
  },
  pollOrders(owner: string) {
    this.stopPolling();
    if (!this.visible || !this.sameOwner(owner)) return;
    const version = this.pollVersion;
    let count = 0;
    const tick = async () => {
      if (version !== this.pollVersion || !this.visible || !this.sameOwner(owner)) return;
      count++;
      for (const id of pendingOrders(owner)) {
        try {
          const order = await api.getRechargeOrder(id);
          if (version !== this.pollVersion || !this.visible || !this.sameOwner(owner)) return;
          if (order.status === "pending") continue;
          this.forgetOrder(owner, id);
          if (id === this.failedOrder && ["credited", "sandbox_paid", "refunded"].includes(order.status)) {
            this.failedOrder = "";
            this.setData({ paymentError: "" });
          }
          const status = order.status === "credited" ? "积分已到账" : order.status === "sandbox_paid" ? "沙箱支付完成，不增加正式积分" : order.status === "refunded" ? "订单已退款" : "订单支付未完成";
          this.setData({ status });
          if (order.status === "credited") void this.loadBalance(owner);
        } catch { /* The server reconciles independently; retry on next tick. */ }
      }
      if (version !== this.pollVersion || !this.visible || !this.sameOwner(owner)) return;
      if (pendingOrders(owner).length && count < 40) {
        this.pollTimer = setTimeout(() => void tick(), 3000) as unknown as number;
      } else if (pendingOrders(owner).length) {
        this.setData({ status: "支付仍在确认中，稍后进入本页可继续查询" });
      }
    };
    void tick();
  },
  stopPolling() {
    this.pollVersion++;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = 0; }
  },
});
