import { createHmac } from "node:crypto";

export interface VirtualPayConfig {
  appId: string; secret: string; offerId: string; appKey: string; env: 0 | 1;
}

/** Keep both environment keys until all old orders have reconciled. */
export function loadVirtualPayConfig(env: 0 | 1): VirtualPayConfig {
  const config = {
    appId: process.env.WECHAT_MP_APPID?.trim() ?? "",
    secret: process.env.WECHAT_MP_SECRET?.trim() ?? "",
    offerId: process.env.WECHAT_VIRTUAL_PAY_OFFER_ID?.trim() ?? "",
    appKey: (env === 1 ? process.env.WECHAT_VIRTUAL_PAY_SANDBOX_APP_KEY : process.env.WECHAT_VIRTUAL_PAY_APP_KEY)?.trim() ?? "",
    env,
  };
  if (!config.appId || !config.secret || !config.offerId || !config.appKey) throw new Error("virtual_payment_not_configured");
  return config;
}

export function loadVirtualPaySales(): { config: VirtualPayConfig; goods: Record<string, string> } {
  const env = process.env.WECHAT_VIRTUAL_PAY_ENV || "0";
  if (process.env.WECHAT_VIRTUAL_PAY_ENABLED !== "1" || !["0", "1"].includes(env)) throw new Error("virtual_payment_disabled");
  const config = loadVirtualPayConfig(env === "1" ? 1 : 0);
  let value: unknown;
  try { value = JSON.parse(process.env.WECHAT_VIRTUAL_PAY_GOODS || "{}"); } catch { throw new Error("virtual_payment_goods_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("virtual_payment_goods_invalid");
  const goods: Record<string, string> = {};
  for (const [key, id] of Object.entries(value)) {
    // Keys are integral points (also the original price in fen), not yuan.
    // Use the same bounds as the recharge route and New API accounting.
    if (!/^[1-9]\d*$/.test(key)) continue;
    const points = Number(key);
    if (!Number.isSafeInteger(points) || points > 10_000_000) continue;
    if (typeof id === "string" && id.trim() && id.length <= 128) goods[key] = id.trim();
  }
  if (!Object.keys(goods).length) throw new Error("virtual_payment_goods_missing");
  return { config, goods };
}

export function signVirtual(key: string, data: string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

export function virtualPaymentParams(config: VirtualPayConfig, orderNo: string, productId: string, points: number, amountFen: number) {
  const signData = JSON.stringify({ offerId: config.offerId, buyQuantity: 1, env: config.env, currencyType: "CNY",
    productId, goodsPrice: points, ...(amountFen !== points ? { activitySellingPrice: amountFen } : {}),
    outTradeNo: orderNo, attach: "lot-agent" });
  return { mode: "short_series_goods" as const, signData, paySig: signVirtual(config.appKey, `requestVirtualPayment&${signData}`) };
}

export interface WechatVirtualOrder {
  order_id: string; status: number; order_type: number; paid_fee: number;
  left_fee?: number; env_type: number; wx_order_id: string; paid_time: number;
}
export interface WechatVirtualAPI {
  query(openid: string, orderNo: string, signal: AbortSignal): Promise<WechatVirtualOrder>;
  deliver(orderNo: string, signal: AbortSignal): Promise<void>;
}

/** Fixed WeChat origin, bounded requests, and no secrets/upstream messages in errors. */
export class WechatVirtualClient implements WechatVirtualAPI {
  private token = "";
  private expiresAt = 0;
  private refreshing?: Promise<string>;
  constructor(private readonly config: VirtualPayConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  private async post(path: string, query: URLSearchParams, body: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    let result: Record<string, unknown>;
    try {
      const response = await this.fetchImpl(`https://api.weixin.qq.com${path}?${query}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body,
        redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
      });
      if (!response.ok) throw new Error();
      result = await response.json() as Record<string, unknown>;
      if (!result || typeof result !== "object") throw new Error();
    } catch { throw new Error("virtual_payment_upstream_unavailable"); }
    if (result.errcode !== undefined && result.errcode !== 0) {
      if ([40001, 40014, 42001].includes(Number(result.errcode))) this.token = "";
      throw new Error("virtual_payment_api_failed");
    }
    return result;
  }

  private async accessToken(signal: AbortSignal): Promise<string> {
    if (this.token && Date.now() < this.expiresAt) return this.token;
    if (!this.refreshing) {
      this.refreshing = this.post("/cgi-bin/stable_token", new URLSearchParams(), JSON.stringify({
        grant_type: "client_credential", appid: this.config.appId, secret: this.config.secret, force_refresh: false,
      }), signal).then((data) => {
        if (typeof data.access_token !== "string" || !data.access_token || typeof data.expires_in !== "number" || data.expires_in <= 300) throw new Error("virtual_payment_token_unavailable");
        this.token = data.access_token;
        this.expiresAt = Date.now() + (data.expires_in - 300) * 1000;
        return this.token;
      }).finally(() => { this.refreshing = undefined; });
    }
    return this.refreshing;
  }

  private async call(path: string, payload: unknown, signed: boolean, signal: AbortSignal) {
    const body = JSON.stringify(payload);
    const query = new URLSearchParams({ access_token: await this.accessToken(signal) });
    if (signed) query.set("pay_sig", signVirtual(this.config.appKey, `${path}&${body}`));
    // No blind write retries: the persistent worker queries the order again first.
    const result = await this.post(path, query, body, signal);
    if (result.errcode !== 0) throw new Error("virtual_payment_response_invalid");
    return result;
  }

  async query(openid: string, orderNo: string, signal: AbortSignal): Promise<WechatVirtualOrder> {
    const result = await this.call("/xpay/query_order", { openid, env: this.config.env, order_id: orderNo }, true, signal);
    if (!result.order || typeof result.order !== "object") throw new Error("virtual_payment_order_unavailable");
    return result.order as WechatVirtualOrder;
  }

  async deliver(orderNo: string, signal: AbortSignal): Promise<void> {
    await this.call("/xpay/notify_provide_goods", { env: this.config.env, order_id: orderNo }, false, signal);
  }
}
