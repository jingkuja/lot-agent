import { FeishuError, type OAuthTokens } from "./client.js";
import { gzipSync } from "node:zlib";

const ACCOUNTS = "https://accounts.feishu.cn";
const REGISTRATION = "/oauth/v1/app/registration";
export interface DeviceGrant { deviceCode: string; url: string; expiresIn: number; interval: number; }
export type Registration = { appId: string; appSecret: string; openId: string };
export type PollResult<T> = { value: T } | { pending: true; slowDown: boolean };

function positive(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.ceil(value), max) : fallback;
}
function required(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 8192) throw new FeishuError("auth");
  return value;
}
export function officialVerificationUrl(value: unknown): string {
  const url = new URL(required(value));
  if (url.protocol !== "https:" || !["open.feishu.cn", "accounts.feishu.cn"].includes(url.hostname)
    || url.port || url.username || url.password) throw new FeishuError("auth");
  return url.href;
}

/** Implements the official CLI's PersonalAgent registration + OAuth device flow.
 * https://github.com/larksuite/cli/blob/main/internal/auth/app_registration.go
 * No external QR service, caller-controlled host, redirects, or write retries.
 */
export class FeishuOnboardingClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  private async form(path: string, values: Record<string, string>, basic?: string): Promise<any> {
    let response: Response;
    try {
      response = await this.fetcher(`${ACCOUNTS}${path}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...(basic ? { Authorization: `Basic ${basic}` } : {}) },
        body: new URLSearchParams(values).toString(),
      });
      const data: any = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new FeishuError("unknown");
      if (data.error === "authorization_pending" || data.error === "slow_down") return data;
      if (response.status >= 500) throw new FeishuError("unknown");
      if (!response.ok || data.error || (data.code !== undefined && data.code !== 0)) throw new FeishuError("auth");
      return data;
    } catch (error) { throw error instanceof FeishuError ? error : new FeishuError("unknown"); }
  }
  async register(): Promise<DeviceGrant> {
    const data = await this.form(REGISTRATION, { action: "begin", archetype: "PersonalAgent", auth_method: "client_secret", request_user_info: "open_id tenant_brand" });
    // Match registerApp/encodeAddons in the official Node SDK. The robot page
    // configures required permissions and subscriptions; the CLI page alone does not.
    const url = new URL(officialVerificationUrl(data.verification_uri_complete));
    url.searchParams.set("from", "sdk");
    url.searchParams.set("source", "node-sdk/lot-agent");
    url.searchParams.set("tp", "sdk");
    url.searchParams.set("createOnly", "true");
    url.searchParams.set("name", "Lot Agent");
    url.searchParams.set("desc", "在飞书中使用你的 Lot Agent 助手");
    url.searchParams.set("addons", gzipSync(Buffer.from(JSON.stringify({
      preset: false,
      scopes: { tenant: ["im:message:send_as_bot", "im:message.p2p_msg:readonly"], user: ["im:message", "im:message.send_as_user"] },
      events: { items: { tenant: ["im.message.receive_v1"] } },
    }))).toString("base64url"));
    return {
      deviceCode: required(data.device_code),
      url: url.href,
      expiresIn: positive(data.expire_in ?? data.expires_in, 600, 1800), interval: positive(data.interval, 5, 60),
    };
  }
  async pollRegistration(code: string): Promise<PollResult<Registration>> {
    const data = await this.form(REGISTRATION, { action: "poll", device_code: code });
    // This integration is Feishu-only. Never send credentials to a host reported by the remote response.
    if (data.user_info?.tenant_brand && data.user_info.tenant_brand !== "feishu") throw new FeishuError("auth");
    if (data.error || !data.client_id || !data.client_secret) return { pending: true, slowDown: data.error === "slow_down" };
    return { value: { appId: required(data.client_id), appSecret: required(data.client_secret), openId: required(data.user_info?.open_id) } };
  }
  async authorize(appId: string, appSecret: string, scopes: string[]): Promise<DeviceGrant> {
    const data = await this.form("/oauth/v1/device_authorization", { client_id: appId, scope: scopes.join(" ") }, Buffer.from(`${appId}:${appSecret}`).toString("base64"));
    return { deviceCode: required(data.device_code), url: officialVerificationUrl(data.verification_uri_complete ?? data.verification_uri),
      expiresIn: positive(data.expires_in, 240, 1800), interval: positive(data.interval, 5, 60) };
  }
  async pollAuthorization(appId: string, appSecret: string, deviceCode: string): Promise<PollResult<OAuthTokens>> {
    const data = await this.form("/oauth/v3/token", { client_id: appId, client_secret: appSecret, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
    if (data.error) return { pending: true, slowDown: data.error === "slow_down" };
    if (data.token_type && data.token_type.toLowerCase() !== "bearer") throw new FeishuError("auth");
    required(data.access_token);
    if (!(data.expires_in > 0)) throw new FeishuError("auth");
    return { value: data };
  }
  async refresh(appId: string, appSecret: string, refreshToken: string): Promise<OAuthTokens> {
    const data = await this.form("/oauth/v3/token", { client_id: appId, client_secret: appSecret, refresh_token: refreshToken, grant_type: "refresh_token" });
    if (data.error || (data.token_type && data.token_type.toLowerCase() !== "bearer")) throw new FeishuError("auth");
    required(data.access_token);
    if (!(data.expires_in > 0)) throw new FeishuError("auth");
    return data;
  }
}
