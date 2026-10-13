import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { FeishuConnection, FeishuRepository, FeishuUserStore, FeishuSetup, FeishuInboxJob } from "@lot-agent/core";
import { SecretBox } from "../auth/secret-box.js";
import { FeishuClient, FeishuError, FEISHU_SCOPES, type ContactSearchInput } from "./client.js";
import { FeishuOnboardingClient, type DeviceGrant, type Registration } from "./onboarding-client.js";

export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
interface SetupData {
  grant?: DeviceGrant;
  app?: Registration;
  connection?: FeishuConnection;
  confirmationHash?: string;
  deliveryUnknown?: boolean;
}
export class FeishuService {
  constructor(readonly repository: FeishuRepository, private readonly secrets: SecretBox,
    private readonly onboarding = new FeishuOnboardingClient(), private readonly fetcher: typeof fetch = fetch) {
    if (!secrets.enabled) throw new Error("Feishu requires encrypted token storage");
  }
  connectionClient(c: FeishuConnection) {
    if (!c.app_secret) throw new FeishuError("auth");
    const secret = this.secrets.open(c.app_secret);
    if (!secret) throw new FeishuError("auth");
    return new FeishuClient({ appId: c.app_id, appSecret: secret }, this.fetcher);
  }
  private view(s: FeishuSetup | null) {
    if (!s) return null;
    const expired = s.phase !== "complete" && s.expires_at <= Date.now();
    const data: SetupData = JSON.parse(this.secrets.open(s.data));
    return { id:s.id, phase:expired ? "expired" : s.phase,
      url:!expired && ["registration","authorization"].includes(s.phase) ? data.grant?.url : undefined,
      expiresAt:s.expires_at, pollAfter:s.poll_after, deliveryUnknown:data.deliveryUnknown === true };
  }
  async begin(userId: string) {
    return this.repository.withUser(userId, async store => {
      const previous = await store.setup();
      if (previous && previous.expires_at > Date.now() && !["complete","failed"].includes(previous.phase)) return this.view(previous);
      const c = await store.connection();
      const previousData: SetupData | undefined = previous ? JSON.parse(this.secrets.open(previous.data)) : undefined;
      const app = c ? { appId:c.app_id,appSecret:this.connectionClient(c).config.appSecret,openId:c.open_id } : previousData?.app;
      const grant = app ? await this.onboarding.authorize(app.appId,app.appSecret,FEISHU_SCOPES) : await this.onboarding.register();
      const now = Date.now();
      const setup: FeishuSetup = { id:randomUUID(),user_id:userId,phase:app ? "authorization" : "registration",
        data:this.secrets.seal(JSON.stringify({ app,grant })), expires_at:now+grant.expiresIn*1000,
        interval:grant.interval,poll_after:now+grant.interval*1000,attempts:0 };
      await store.saveSetup(setup);
      return this.view(setup);
    });
  }
  async poll(userId: string, id: string) {
    // Only an authenticated owner can poll. Device codes and app secrets never leave the server.
    const result = await this.repository.withUser(userId, async store => {
      const s = await store.setup();
      if (!s || s.id !== id) throw new FeishuError("auth");
      if (s.expires_at <= Date.now() || s.poll_after > Date.now() || !["registration","authorization"].includes(s.phase)) return { view:this.view(s) };
      const data: SetupData = JSON.parse(this.secrets.open(s.data));
      try {
        if (s.phase === "registration") {
          const registered = await this.onboarding.pollRegistration(data.grant!.deviceCode);
          if ("pending" in registered) {
            if (registered.slowDown) s.interval = Math.min(60,s.interval+5);
          } else {
            data.app = registered.value;
            // Preserve returned app credentials even if the next authorization request fails.
            data.grant = undefined;
            s.data = this.secrets.seal(JSON.stringify(data));
            await store.saveSetup(s);
            data.grant = await this.onboarding.authorize(data.app.appId,data.app.appSecret,FEISHU_SCOPES);
            s.phase = "authorization";
            s.interval = data.grant.interval;
            s.expires_at = Date.now()+data.grant.expiresIn*1000;
          }
        } else {
          const app = data.app!;
          const authorized = await this.onboarding.pollAuthorization(app.appId,app.appSecret,data.grant!.deviceCode);
          if ("pending" in authorized) {
            if (authorized.slowDown) s.interval = Math.min(60,s.interval+5);
          } else {
            const tokens = authorized.value;
            const profile = await new FeishuClient(app, this.fetcher).profile(tokens.access_token);
            if (profile.open_id !== app.openId) throw new FeishuError("auth");
            const connection: FeishuConnection = { user_id:userId,app_id:app.appId,app_secret:this.secrets.seal(app.appSecret),...profile,
              access_token:this.secrets.seal(tokens.access_token),refresh_token:this.secrets.seal(tokens.refresh_token ?? ""),
              expires_at:Date.now()+tokens.expires_in*1000,scopes:(tokens.scope ?? "").split(/\s+/).filter(Boolean),revision:randomUUID() };
            const code = randomInt(0,1_000_000).toString().padStart(6,"0");
            data.connection = connection;
            data.confirmationHash = hash(`${s.id}:${code}`);
            data.grant = undefined;
            s.phase = "verification";
            s.expires_at = Date.now()+600_000;
            s.data = this.secrets.seal(JSON.stringify(data));
            await store.saveSetup(s);
            return { view:this.view(s),challenge:{ code,connection,id:s.id } };
          }
        }
        s.poll_after = Date.now()+s.interval*1000;
      } catch {
        s.phase = "failed";
      }
      s.data = this.secrets.seal(JSON.stringify(data));
      await store.saveSetup(s);
      return { view:this.view(s) };
    });
    if (result.challenge) {
      const { code,connection,id:setupId } = result.challenge;
      // Persisted challenge BEFORE the single external write. Polling never re-sends it.
      try {
        await this.connectionClient(connection).botSend(connection.open_id,
          `Lot Agent 绑定验证码：${code}\n请在你自己已登录的 Lot Agent「飞书接入」页面输入，10 分钟内有效。不要把验证码发给他人；未主动连接请忽略。`,hash(`pair:${setupId}`).slice(0,40));
      } catch {
        await this.repository.withUser(userId, async store => {
          const s = await store.setup();
          if (!s || s.id !== setupId || s.phase !== "verification") return;
          const data: SetupData = JSON.parse(this.secrets.open(s.data));
          data.deliveryUnknown = true; s.data = this.secrets.seal(JSON.stringify(data)); await store.saveSetup(s);
        });
        result.view = { ...result.view!,deliveryUnknown:true };
      }
    }
    return result.view;
  }
  async confirm(userId: string, id: string, code: string) {
    const ok = await this.repository.withUser(userId, async store => {
      const s = await store.setup();
      if (!s || s.id !== id || s.phase !== "verification" || s.expires_at <= Date.now() || s.attempts >= 5) return false;
      const data: SetupData = JSON.parse(this.secrets.open(s.data));
      s.attempts++;
      const expected = Buffer.from(data.confirmationHash ?? "");
      const actual = Buffer.from(hash(`${s.id}:${code}`));
      if (expected.length !== actual.length || !timingSafeEqual(expected,actual) || !data.connection) {
        if (s.attempts >= 5) s.phase = "failed";
        await store.saveSetup(s); return false;
      }
      // Disconnect also invalidates queued/running work from the previous identity.
      const previous = await store.connection();
      const sameIdentity = previous?.app_id === data.connection.app_id && previous?.tenant_key === data.connection.tenant_key && previous?.open_id === data.connection.open_id;
      await store.disconnect(sameIdentity);
      await store.saveConnection(data.connection);
      await store.conversation();
      s.phase = "complete"; s.data = this.secrets.seal("{}"); await store.saveSetup(s);
      return true;
    });
    if (!ok) throw new FeishuError("verification");
    return { ok:true };
  }
  async status(userId: string) {
    const { c,s } = await this.repository.withUser(userId, async store => ({ c:await store.connection(),s:await store.setup() }));
    return { configured:true,connected:!!c, appId:c?.app_id,
      account:c ? { name:c.name,openId:c.open_id } : null,
      canSendAsUser:!!c && ["im:message","im:message.send_as_user"].every(scope => c.scopes.includes(scope)),
      canSearchContacts: !!c && c.scopes.includes("contact:user:search"),
      needsReauthorization:!!c && c.expires_at <= Date.now() && !this.secrets.open(c.refresh_token),
      setup:this.view(s),contacts:await this.repository.contacts(userId),recent:await this.repository.recent(userId) };
  }
  async searchContacts(userId: string, input: ContactSearchInput, revision?: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if ((input.query !== undefined && (!input.query.trim() || [...input.query].length > 50))
      || (input.pageSize !== undefined && (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 30))
      || (input.pageToken !== undefined && input.pageToken.length > 2048)) throw new FeishuError("search_failed");
    const staged = await this.repository.withUser(userId, async store => {
      const c = await store.connection();
      if (!c || (revision && c.revision !== revision)) return { error: new FeishuError("auth") };
      if (!c.scopes.includes("contact:user:search")) return { error: new FeishuError("contact_permission") };
      let token: string;
      try { token = await this.access(store, c); } catch { return { error: new FeishuError("auth") }; }
      if (!c.scopes.includes("contact:user:search")) return { error: new FeishuError("contact_permission") };
      return { token, client: this.connectionClient(c), revision: c.revision };
    });
    if (staged.error) throw staged.error;
    signal?.throwIfAborted();
    const result = await staged.client!.searchContacts(staged.token!, input, signal);
    const active = await this.repository.withUser(userId, async store => (await store.connection())?.revision === staged.revision);
    signal?.throwIfAborted();
    if (!active) throw new FeishuError("auth");
    return result;
  }
  async disconnect(userId: string) { await this.repository.withUser(userId, store => store.disconnect()); }
  async botReply(job: FeishuInboxJob, text: string, signal?: AbortSignal) {
    const c = await this.repository.withUser(job.user_id, store => store.connection());
    if (!c || c.revision !== job.revision) throw new FeishuError("auth");
    signal?.throwIfAborted();
    return this.connectionClient(c).botReply(job.message_id,text,hash(`reply:${job.message_id}`).slice(0,40),signal);
  }
  private async access(store: FeishuUserStore, c: FeishuConnection) {
    if (c.expires_at > Date.now() + 60_000) return this.secrets.open(c.access_token);
    const refresh = this.secrets.open(c.refresh_token);
    if (!refresh) throw new FeishuError("auth");
    try {
      const { appId, appSecret } = this.connectionClient(c).config;
      const next = await this.onboarding.refresh(appId,appSecret,refresh);
      c.access_token = this.secrets.seal(next.access_token);
      c.refresh_token = this.secrets.seal(next.refresh_token ?? refresh);
      c.expires_at = Date.now() + next.expires_in * 1000;
      if (next.scope !== undefined) c.scopes = next.scope.split(/\s+/);
      await store.saveConnection(c);
      return next.access_token;
    } catch {
      // Refresh tokens may rotate. An unknown response must require reauthorization.
      c.refresh_token = this.secrets.seal(""); c.expires_at = 0;
      await store.saveConnection(c);
      throw new FeishuError("auth");
    }
  }
  async send(userId: string, input: { recipient: string; text: string; requestId: string; reply?: boolean; identity?: "user" | "bot"; alternateRequestId?: string }, revision?: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (input.identity !== undefined && !["user", "bot"].includes(input.identity)) throw new FeishuError("rejected");
    let fingerprint = "";
    const self = !input.reply && ["self", "me", "myself", "我", "自己", "我自己", "本人"].includes(input.recipient.trim().toLowerCase());
    const identity = self ? "bot" as const : input.identity ?? "user";
    const staged = await this.repository.withUser(userId, async store => {
      const c = await store.connection();
      if (!c || (revision && revision !== c.revision)) return { error: new FeishuError("auth") };
      // Retain legacy fingerprints for user/self sends; explicitly requested bot sends are distinct operations.
      fingerprint = hash(JSON.stringify([c.app_id,c.tenant_key,c.open_id,self ? "self" : input.recipient,input.text,!!input.reply,
        ...(!self && identity === "bot" ? ["bot"] : [])]));
      const existing = await store.sendRecord(input.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) return { error: new FeishuError("rejected") };
        return existing.status === "sent" ? { messageId: existing.message_id! }
          : { error: new FeishuError(existing.status === "failed" ? "rejected" : "unknown") };
      }
      // A model changing identities within one request must not bypass an uncertain/successful send.
      if (input.alternateRequestId) {
        const alternate = await store.sendRecord(input.alternateRequestId);
        if (alternate && alternate.status !== "failed") {
          return { error: new FeishuError(alternate.status === "sent" ? "rejected" : "unknown") };
        }
      }
      const target = self ? c.open_id : input.reply ? input.recipient : /^ou_[\w-]+$/.test(input.recipient) ? input.recipient : await store.contact(input.recipient);
      if (!target || (input.reply && !/^om_[\w-]+$/.test(target))) return { error: new FeishuError("rejected") };
      let token: string | undefined;
      if (identity === "user") {
        try { token = await this.access(store,c); } catch { return { error: new FeishuError("auth") }; }
        if (!["im:message", "im:message.send_as_user"].every(s => c.scopes.includes(s))) return { error: new FeishuError("permission") };
      }
      if (signal?.aborted) return { error: new Error("Feishu send cancelled") };
      await store.saveSend({ request_id: input.requestId, fingerprint, status: "sending", message_id: null });
      return { token, target, client: this.connectionClient(c) };
    });
    if (staged.error) throw staged.error;
    if (staged.messageId) return { messageId: staged.messageId, identity };
    // The intent is COMMITTED before the external write; interrupted sends are never replayed.
    let dispatched = false;
    try {
      signal?.throwIfAborted();
      dispatched = true;
      const uuid = hash(`${userId}:${input.requestId}`).slice(0,40);
      const messageId = identity === "bot"
        ? await staged.client!.botSend(staged.target!,input.text,uuid,input.reply,signal)
        : await staged.client!.send(staged.token!,staged.target!,input.text,uuid,input.reply,signal);
      await this.repository.withUser(userId, store => store.saveSend({ request_id: input.requestId,fingerprint,status: "sent",message_id: messageId }));
      return { messageId, identity };
    } catch (error) {
      await this.repository.withUser(userId, store => store.saveSend({ request_id: input.requestId,fingerprint,
        status: !dispatched || (error instanceof FeishuError && error.kind !== "unknown") ? "failed" : "unknown", message_id: null }));
      throw error instanceof FeishuError ? error : new FeishuError("unknown");
    }
  }
}
