import { randomUUID } from "node:crypto";
import { logger } from "@lot-agent/core";

export interface WechatSession {
  openid: string;
  unionid?: string;
}

const TICKET_TTL_MS = 10 * 60 * 1000;
const tickets = new Map<string, { value: WechatSession; expiresAt: number }>();

export function wechatConfigured(): boolean {
  return Boolean(process.env.WECHAT_MP_APPID?.trim() && process.env.WECHAT_MP_SECRET?.trim());
}

export async function exchangeWechatCode(code: string): Promise<WechatSession> {
  const appid = process.env.WECHAT_MP_APPID?.trim();
  const secret = process.env.WECHAT_MP_SECRET?.trim();
  if (!appid || !secret) {
    throw new Error("wechat mini program is not configured");
  }
  const url =
    `https://api.weixin.qq.com/sns/jscode2session` +
    `?appid=${encodeURIComponent(appid)}` +
    `&secret=${encodeURIComponent(secret)}` +
    `&js_code=${encodeURIComponent(code)}` +
    `&grant_type=authorization_code`;
  const res = await fetch(url);
  let body: { openid?: string; unionid?: string; errcode?: number; errmsg?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new Error("wechat session exchange failed");
  }
  if (!res.ok || body.errcode || !body.openid) {
    logger.warn("wechat jscode2session failed", {
      status: res.status,
      errcode: body.errcode,
    });
    throw new Error("wechat session exchange failed");
  }
  return { openid: body.openid, unionid: body.unionid || undefined };
}

export function issueWechatTicket(session: WechatSession): string {
  const id = randomUUID();
  tickets.set(id, { value: session, expiresAt: Date.now() + TICKET_TTL_MS });
  return id;
}

export function consumeWechatTicket(id: string): WechatSession | null {
  const row = tickets.get(id);
  if (!row) return null;
  tickets.delete(id);
  if (row.expiresAt < Date.now()) return null;
  return row.value;
}
