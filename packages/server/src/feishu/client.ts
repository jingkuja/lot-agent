export interface FeishuConfig { appId: string; appSecret: string; }
export const FEISHU_SCOPES = ["im:message", "im:message.send_as_user", "offline_access"];

export function loadFeishuConfig(env = process.env): FeishuConfig | null {
  if (!env.SECRET_MASTER_KEY || env.FEISHU_ENABLED === "0") return null;
  if (!env.FEISHU_APP_ID && !env.FEISHU_APP_SECRET) return { appId: "", appSecret: "" };
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error("Legacy Feishu app credentials must be configured together");
  return { appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET };
}

export class FeishuError extends Error {
  constructor(public readonly kind: "permission" | "auth" | "rejected" | "unknown" | "verification") {
    super({ permission: "飞书权限不足，请重新授权；若仍失败请联系企业管理员", auth: "飞书授权已失效，请重新连接",
      rejected: "飞书拒绝了请求，请检查收件人和应用权限", unknown: "发送结果暂时无法确认，请先在飞书核实，勿重复发送",
      verification: "绑定验证码无效或已过期，请检查飞书私聊后重试" }[kind]);
  }
}

export interface OAuthTokens { access_token: string; refresh_token?: string; expires_in: number; scope?: string; }

/** Fixed official origin; no caller-controlled URLs, redirects, or automatic write retries. */
export class FeishuClient {
  constructor(readonly config: FeishuConfig, private readonly fetcher: typeof fetch = fetch) {}
  forApp(appId: string, appSecret: string) { return new FeishuClient({ appId, appSecret }, this.fetcher); }
  private async call(path: string, body?: unknown, token?: string, signal?: AbortSignal): Promise<any> {
    let response: Response;
    try {
      response = await this.fetcher(`https://open.feishu.cn/open-apis/${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new FeishuError("unknown"); }
    let value: any;
    try { value = await response.json(); } catch { throw new FeishuError("unknown"); }
    if (response.status === 401 || [99991663,99991668,99991671,99991677].includes(value.code)) throw new FeishuError("auth");
    if (response.status === 403 || [99991672,99991679,230027].includes(value.code)) throw new FeishuError("permission");
    if (response.status >= 500) throw new FeishuError("unknown");
    if (!response.ok || (value.code !== undefined && value.code !== 0) || value.error) throw new FeishuError("rejected");
    return value;
  }
  async tokens(grant: { refresh_token: string }): Promise<OAuthTokens> {
    const result = await this.call("authen/v2/oauth/token", {
      client_id: this.config.appId, client_secret: this.config.appSecret,
      grant_type: "refresh_token", ...grant,
    });
    if (typeof result.access_token !== "string" || !result.access_token || !(result.expires_in > 0)) throw new FeishuError("auth");
    return result;
  }
  async profile(token: string): Promise<{ open_id: string; tenant_key: string; name: string }> {
    const { data } = await this.call("authen/v1/user_info", undefined, token);
    if (!data?.open_id || !data.tenant_key) throw new FeishuError("auth");
    return { open_id: data.open_id, tenant_key: data.tenant_key, name: data.name ?? data.open_id };
  }
  async send(token: string, target: string, text: string, uuid: string, reply = false, signal?: AbortSignal): Promise<string> {
    const path = reply ? `im/v1/messages/${encodeURIComponent(target)}/reply` : "im/v1/messages?receive_id_type=open_id";
    const result = await this.call(path, {
      ...(reply ? {} : { receive_id: target }), msg_type: "text", content: JSON.stringify({ text }), uuid,
    }, token, signal);
    if (typeof result.data?.message_id !== "string") throw new FeishuError("unknown");
    return result.data.message_id;
  }
  async botSend(target: string, text: string, uuid: string, reply = false, signal?: AbortSignal) {
    const auth = await this.call("auth/v3/tenant_access_token/internal", {
      app_id: this.config.appId, app_secret: this.config.appSecret,
    }, undefined, signal);
    if (!auth.tenant_access_token) throw new FeishuError("auth");
    return this.send(auth.tenant_access_token, target, text, uuid, reply, signal);
  }
  botReply(messageId: string, text: string, uuid: string, signal?: AbortSignal) { return this.botSend(messageId, text, uuid, true, signal); }
}
