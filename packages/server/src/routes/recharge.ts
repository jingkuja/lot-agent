import { Hono } from "hono";
import { createHmac } from "node:crypto";
import { logger } from "@lot-agent/core";
import type { MiniPaymentService } from "../payments/service.js";
import type { AgentService } from "../services/agent-service.js";
import { exchangeWechatPaymentCode, wechatConfigured } from "../auth/wechat.js";

type Variables = { userId: string };

async function externalUserId(service: AgentService, userId: string): Promise<number | null> {
  const user = await service.db.getUserById(userId);
  return user?.external_user_id ?? null;
}

export function createRechargeRoutes(service: AgentService, payments?: MiniPaymentService): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/info", async (c) => {
    if (!service.managedKeysEnabled) return c.json({ error: "托管订阅未启用" }, 409);
    const userId = c.get("userId");
    const newApiUserId = await externalUserId(service, userId);
    if (newApiUserId == null) return c.json({ error: "订阅凭证不可用" }, 409);
    try {
      const mini = c.req.query("client") === "miniprogram" || c.req.header("X-Lot-Client") === "miniprogram";
      if (mini) return c.json(payments ? await payments.info(newApiUserId, c.req.query("platform") === "ios" ? "ios" : "other") : { enabled: false, offers: [], paymentMethods: [], amountDiscount: {} });
      return c.json(await service.tokenhub.getManagedRechargeInfo(newApiUserId));
    } catch (err) {
      logger.warn("managed recharge info failed", { userId, err });
      return c.json({ error: "支付方式加载失败" }, 502);
    }
  });

  app.get("/orders", async (c) => {
    if (!service.managedKeysEnabled) return c.json({ error: "托管订阅未启用" }, 409);
    const userId = c.get("userId");
    const newApiUserId = await externalUserId(service, userId);
    if (newApiUserId == null) return c.json({ error: "订阅凭证不可用" }, 409);
    const requestedPage = Number(c.req.query("page") ?? "1");
    const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 && requestedPage <= 1_000_000 ? requestedPage : 1;
    try {
      return c.json(await service.tokenhub.getManagedRechargeHistory(newApiUserId, page, 20));
    } catch (err) {
      logger.warn("managed recharge history failed", { userId, err });
      return c.json({ error: "充值明细加载失败" }, 502);
    }
  });

  app.post("/orders", async (c) => {
    if (!service.managedKeysEnabled) return c.json({ error: "托管订阅未启用" }, 409);
    let body: { points?: number; paymentMethod?: string; client?: string; wxCode?: string; platform?: string; expectedAmountFen?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "无效的充值请求" }, 400);
    }
    if (!body || typeof body !== "object") return c.json({ error: "无效的充值请求" }, 400);
    const points = body.points;
    if (typeof points !== "number" || !Number.isSafeInteger(points) || points < 1 || points > 10_000_000) {
      return c.json({ error: "充值积分必须是 1 到 10000000 之间的整数" }, 400);
    }
    const paymentMethod = typeof body.paymentMethod === "string" ? body.paymentMethod.trim() : "";
    if (!paymentMethod || paymentMethod.length > 50) {
      return c.json({ error: "请选择收款方式" }, 400);
    }
    const isMiniprogram = body.client === "miniprogram" || c.req.header("X-Lot-Client") === "miniprogram" || paymentMethod === "wxpay_virtual";
    if (isMiniprogram && paymentMethod !== "wxpay" && paymentMethod !== "wxpay_virtual") {
      return c.json({ error: "小程序端仅支持虚拟支付" }, 400);
    }
    const userId = c.get("userId");
    const user = await service.db.getUserById(userId);
    const newApiUserId = user?.external_user_id;
    if (newApiUserId == null) return c.json({ error: "订阅凭证不可用" }, 409);
    let openid: string | undefined;
    let sessionKey: string | undefined;
    if (isMiniprogram) {
      if (!wechatConfigured()) {
        return c.json({ error: "小程序支付未配置" }, 409);
      }
      const wxCode = typeof body.wxCode === "string" ? body.wxCode.trim() : "";
      if (!wxCode) {
        return c.json({ error: "缺少微信登录凭证" }, 400);
      }
      if (!Number.isSafeInteger(body.expectedAmountFen) || (body.expectedAmountFen ?? 0) <= 0) {
        return c.json({ error: "请刷新充值档位后重试" }, 400);
      }
      try {
        // The authenticated Agent account owns the recharge. This fresh WeChat
        // session identifies the payer and signs payment, independently of any
        // historical login binding. Never rebind or switch the credit recipient.
        const session = await exchangeWechatPaymentCode(wxCode);
        openid = session.openid;
        sessionKey = session.sessionKey;
      } catch (err) {
        logger.warn("miniprogram recharge openid exchange failed", { err });
        return c.json({ error: "微信登录凭证失效，请重试" }, 400);
      }
    }
    try {
      if (isMiniprogram && !payments) return c.json({ error: "小程序支付未配置" }, 409);
      const order = isMiniprogram
        ? await payments!.create({ userId, externalUserId: newApiUserId, points, openid: openid!,
          platform: body.platform === "ios" ? "ios" : "other", expectedAmountFen: body.expectedAmountFen! })
        : await service.tokenhub.createManagedRechargeOrder({ userId: newApiUserId, points, paymentMethod });
      if (isMiniprogram) {
        if (order.paymentKind !== "virtual" || !order.virtualPay?.paySig || !order.virtualPay.signData || !sessionKey) {
          return c.json({ error: "虚拟支付参数不可用，请稍后重试" }, 502);
        }
        order.virtualPay.signature = createHmac("sha256", sessionKey).update(order.virtualPay.signData).digest("hex");
      }
      return c.json(order);
    } catch (err) {
      if (err instanceof Error && err.message === "virtual_payment_quote_changed") {
        return c.json({ error: "充值价格已更新，请刷新档位后重试" }, 409);
      }
      logger.warn("managed recharge order creation failed", { userId, err });
      return c.json({ error: "支付订单创建失败" }, 502);
    }
  });

  app.get("/orders/:transactionId", async (c) => {
    if (!service.managedKeysEnabled) return c.json({ error: "托管订阅未启用" }, 409);
    const userId = c.get("userId");
    const newApiUserId = await externalUserId(service, userId);
    if (newApiUserId == null) return c.json({ error: "订阅凭证不可用" }, 409);
    const transactionId = c.req.param("transactionId").trim();
    if (!transactionId || transactionId.length > 128) return c.json({ error: "无效的充值订单号" }, 400);
    try {
      if (transactionId.startsWith("LV")) {
        const order = await payments?.status(userId, transactionId);
        return order ? c.json(order) : c.json({ error: "充值订单不存在" }, 404);
      }
      return c.json(await service.tokenhub.getManagedRechargeOrder(
        newApiUserId,
        transactionId
      ));
    } catch (err) {
      logger.warn("managed recharge order status failed", {
        userId,
        transactionId,
        err,
      });
      return c.json({ error: "充值订单查询失败" }, 502);
    }
  });

  return app;
}
