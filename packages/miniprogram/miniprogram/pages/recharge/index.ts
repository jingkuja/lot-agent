import { api } from "../../services/api";
import { formatPoints, yuanToPoints } from "../../lib/points";

interface Tier {
  points: number;
  priceText: string;
  discountText: string;
}

/** 充值面额档位（积分）。1 元 = 100 积分，实付 = 积分 × 档位折扣 / 100。 */
const TIER_POINTS = [100, 500, 1000, 2000, 5000, 10000];

Page({
  data: {
    balanceText: "—",
    tiers: [] as Tier[],
    selected: 0,
    currentPriceText: "0.00",
    paying: false,
    discount: {} as Record<string, number>,
  },

  onLoad() {
    this.setData({ tiers: this.buildTiers({}) });
  },

  onShow() {
    void this.init();
  },

  onUnload() {
    this.stopPolling();
  },

  async init() {
    if (!(await getApp().ensureSession())) return;
    void this.loadBalance();
    try {
      const info = await api.rechargeInfo();
      const discount = info?.amountDiscount ?? {};
      this.setData({ tiers: this.buildTiers(discount), discount });
      this.refreshCurrentPrice();
    } catch {
      // 折扣表加载失败时按原价展示，不阻塞充值入口
    }
  },

  async loadBalance() {
    try {
      const bal = await api.balance();
      // 接口返回元，按 1 元 = 100 积分换算展示
      this.setData({ balanceText: formatPoints(yuanToPoints(Number(bal.balance))) });
    } catch {
      this.setData({ balanceText: "—" });
    }
  },

  /** 按积分档位匹配最优折扣率：取不大于 points 的最大档位的折扣。 */
  discountFor(points: number, discount: Record<string, number>): number {
    let best = 0;
    let rate = 1;
    for (const key of Object.keys(discount)) {
      const threshold = Number(key);
      const r = discount[key];
      if (Number.isInteger(threshold) && threshold > 0 && threshold <= points && threshold >= best && r > 0 && r <= 1) {
        best = threshold;
        rate = r;
      }
    }
    return rate;
  },

  buildTiers(discount: Record<string, number>): Tier[] {
    return TIER_POINTS.map((points) => {
      const rate = this.discountFor(points, discount);
      const price = (points * rate) / 100;
      return {
        points,
        priceText: price.toFixed(2),
        discountText: rate < 1 ? `${(rate * 10).toFixed(1)}折` : "",
      };
    });
  },

  selectTier(e: { currentTarget: { dataset: { points: number } } }) {
    const points = Number(e.currentTarget.dataset.points);
    if (!Number.isInteger(points) || points <= 0) return;
    this.setData({ selected: points });
    this.refreshCurrentPrice();
  },

  refreshCurrentPrice() {
    const tier = this.data.tiers.find((t: Tier) => t.points === this.data.selected);
    this.setData({ currentPriceText: tier ? tier.priceText : "0.00" });
  },

  /** wx.login() 拿一次性 code，服务端用它换付款人 openid。 */
  loginCode(): Promise<string> {
    return new Promise((resolve, reject) => {
      wx.login({
        success: (res) => (res.code ? resolve(res.code) : reject(new Error("微信登录失败"))),
        fail: () => reject(new Error("微信登录失败")),
      });
    });
  },

  requestPayment(pay: NonNullable<import("../../services/api").RechargeOrder["miniprogramPay"]>): Promise<void> {
    return new Promise((resolve, reject) => {
      wx.requestPayment({
        timeStamp: pay.timeStamp,
        nonceStr: pay.nonceStr,
        package: pay.package,
        signType: pay.signType as "MD5" | "HMAC-SHA256" | "RSA",
        paySign: pay.paySign,
        success: () => resolve(),
        fail: (err) => reject(err),
      });
    });
  },

  async pay() {
    if (this.data.paying || !this.data.selected) return;
    if (!(await getApp().ensureSession())) return;
    this.setData({ paying: true });
    try {
      const wxCode = await this.loginCode();
      const order = await api.createRechargeOrder({
        points: this.data.selected,
        paymentMethod: "wxpay",
        client: "miniprogram",
        wxCode,
      });
      const pay = order.miniprogramPay;
      if (!pay || !pay.paySign) {
        throw new Error("支付参数缺失，请稍后重试");
      }
      try {
        await this.requestPayment(pay);
      } catch (err) {
        const msg = (err as { errMsg?: string })?.errMsg ?? "";
        if (msg.includes("cancel")) {
          wx.showToast({ title: "已取消支付", icon: "none" });
          return;
        }
        throw new Error("支付未完成");
      }
      wx.showToast({ title: "支付成功，入账中…", icon: "none" });
      this.pollOrder(order.transactionId);
    } catch (err) {
      wx.showToast({ title: err instanceof Error ? err.message : "下单失败", icon: "none" });
    } finally {
      this.setData({ paying: false });
    }
  },

  pollTimer: 0 as number,
  pollCount: 0,

  /** 支付完成后轮询订单，直到积分入账。 */
  pollOrder(transactionId: string) {
    this.stopPolling();
    this.pollCount = 0;
    const tick = async () => {
      this.pollCount += 1;
      try {
        const order = await api.getRechargeOrder(transactionId);
        if (order.status === "credited") {
          this.stopPolling();
          wx.showToast({ title: "已到账", icon: "success" });
          void this.loadBalance();
          return;
        }
        if (order.status === "payment_failed") {
          this.stopPolling();
          wx.showToast({ title: "支付未完成", icon: "none" });
          return;
        }
      } catch {
        // 单次查询失败忽略，继续轮询
      }
      if (this.pollCount < 20) {
        this.pollTimer = setTimeout(() => void tick(), 1500) as unknown as number;
      } else {
        // 超时兜底：刷新一次余额，让用户自己看到账结果
        void this.loadBalance();
      }
    };
    this.pollTimer = setTimeout(() => void tick(), 1200) as unknown as number;
  },

  stopPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = 0;
    }
  },
});
