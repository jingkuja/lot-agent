import { describe, it, expect, vi } from "vitest";
import { createAuthRoutes } from "./auth.js";

function fakeService() {
  return {
    tokenhub: { login: vi.fn(), tokenLogin: vi.fn() },
    db: { upsertUserByExternalId: vi.fn() },
    sessions: { createSession: vi.fn().mockResolvedValue("tok-1") },
  } as unknown as import("../services/agent-service.js").AgentService;
}

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

describe("auth mode", () => {
  it("reports debug off when the service is not in debug mode", async () => {
    const svc = fakeService();
    (svc as { debug: boolean }).debug = false;
    const app = createAuthRoutes(svc);
    const res = await app.request("/mode");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ debug: false, user: null });
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
