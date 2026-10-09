import { randomBytes } from "node:crypto";
import { logger, type VirtualPaymentOrder, type VirtualPaymentRepository } from "@lot-agent/core";
import type { TokenhubClient, ManagedRechargeInfo, ManagedRechargeOrder } from "../tokenhub/client.js";
import { loadVirtualPayConfig, loadVirtualPaySales, signVirtual, virtualPaymentParams, WechatVirtualClient, type WechatVirtualAPI } from "./wechat-virtual.js";

type Accounting = Pick<TokenhubClient, "getManagedRechargeInfo" | "reportManagedRecharge">;
export interface CreateVirtualOrder {
  userId: string; externalUserId: number; openid: string; points: number; platform: string; expectedAmountFen: number;
}
export interface MiniPaymentService {
  info(externalUserId: number, platform: string): Promise<ManagedRechargeInfo>;
  create(args: CreateVirtualOrder): Promise<ManagedRechargeOrder>;
  status(userId: string, orderNo: string): Promise<ManagedRechargeOrder | null>;
}

function publicOrder(order: VirtualPaymentOrder): ManagedRechargeOrder {
  return { transactionId: order.orderNo, status: order.status, points: order.points, amount: order.amountFen / 100,
    currency: "CNY", orderSource: "lot-agent-miniprogram", paymentMethod: "wxpay_virtual" };
}

// Match decimal.NewFromFloat(rate).Mul(points).Round(0) used by existing
// recharge pricing, without a binary floating-point rounding boundary.
export function discountedFen(points: number, rate: number): number {
  const [coefficient, exponent = "0"] = String(rate).toLowerCase().split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  const scale = fraction.length - Number(exponent);
  const numerator = BigInt(whole + fraction) * BigInt(points);
  if (scale <= 0) return Number(numerator * 10n ** BigInt(-scale));
  const divisor = 10n ** BigInt(scale);
  return Number((numerator * 2n + divisor) / (divisor * 2n));
}

export class VirtualPaymentService implements MiniPaymentService {
  private clients = new Map<string, WechatVirtualAPI>();
  constructor(private readonly repository: VirtualPaymentRepository, private readonly accounting: Accounting,
    private readonly apiFor?: (order: VirtualPaymentOrder) => WechatVirtualAPI) {}

  private async quote(externalUserId: number, platform: string) {
    const sales = loadVirtualPaySales();
    // Reuse the existing generic recharge discount policy; no WeChat data is sent to New API.
    const { amountDiscount } = await this.accounting.getManagedRechargeInfo(externalUserId);
    const offers = Object.keys(sales.goods).map(Number).sort((a, b) => a - b).flatMap((points) => {
      let threshold = 0;
      let discount = 1;
      for (const [key, rate] of Object.entries(amountDiscount)) {
        const value = Number(key);
        if (Number.isSafeInteger(value) && value > threshold && value <= points && Number.isFinite(rate) && rate > 0) {
          threshold = value; discount = rate;
        }
      }
      const amountFen = discountedFen(points, discount);
      const productId = sales.goods[points];
      if (!productId || discount > 1 || amountFen <= 0 || platform === "ios" && (amountFen < 100 || sales.config.env === 1)) return [];
      return [{ points, productId, amountFen }];
    });
    return { ...sales, offers, amountDiscount };
  }

  async info(externalUserId: number, platform: string): Promise<ManagedRechargeInfo> {
    try {
      const { offers, amountDiscount } = await this.quote(externalUserId, platform);
      return { enabled: offers.length > 0, paymentMethods: [{ name: "虚拟支付", type: "wxpay_virtual" }], offers, amountDiscount };
    } catch { return { enabled: false, paymentMethods: [], offers: [], amountDiscount: {} }; }
  }

  async create(args: CreateVirtualOrder): Promise<ManagedRechargeOrder> {
    const { config, offers } = await this.quote(args.externalUserId, args.platform);
    const chosen = offers.find((offer) => offer.points === args.points && offer.amountFen === args.expectedAmountFen);
    if (!chosen) throw new Error("virtual_payment_quote_changed");
    const order: VirtualPaymentOrder = { orderNo: `LV${randomBytes(15).toString("hex")}`, userId: args.userId,
      externalUserId: args.externalUserId, points: chosen.points, amountFen: chosen.amountFen, appId: config.appId,
      offerId: config.offerId, openid: args.openid, productId: chosen.productId, env: config.env,
      createdAt: Math.floor(Date.now() / 1000), status: "pending", refundedFen: 0, delivered: false };
    await this.repository.create(order);
    return { ...publicOrder(order), paymentKind: "virtual", virtualPay: virtualPaymentParams(config, order.orderNo, order.productId, order.points, order.amountFen) };
  }

  async status(userId: string, orderNo: string): Promise<ManagedRechargeOrder | null> {
    // Check ownership before claiming an order or contacting either upstream.
    if (!await this.repository.findForUser(orderNo, userId)) return null;
    await this.reconcile(orderNo);
    const order = await this.repository.findForUser(orderNo, userId);
    return order ? publicOrder(order) : null;
  }

  private client(order: VirtualPaymentOrder): WechatVirtualAPI {
    if (this.apiFor) return this.apiFor(order);
    const config = loadVirtualPayConfig(order.env);
    if (config.appId !== order.appId || config.offerId !== order.offerId) throw new Error("virtual_payment_identity_changed");
    const key = signVirtual(config.appKey, `${config.appId}:${config.secret}:${config.offerId}:${config.env}`);
    let client = this.clients.get(key);
    if (!client) { client = new WechatVirtualClient(config); this.clients.set(key, client); }
    return client;
  }

  async reconcile(orderNo: string, parentSignal?: AbortSignal): Promise<void> {
    const lease = await this.repository.claim(orderNo);
    if (!lease) return;
    const { order, leaseId } = lease;
    let delay = 15;
    try {
      const signal = AbortSignal.any([AbortSignal.timeout(55_000), ...(parentSignal ? [parentSignal] : [])]);
      await this.reconcileClaimed(order, this.client(order), signal);
      if (order.delivered || Date.now() / 1000 - order.createdAt > 86400) delay = 3600;
    } catch {
      // IDs are safe; upstream errors can contain credentials or signed URLs.
      logger.warn("virtual payment reconciliation deferred", { orderNo });
      delay = 60;
    } finally { await this.repository.finish(order, leaseId, delay); }
  }

  private async reconcileClaimed(order: VirtualPaymentOrder, api: WechatVirtualAPI, signal: AbortSignal) {
    const remote = await api.query(order.openid, order.orderNo, signal);
    if (remote.order_id !== order.orderNo || remote.env_type !== order.env + 1 || ![0, 7].includes(remote.order_type)) throw new Error("virtual_payment_identity_mismatch");
    if ([0, 1].includes(remote.status)) return;
    if (remote.status === 6) {
      if (order.status !== "pending") throw new Error("virtual_payment_state_conflict");
      order.status = "payment_failed"; return;
    }
    if (![2, 3, 4, 5, 7, 8, 9, 10].includes(remote.status) || remote.paid_fee !== order.amountFen || !remote.wx_order_id || !Number.isSafeInteger(remote.paid_time) || remote.paid_time <= 0) throw new Error("virtual_payment_amount_mismatch");
    let refundedFen = 0;
    if (remote.left_fee !== undefined) {
      if (!Number.isSafeInteger(remote.left_fee) || remote.left_fee < 0 || remote.left_fee > remote.paid_fee) throw new Error("virtual_payment_refund_invalid");
      refundedFen = remote.paid_fee - remote.left_fee;
    }
    if ([5, 8, 9, 10].includes(remote.status) && !refundedFen) throw new Error("virtual_payment_refund_unconfirmed");
    refundedFen = Math.max(order.refundedFen, refundedFen);
    if (order.env === 0) {
      // The receipt is the durable outbox: until acknowledged, this order stays
      // due for reconciliation. New API makes a repeated receipt atomic/idempotent.
      const receipt = await this.accounting.reportManagedRecharge({ userId: order.externalUserId, transactionId: order.orderNo,
        points: order.points, paidAmountFen: order.amountFen, refundedFen, providerTradeNo: remote.wx_order_id, paidAt: remote.paid_time }, signal);
      if (receipt.transactionId !== order.orderNo || (!Number.isSafeInteger(receipt.refundedFen) || receipt.refundedFen < refundedFen || receipt.refundedFen > order.amountFen) || !["success", "refunded"].includes(receipt.status) || (receipt.status === "refunded") !== (receipt.refundedFen === order.amountFen)) throw new Error("recharge_receipt_unconfirmed");
      order.status = receipt.status === "refunded" ? "refunded" : "credited";
      order.refundedFen = receipt.refundedFen;
    } else {
      // Sandbox payments never cross the accounting boundary.
      order.status = refundedFen === order.amountFen ? "refunded" : "sandbox_paid";
      order.refundedFen = refundedFen;
    }
    if (order.status === "refunded") return;
    if ([2, 3].includes(remote.status)) await api.deliver(order.orderNo, signal);
    order.delivered = true;
  }

  start(): () => Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: Promise<void>;
    const run = async () => {
      try {
        const ids = await this.repository.due(100);
        for (let i = 0; i < ids.length && !controller.signal.aborted; i += 4) {
          await Promise.allSettled(ids.slice(i, i + 4).map((id) => this.reconcile(id, controller.signal)));
        }
      } catch { logger.warn("virtual payment reconciliation scan failed"); }
      if (!controller.signal.aborted) timer = setTimeout(() => { active = run(); }, 15_000);
    };
    active = run();
    return async () => { controller.abort(); clearTimeout(timer); await active; };
  }
}
