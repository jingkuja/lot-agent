import { Hono } from "hono";
import { FeishuError } from "./client.js";
import { FeishuService } from "./service.js";

export function createFeishuRoutes(service: FeishuService | null, onDisconnect: (userId: string) => void = () => {}, connectionStatus: (appId?: string) => string = () => "disabled") {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.onError((error, c) => c.json({ error: error instanceof FeishuError ? error.message : "飞书请求失败，请稍后查看连接状态" }, 400));
  app.use("*", async (c,next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.get("/status", async c => {
    if (!service) return c.json({ configured:false,connected:false,canSendAsUser:false,account:null,contacts:[],recent:[] });
    const status = await service.status(c.get("userId"));
    return c.json({ ...status,messageConnection:connectionStatus(status.appId) });
  });
  app.use("*", async (c, next) => service ? next() : c.json({ error: "服务端尚未配置飞书接入" }, 503));
  app.post("/authorize", async c => c.json(await service!.begin(c.get("userId"))));
  app.post("/setup/:id/poll", async c => {
    if (!/^[0-9a-f-]{36}$/i.test(c.req.param("id"))) return c.json({ error:"Invalid setup" },400);
    return c.json(await service!.poll(c.get("userId"),c.req.param("id")));
  });
  app.post("/setup/:id/confirm", async c => {
    const body = await c.req.json().catch(() => null);
    if (!/^[0-9a-f-]{36}$/i.test(c.req.param("id")) || !body || typeof body.code !== "string" || !/^\d{6}$/.test(body.code)) return c.json({ error:"请输入六位绑定验证码" },400);
    return c.json(await service!.confirm(c.get("userId"),c.req.param("id"),body.code));
  });
  app.delete("/connection", async c => {
    onDisconnect(c.get("userId"));
    await service!.disconnect(c.get("userId"));
    return c.json({ ok: true });
  });
  app.post("/contacts", async c => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.alias !== "string" || !/^[^\s：:]{1,40}$/u.test(body.alias)
      || typeof body.openId !== "string" || !/^ou_[\w-]{1,100}$/.test(body.openId)) return c.json({ error: "请输入联系人别名和有效的飞书用户 ID" }, 400);
    if (!(await service!.status(c.get("userId"))).connected) return c.json({ error: "请先连接飞书" }, 409);
    await service!.repository.saveContact(c.get("userId"), body.alias, body.openId);
    return c.json({ ok: true });
  });
  app.delete("/contacts/:alias", async c => {
    await service!.repository.deleteContact(c.get("userId"), c.req.param("alias"));
    return c.json({ ok: true });
  });
  app.post("/messages", async c => {
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b.recipient !== "string" || !b.recipient.trim() || b.recipient.length > 120
      || typeof b.text !== "string" || !b.text.trim() || Buffer.byteLength(b.text) > 12_000
      || typeof b.requestId !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(b.requestId)
      || (b.reply !== undefined && typeof b.reply !== "boolean")) return c.json({ error: "消息参数无效" }, 400);
    return c.json(await service!.send(c.get("userId"), { recipient: b.recipient.trim(), text: b.text, requestId: b.requestId, reply: b.reply },undefined,c.req.raw.signal));
  });
  return app;
}

/** Retire all transferable OAuth tickets, including bookmarks created by v1. */
export function createFeishuPublicRoutes(_service: FeishuService | null) {
  const app = new Hono();
  app.all("*", c => { c.header("Cache-Control", "no-store"); return c.text("此授权链接已停用，请从 Lot Agent 的飞书接入页面重新连接。",410); });
  return app;
}
