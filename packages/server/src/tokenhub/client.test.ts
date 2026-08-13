import { describe, it, expect, vi } from "vitest";
import { TokenhubClient } from "./client.js";

const ok = (data: unknown) =>
  ({ ok: true, json: async () => ({ data, success: true }) }) as Response;
const fail = () =>
  ({ ok: true, json: async () => ({ data: null, success: false, message: "bad" }) }) as Response;

describe("TokenhubClient", () => {
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
});
