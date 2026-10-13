import { ToolRegistry } from "@lot-agent/core";
import { createFeishuTools } from "./tools.js";
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { FeishuRepository, FeishuUserStore, FeishuConnection, FeishuSendRecord, FeishuInboxJob, FeishuSetup } from "@lot-agent/core";
import { FeishuError, isFeishuEnabled } from "./client.js";
import { FeishuService, hash } from "./service.js";
import { FeishuChannel } from "./channel.js";
import { createFeishuRoutes, createFeishuPublicRoutes } from "./routes.js";
import { parseSendCommand } from "./policy.js";
import { FeishuOnboardingClient } from "./onboarding-client.js";
import { SecretBox } from "../auth/secret-box.js";
import type { AgentService } from "../services/agent-service.js";

class MemoryRepository implements FeishuRepository {
  bindings = new Map<string,FeishuConnection>();
  setups = new Map<string,FeishuSetup>();
  conversationIds = new Map<string,string>();
  sends = new Map<string,FeishuSendRecord>();
  people = new Map<string,string>();
  inbox = new Map<string,FeishuInboxJob>();
  cancel = vi.fn(async (_user: string, _except?: string) => {});
  private mutex: Promise<unknown> = Promise.resolve();
  withUser<T>(userId: string, work: (store: FeishuUserStore) => Promise<T>): Promise<T> {
    const task = this.mutex.then(() => work({
      connection: async () => this.bindings.get(userId) ?? null,
      saveConnection: async c => { this.bindings.set(userId,structuredClone(c)); },
      setup: async () => this.setups.get(userId) ?? null,
      saveSetup: async s => { this.setups.set(userId,structuredClone(s)); },
      conversation: async () => { const id=this.conversationIds.get(userId) ?? `conversation-${userId}`; this.conversationIds.set(userId,id); return id; },
      disconnect: async () => { this.setups.delete(userId); this.bindings.delete(userId); },
      contact: async alias => this.people.get(`${userId}:${alias}`) ?? null,
      saveContact: async (alias,id) => { this.people.set(`${userId}:${alias}`,id); },
      deleteContact: async alias => { this.people.delete(`${userId}:${alias}`); },
      sendRecord: async id => this.sends.get(`${userId}:${id}`) ?? null,
      saveSend: async r => { this.sends.set(`${userId}:${r.request_id}`,structuredClone(r)); },
    }));
    this.mutex = task.catch(() => {});
    return task;
  }
  async findSender(appId: string,tenant: string,openId: string) { return [...this.bindings.values()].find(c => c.app_id===appId && c.tenant_key===tenant && c.open_id===openId) ?? null; }
  async contacts(_u: string) { return []; }
  async saveContact(u: string,a: string,id: string) { this.people.set(`${u}:${a}`,id); }
  async deleteContact(u: string,a: string) { this.people.delete(`${u}:${a}`); }
  async enqueue(j: FeishuInboxJob) {
    if (this.inbox.has(j.message_id)) return false;
    this.inbox.set(j.message_id,j);
    if (["/cancel","取消任务"].includes(j.text.trim())) await this.cancel(j.user_id,j.message_id);
    return true;
  }
  async connections() { return [...this.bindings.values()]; }
  async recordResult(_job: FeishuInboxJob, _text: string, _status: string) {}
  async claim(): Promise<FeishuInboxJob | null> { return null; }
  async finish(_id: string,_status: string) {}
  async active(_job: FeishuInboxJob) { return true; }
  async recent(_u: string) { return []; }
}

function setup(fetcher = vi.fn<typeof fetch>()) {
  const repo = new MemoryRepository();
  const secrets = new SecretBox("11".repeat(32));
  const onboardingFetch = vi.fn<typeof fetch>();
  const service = new FeishuService(repo,secrets,new FeishuOnboardingClient(onboardingFetch),fetcher);
  repo.bindings.set("u1",{ user_id:"u1",app_id:"cli_test",app_secret:secrets.seal("secret"),tenant_key:"tenant",open_id:"ou_me",name:"Me",
    access_token:secrets.seal("user-token"),refresh_token:secrets.seal("refresh-token"),expires_at:Date.now()+3600_000,
    scopes:["im:message","im:message.send_as_user","contact:user:search"],revision:"revision" });
  const input = { recipient:"ou_alice",text:"原文\n`$()`",requestId:"request_1234567890" };
  return { repo,secrets,service,fetcher,onboardingFetch,input };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value),{ status,headers:{ "Content-Type":"application/json" } });

describe("Feishu user identity and delivery safety",() => {
  it("uses each owner's encrypted application credentials for bot sends", async () => {
    const s = setup();
    s.repo.bindings.set("u2", { ...s.repo.bindings.get("u1")!, user_id: "u2", app_id: "cli_second", app_secret: s.secrets.seal("second-secret") });
    const apps: unknown[] = [];
    s.fetcher.mockImplementation(async (url, init) => {
      if (String(url).includes("tenant_access_token")) {
        const app = JSON.parse(String(init?.body));
        apps.push(app);
        return json({ code: 0, tenant_access_token: `bot-${app.app_id}` });
      }
      return json({ code: 0, data: { message_id: "om_sent" } });
    });
    await s.service.send("u1", { ...s.input, identity: "bot" });
    await s.service.send("u2", { ...s.input, identity: "bot" });
    expect(apps).toEqual([{ app_id: "cli_test", app_secret: "secret" }, { app_id: "cli_second", app_secret: "second-secret" }]);
    expect(s.fetcher.mock.calls[1][1]?.headers).toMatchObject({ Authorization: "Bearer bot-cli_test" });
    expect(s.fetcher.mock.calls[3][1]?.headers).toMatchObject({ Authorization: "Bearer bot-cli_second" });
  });
  it("rejects a binding without its own application secret before making an HTTP request", async () => {
    const s = setup();
    s.repo.bindings.get("u1")!.app_secret = "";
    await expect(s.service.send("u1", { ...s.input, identity: "bot" })).rejects.toMatchObject({ kind: "auth" });
    await expect(s.service.begin("u1")).rejects.toMatchObject({ kind: "auth" });
    expect(s.fetcher).not.toHaveBeenCalled();
    expect(s.onboardingFetch).not.toHaveBeenCalled();
  });
  it("uses the owner's bot only when explicitly selected, with a separate idempotency key after a user rejection", async () => {
    const s = setup();
    s.fetcher.mockImplementation(async (url, init) => {
      if (String(url).includes("tenant_access_token")) return json({ code: 0, tenant_access_token: "bot-token" });
      const bot = (init?.headers as Record<string, string>).Authorization === "Bearer bot-token";
      expect(JSON.parse(String(init?.body))).toMatchObject({ receive_id: "ou_alice", content: JSON.stringify({ text: "fixture" }) });
      return bot ? json({ code: 0, data: { message_id: "om_bot" } }) : json({ code: 230038 }, 400);
    });
    const registry = new ToolRegistry();
    for (const tool of createFeishuTools(s.service, "u1")) registry.register(tool);
    const context = { userId: "u1", runId: "run", sourceMessageId: "input", workingDirectory: "/tmp" };
    const input = { recipient: "ou_alice", text: "fixture" };
    expect(await registry.execute("feishu_send_message", input, context)).toMatchObject({ errorKind: "validation" });
    expect(s.fetcher).toHaveBeenCalledTimes(1); // No silent bot fallback.
    const result = await registry.execute("feishu_send_message", { ...input, identity: "bot" }, context);
    expect(JSON.parse(result.content)).toMatchObject({ status: "sent", identity: "bot", messageId: "om_bot" });
    await registry.execute("feishu_send_message", { ...input, identity: "bot" }, context);
    expect(s.fetcher).toHaveBeenCalledTimes(3);
    expect([...s.repo.sends.values()].map(row => row.status).sort()).toEqual(["failed", "sent"]);
  });
  it("isolates explicit bot sends by owner/revision, does not refresh the user token and supports bot replies", async () => {
    const s = setup();
    s.repo.bindings.get("u1")!.expires_at = 0;
    s.repo.bindings.get("u1")!.scopes = [];
    s.fetcher.mockImplementation(async (url, init) => {
      if (String(url).includes("tenant_access_token")) return json({ code: 0, tenant_access_token: "bot-token" });
      expect(String(url)).toContain("im/v1/messages/om_original/reply");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer bot-token" });
      return json({ code: 0, data: { message_id: "om_reply" } });
    });
    const input = { ...s.input, recipient: "om_original", reply: true, identity: "bot" as const };
    await expect(s.service.send("u2", input)).rejects.toMatchObject({ kind: "auth" });
    await expect(s.service.send("u1", input, "old-binding")).rejects.toMatchObject({ kind: "auth" });
    expect(s.fetcher).not.toHaveBeenCalled();
    expect(await s.service.send("u1", input)).toEqual({ identity: "bot", messageId: "om_reply" });
    expect(s.fetcher).toHaveBeenCalledTimes(2);
    expect(s.onboardingFetch).not.toHaveBeenCalled();
    await expect(s.service.send("u1", { ...input, identity: "user" })).rejects.toMatchObject({ kind: "rejected" });
  });
  it("explains missing bot availability and never retries a lost delivery response", async () => {
    const s = setup();
    s.fetcher.mockImplementation(async url => String(url).includes("tenant_access_token")
      ? json({ code: 0, tenant_access_token: "bot-token" }) : json({ code: 230013 }, 400));
    await expect(s.service.send("u1", { ...s.input, identity: "bot" })).rejects.toMatchObject({ kind: "bot_unavailable", apiCode: 230013,
      message: expect.stringContaining("https://applink.feishu.cn/client/bot/open?appId=cli_test") });
    expect(s.repo.sends.get(`u1:${s.input.requestId}`)?.status).toBe("failed");
    const next = { ...s.input, requestId: "uncertain_bot_send", identity: "bot" as const };
    s.fetcher.mockImplementation(async url => {
      if (String(url).includes("tenant_access_token")) return json({ code: 0, tenant_access_token: "bot-token" });
      throw new Error("lost receipt");
    });
    await expect(s.service.send("u1", next)).rejects.toMatchObject({ kind: "unknown" });
    await expect(s.service.send("u1", next)).rejects.toMatchObject({ kind: "unknown" });
    expect(s.fetcher).toHaveBeenCalledTimes(4);
  });
  it("does not label failed bot authentication as a possibly delivered message", async () => {
    const s = setup();
    s.fetcher.mockRejectedValue(new Error("token endpoint unavailable"));
    await expect(s.service.send("u1", { ...s.input, identity: "bot" })).rejects.toMatchObject({ kind: "bot_auth" });
    expect(s.repo.sends.get(`u1:${s.input.requestId}`)?.status).toBe("failed");
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["user", "sent"], ["user", "unknown"], ["bot", "sent"], ["bot", "unknown"],
  ] as const)("does not bypass a %s send with %s outcome by switching identities", async (identity, outcome) => {
    const s = setup();
    s.fetcher.mockImplementation(async url => {
      if (String(url).includes("tenant_access_token")) return json({ code: 0, tenant_access_token: "bot-token" });
      if (outcome === "unknown") throw new Error("lost delivery receipt");
      return json({ code: 0, data: { message_id: "om_sent" } });
    });
    const registry = new ToolRegistry();
    for (const tool of createFeishuTools(s.service, "u1")) registry.register(tool);
    const context = { userId: "u1", runId: "run", sourceMessageId: "input", workingDirectory: "/tmp" };
    const input = { recipient: "ou_alice", text: "fixture", identity };
    await registry.execute("feishu_send_message", input, context);
    const before = s.fetcher.mock.calls.length;
    const result = await registry.execute("feishu_send_message", { ...input, identity: identity === "bot" ? "user" : "bot" }, context);
    expect(result).toMatchObject({ isError: true, errorKind: outcome === "unknown" ? "unknown_outcome" : "validation" });
    expect(s.fetcher).toHaveBeenCalledTimes(before);
    expect(s.repo.sends.size).toBe(1);
  });
  it("explains 230038 as a cross-tenant API restriction, with no retry or bot fallback", async () => {
    const s = setup();
    s.fetcher.mockResolvedValue(json({ code: 230038, msg: "Cross tenant p2p chat operate forbid." }, 400));
    const registry = new ToolRegistry();
    for (const tool of createFeishuTools(s.service, "u1")) registry.register(tool);
    const result = await registry.execute("feishu_send_message", { recipient: "ou_external", text: "fixture" },
      { userId: "u1", runId: "run", workingDirectory: "/tmp" });
    expect(result).toMatchObject({ isError: true, errorKind: "validation" });
    expect(result.content).toContain("跨租户");
    expect(result.content).toContain("重新授权或改用姓名不能解除");
    expect(result.content).toContain("230038");
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    expect(s.fetcher.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer user-token" });
  });
  it("keeps a definite rejection definite when the same send is retried by name, without another HTTP write", async () => {
    const s = setup();
    s.fetcher.mockImplementation(async url => String(url).includes("users/search")
      ? json({ code: 0, data: { items: [{ id: "ou_alice", meta_data: { i18n_names: { en_us: "Anson" } } }], has_more: false } })
      : json({ code: 230013, msg: "upstream body with secret-token" }, 400));
    const registry = new ToolRegistry();
    for (const tool of createFeishuTools(s.service, "u1")) registry.register(tool);
    const context = { userId: "u1", runId: "run", sourceMessageId: "input", workingDirectory: "/tmp" };
    const first = await registry.execute("feishu_send_message", { recipient: "ou_alice", text: "fixture" }, context);
    const second = await registry.execute("feishu_send_message", { recipient: "Anson", text: "fixture" }, context);
    expect(first).toMatchObject({ isError: true, errorKind: "validation" });
    expect(first.content).toContain("230013");
    expect(first.content).not.toContain("secret-token");
    expect(second).toMatchObject({ isError: true, errorKind: "validation" });
    expect(second.content).not.toContain("无法确认");
    expect(s.fetcher.mock.calls.filter(([url]) => String(url).includes("im/v1/messages"))).toHaveLength(1);
  });
  it("sends exact text with the user's token and persists the intent before HTTP",async () => {
    const s=setup();
    s.fetcher.mockImplementation(async (_url,init) => {
      expect(s.repo.sends.get(`u1:${s.input.requestId}`)?.status).toBe("sending");
      expect(init?.headers).toMatchObject({ Authorization:"Bearer user-token" });
      expect(JSON.parse(String(init?.body))).toMatchObject({ receive_id:"ou_alice",content:JSON.stringify({ text:s.input.text }) });
      return json({ code:0,data:{ message_id:"om_sent" } });
    });
    expect(await s.service.send("u1",s.input)).toEqual({ identity:"user",messageId:"om_sent" });
    await s.service.send("u1",s.input);
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  });
  it("blocks other users, changed payloads and missing user-send permission without bot fallback",async () => {
    const s=setup(); s.fetcher.mockResolvedValue(json({ code:0,data:{ message_id:"om_sent" } }));
    await expect(s.service.send("u2",s.input)).rejects.toMatchObject({ kind:"auth" });
    await s.service.send("u1",s.input);
    await expect(s.service.send("u1",{ ...s.input,text:"changed" })).rejects.toMatchObject({ kind:"rejected" });
    s.repo.bindings.get("u1")!.scopes=[];
    await expect(s.service.send("u1",{ ...s.input,requestId:"different_request" })).rejects.toMatchObject({ kind:"permission" });
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not replay an unknown send, including a concurrent duplicate",async () => {
    const s=setup(); s.fetcher.mockRejectedValue(new Error("network error with secret data"));
    const first=await Promise.allSettled([s.service.send("u1",s.input),s.service.send("u1",s.input)]);
    expect(first.every(r => r.status==="rejected")).toBe(true);
    await expect(s.service.send("u1",s.input)).rejects.toMatchObject({ kind:"unknown" });
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    expect(s.repo.sends.get(`u1:${s.input.requestId}`)?.status).toBe("unknown");
  });
  it("refreshes under the user lock, encrypts rotation and never exposes tokens in status",async () => {
    const s=setup(); s.repo.bindings.get("u1")!.expires_at=0;
    s.onboardingFetch.mockResolvedValue(json({ access_token:"new-access",refresh_token:"new-refresh",expires_in:7200 }));
    s.fetcher.mockImplementation(async () => json({ code:0,data:{ message_id:"om_sent" } }));
    await Promise.all([s.service.send("u1",s.input),s.service.send("u1",{ ...s.input,requestId:"second-request-id" })]);
    expect(s.onboardingFetch).toHaveBeenCalledTimes(1);
    expect(s.onboardingFetch.mock.calls[0][0]).toBe("https://accounts.feishu.cn/oauth/v3/token");
    expect(Object.fromEntries(new URLSearchParams(String(s.onboardingFetch.mock.calls[0][1]?.body)))).toEqual({ client_id:"cli_test",client_secret:"secret",refresh_token:"refresh-token",grant_type:"refresh_token" });
    expect(s.repo.bindings.get("u1")!.refresh_token).toMatch(/^enc:v1:/);
    expect(s.secrets.open(s.repo.bindings.get("u1")!.refresh_token)).toBe("new-refresh");
    expect(JSON.stringify(await s.service.status("u1"))).not.toMatch(/new-access|new-refresh|enc:v1/);
  });
  it("requires reauthorization after uncertain refresh instead of reusing a rotated token",async () => {
    const s=setup(); s.repo.bindings.get("u1")!.expires_at=0;
    s.onboardingFetch.mockRejectedValue(new Error("timeout"));
    await expect(s.service.send("u1",s.input)).rejects.toMatchObject({ kind:"auth" });
    await expect(s.service.send("u1",s.input)).rejects.toMatchObject({ kind:"auth" });
    expect(s.onboardingFetch).toHaveBeenCalledTimes(1);
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it("does not send when cancelled while refreshing credentials",async () => {
    const s=setup(); s.repo.bindings.get("u1")!.expires_at=0;
    const controller=new AbortController();
    s.onboardingFetch.mockImplementation(async () => {
      controller.abort(); return json({ access_token:"fresh",refresh_token:"rotated",expires_in:7200 });
    });
    await expect(s.service.send("u1",s.input,undefined,controller.signal)).rejects.toThrow("cancelled");
    expect(s.onboardingFetch).toHaveBeenCalledTimes(1);
    expect(s.fetcher).not.toHaveBeenCalled();
    expect(s.repo.sends.size).toBe(0);
    expect(s.secrets.open(s.repo.bindings.get("u1")!.refresh_token)).toBe("rotated");
  });
  it("resolves only the owner's saved contacts and refuses a stale binding",async () => {
    const s=setup(); await s.repo.saveContact("u2","张三","ou_wrong");
    await expect(s.service.send("u1",{ ...s.input,recipient:"张三" })).rejects.toMatchObject({ kind:"rejected" });
    await expect(s.service.send("u1",s.input,"old-revision")).rejects.toMatchObject({ kind:"auth" });
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it("replies through the reply endpoint using user identity",async () => {
    const s=setup(); s.fetcher.mockResolvedValue(json({ code:0,data:{ message_id:"om_reply" } }));
    await s.service.send("u1",{ ...s.input,recipient:"om_source",reply:true });
    expect(String(s.fetcher.mock.calls[0]![0])).toContain("/im/v1/messages/om_source/reply");
    expect(s.fetcher.mock.calls[0]![1]?.headers).toMatchObject({ Authorization:"Bearer user-token" });
  });
});

describe("Feishu OAuth and routes",() => {
  it("retires transferable public OAuth tickets",async () => {
    const s=setup(); const app=createFeishuPublicRoutes(s.service);
    expect((await app.request("/start?ticket=attacker")).status).toBe(410);
    expect((await app.request("/callback?code=victim&state=attacker")).status).toBe(410);
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  async function beginNew(s: ReturnType<typeof setup>) {
    s.repo.bindings.clear();
    s.onboardingFetch.mockResolvedValueOnce(json({ device_code:"registration-device",user_code:"registration-code",verification_uri_complete:"https://open.feishu.cn/page/robot?user_code=registration-code",expire_in:600,interval:5 }));
    return (await s.service.begin("u1"))!;
  }
  async function authorizeNew(s: ReturnType<typeof setup>, id: string, openId="ou_me") {
    s.repo.setups.get("u1")!.poll_after=0;
    s.onboardingFetch.mockResolvedValueOnce(json({ client_id:"cli_personal",client_secret:"personal-secret",user_info:{ open_id:"ou_me",tenant_brand:"feishu" } }))
      .mockResolvedValueOnce(json({ device_code:"authorization-device",verification_uri_complete:"https://accounts.feishu.cn/authorize?user_code=code",expires_in:240,interval:5 }));
    expect((await s.service.poll("u1",id))?.phase).toBe("authorization");
    s.repo.setups.get("u1")!.poll_after=0;
    s.onboardingFetch.mockResolvedValueOnce(json({ access_token:"granted",refresh_token:"refresh",expires_in:7200,scope:"im:message im:message.send_as_user" }));
    s.fetcher.mockResolvedValueOnce(json({ code:0,data:{ open_id:openId,tenant_key:"tenant",name:"Me" } }))
      .mockResolvedValueOnce(json({ code:0,tenant_access_token:"bot-token" }))
      .mockResolvedValueOnce(json({ code:0,data:{ message_id:"om_code" } }));
    return s.service.poll("u1",id);
  }
  it("creates an encrypted personal app and activates only after the owner's bot code",async () => {
    const s=setup(); const first=await beginNew(s);
    expect(first.phase).toBe("registration");
    expect(await s.service.begin("u1")).toEqual(first);
    expect(s.onboardingFetch).toHaveBeenCalledTimes(1);
    const view=await authorizeNew(s,first.id);
    expect(view?.phase).toBe("verification");
    expect(s.repo.bindings.size).toBe(0);
    const payload=JSON.parse(String(s.fetcher.mock.calls.at(-1)?.[1]?.body));
    const code=JSON.parse(payload.content).text.match(/验证码：(\d{6})/)[1];
    expect(payload.receive_id).toBe("ou_me");
    expect(JSON.stringify(await s.service.status("u1"))).not.toMatch(new RegExp(`personal-secret|granted|registration-device|authorization-device|${code}`));
    expect(s.repo.setups.get("u1")!.data).toMatch(/^enc:v1:/);
    await expect(s.service.confirm("u2",first.id,code)).rejects.toBeInstanceOf(FeishuError);
    await s.service.confirm("u1",first.id,code);
    expect(s.repo.bindings.get("u1")!.app_id).toBe("cli_personal");
    expect(s.secrets.open(s.repo.bindings.get("u1")!.app_secret!)).toBe("personal-secret");
    expect(s.repo.conversationIds.size).toBe(1);
    await expect(s.service.confirm("u1",first.id,code)).rejects.toBeInstanceOf(FeishuError);
  });
  it("does not bind a forwarded scan without the private bot code; locks after five attempts",async () => {
    const s=setup(); const first=await beginNew(s);
    await authorizeNew(s,first.id);
    for (let n=0;n<5;n++) await expect(s.service.confirm("u1",first.id,"invalid")).rejects.toBeInstanceOf(FeishuError);
    expect(s.repo.setups.get("u1")!.phase).toBe("failed");
    expect(s.repo.bindings.size).toBe(0);
  });
  it("rejects mismatched creator and authorizing identity before sending any code",async () => {
    const s=setup(); const first=await beginNew(s);
    expect((await authorizeNew(s,first.id,"ou_other"))?.phase).toBe("failed");
    expect(s.fetcher).toHaveBeenCalledTimes(1); expect(s.repo.bindings.size).toBe(0);
  });
  it("invalidates pending setup on disconnect and enforces polling ownership and interval",async () => {
    const s=setup(); const first=await beginNew(s);
    await expect(s.service.poll("u2",first.id)).rejects.toBeInstanceOf(FeishuError);
    await s.service.poll("u1",first.id);
    expect(s.onboardingFetch).toHaveBeenCalledTimes(1);
    await s.service.disconnect("u1");
    await expect(s.service.poll("u1",first.id)).rejects.toBeInstanceOf(FeishuError);
  });
  it("honors slow_down and expires without issuing another upstream call",async () => {
    const s=setup(); const first=await beginNew(s);
    s.repo.setups.get("u1")!.poll_after=0;
    s.onboardingFetch.mockResolvedValueOnce(json({ error:"slow_down" },400));
    await s.service.poll("u1",first.id);
    expect(s.repo.setups.get("u1")!.interval).toBe(10);
    s.repo.setups.get("u1")!.expires_at=0;
    expect((await s.service.poll("u1",first.id))?.phase).toBe("expired");
    expect(s.onboardingFetch).toHaveBeenCalledTimes(2);
  });
  it("uses the authenticated owner and rejects malformed sends",async () => {
    const s=setup(); const app=new Hono<{ Variables:{ userId:string } }>();
    app.use("*",async (c,next) => { c.set("userId","u2"); await next(); });
    app.route("/",createFeishuRoutes(s.service));
    const response=await app.request("/messages",{ method:"POST",headers:{ "Content-Type":"application/json" },body:JSON.stringify({ ...s.input,userId:"u1" }) });
    expect(response.status).toBe(400); expect(s.fetcher).not.toHaveBeenCalled();
    expect((await app.request("/messages",{ method:"POST",body:"{}" })).status).toBe(400);
  });
  it("requires encryption but not developer app configuration for QR setup",() => {
    expect(isFeishuEnabled({})).toBe(false);
    expect(isFeishuEnabled({ SECRET_MASTER_KEY:"x" })).toBe(true);
    expect(isFeishuEnabled({ SECRET_MASTER_KEY:"x",FEISHU_ENABLED:"1" })).toBe(true);
    expect(isFeishuEnabled({ SECRET_MASTER_KEY:"x",FEISHU_ENABLED:"0" })).toBe(false);
  });
});

describe("Feishu incoming commands",() => {
  const job: FeishuInboxJob={ message_id:"om_incoming",chat_id:"oc_chat",user_id:"u1",revision:"revision",text:"" };
  it("keeps quoted outbound messages intact and allows writing scripts",() => {
    expect(parseSendCommand("给张三发：请生成视频\n谢谢")).toEqual({ recipient:"张三",text:"请生成视频\n谢谢" });
    expect(parseSendCommand("/send 张三 原文\n内容")).toMatchObject({ recipient:"张三",text:"原文\n内容" });
  });
  it("accepts only the bound owner in private chat and deduplicates cancellation",async () => {
    const s=setup(); const channel=new FeishuChannel(s.service,{} as AgentService);
    const event={ sender:{ sender_type:"user",tenant_key:"tenant",sender_id:{ open_id:"ou_me" } },
      message:{ message_id:"om_event",chat_id:"oc_chat",chat_type:"p2p",message_type:"text",content:JSON.stringify({ text:"/cancel" }) } };
    await channel.receive({ ...event,sender:{ ...event.sender,tenant_key:"another-tenant" } }, "cli_test");
    await channel.receive({ ...event,message:{ ...event.message,chat_type:"group" } }, "cli_test");
    await channel.receive(event, "cli_other");
    await channel.receive(event, "");
    expect(s.repo.inbox.size).toBe(0);
    await channel.receive(event, "cli_test"); await channel.receive(event, "cli_test");
    expect(s.repo.inbox.size).toBe(1); expect(s.repo.cancel).toHaveBeenCalledTimes(1);
  });
  it("dispatches explicit commands with the inbound message id as idempotency key",async () => {
    const s=setup(); const channel=new FeishuChannel(s.service,{} as AgentService);
    s.fetcher.mockResolvedValue(json({ code:0,data:{ message_id:"om_sent" } }));
    expect(await channel.execute({ ...job,text:"/send ou_alice hello" },new AbortController().signal)).toContain("本人身份");
    expect(s.repo.sends.has(`u1:${hash("inbound:om_incoming")}`)).toBe(true);
  });
});


describe("Feishu conversation tools", () => {
  function tools(s: ReturnType<typeof setup>, revision = "revision") {
    const registry = new ToolRegistry();
    for (const tool of createFeishuTools(s.service, "u1", revision)) registry.register(tool);
    const context = { workingDirectory: ".", userId: "u1", runId: "run1", sourceMessageId: "input1" };
    return { registry, context };
  }
  it("delivers researched text to the bound self via the bot and deduplicates repeated calls", async () => {
    const s = setup();
    s.repo.bindings.get("u1")!.scopes = [];
    s.fetcher.mockImplementation(async (url, init) => {
      if (String(url).includes("tenant_access_token")) return json({ code: 0, tenant_access_token: "bot-token" });
      expect(init?.headers).toMatchObject({ Authorization: "Bearer bot-token" });
      expect(JSON.parse(String(init?.body))).toMatchObject({ receive_id: "ou_me", content: JSON.stringify({ text: "已核实的收盘价和来源" }) });
      return json({ code: 0, data: { message_id: "om_self" } });
    });
    const { registry, context } = tools(s);
    const input = { recipient: "self", text: "已核实的收盘价和来源" };
    const result = await registry.execute("feishu_send_message", input, context);
    expect(JSON.parse(result.content)).toEqual({ status: "sent", messageId: "om_self", identity: "bot" });
    await registry.execute("feishu_send_message", input, { ...context, operationId: "another-tool-call" });
    expect(s.fetcher).toHaveBeenCalledTimes(2);
  });
  it("uses the owner's saved contact and exact text with user identity", async () => {
    const s = setup(); await s.repo.saveContact("u1", "张三", "ou_alice");
    s.fetcher.mockImplementation(async (_url, init) => {
      if (String(_url).includes("users/search")) return json({ code: 0, data: { items: [{ id: "ou_alice", meta_data: { i18n_names: { zh_cn: "张三" } } }], has_more: false } });
      expect(init?.headers).toMatchObject({ Authorization: "Bearer user-token" });
      expect(JSON.parse(String(init?.body))).toMatchObject({ receive_id: "ou_alice", content: JSON.stringify({ text: s.input.text }) });
      return json({ code: 0, data: { message_id: "om_contact" } });
    });
    const { registry, context } = tools(s);
    expect((await registry.execute("feishu_send_message", { recipient: "张三", text: s.input.text }, context)).isError).toBeUndefined();
  });
  it("validates input, authenticated owner, stale binding and cancellation before sending", async () => {
    const s = setup(), { registry, context } = tools(s, "stale");
    const input = { recipient: "self", text: "hello" };
    expect(await registry.execute("feishu_send_message", { ...input, userId: "u2" }, context)).toMatchObject({ errorKind: "validation" });
    expect(await registry.execute("feishu_send_message", input, { ...context, userId: "u2" })).toMatchObject({ errorKind: "permission" });
    expect(await registry.execute("feishu_contacts", {}, { ...context, userId: "u2" })).toMatchObject({ errorKind: "permission" });
    expect(await registry.execute("feishu_send_message", input, context)).toMatchObject({ errorKind: "permission" });
    expect(await registry.execute("feishu_send_message", input, context, { signal: AbortSignal.abort() })).toMatchObject({ errorKind: "cancelled" });
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it("returns uncertain delivery without replaying the external write", async () => {
    const s = setup(); s.fetcher.mockRejectedValue(new Error("private transport details"));
    const { registry, context } = tools(s);
    const input = { recipient: "ou_alice", text: "hello" };
    for (let i = 0; i < 2; i++) {
      const result = await registry.execute("feishu_send_message", input, context);
      expect(result).toMatchObject({ isError: true, errorKind: "unknown_outcome" });
      expect(result.content).not.toContain("private transport");
    }
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  });
  it("lists only public connection details and guides unbound users to connect", async () => {
    const s = setup(), { registry, context } = tools(s);
    s.fetcher.mockResolvedValue(json({ code: 0, data: { items: [{ id: "ou_me", meta_data: { i18n_names: { zh_cn: "Me" } } }], has_more: false } }));
    const result = await registry.execute("feishu_contacts", {}, context);
    expect(JSON.parse(result.content)).toMatchObject({ users: [{ openId: "ou_me" }] });
    expect(result.content).not.toMatch(/user-token|refresh-token|enc:v1|secret/);
    s.repo.bindings.clear();
    expect(await registry.execute("feishu_contacts", {}, context)).toMatchObject({ isError: true, errorKind: "permission" });
  });
});


describe("official Feishu contact search", () => {
  const result = (items: unknown[] = [], hasMore = false) => json({ code: 0, data: { items, has_more: hasMore, page_token: hasMore ? "next+page" : "" } });
  const person = (id = "ou_alice", name = "张三") => ({ id, display_info: "<h>张三</h>\n研发部", meta_data: { i18n_names: { zh_cn: name }, mail_address: "alice@example.org", chat_id: "oc_known", is_cross_tenant: true } });
  it("uses the official POST endpoint, user credential, pagination and external-contact fields", async () => {
    const s = setup(); s.fetcher.mockImplementation(async () => result([person()], true));
    const found = await s.service.searchContacts("u1", { query: "张三", pageSize: 30, pageToken: "next+page" }, "revision");
    const [url, init] = s.fetcher.mock.calls[0];
    expect(String(url)).toBe("https://open.feishu.cn/open-apis/contact/v3/users/search?page_size=30&page_token=next%2Bpage");
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer user-token" } });
    expect(JSON.parse(String(init?.body))).toEqual({ query: "张三" });
    expect(found).toMatchObject({ users: [{ openId: "ou_alice", name: "张三", displayInfo: "张三\n研发部", hasChatted: true, isExternal: true }], hasMore: true, pageToken: "next+page" });
    await s.service.searchContacts("u1", {});
    expect(JSON.parse(String(s.fetcher.mock.calls[1][1]?.body))).toEqual({ filter: { has_contact: true } });
  });
  it("requires contact scope, validates owner and binding version, and never uses a bot token", async () => {
    const s = setup();
    await expect(s.service.searchContacts("u2", { query: "张三" })).rejects.toMatchObject({ kind: "auth" });
    await expect(s.service.searchContacts("u1", { query: "张三" }, "stale")).rejects.toMatchObject({ kind: "auth" });
    s.repo.bindings.get("u1")!.scopes = ["im:message", "im:message.send_as_user"];
    expect(await s.service.status("u1")).toMatchObject({ canSendAsUser: true, canSearchContacts: false });
    await expect(s.service.searchContacts("u1", {})).rejects.toMatchObject({ kind: "contact_permission" });
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it("refreshes search credentials under the owner lock", async () => {
    const s = setup(); s.repo.bindings.get("u1")!.expires_at = 0;
    s.onboardingFetch.mockResolvedValue(json({ access_token: "new-token", refresh_token: "rotated", expires_in: 7200 }));
    s.fetcher.mockImplementation(async (_url, init) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer new-token" });
      return result([person()]);
    });
    expect((await s.service.searchContacts("u1", { query: "张三" })).users).toHaveLength(1);
    expect(s.onboardingFetch).toHaveBeenCalledTimes(1);
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  });
  it("discards results after disconnection and does not execute an already-cancelled search", async () => {
    const s = setup();
    await expect(s.service.searchContacts("u1", {}, undefined, AbortSignal.abort())).rejects.toThrow();
    expect(s.fetcher).not.toHaveBeenCalled();
    s.fetcher.mockImplementation(async () => { s.repo.bindings.clear(); return result([person()]); });
    await expect(s.service.searchContacts("u1", {})).rejects.toMatchObject({ kind: "auth" });
  });
  it.each([{ items: [] }, { items: [person(), person("ou_other")] }])("never sends to missing or ambiguous names", async ({ items }) => {
    const s = setup(); s.fetcher.mockResolvedValue(result(items));
    const tool = createFeishuTools(s.service, "u1")[1];
    const receipt = await tool.execute({ recipient: "张三", text: "hello" }, { workingDirectory: ".", userId: "u1", runId: "run" });
    expect(receipt).toMatchObject({ isError: true, errorKind: "validation" });
    expect(JSON.parse(receipt.content).users).toHaveLength(items.length);
    expect(s.repo.sends.size).toBe(0);
    expect(s.fetcher.mock.calls.every(([url]) => String(url).includes("users/search"))).toBe(true);
  });
  it("does not select the first page's only person when more candidates exist", async () => {
    const s = setup(); s.fetcher.mockResolvedValue(result([person()], true));
    const tool = createFeishuTools(s.service, "u1")[1];
    expect(await tool.execute({ recipient: "张三", text: "hello" }, { workingDirectory: ".", userId: "u1", runId: "run" })).toMatchObject({ isError: true });
    expect(s.repo.sends.size).toBe(0);
  });
  it("classifies permission errors and malformed search responses without exposing raw data", async () => {
    const s = setup();
    s.fetcher.mockResolvedValueOnce(json({ code: 99991672, msg: "secret" }, 403));
    await expect(s.service.searchContacts("u1", {})).rejects.toMatchObject({ kind: "contact_permission" });
    s.fetcher.mockResolvedValueOnce(json({ data: { items: [{ id: "not-an-open-id" }], has_more: false } }));
    await expect(s.service.searchContacts("u1", {})).rejects.toMatchObject({ kind: "search_failed" });
  });
  it("includes the new scope when an existing account authorizes again", async () => {
    const s = setup();
    s.onboardingFetch.mockResolvedValue(json({ device_code: "device", verification_uri_complete: "https://accounts.feishu.cn/authorize", expires_in: 240, interval: 5 }));
    await s.service.begin("u1");
    expect(new URLSearchParams(String(s.onboardingFetch.mock.calls[0][1]?.body)).get("scope")).toContain("contact:user:search");
  });
});
