import { describe, it, expect, vi } from "vitest";
import { TokenhubClient } from "./client.js";

const ok = (data: unknown) =>
  ({ ok: true, json: async () => ({ data, success: true }) }) as Response;
const fail = () =>
  ({ ok: true, json: async () => ({ data: null, success: false, message: "bad" }) }) as Response;

describe("TokenhubClient", () => {
  it("login maps a successful response", async () => {
    const f = vi.fn().mockResolvedValue(
      ok({ user_id: 2, name: "13881071870", api_key: "sk-X", access_token: "sk-X" })
    );
    const c = new TokenhubClient("https://h/api/agent-market", f as unknown as typeof fetch);
    await expect(c.login("13881071870", "pw")).resolves.toEqual({
      userId: 2,
      name: "13881071870",
      apiKey: "sk-X",
    });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://h/api/agent-market/auth/login");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      username: "13881071870",
      password: "pw",
    });
  });

  it("login throws generic error on success:false", async () => {
    const c = new TokenhubClient("https://h/api/agent-market", vi.fn().mockResolvedValue(fail()) as unknown as typeof fetch);
    await expect(c.login("u", "p")).rejects.toThrow("tokenhub_login_failed");
  });

  it("login throws generic error on network failure", async () => {
    const c = new TokenhubClient("https://h/api/agent-market", vi.fn().mockRejectedValue(new Error("ECONN")) as unknown as typeof fetch);
    await expect(c.login("u", "p")).rejects.toThrow("tokenhub_login_failed");
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
