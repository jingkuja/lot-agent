import { Hono } from "hono";
import { logger } from "@lot-agent/core";
import type { AgentService } from "../services/agent-service.js";

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

  app.post("/orders", async (c) => {
    if (!service.managedKeysEnabled) return c.json({ error: "托管订阅未启用" }, 409);
    let body: { points?: number; paymentMethod?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "无效的充值请求" }, 400);
    }
    const points = body.points;
    if (typeof points !== "number" || !Number.isSafeInteger(points) || points < 100 || points > 10_000_000 || points % 100 !== 0) {
      return c.json({ error: "充值积分必须是 100 到 10000000 之间的 100 整数倍" }, 400);
    }
    const paymentMethod = body.paymentMethod?.trim();
    if (!paymentMethod || paymentMethod.length > 50) {
      return c.json({ error: "请选择收款方式" }, 400);
    }
    const userId = c.get("userId");
    const newApiUserId = await externalUserId(service, userId);
    if (newApiUserId == null) return c.json({ error: "订阅凭证不可用" }, 409);
    try {
      return c.json(await service.tokenhub.createManagedRechargeOrder({
        userId: newApiUserId,
        points,
        paymentMethod,
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
