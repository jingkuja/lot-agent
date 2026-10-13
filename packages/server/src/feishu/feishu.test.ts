import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { FeishuRepository, FeishuUserStore, FeishuConnection, FeishuSendRecord, FeishuInboxJob, FeishuSetup } from "@lot-agent/core";
import { FeishuClient, FeishuError, loadFeishuConfig } from "./client.js";
import { FeishuService, hash } from "./service.js";
import { FeishuChannel } from "./channel.js";
import { createFeishuRoutes, createFeishuPublicRoutes } from "./routes.js";
import { isMediaGeneration, MEDIA_UNAVAILABLE, parseSendCommand } from "./policy.js";
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
  const client = new FeishuClient({ appId:"cli_test",appSecret:"secret" },fetcher);
  const onboardingFetch = vi.fn<typeof fetch>();
  const service = new FeishuService(repo,client,secrets,new FeishuOnboardingClient(onboardingFetch));
  repo.bindings.set("u1",{ user_id:"u1",app_id:"cli_test",tenant_key:"tenant",open_id:"ou_me",name:"Me",
    access_token:secrets.seal("user-token"),refresh_token:secrets.seal("refresh-token"),expires_at:Date.now()+3600_000,
    scopes:["im:message","im:message.send_as_user"],revision:"revision" });
  const input = { recipient:"ou_alice",text:"原文\n`$()`",requestId:"request_1234567890" };
  return { repo,secrets,client,service,fetcher,onboardingFetch,input };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value),{ status,headers:{ "Content-Type":"application/json" } });

describe("Feishu user identity and delivery safety",() => {
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
    s.fetcher.mockImplementation(async url => String(url).includes("oauth/token")
      ? json({ access_token:"new-access",refresh_token:"new-refresh",expires_in:7200 })
      : json({ code:0,data:{ message_id:"om_sent" } }));
    await Promise.all([s.service.send("u1",s.input),s.service.send("u1",{ ...s.input,requestId:"second-request-id" })]);
    expect(s.fetcher.mock.calls.filter(([url]) => String(url).includes("oauth/token"))).toHaveLength(1);
    expect(s.repo.bindings.get("u1")!.refresh_token).toMatch(/^enc:v1:/);
    expect(s.secrets.open(s.repo.bindings.get("u1")!.refresh_token)).toBe("new-refresh");
    expect(JSON.stringify(await s.service.status("u1"))).not.toMatch(/new-access|new-refresh|enc:v1/);
  });
  it("requires reauthorization after uncertain refresh instead of reusing a rotated token",async () => {
    const s=setup(); s.repo.bindings.get("u1")!.expires_at=0;
    s.fetcher.mockRejectedValue(new Error("timeout"));
    await expect(s.service.send("u1",s.input)).rejects.toMatchObject({ kind:"auth" });
    await expect(s.service.send("u1",s.input)).rejects.toMatchObject({ kind:"auth" });
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not send when cancelled while refreshing credentials",async () => {
    const s=setup(); s.repo.bindings.get("u1")!.expires_at=0;
    const controller=new AbortController();
    s.fetcher.mockImplementation(async () => {
      controller.abort(); return json({ access_token:"fresh",refresh_token:"rotated",expires_in:7200 });
    });
    await expect(s.service.send("u1",s.input,undefined,controller.signal)).rejects.toThrow("cancelled");
    expect(s.fetcher).toHaveBeenCalledTimes(1);
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
    expect(loadFeishuConfig({})).toBeNull();
    expect(loadFeishuConfig({ SECRET_MASTER_KEY:"x" })).toEqual({ appId:"",appSecret:"" });
    expect(loadFeishuConfig({ SECRET_MASTER_KEY:"x",FEISHU_ENABLED:"0" })).toBeNull();
    expect(() => loadFeishuConfig({ SECRET_MASTER_KEY:"x",FEISHU_APP_ID:"partial" })).toThrow();
    expect(loadFeishuConfig({ SECRET_MASTER_KEY:"x",FEISHU_APP_ID:"cli",FEISHU_APP_SECRET:"secret",FEISHU_REDIRECT_URI:"deprecated" })).toEqual({ appId:"cli",appSecret:"secret" });
  });
});

describe("Feishu incoming commands",() => {
  const job: FeishuInboxJob={ message_id:"om_incoming",chat_id:"oc_chat",user_id:"u1",revision:"revision",text:"" };
  it.each(["生成一张海报","帮我制作视频","给我画一张猫咪图片","generate an image of a cat","create a short video"])("returns exact media placeholder for %s",async text => {
    const s=setup(); const agent={ streamAgentResponse:vi.fn() } as unknown as AgentService;
    const channel=new FeishuChannel(s.service,agent);
    expect(await channel.execute({ ...job,text },new AbortController().signal)).toBe(MEDIA_UNAVAILABLE);
    expect(agent.streamAgentResponse).not.toHaveBeenCalled(); expect(s.fetcher).not.toHaveBeenCalled();
  });
  it("keeps quoted outbound messages intact and allows writing scripts",() => {
    expect(parseSendCommand("给张三发：请生成视频\n谢谢")).toEqual({ recipient:"张三",text:"请生成视频\n谢谢" });
    expect(parseSendCommand("/send 张三 原文\n内容")).toMatchObject({ recipient:"张三",text:"原文\n内容" });
    expect(isMediaGeneration("帮我写一段视频脚本")).toBe(false);
  });
  it("accepts only the bound owner in private chat and deduplicates cancellation",async () => {
    const s=setup(); const channel=new FeishuChannel(s.service,{} as AgentService);
    const event={ sender:{ sender_type:"user",tenant_key:"tenant",sender_id:{ open_id:"ou_me" } },
      message:{ message_id:"om_event",chat_id:"oc_chat",chat_type:"p2p",message_type:"text",content:JSON.stringify({ text:"/cancel" }) } };
    await channel.receive({ ...event,sender:{ ...event.sender,tenant_key:"another-tenant" } });
    await channel.receive({ ...event,message:{ ...event.message,chat_type:"group" } });
    expect(s.repo.inbox.size).toBe(0);
    await channel.receive(event); await channel.receive(event);
    expect(s.repo.inbox.size).toBe(1); expect(s.repo.cancel).toHaveBeenCalledTimes(1);
  });
  it("dispatches explicit commands with the inbound message id as idempotency key",async () => {
    const s=setup(); const channel=new FeishuChannel(s.service,{} as AgentService);
    s.fetcher.mockResolvedValue(json({ code:0,data:{ message_id:"om_sent" } }));
    expect(await channel.execute({ ...job,text:"/send ou_alice hello" },new AbortController().signal)).toContain("本人身份");
    expect(s.repo.sends.has(`u1:${hash("inbound:om_incoming")}`)).toBe(true);
  });
});
