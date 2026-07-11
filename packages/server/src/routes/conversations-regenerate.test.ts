import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createConversationRoutes } from "./conversations.js";

function fakeService(opts: {
  conversationOwner?: string | null;
  deleteResult?: boolean;
} = {}) {
  const owner = opts.conversationOwner === undefined ? "u1" : opts.conversationOwner;
  return {
    llmConfig: { default: "openai", openai: { model: "gpt-4o-mini" }, anthropic: { model: "claude" } },
    db: {
      getConversation: vi.fn(async () =>
        owner == null ? null : { id: "c1", user_id: owner }
      ),
      deleteMessagesFromAndAfter: vi.fn(async () => opts.deleteResult ?? true),
    },
  } as any;
}

function app(service: any) {
  const a = new Hono<{ Variables: { userId: string } }>();
  a.use("*", async (c, next) => {
    c.set("userId", "u1");
    await next();
  });
  a.route("/conversations", createConversationRoutes(service));
  return a;
}

const regenerate = (a: Hono, afterMessageId: string) =>
  a.request("/conversations/c1/regenerate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ afterMessageId }),
  });

describe("POST /conversations/:id/regenerate", () => {
  it("deletes messages from the given boundary in the caller's own conversation", async () => {
    const service = fakeService();
    const res = await regenerate(app(service), "m1");
    expect(res.status).toBe(200);
    expect(service.db.deleteMessagesFromAndAfter).toHaveBeenCalledWith("c1", "m1");
  });

  it("404s when the conversation belongs to another user", async () => {
    const service = fakeService({ conversationOwner: "other" });
    const res = await regenerate(app(service), "m1");
    expect(res.status).toBe(404);
    expect(service.db.deleteMessagesFromAndAfter).not.toHaveBeenCalled();
  });

  it("404s for an unknown conversation", async () => {
    const service = fakeService({ conversationOwner: null });
    const res = await regenerate(app(service), "m1");
    expect(res.status).toBe(404);
  });

  it("404s when afterMessageId belongs to a different conversation (db reports no match)", async () => {
    const service = fakeService({ deleteResult: false });
    const res = await regenerate(app(service), "some-other-convo-message");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});
