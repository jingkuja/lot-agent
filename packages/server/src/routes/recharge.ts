import { Hono } from "hono";
import { logger } from "@lot-agent/core";
import type { AgentService } from "../services/agent-service.js";
import { exchangeWechatCode, wechatConfigured } from "../auth/wechat.js";

type Variables = { userId: string };

async function externalUserId(service: AgentService, userId: string): Promise<number | null> {
  const user = await service.db.getUserById(userId);
  return user?.external_user_id ?? null;
}

export function createRechargeRoutes(service: AgentService): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/info", async (c) => {
    if (!service.managedKeysEnabled) return c.json({ error: "托管订阅未启用" }, 409);
    const userId = c.get("userId");
    const newApiUserId = await externalUserId(service, userId);
    if (newApiUserId == null) return c.json({ error: "订阅凭证不可用" }, 409);
    try {
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
    let body: { points?: number; paymentMethod?: string; client?: string; wxCode?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "无效的充值请求" }, 400);
    }
    const points = body.points;
    if (typeof points !== "number" || !Number.isSafeInteger(points) || points < 1 || points > 10_000_000) {
      return c.json({ error: "充值积分必须是 1 到 10000000 之间的整数" }, 400);
    }
    const paymentMethod = body.paymentMethod?.trim();
    if (!paymentMethod || paymentMethod.length > 50) {
      return c.json({ error: "请选择收款方式" }, 400);
    }
    const client = body.client?.trim();
    const isMiniprogram = client === "miniprogram";
    if (isMiniprogram && paymentMethod !== "wxpay") {
      return c.json({ error: "小程序端仅支持微信支付" }, 400);
    }
    // 小程序 JSAPI 支付需要付款人 openid，用 wx.login() 下发的临时 code 现换。
    let openid: string | undefined;
    if (isMiniprogram) {
      if (!wechatConfigured()) {
        return c.json({ error: "小程序支付未配置" }, 409);
      }
      const wxCode = body.wxCode?.trim();
      if (!wxCode) {
        return c.json({ error: "缺少微信登录凭证" }, 400);
      }
      try {
        const session = await exchangeWechatCode(wxCode);
        openid = session.openid;
      } catch (err) {
        logger.warn("miniprogram recharge openid exchange failed", { err });
        return c.json({ error: "微信登录凭证失效，请重试" }, 400);
      }
    }
    const userId = c.get("userId");
    const newApiUserId = await externalUserId(service, userId);
    if (newApiUserId == null) return c.json({ error: "订阅凭证不可用" }, 409);
    try {
      return c.json(await service.tokenhub.createManagedRechargeOrder({
        userId: newApiUserId,
        points,
        paymentMethod,
        ...(isMiniprogram ? { client: "miniprogram", openid } : {}),
      }));
    } catch (err) {
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
