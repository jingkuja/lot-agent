import { afterEach, describe, it, expect, vi } from "vitest";
import { createAuthRoutes } from "./auth.js";
import { TokenhubClientError, TokenhubMergeRequiredError } from "../tokenhub/client.js";

function fakeService() {
  return {
    tokenhub: { login: vi.fn(), tokenLogin: vi.fn() },
    db: { upsertUserByExternalId: vi.fn() },
    sessions: { createSession: vi.fn().mockResolvedValue("tok-1") },
  } as unknown as import("../services/agent-service.js").AgentService;
}

function fakeManagedService() {
  const service = {
    managedKeysEnabled: true,
    tokenhub: {
      login: vi.fn(),
      tokenLogin: vi.fn(),
      registerAgentUser: vi.fn(),
      sendAgentEmailVerification: vi.fn(),
      sendAgentPasswordResetEmail: vi.fn(),
      resetAgentPassword: vi.fn(),
      sendAgentPhoneVerification: vi.fn(),
      authenticateAgentUserByPhone: vi.fn(),
      authenticateWechatMiniUser: vi.fn(),
      bindWechatMiniPhone: vi.fn(),
      mergeWechatMiniPhone: vi.fn(),
      updateAgentDisplayName: vi.fn(),
      sendAgentPhoneBindingVerification: vi.fn(),
      bindAgentPhone: vi.fn(),
    },
    db: {
      upsertManagedUser: vi.fn(),
      updateUserPhone: vi.fn(),
      updateUserDisplayName: vi.fn(),
      getUserById: vi.fn().mockResolvedValue({ external_user_id: 7 }),
      bindUserWechat: vi.fn().mockResolvedValue("ok"),
      reassignWechatOpenid: vi.fn().mockResolvedValue("ok"),
      countUserOwnedRecords: vi.fn().mockResolvedValue({ conversations: 0, assets: 0, tasks: 0 }),
      reassignUserOwnedData: vi.fn().mockResolvedValue(undefined),
      deleteLocalUser: vi.fn().mockResolvedValue(undefined),
      getUserByExternalId: vi.fn(),
    },
    sessions: {
      createSession: vi.fn().mockResolvedValue("tok-managed"),
      resolve: vi.fn().mockResolvedValue({ userId: "u7" }),
    },
  };
  return service as unknown as import("../services/agent-service.js").AgentService;
}

const managedResult = {
  userId: 7,
  username: "alice",
  name: "Alice",
  phone: "13800138000",
  managedKey: { tokenId: 9, apiKey: "managed-secret", credentialVersion: 2, remainQuota: 0 },
  created: false,
};

const storedManagedUser = {
  id: "u7", email: null, name: "Alice", created_at: "t",
  external_user_id: 7, username: "alice", api_key: "managed-secret", api_keys: [],
  phone: "138****8000",
  managed_token_id: 9, managed_credential_version: 2,
};

async function encryptFor(app: ReturnType<typeof createAuthRoutes>, pw: string) {
  const { publicEncrypt, constants } = await import("node:crypto");
  const res = await app.request("/public-key");
  const { publicKey } = await res.json();
  return publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(pw, "utf-8")
  ).toString("base64");
}

describe("auth login", () => {
  it("decrypts, calls tokenhub, upserts, returns token + sanitized user", async () => {
    const svc = fakeService();
    (svc.tokenhub.login as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 2, name: "138", apiKeys: [{ apiKey: "sk-SECRETSECRET", name: "开放API密钥" }],
    });
    (svc.db.upsertUserByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u1", email: null, name: "138", created_at: "t",
      external_user_id: 2, username: "138", api_key: "sk-SECRETSECRET",
      api_keys: [{ apiKey: "sk-SECRETSECRET", name: "开放API密钥" }],
    });
    const app = createAuthRoutes(svc);
    const encryptedPassword = await encryptFor(app, "pw");
    const res = await app.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "138", encryptedPassword }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.token).toBe("tok-1");
    expect(json.user).toEqual({
      id: "u1", name: "138", username: "138",
      phone: null,
      apiKeys: [], activeKeyIndex: -1,
    });
    expect(JSON.stringify(json)).not.toContain("sk-SECRETSECRET");
    expect(svc.tokenhub.login).toHaveBeenCalledWith("138", "pw");
  });

  it("allows login when the account has no api key (empty apiKeys)", async () => {
    const svc = fakeService();
    (svc.tokenhub.login as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 2, name: "138", apiKeys: [],
    });
    (svc.db.upsertUserByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u1", email: null, name: "138", created_at: "t",
      external_user_id: 2, username: "138", api_key: null, api_keys: [],
    });
    const app = createAuthRoutes(svc);
    const encryptedPassword = await encryptFor(app, "pw");
    const res = await app.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "138", encryptedPassword }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.token).toBe("tok-1");
    expect(json.user).toMatchObject({ apiKeys: [], activeKeyIndex: -1 });
  });

  it("returns generic 401 when tokenhub login fails", async () => {
    const svc = fakeService();
    (svc.tokenhub.login as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("tokenhub_login_failed"));
    const app = createAuthRoutes(svc);
    const encryptedPassword = await encryptFor(app, "pw");
    const res = await app.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "138", encryptedPassword }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("登录失败，请稍后再试或者联系管理员");
  });

  it("returns generic 401 when decryption fails", async () => {
    const svc = fakeService();
    const app = createAuthRoutes(svc);
    const res = await app.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "138", encryptedPassword: "not-base64-rsa" }),
    });
    expect(res.status).toBe(401);
    expect(svc.tokenhub.login).not.toHaveBeenCalled();
  });
});

describe("auth token-login", () => {
  it("exchanges the token, upserts, returns session token + sanitized user", async () => {
    const svc = fakeService();
    (svc.tokenhub.tokenLogin as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 1, name: "Root", apiKeys: [{ apiKey: "sk-SECRETSECRET", name: "默认令牌", group: "default" }],
    });
    (svc.db.upsertUserByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u1", email: null, name: "Root", created_at: "t",
      external_user_id: 1, username: "Root", api_key: "sk-SECRETSECRET",
      api_keys: [{ apiKey: "sk-SECRETSECRET", name: "默认令牌", group: "default" }],
    });
    const app = createAuthRoutes(svc);
    const res = await app.request("/token-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "jwt.abc.def" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.token).toBe("tok-1");
    expect(json.user).toMatchObject({ id: "u1", username: "Root" });
    expect(JSON.stringify(json)).not.toContain("sk-SECRETSECRET");
    expect(svc.tokenhub.tokenLogin).toHaveBeenCalledWith("jwt.abc.def");
    expect(svc.db.upsertUserByExternalId).toHaveBeenCalledWith({
      externalUserId: 1, username: "Root",
      apiKeys: [{ apiKey: "sk-SECRETSECRET", name: "默认令牌", group: "default" }],
    });
  });

  it("returns generic 401 when the token is missing", async () => {
    const svc = fakeService();
    const app = createAuthRoutes(svc);
    const res = await app.request("/token-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("登录失败，请稍后再试或者联系管理员");
    expect(svc.tokenhub.tokenLogin).not.toHaveBeenCalled();
  });

  it("returns generic 401 when tokenhub token-login fails", async () => {
    const svc = fakeService();
    (svc.tokenhub.tokenLogin as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("tokenhub_token_login_failed")
    );
    const app = createAuthRoutes(svc);
    const res = await app.request("/token-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "bad" }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("登录失败，请稍后再试或者联系管理员");
  });
});

describe("managed contact verification", () => {
  it("requires an email and verification code for registration", async () => {
    const svc = fakeManagedService();
    const res = await createAuthRoutes(svc).request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", encryptedPassword: "not-used" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("注册必须绑定邮箱并完成邮箱验证");
    expect(svc.tokenhub.registerAgentUser).not.toHaveBeenCalled();
  });

  it("blocks an occupied email before reporting a code as sent", async () => {
    const svc = fakeManagedService();
    (svc.tokenhub.sendAgentEmailVerification as ReturnType<typeof vi.fn>).mockRejectedValue(
      new TokenhubClientError("new_api_email_verification_failed", "email_taken")
    );
    const res = await createAuthRoutes(svc).request("/verification/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "used@example.com" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "该邮箱已被其他用户使用", code: "email_taken" });
  });

  it("forwards password reset requests to new-api with the public Lot Agent page", async () => {
    const svc = fakeManagedService();
    (svc.tokenhub.sendAgentPasswordResetEmail as ReturnType<typeof vi.fn>).mockResolvedValue({
      expiresIn: 600,
      resendAfter: 60,
    });
    const res = await createAuthRoutes(svc).request("/password-reset/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://lot.example",
      },
      body: JSON.stringify({ email: "alice@example.com" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, expiresIn: 600 });
    expect(svc.tokenhub.sendAgentPasswordResetEmail).toHaveBeenCalledWith(
      "alice@example.com",
      "https://lot.example/reset-password"
    );
  });

  it("forwards password reset confirmation to new-api", async () => {
    const svc = fakeManagedService();
    const res = await createAuthRoutes(svc).request("/password-reset/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "alice@example.com",
        token: "reset-token",
        password: "password2",
        confirmPassword: "password2",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(svc.tokenhub.resetAgentPassword).toHaveBeenCalledWith({
      email: "alice@example.com",
      token: "reset-token",
      password: "password2",
      confirmPassword: "password2",
    });
  });

  it("passes both optional bindings and their codes to managed registration", async () => {
    const svc = fakeManagedService();
    (svc.tokenhub.registerAgentUser as ReturnType<typeof vi.fn>).mockResolvedValue(managedResult);
    (svc.db.upsertManagedUser as ReturnType<typeof vi.fn>).mockResolvedValue(storedManagedUser);
    const app = createAuthRoutes(svc);
    const encryptedPassword = await encryptFor(app, "password1");
    const res = await app.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "alice",
        encryptedPassword,
        email: "alice@example.com",
        emailVerificationCode: "123456",
        phone: "13800138000",
        phoneVerificationCode: "654321",
        requestId: "req-1",
      }),
    });
    expect(res.status).toBe(200);
    expect(svc.tokenhub.registerAgentUser).toHaveBeenCalledWith(expect.objectContaining({
      email: "alice@example.com",
      emailVerificationCode: "123456",
      phone: "13800138000",
      phoneVerificationCode: "654321",
    }));
  });

  it("creates a local session after phone-code authentication", async () => {
    const svc = fakeManagedService();
    (svc.tokenhub.authenticateAgentUserByPhone as ReturnType<typeof vi.fn>).mockResolvedValue(managedResult);
    (svc.db.upsertManagedUser as ReturnType<typeof vi.fn>).mockResolvedValue(storedManagedUser);
    const res = await createAuthRoutes(svc).request("/phone-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13800138000", verificationCode: "123456" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ token: "tok-managed", user: { id: "u7", username: "alice" } });
    expect(svc.tokenhub.authenticateAgentUserByPhone).toHaveBeenCalledWith("13800138000", "123456");
  });

  it("binds a phone only for the managed user resolved from the local session", async () => {
    const svc = fakeManagedService();
    (svc.tokenhub.sendAgentPhoneBindingVerification as ReturnType<typeof vi.fn>).mockResolvedValue({
      expiresIn: 600,
      resendAfter: 60,
    });
    (svc.tokenhub.bindAgentPhone as ReturnType<typeof vi.fn>).mockResolvedValue({ phone: "13800138000" });
    const app = createAuthRoutes(svc);

    const send = await app.request("/phone-binding/verification", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer local-session" },
      body: JSON.stringify({ phone: "13800138000" }),
    });
    expect(send.status).toBe(200);
    expect(svc.tokenhub.sendAgentPhoneBindingVerification).toHaveBeenCalledWith(7, "13800138000");

    const bind = await app.request("/phone-binding", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer local-session" },
      body: JSON.stringify({ phone: "13800138000", verificationCode: "123456" }),
    });
    expect(bind.status).toBe(200);
    expect(await bind.json()).toEqual({ ok: true, phone: "138****8000" });
    expect(svc.tokenhub.bindAgentPhone).toHaveBeenCalledWith(7, "13800138000", "123456");
    expect(svc.db.updateUserPhone).toHaveBeenCalledWith("u7", "13800138000");
  });

  it("rejects phone binding without a valid local session", async () => {
    const svc = fakeManagedService();
    (svc.sessions.resolve as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await createAuthRoutes(svc).request("/phone-binding", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer expired" },
      body: JSON.stringify({ phone: "13800138000", verificationCode: "123456" }),
    });
    expect(res.status).toBe(401);
    expect(svc.tokenhub.bindAgentPhone).not.toHaveBeenCalled();
  });

  it("updates tokenhub display_name and the local name cache", async () => {
    const svc = fakeManagedService();
    (svc.db.getUserById as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...storedManagedUser,
      external_user_id: 7,
    });
    (svc.tokenhub.updateAgentDisplayName as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 7, username: "alice", displayName: "印社老板",
    });
    (svc.db.updateUserDisplayName as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...storedManagedUser,
      name: "印社老板",
    });
    const res = await createAuthRoutes(svc).request("/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok-managed" },
      body: JSON.stringify({ displayName: "  印社老板  " }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, user: { name: "印社老板" } });
    expect(svc.tokenhub.updateAgentDisplayName).toHaveBeenCalledWith(7, "印社老板");
    expect(svc.db.updateUserDisplayName).toHaveBeenCalledWith("u7", "印社老板");
  });
});

describe("auth mode", () => {
  it("reports debug off when the service is not in debug mode", async () => {
    vi.stubEnv("WECHAT_MP_APPID", "");
    vi.stubEnv("WECHAT_MP_SECRET", "");
    const svc = fakeService();
    (svc as { debug: boolean }).debug = false;
    const app = createAuthRoutes(svc);
    const res = await app.request("/mode");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      debug: false,
      user: null,
      managedRegistration: false,
      wechatLogin: false,
    });
  });

  it("returns the sanitized debug user when in debug mode", async () => {
    const svc = fakeService();
    (svc as { debug: boolean; debugUserId: string }).debug = true;
    (svc as { debugUserId: string }).debugUserId = "u-debug";
    (svc.db as { getUserById: ReturnType<typeof vi.fn> }).getUserById = vi
      .fn()
      .mockResolvedValue({
        id: "u-debug", email: null, name: "debug", created_at: "t",
        external_user_id: 0, username: "debug", api_key: null, api_keys: [],
      });
    const app = createAuthRoutes(svc);
    const res = await app.request("/mode");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.debug).toBe(true);
    expect(json.user).toMatchObject({ id: "u-debug", username: "debug" });
  });
});

describe("wechat mini program login", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns 404 when WeChat credentials are not configured", async () => {
    vi.stubEnv("WECHAT_MP_APPID", "");
    vi.stubEnv("WECHAT_MP_SECRET", "");
    const res = await createAuthRoutes(fakeManagedService()).request("/wechat-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "abc" }),
    });
    expect(res.status).toBe(404);
  });

  it("creates a tokenhub wx_mini account for an unknown openid", async () => {
    vi.stubEnv("WECHAT_MP_APPID", "wxapp");
    vi.stubEnv("WECHAT_MP_SECRET", "secret");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ openid: "o-new", unionid: "u-new" }),
    })));
    const svc = fakeManagedService();
    (svc.tokenhub.authenticateWechatMiniUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...managedResult,
      username: "wx_mini_8",
      name: "wx_mini",
      created: true,
    });
    (svc.db.upsertManagedUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...storedManagedUser,
      username: "wx_mini_8",
      name: "wx_mini",
    });
    (svc.db as { bindUserWechat?: ReturnType<typeof vi.fn> }).bindUserWechat = vi
      .fn()
      .mockResolvedValue("ok");
    const res = await createAuthRoutes(svc).request("/wechat-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "fresh" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.token).toBe("tok-managed");
    expect(json.user).toMatchObject({ username: "wx_mini_8", name: "wx_mini" });
    expect(json.needBind).toBeUndefined();
    expect(svc.tokenhub.authenticateWechatMiniUser).toHaveBeenCalledWith("o-new", "u-new");
    expect((svc.db as { bindUserWechat: ReturnType<typeof vi.fn> }).bindUserWechat)
      .toHaveBeenCalledWith("u7", "o-new", "u-new");
  });

  it("binds a WeChat phone number onto the current mini-program user", async () => {
    vi.stubEnv("WECHAT_MP_APPID", "wxapp");
    vi.stubEnv("WECHAT_MP_SECRET", "secret");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("cgi-bin/token")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "at", expires_in: 7200 }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ phone_info: { purePhoneNumber: "13800138000" } }),
      };
    }));
    const svc = fakeManagedService();
    (svc.db.getUserById as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...storedManagedUser,
      wechat_openid: "o-mini",
    });
    (svc.tokenhub.bindWechatMiniPhone as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...managedResult,
      adopted: false,
    });
    const res = await createAuthRoutes(svc).request("/wechat-phone-bind", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok-managed" },
      body: JSON.stringify({ code: "phone-code" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, adopted: false });
    expect(svc.tokenhub.bindWechatMiniPhone).toHaveBeenCalledWith(7, "13800138000");
    expect(svc.db.updateUserPhone).toHaveBeenCalledWith("u7", "13800138000");
  });

  it("asks for confirmation when the phone belongs to another account", async () => {
    vi.stubEnv("WECHAT_MP_APPID", "wxapp");
    vi.stubEnv("WECHAT_MP_SECRET", "secret");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("cgi-bin/token")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "at", expires_in: 7200 }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ phone_info: { purePhoneNumber: "13900139000" } }),
      };
    }));
    const svc = fakeManagedService();
    (svc.db.getUserById as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...storedManagedUser,
      wechat_openid: "o-mini",
    });
    (svc.tokenhub.bindWechatMiniPhone as ReturnType<typeof vi.fn>).mockRejectedValue(
      new TokenhubMergeRequiredError({
        needsConfirm: true,
        phone: "13900139000",
        from: {
          userId: 7, username: "wx_mini_8", displayName: "wx_mini",
          quota: 2000, quotaAmount: 0.004, managedRemainQuota: 1500, managedRemainAmount: 0.003,
        },
        to: {
          userId: 99, username: "phone-owner", displayName: "Phone Owner",
          quota: 5000, quotaAmount: 0.01, managedRemainQuota: 0, managedRemainAmount: 0,
        },
      })
    );
    (svc.db.countUserOwnedRecords as ReturnType<typeof vi.fn>).mockResolvedValue({
      conversations: 2, assets: 1, tasks: 0,
    });
    const res = await createAuthRoutes(svc).request("/wechat-phone-bind", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok-managed" },
      body: JSON.stringify({ code: "phone-code" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { needConfirm: boolean; ticket: string; merge: Record<string, unknown> };
    expect(json.needConfirm).toBe(true);
    expect(typeof json.ticket).toBe("string");
    expect(json.merge).toMatchObject({
      targetName: "Phone Owner",
      conversations: 2,
      assets: 1,
      currentAccountWillBeDisabled: true,
    });
    expect(svc.tokenhub.mergeWechatMiniPhone).not.toHaveBeenCalled();
  });

  it("merges quota, local data and disables the wx_mini account after confirm", async () => {
    vi.stubEnv("WECHAT_MP_APPID", "wxapp");
    vi.stubEnv("WECHAT_MP_SECRET", "secret");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("cgi-bin/token")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "at", expires_in: 7200 }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ phone_info: { purePhoneNumber: "13900139000" } }),
      };
    }));
    const svc = fakeManagedService();
    (svc.db.getUserById as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...storedManagedUser,
      wechat_openid: "o-mini",
    });
    (svc.tokenhub.bindWechatMiniPhone as ReturnType<typeof vi.fn>).mockRejectedValue(
      new TokenhubMergeRequiredError({
        needsConfirm: true,
        phone: "13900139000",
        from: {
          userId: 7, username: "wx_mini_8", displayName: "wx_mini",
          quota: 2000, quotaAmount: 0.004, managedRemainQuota: 1500, managedRemainAmount: 0.003,
        },
        to: {
          userId: 99, username: "phone-owner", displayName: "Phone Owner",
          quota: 5000, quotaAmount: 0.01, managedRemainQuota: 0, managedRemainAmount: 0,
        },
      })
    );
    const preview = await createAuthRoutes(svc).request("/wechat-phone-bind", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok-managed" },
      body: JSON.stringify({ code: "phone-code" }),
    });
    const { ticket } = await preview.json() as { ticket: string };
    (svc.tokenhub.mergeWechatMiniPhone as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...managedResult,
      userId: 99,
      username: "phone-owner",
      name: "Phone Owner",
      phone: "13900139000",
      adopted: true,
      fromUserId: 7,
      wechatMpOpenid: "o-mini",
    });
    (svc.db.upsertManagedUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...storedManagedUser,
      id: "u99",
      external_user_id: 99,
      username: "phone-owner",
      name: "Phone Owner",
    });
    (svc.db.getUserByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...storedManagedUser,
      id: "u99",
      external_user_id: 99,
    });
    (svc.sessions as { revoke?: ReturnType<typeof vi.fn> }).revoke = vi.fn().mockResolvedValue(undefined);
    const res = await createAuthRoutes(svc).request("/wechat-phone-bind/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok-managed" },
      body: JSON.stringify({ ticket }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.adopted).toBe(true);
    expect(json.user).toMatchObject({ id: "u99", username: "phone-owner" });
    expect(svc.tokenhub.mergeWechatMiniPhone).toHaveBeenCalledWith(7, "13900139000");
    expect(svc.db.reassignUserOwnedData).toHaveBeenCalledWith("u7", "u99");
    expect(svc.db.deleteLocalUser).toHaveBeenCalledWith("u7");
  });
});
