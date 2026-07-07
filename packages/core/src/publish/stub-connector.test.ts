import { describe, it, expect } from "vitest";
import { XiaohongshuConnector } from "./stub-connector.js";

describe("StubConnector (publish v2)", () => {
  it("exchangeToken returns an access token, refresh token and expiry", async () => {
    const c = new XiaohongshuConnector();
    const tok = await c.exchangeToken("code123");
    expect(tok.accessToken).toContain("xiaohongshu");
    expect(tok.refreshToken).toBeTruthy();
    expect(tok.expiresAt).toBeGreaterThan(Date.now());
  });

  it("refreshToken issues a fresh access token", async () => {
    const c = new XiaohongshuConnector();
    const tok = await c.refreshToken("rt-abc");
    expect(tok.accessToken).toBeTruthy();
    expect(tok.expiresAt).toBeGreaterThan(Date.now());
  });

  it("revoke resolves without throwing", async () => {
    const c = new XiaohongshuConnector();
    await expect(c.revoke("user-1")).resolves.toBeUndefined();
  });

  it("publish accepts the extended input (tags/cover/schedule/idempotencyKey) and returns a url", async () => {
    const c = new XiaohongshuConnector();
    const res = await c.publish({
      title: "标题",
      body: "正文",
      assetIds: ["a1"],
      tags: ["#夏天", "#穿搭"],
      coverAssetId: "a1",
      scheduleAt: new Date(Date.now() + 3600_000).toISOString(),
      idempotencyKey: "k-1",
    });
    expect(res.url).toContain("xiaohongshu");
  });
});
