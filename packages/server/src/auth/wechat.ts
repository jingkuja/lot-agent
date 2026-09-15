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

export interface PhoneMergeTicket {
  phone: string;
  fromExternalUserId: number;
  fromLocalUserId: string;
}

const phoneMergeTickets = new Map<string, { value: PhoneMergeTicket; expiresAt: number }>();

export function issuePhoneMergeTicket(ticket: PhoneMergeTicket): string {
  const id = randomUUID();
  phoneMergeTickets.set(id, { value: ticket, expiresAt: Date.now() + TICKET_TTL_MS });
  return id;
}

export function peekPhoneMergeTicket(id: string): PhoneMergeTicket | null {
  const row = phoneMergeTickets.get(id);
  if (!row || row.expiresAt < Date.now()) {
    if (row) phoneMergeTickets.delete(id);
    return null;
  }
  return row.value;
}

export function consumePhoneMergeTicket(id: string): PhoneMergeTicket | null {
  const value = peekPhoneMergeTicket(id);
  if (!value) return null;
  phoneMergeTickets.delete(id);
  return value;
}

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

export function clearWechatAccessTokenCache(): void {
  cachedAccessToken = null;
}

export async function getWechatAccessToken(): Promise<string> {
  const appid = process.env.WECHAT_MP_APPID?.trim();
  const secret = process.env.WECHAT_MP_SECRET?.trim();
  if (!appid || !secret) {
    throw new Error("wechat mini program is not configured");
  }
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now()) {
    return cachedAccessToken.token;
  }
  const url =
    `https://api.weixin.qq.com/cgi-bin/token` +
    `?grant_type=client_credential` +
    `&appid=${encodeURIComponent(appid)}` +
    `&secret=${encodeURIComponent(secret)}`;
  const res = await fetch(url);
  let body: { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new Error("wechat access token exchange failed");
  }
  if (!res.ok || body.errcode || !body.access_token) {
    logger.warn("wechat access token failed", { status: res.status, errcode: body.errcode });
    throw new Error("wechat access token exchange failed");
  }
  const ttlMs = Math.max(60, (body.expires_in ?? 7200) - 300) * 1000;
  cachedAccessToken = { token: body.access_token, expiresAt: Date.now() + ttlMs };
  return body.access_token;
}

export async function exchangeWechatPhoneCode(code: string): Promise<string> {
  const token = await getWechatAccessToken();
  const res = await fetch(
    `https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    }
  );
  let body: {
    errcode?: number;
    errmsg?: string;
    phone_info?: { purePhoneNumber?: string; phoneNumber?: string; countryCode?: string };
  } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new Error("wechat phone exchange failed");
  }
  if (body.errcode === 40001) {
    clearWechatAccessTokenCache();
  }
  const phone = body.phone_info?.purePhoneNumber || body.phone_info?.phoneNumber || "";
  if (!res.ok || body.errcode || !phone) {
    logger.warn("wechat getuserphonenumber failed", { status: res.status, errcode: body.errcode });
    throw new Error("wechat phone exchange failed");
  }
  return phone;
}
