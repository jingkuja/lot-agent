import { describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { FeishuOnboardingClient, officialVerificationUrl } from "./onboarding-client.js";
const json=(value: unknown,status=200) => new Response(JSON.stringify(value),{ status });

describe("official Feishu registration protocol",() => {
  it("uses the robot confirmation URL and supplies explicit scopes/events without reconfiguring an existing bot",async () => {
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(json({ device_code:"secret-device",verification_uri_complete:"https://accounts.feishu.cn/oauth/v1/app/verify?user_code=public-code",expire_in:123,interval:7 }));
    const grant=await new FeishuOnboardingClient(fetcher).register();
    const [endpoint,init]=fetcher.mock.calls[0];
    expect(endpoint).toBe("https://accounts.feishu.cn/oauth/v1/app/registration");
    expect(init?.redirect).toBe("error");
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ action:"begin",archetype:"PersonalAgent",auth_method:"client_secret",request_user_info:"open_id tenant_brand" });
    const url=new URL(grant.url);
    expect(url.searchParams.get("createOnly")).toBe("true");
    expect(url.searchParams.get("user_code")).toBe("public-code");
    expect(url.href).not.toContain("secret-device");
    const addons=JSON.parse(gunzipSync(Buffer.from(url.searchParams.get("addons")!,"base64url")).toString());
    expect(addons).toEqual({ preset:false,scopes:{ tenant:["im:message:send_as_bot","im:message.p2p_msg:readonly"],user:["im:message","im:message.send_as_user","contact:user:search"] },events:{ items:{ tenant:["im.message.receive_v1"] } } });
    expect(grant).toMatchObject({ expiresIn:123,interval:7 });
  });
  it("uses Basic auth to request the device grant and form-encoded v3 tokens",async () => {
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(json({ device_code:"device",verification_uri_complete:"https://accounts.feishu.cn/authorize",expires_in:240,interval:5 }))
      .mockResolvedValueOnce(json({ error:"authorization_pending" },400))
      .mockResolvedValueOnce(json({ access_token:"access",refresh_token:"refresh",expires_in:3600,token_type:"Bearer" }));
    const client=new FeishuOnboardingClient(fetcher);
    await client.authorize("app","secret",["im:message","offline_access"]);
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ Authorization:`Basic ${Buffer.from("app:secret").toString("base64")}` });
    expect(await client.pollAuthorization("app","secret","device")).toMatchObject({ pending:true });
    const result=await client.refresh("app","secret","refresh"); expect(result.access_token).toBe("access");
    expect(fetcher.mock.calls[2][0]).toBe("https://accounts.feishu.cn/oauth/v3/token");
    expect(new URLSearchParams(String(fetcher.mock.calls[2][1]?.body)).get("grant_type")).toBe("refresh_token");
  });
  it.each(["https://attacker.example/path","http://open.feishu.cn/path","https://secret@open.feishu.cn/path","https://open.feishu.cn:8443/path"])("rejects untrusted verification URLs: %s",url => {
    expect(() => officialVerificationUrl(url)).toThrow();
  });
  it.each(["access_denied","expired_token","invalid_grant"])("treats %s as terminal without retrying",async error => {
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(json({ error,error_description:"secret response details" },400));
    await expect(new FeishuOnboardingClient(fetcher).pollRegistration("device")).rejects.toMatchObject({ kind:"auth" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects international credentials and key-bound tokens",async () => {
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(json({ client_id:"app",client_secret:"secret",user_info:{ tenant_brand:"lark",open_id:"ou_me" } }))
      .mockResolvedValueOnce(json({ access_token:"token",expires_in:3600,token_type:"DPoP" }));
    const client=new FeishuOnboardingClient(fetcher);
    await expect(client.pollRegistration("device")).rejects.toMatchObject({ kind:"auth" });
    await expect(client.pollAuthorization("app","secret","device")).rejects.toMatchObject({ kind:"auth" });
  });
});
