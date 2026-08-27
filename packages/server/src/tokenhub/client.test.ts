import { describe, it, expect, vi } from "vitest";
import { TokenhubClient, TokenhubClientError } from "./client.js";
import { createHash, createHmac } from "node:crypto";

const ok = (data: unknown) =>
  ({ ok: true, json: async () => ({ data, success: true }) }) as Response;
const fail = () =>
  ({ ok: true, json: async () => ({ data: null, success: false, message: "bad" }) }) as Response;

describe("TokenhubClient", () => {
  it("sends registration bindings and both verification codes through the signed control plane", async () => {
    const f = vi.fn().mockResolvedValue(ok({
      user_id: 7,
      username: "alice",
      display_name: "Alice",
      phone: "13800138000",
      managed_key: { token_id: 9, api_key: "managed-secret", credential_version: 2, remain_quota: 0 },
      created: true,
    }));
    const c = new TokenhubClient(
      "https://h/api/agent-market",
      f as unknown as typeof fetch,
      "",
      "https://h/api/internal",
      "lot-agent",
      "control-secret"
    );
    await c.registerAgentUser({
      requestId: "req-1",
      username: "alice",
      password: "password1",
      email: "alice@example.com",
      emailVerificationCode: "123456",
      phone: "13800138000",
      phoneVerificationCode: "654321",
    });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://h/api/internal/agent-users/register");
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      email: "alice@example.com",
      email_verification_code: "123456",
      phone: "13800138000",
      phone_verification_code: "654321",
    });
  });

  it("preserves safe upstream error codes for the Lot Agent route to translate", async () => {
    const f = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ data: null, success: false, code: "email_taken", message: "occupied" }),
    } as Response);
    const c = new TokenhubClient(
      "https://h/api/agent-market",
      f as unknown as typeof fetch,
      "",
      "https://h/api/internal",
      "lot-agent",
      "control-secret"
    );
    const error = await c.sendAgentEmailVerification("used@example.com").catch((err) => err);
    expect(error).toBeInstanceOf(TokenhubClientError);
    expect(error.code).toBe("email_taken");
  });

  it("sends password reset email requests through the signed control plane", async () => {
    const f = vi.fn().mockResolvedValue(ok({ expires_in: 600, resend_after: 60 }));
    const c = new TokenhubClient(
      "https://h/api/agent-market",
      f as unknown as typeof fetch,
      "",
      "https://h/api/internal",
      "lot-agent",
      "control-secret"
    );
    await expect(c.sendAgentPasswordResetEmail("alice@example.com", "https://lot.example/reset-password"))
      .resolves.toEqual({ expiresIn: 600, resendAfter: 60 });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://h/api/internal/agent-users/password-reset");
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      owner_app: "lot-agent",
      email: "alice@example.com",
      reset_url: "https://lot.example/reset-password",
    });
  });

  it("confirms password reset through the signed control plane", async () => {
    const f = vi.fn().mockResolvedValue(ok(true));
    const c = new TokenhubClient(
      "https://h/api/agent-market",
      f as unknown as typeof fetch,
      "",
      "https://h/api/internal",
      "lot-agent",
      "control-secret"
    );
    await expect(c.resetAgentPassword({
      email: "alice@example.com",
      token: "reset-token",
      password: "password2",
      confirmPassword: "password2",
    })).resolves.toBeUndefined();
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://h/api/internal/agent-users/password-reset/confirm");
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      owner_app: "lot-agent",
      email: "alice@example.com",
      token: "reset-token",
      password: "password2",
      confirm_password: "password2",
    });
  });

  it("authenticates a phone verification code through the signed control plane", async () => {
    const f = vi.fn().mockResolvedValue(ok({
      user_id: 7,
      username: "alice",
      display_name: "Alice",
      phone: "13800138000",
      managed_key: { token_id: 9, api_key: "managed-secret", credential_version: 2, remain_quota: 0 },
      created: false,
    }));
    const c = new TokenhubClient(
      "https://h/api/agent-market",
      f as unknown as typeof fetch,
      "",
      "https://h/api/internal",
      "lot-agent",
      "control-secret"
    );
    await expect(c.authenticateAgentUserByPhone("13800138000", "123456")).resolves.toMatchObject({
      userId: 7,
      username: "alice",
      phone: "13800138000",
    });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://h/api/internal/agent-users/authenticate-phone");
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      phone: "13800138000",
      verification_code: "123456",
    });
  });

  it("sends and confirms a phone binding for the authenticated managed user", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(ok({ expires_in: 600, resend_after: 60 }))
      .mockResolvedValueOnce(ok({ phone: "13800138000" }));
    const c = new TokenhubClient(
      "https://h/api/agent-market",
      f as unknown as typeof fetch,
      "",
      "https://h/api/internal",
      "lot-agent",
      "control-secret"
    );

    await expect(c.sendAgentPhoneBindingVerification(7, "13800138000")).resolves.toEqual({
      expiresIn: 600,
      resendAfter: 60,
    });
    await expect(c.bindAgentPhone(7, "13800138000", "123456")).resolves.toEqual({ phone: "13800138000" });

    expect(f.mock.calls[0][0]).toBe("https://h/api/internal/agent-users/verification/phone/bind");
    expect(JSON.parse(String((f.mock.calls[0][1] as RequestInit).body))).toMatchObject({
      user_id: 7,
      phone: "13800138000",
    });
    expect(f.mock.calls[1][0]).toBe("https://h/api/internal/agent-users/bind-phone");
    expect(JSON.parse(String((f.mock.calls[1][1] as RequestInit).body))).toMatchObject({
      user_id: 7,
      phone: "13800138000",
      verification_code: "123456",
    });
  });

  it("login maps a successful response with only api_key", async () => {
    const f = vi.fn().mockResolvedValue(
      ok({ user_id: 2, name: "13881071870", api_key: "sk-X", access_token: "sk-X" })
    );
    const c = new TokenhubClient("https://h/api/agent-market", f as unknown as typeof fetch);
    await expect(c.login("13881071870", "pw")).resolves.toEqual({
      userId: 2,
      name: "13881071870",
      apiKeys: [{ apiKey: "sk-X" }],
    });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://h/api/agent-market/auth/login");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      username: "13881071870",
      password: "pw",
    });
  });

  it("login maps bare-string api_keys array (legacy tokenhub shape)", async () => {
    const f = vi.fn().mockResolvedValue(
      ok({ user_id: 2, name: "138", api_key: "sk-A", api_keys: ["sk-A", "sk-B"], access_token: "sk-A" })
    );
    const c = new TokenhubClient("https://h/api/agent-market", f as unknown as typeof fetch);
    await expect(c.login("138", "pw")).resolves.toEqual({
      userId: 2, name: "138", apiKeys: [{ apiKey: "sk-A" }, { apiKey: "sk-B" }],
    });
  });

  it("login maps api_keys objects with name/group", async () => {
    const f = vi.fn().mockResolvedValue(
      ok({
        user_id: 2,
        name: "138",
        api_key: "sk-A",
        api_keys: [
          { api_key: "sk-A", name: "开放API密钥", group: "" },
          { api_key: "sk-B", name: "test", group: "agent2_demo" },
        ],
        access_token: "sk-A",
      })
    );
    const c = new TokenhubClient("https://h/api/agent-market", f as unknown as typeof fetch);
    await expect(c.login("138", "pw")).resolves.toEqual({
      userId: 2,
      name: "138",
      apiKeys: [
        { apiKey: "sk-A", name: "开放API密钥" },
        { apiKey: "sk-B", name: "test", group: "agent2_demo" },
      ],
    });
  });

  it("login falls back to [{apiKey}] when api_keys absent", async () => {
    const f = vi.fn().mockResolvedValue(ok({ user_id: 2, name: "138", api_key: "sk-A" }));
    const c = new TokenhubClient("https://h/api/agent-market", f as unknown as typeof fetch);
    await expect(c.login("138", "pw")).resolves.toEqual({
      userId: 2, name: "138", apiKeys: [{ apiKey: "sk-A" }],
    });
  });

  it("login yields [] when neither api_keys nor api_key present", async () => {
    const f = vi.fn().mockResolvedValue(ok({ user_id: 2, name: "138" }));
    const c = new TokenhubClient("https://h/api/agent-market", f as unknown as typeof fetch);
    await expect(c.login("138", "pw")).resolves.toEqual({ userId: 2, name: "138", apiKeys: [] });
  });

  it("login throws generic error on success:false", async () => {
    const c = new TokenhubClient("https://h/api/agent-market", vi.fn().mockResolvedValue(fail()) as unknown as typeof fetch);
    await expect(c.login("u", "p")).rejects.toThrow("tokenhub_login_failed");
  });

  it("login throws generic error on network failure", async () => {
    const c = new TokenhubClient("https://h/api/agent-market", vi.fn().mockRejectedValue(new Error("ECONN")) as unknown as typeof fetch);
    await expect(c.login("u", "p")).rejects.toThrow("tokenhub_login_failed");
  });

  it("tokenLogin maps a successful response and normalizes api_keys", async () => {
    const f = vi.fn().mockResolvedValue(
      ok({
        user_id: 1,
        name: "Root",
        api_key: "sk-xxx",
        api_keys: [{ api_key: "sk-xxx", name: "默认令牌", group: "default" }],
        access_token: "sk-xxx",
      })
    );
    const c = new TokenhubClient("https://h/api/agent-market", f as unknown as typeof fetch);
    await expect(c.tokenLogin("jwt.abc.def")).resolves.toEqual({
      userId: 1,
      name: "Root",
      apiKeys: [{ apiKey: "sk-xxx", name: "默认令牌", group: "default" }],
    });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://h/api/agent-market/auth/token-login");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ token: "jwt.abc.def" });
  });

  it("tokenLogin sends the agent key as a Bearer header when configured", async () => {
    const f = vi.fn().mockResolvedValue(ok({ user_id: 1, name: "Root", api_key: "sk-xxx" }));
    const c = new TokenhubClient("https://h/api/agent-market", f as unknown as typeof fetch, "agent-secret");
    await c.tokenLogin("jwt.abc.def");
    const [, init] = f.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer agent-secret",
    });
  });

  it("tokenLogin omits the Authorization header when no agent key is set", async () => {
    const f = vi.fn().mockResolvedValue(ok({ user_id: 1, name: "Root", api_key: "sk-xxx" }));
    const c = new TokenhubClient("https://h/api/agent-market", f as unknown as typeof fetch);
    await c.tokenLogin("jwt.abc.def");
    const [, init] = f.mock.calls[0];
    expect((init as RequestInit).headers).not.toHaveProperty("Authorization");
  });

  it("tokenLogin throws generic error on success:false", async () => {
    const c = new TokenhubClient("https://h/api/agent-market", vi.fn().mockResolvedValue(fail()) as unknown as typeof fetch);
    await expect(c.tokenLogin("bad")).rejects.toThrow("tokenhub_token_login_failed");
  });

  it("tokenLogin throws generic error on network failure", async () => {
    const c = new TokenhubClient("https://h/api/agent-market", vi.fn().mockRejectedValue(new Error("ECONN")) as unknown as typeof fetch);
    await expect(c.tokenLogin("t")).rejects.toThrow("tokenhub_token_login_failed");
  });

  it("listModels returns the three buckets", async () => {
    const f = vi.fn().mockResolvedValue(ok({ llm: ["gpt-5.4"], image: ["gpt-image-2"], video: ["veo3.1"] }));
    const c = new TokenhubClient("https://h/api/agent-market", f as unknown as typeof fetch);
    await expect(c.listModels("sk-X")).resolves.toEqual({
      llm: ["gpt-5.4"], image: ["gpt-image-2"], video: ["veo3.1"],
    });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://h/api/agent-market/models");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer sk-X" });
  });

  it("authenticates through the signed internal control plane and maps only the managed key", async () => {
    const f = vi.fn().mockResolvedValue(ok({
      user_id: 7,
      username: "alice",
      display_name: "Alice",
      managed_key: {
        token_id: 9,
        api_key: "managed-secret",
        credential_version: 2,
        remain_quota: 123,
      },
      created: false,
    }));
    const c = new TokenhubClient(
      "https://h/api/agent-market",
      f as unknown as typeof fetch,
      "",
      "https://h/api/internal",
      "lot-agent",
      "control-secret"
    );
    await expect(c.authenticateAgentUser("alice", "password1")).resolves.toMatchObject({
      userId: 7,
      username: "alice",
      managedKey: { tokenId: 9, apiKey: "managed-secret", credentialVersion: 2 },
    });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://h/api/internal/agent-users/authenticate");
    const headers = (init as RequestInit).headers as Record<string, string>;
    const body = String((init as RequestInit).body);
    const canonical = [
      "POST",
      "/api/internal/agent-users/authenticate",
      headers["X-Internal-Timestamp"],
      headers["X-Internal-Nonce"],
      createHash("sha256").update(body).digest("hex"),
    ].join("\n");
    expect(headers["X-Internal-Client-Id"]).toBe("lot-agent");
    expect(headers["X-Internal-Signature"]).toBe(
      createHmac("sha256", "control-secret").update(canonical).digest("hex")
    );
    expect(body).not.toContain("managed-secret");
  });

  it("creates a managed recharge order through New API's signed payment control plane", async () => {
    const f = vi.fn().mockResolvedValue(ok({
      transaction_id: "LOT7abc",
      status: "pending",
      payment_method: "wxpay",
      payment_kind: "qrcode",
      code_url: "weixin://wxpay/bizpayurl?pr=test",
      order_source: "lot-agent",
    }));
    const c = new TokenhubClient(
      "https://h/api/agent-market",
      f as unknown as typeof fetch,
      "",
      "https://h/api/internal",
      "lot-agent",
      "control-secret"
    );
    await expect(c.createManagedRechargeOrder({
      userId: 7,
      points: 1_000,
      paymentMethod: "alipay",
    })).resolves.toMatchObject({
      transactionId: "LOT7abc",
      status: "pending",
      orderSource: "lot-agent",
      paymentMethod: "wxpay",
      paymentKind: "qrcode",
      codeUrl: "weixin://wxpay/bizpayurl?pr=test",
    });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://h/api/internal/agent-managed-recharge/orders");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      owner_app: "lot-agent",
      user_id: 7,
      points: 1_000,
      payment_method: "alipay",
    });
    expect((init as RequestInit).headers).toMatchObject({ "X-Internal-Client-Id": "lot-agent" });
  });

  it("loads the New API payment methods available to Lot Agent", async () => {
    const f = vi.fn().mockResolvedValue(ok({
      enabled: true,
      pay_methods: [
        { name: "支付宝", type: "alipay", color: "blue" },
        { name: "微信支付", type: "wxpay" },
        { name: "invalid" },
      ],
      amount_discount: { "1000": 0.95, invalid: 0.5, "5000": 1.2 },
    }));
    const c = new TokenhubClient(
      "https://h/api/agent-market",
      f as unknown as typeof fetch,
      "",
      "https://h/api/internal",
      "lot-agent",
      "control-secret"
    );
    await expect(c.getManagedRechargeInfo(7)).resolves.toEqual({
      enabled: true,
      paymentMethods: [
        { name: "支付宝", type: "alipay" },
        { name: "微信支付", type: "wxpay" },
      ],
      amountDiscount: { "1000": 0.95 },
    });
    expect(f.mock.calls[0][0]).toBe("https://h/api/internal/agent-managed-recharge/info?owner_app=lot-agent&user_id=7");
  });

  it("maps an Alipay recharge order to a redirect URL", async () => {
    const f = vi.fn().mockResolvedValue(ok({
      transaction_id: "LOT-alipay",
      status: "pending",
      payment_method: "alipay",
      payment_kind: "redirect",
      pay_url: "https://pay.example.com/alipay/order",
    }));
    const c = new TokenhubClient(
      "https://h/api/agent-market",
      f as unknown as typeof fetch,
      "",
      "https://h/api/internal",
      "lot-agent",
      "control-secret"
    );
    await expect(c.createManagedRechargeOrder({
      userId: 7,
      points: 1_000,
      paymentMethod: "alipay",
    })).resolves.toMatchObject({
      paymentMethod: "alipay",
      paymentKind: "redirect",
      payUrl: "https://pay.example.com/alipay/order",
    });
  });

  it("reads managed balance as monetary amounts for lot-agent", async () => {
    const f = vi.fn().mockResolvedValue(ok({
      user_id: 7,
      token_id: 9,
      remain_quota: 1_500_000,
      used_quota: 500_000,
      remain_amount: 3,
      used_amount: 1,
      recharged_amount: 10,
      status: "active",
      credential_version: 1,
      policy_revision: 1,
      allow_balance_fallback: false,
    }));
    const c = new TokenhubClient(
      "https://h/api/agent-market",
      f as unknown as typeof fetch,
      "",
      "https://h/api/internal",
      "lot-agent",
      "control-secret"
    );
    await expect(c.getManagedBalance(7)).resolves.toMatchObject({
      remainAmount: 3,
      usedAmount: 1,
      rechargedAmount: 10,
      allowBalanceFallback: false,
    });
  });

  it("updates managed balance fallback without changing the key", async () => {
    const f = vi.fn().mockResolvedValue(ok({ allow_balance_fallback: true }));
    const c = new TokenhubClient(
      "https://h/api/agent-market",
      f as unknown as typeof fetch,
      "",
      "https://h/api/internal",
      "lot-agent",
      "control-secret"
    );

    await expect(c.setManagedBalanceFallback(7, true)).resolves.toBe(true);
    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://h/api/internal/agent-managed-keys/7/balance-fallback");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ owner_app: "lot-agent", enabled: true });
  });
});
