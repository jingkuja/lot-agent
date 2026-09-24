import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createVideoDraftRoutes } from "./video-drafts.js";
function setup() {
  const service = { generateVideoCopy: vi.fn().mockResolvedValue({ script: "镜头", mainTitle: "标题", subtitle: "副标题", publishTitle: "发布", tags: "#创作" }) };
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => { c.set("userId", "owner"); await next(); });
  app.route("/", createVideoDraftRoutes(service));
  const post = (body: unknown) => app.request("/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { service, post };
}
describe("video draft copy", () => {
  it("uses the authenticated owner, never a caller-supplied identity", async () => {
    const { service, post } = setup();
    expect((await post({ topic: "咖啡店", userId: "other" })).status).toBe(200);
    expect(service.generateVideoCopy).toHaveBeenCalledWith("咖啡店", "owner", expect.any(AbortSignal));
  });
  it.each([null, {}, { topic: 3 }, { topic: " " }, { topic: "x".repeat(1001) }])("rejects invalid input %j before a model call", async body => {
    const { service, post } = setup(); expect((await post(body)).status).toBe(400); expect(service.generateVideoCopy).not.toHaveBeenCalled();
  });
  it("does not expose vendor failures", async () => {
    const { service, post } = setup(); service.generateVideoCopy.mockRejectedValue(new Error("secret vendor error"));
    const res = await post({ topic: "coffee" }); expect(res.status).toBe(502); expect(await res.text()).not.toContain("secret");
  });
});

it("rejects a request without an authenticated owner", async () => {
  const service = { generateVideoCopy: vi.fn() };
  const app = createVideoDraftRoutes(service);
  const response = await app.request("/", { method: "POST", body: JSON.stringify({ topic: "test" }) });
  expect(response.status).toBe(401); expect(service.generateVideoCopy).not.toHaveBeenCalled();
});
