export interface FeishuAppCredentials { appId: string; appSecret: string; }
export const FEISHU_USER_SCOPES = ["im:message", "im:message.send_as_user", "contact:user:search"];
export const FEISHU_SCOPES = [...FEISHU_USER_SCOPES, "offline_access"];
export interface ContactSearchInput { query?: string; hasChatted?: boolean; pageSize?: number; pageToken?: string; }
export interface FeishuContact { openId: string; name: string; email: string; enterpriseEmail: string; displayInfo: string; hasChatted: boolean; isExternal: boolean; }
export interface ContactSearchResult { users: FeishuContact[]; hasMore: boolean; pageToken?: string; }

export function isFeishuEnabled(env = process.env): boolean {
  return !!env.SECRET_MASTER_KEY && env.FEISHU_ENABLED !== "0";
}

export class FeishuError extends Error {
  constructor(public readonly kind: "permission" | "auth" | "rejected" | "unknown" | "verification" | "contact_permission" | "search_failed" | "bot_unavailable" | "bot_auth", public readonly apiCode?: number, botAppId?: string) {
    super(({ contact_permission: "飞书联系人搜索尚未授权，请重新授权；若仍失败，请由管理员开通搜索用户权限", search_failed: "飞书联系人查询失败，请稍后重试", permission: "飞书权限不足，请重新授权；若仍失败请联系企业管理员", auth: "飞书授权已失效，请重新连接",
      rejected: apiCode === 230038 ? "飞书不允许通过此接口向跨租户外部联系人发送单聊消息。此请求已被拒绝，未发送成功；重新授权或改用姓名不能解除该接口限制，也不会自动改用机器人身份发送" : "飞书拒绝了请求，请检查收件人和应用权限", unknown: "发送结果暂时无法确认，请先在飞书核实，勿重复发送",
      verification: "绑定验证码无效或已过期，请检查飞书私聊后重试",
      bot_unavailable: "机器人无法向此收件人发送消息，消息未发送成功。请检查应用已发布对外共享和外部用户单聊，且收件人已打开机器人并确认开启单聊（如需审核，应先由应用所有者通过）；同时检查应用可用范围和禁用名单。无需反复进行用户 OAuth 授权",
      bot_auth: "机器人凭据获取失败，尚未提交消息。请检查机器人应用配置或网络连接",
    }[kind]) + (Number.isSafeInteger(apiCode) ? `（错误码：${apiCode}）` : "")
      + (kind === "bot_unavailable" && botAppId ? `\n收件人首次开启机器人单聊的入口：https://applink.feishu.cn/client/bot/open?appId=${encodeURIComponent(botAppId)}\n完成启用后，可在对话中要求机器人自动发送，无需手动填写消息表单。` : ""));
  }
}

export interface OAuthTokens { access_token: string; refresh_token?: string; expires_in: number; scope?: string; }

/** Fixed official origin; no caller-controlled URLs, redirects, or automatic write retries. */
export class FeishuClient {
  constructor(readonly config: FeishuAppCredentials, private readonly fetcher: typeof fetch = fetch) {}
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
    const code = Number.isSafeInteger(value.code) ? value.code : undefined;
    if (response.status === 401 || [99991663,99991668,99991671,99991677].includes(code)) throw new FeishuError("auth", code);
    if (response.status === 403 || [99991672,99991679,230027].includes(code)) throw new FeishuError("permission", code);
    if (response.status >= 500) throw new FeishuError("unknown", code);
    if (!response.ok || (value.code !== undefined && value.code !== 0) || value.error) throw new FeishuError("rejected", code);
    return value;
  }
  async profile(token: string): Promise<{ open_id: string; tenant_key: string; name: string }> {
    const { data } = await this.call("authen/v1/user_info", undefined, token);
    if (!data?.open_id || !data.tenant_key) throw new FeishuError("auth");
    return { open_id: data.open_id, tenant_key: data.tenant_key, name: data.name ?? data.open_id };
  }
  /** Official contact/v3 search, including visible external contacts; user identity only. */
  async searchContacts(token: string, input: ContactSearchInput, signal?: AbortSignal): Promise<ContactSearchResult> {
    const params = new URLSearchParams({ page_size: String(input.pageSize ?? 20) });
    if (input.pageToken) params.set("page_token", input.pageToken);
    try {
      const { data } = await this.call(`contact/v3/users/search?${params}`, {
        ...(input.query ? { query: input.query } : {}),
        ...(input.hasChatted || !input.query ? { filter: { has_contact: true } } : {}),
      }, token, signal);
      if (!Array.isArray(data?.items) || typeof data.has_more !== "boolean") throw new FeishuError("search_failed");
      const users: FeishuContact[] = data.items.map((item: any) => {
        if (typeof item?.id !== "string" || !/^ou_[\w-]+$/.test(item.id)) throw new FeishuError("search_failed");
        const meta = item.meta_data ?? {};
        const str = (v: unknown) => typeof v === "string" ? v : "";
        return { openId: item.id, name: str(meta.i18n_names?.zh_cn) || str(meta.i18n_names?.en_us) || item.id,
          email: str(meta.mail_address), enterpriseEmail: str(meta.enterprise_mail_address),
          displayInfo: str(item.display_info).replace(/<[^>]*>/g, ""), hasChatted: !!str(meta.chat_id), isExternal: meta.is_cross_tenant === true };
      });
      return { users, hasMore: data.has_more, ...(typeof data.page_token === "string" ? { pageToken: data.page_token } : {}) };
    } catch (error) {
      if (error instanceof FeishuError && error.kind === "permission") throw new FeishuError("contact_permission", error.apiCode);
      if (error instanceof FeishuError && error.kind === "auth") throw error;
      throw new FeishuError("search_failed", error instanceof FeishuError ? error.apiCode : undefined);
    }
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
    let token: string;
    try {
      const auth = await this.call("auth/v3/tenant_access_token/internal", {
        app_id: this.config.appId, app_secret: this.config.appSecret,
      }, undefined, signal);
      if (typeof auth.tenant_access_token !== "string" || !auth.tenant_access_token) throw new FeishuError("auth");
      token = auth.tenant_access_token;
    } catch (error) {
      // This is before message dispatch, so a lost token response cannot mean a sent message.
      throw new FeishuError("bot_auth", error instanceof FeishuError ? error.apiCode : undefined);
    }
    try { return await this.send(token, target, text, uuid, reply, signal); }
    catch (error) {
      if (error instanceof FeishuError && [230013, 230038].includes(error.apiCode ?? 0)) throw new FeishuError("bot_unavailable", error.apiCode, this.config.appId);
      throw error;
    }
  }
  botReply(messageId: string, text: string, uuid: string, signal?: AbortSignal) { return this.botSend(messageId, text, uuid, true, signal); }
}
