import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createConversationRoutes } from "./conversations.js";

/**
 * Report #20 (concurrency half) / architecture #10: two sends into the same
 * conversation must not both run — the route claims a run lease before
 * starting the SSE stream (or before the regenerate delete) and 409s if
 * another run already holds it. These tests exercise the route with a fake
 * `service` (db + streamAgentResponse/generateTitle stubbed), following the
 * fake-service pattern in conversations-regenerate.test.ts.
 */
function fakeService(
  opts: {
    conversationOwner?: string | null;
    claimResult?: boolean;
    deleteResult?: boolean;
    streamThrows?: Error;
    generateTitle?: () => Promise<string | null>;
  } = {}
) {
  const owner = opts.conversationOwner === undefined ? "u1" : opts.conversationOwner;
  const claimConversationRun = vi.fn(async () => opts.claimResult ?? true);
  const releaseConversationRun = vi.fn(async () => {});
  return {
    db: {
      getConversation: vi.fn(async () =>
        owner == null ? null : { id: "c1", user_id: owner, agent_id: "general" }
      ),
      claimConversationRun,
      releaseConversationRun,
      deleteMessagesFromAndAfter: vi.fn(async () => opts.deleteResult ?? true),
      getAsset: vi.fn(async () => null),
    },
    streamAgentResponse: vi.fn(async function* () {
      if (opts.streamThrows) throw opts.streamThrows;
      yield { type: "text", content: "hi" };
      yield { type: "done", totalTokens: 1, inputTokens: 1, outputTokens: 0, cachedPromptTokens: 0 };
    }),
    generateTitle: vi.fn(opts.generateTitle ?? (async () => null)),
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

const sendMessage = (a: Hono, content = "hello") =>
  a.request("/conversations/c1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

const regenerate = (a: Hono, afterMessageId = "m1") =>
  a.request("/conversations/c1/regenerate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ afterMessageId }),
  });

describe("POST /conversations/:id/messages — run lease", () => {
  it("claims the lease, streams, and releases the SAME runId when the stream finishes", async () => {
    const service = fakeService();
    const res = await sendMessage(app(service));
    expect(res.status).toBe(200);
    await res.text(); // drain the SSE body so start()'s finally runs

    expect(service.db.claimConversationRun).toHaveBeenCalledTimes(1);
    expect(service.streamAgentResponse).toHaveBeenCalledTimes(1);
    expect(service.db.releaseConversationRun).toHaveBeenCalledTimes(1);

    const [claimConvId, claimRunId] = service.db.claimConversationRun.mock.calls[0];
    const [releaseConvId, releaseRunId] = service.db.releaseConversationRun.mock.calls[0];
    expect(claimConvId).toBe("c1");
    expect(releaseConvId).toBe("c1");
    expect(releaseRunId).toBe(claimRunId);
  });

  it("releases the lease before title tail work so stream_end really permits the next turn", async () => {
    let activeRunId: string | null = null;
    let finishFirstTitle!: () => void;
    const firstTitlePending = new Promise<void>((resolve) => {
      finishFirstTitle = resolve;
    });
    let titleCalls = 0;
    const service = fakeService({
      generateTitle: async () => {
        titleCalls += 1;
        if (titleCalls === 1) await firstTitlePending;
        return null;
      },
    });
    service.db.claimConversationRun.mockImplementation(async (_id: string, runId: string) => {
      if (activeRunId) return false;
      activeRunId = runId;
      return true;
    });
    service.db.releaseConversationRun.mockImplementation(async (_id: string, runId: string) => {
      if (activeRunId === runId) activeRunId = null;
    });

    const firstResponse = await sendMessage(app(service), "first");
    const firstReader = firstResponse.body!.getReader();
    const decoder = new TextDecoder();
    let firstBody = "";
    while (!firstBody.includes('"type":"stream_end"')) {
      const chunk = await firstReader.read();
      expect(chunk.done).toBe(false);
      firstBody += decoder.decode(chunk.value, { stream: true });
    }

    // The first request is deliberately still blocked in generateTitle. Once
    // stream_end is visible, a follow-up (especially an interactive tool card
    // answer) must nevertheless be able to claim and run immediately.
    const secondResponse = await sendMessage(app(service), "second");
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.text()).toContain('"type":"stream_end"');

    finishFirstTitle();
    await firstReader.read();
    expect(service.streamAgentResponse).toHaveBeenCalledTimes(2);
  });

  it("409s and never starts the stream when the lease is already held", async () => {
    const service = fakeService({ claimResult: false });
    const res = await sendMessage(app(service));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "对话正在处理另一条消息，请稍候再试" });
    expect(service.streamAgentResponse).not.toHaveBeenCalled();
    expect(service.db.releaseConversationRun).not.toHaveBeenCalled();
  });

  it("releases the lease even when the stream throws mid-run", async () => {
    const service = fakeService({ streamThrows: new Error("boom") });
    const res = await sendMessage(app(service));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"type":"error"');
    expect(body).toContain("boom");

    expect(service.db.releaseConversationRun).toHaveBeenCalledTimes(1);
    const [claimConvId, claimRunId] = service.db.claimConversationRun.mock.calls[0];
    const [releaseConvId, releaseRunId] = service.db.releaseConversationRun.mock.calls[0];
    expect(releaseConvId).toBe(claimConvId);
    expect(releaseRunId).toBe(claimRunId);
  });

  it("404s (not the lease path) for a conversation owned by another user, and never claims", async () => {
    const service = fakeService({ conversationOwner: "other" });
    const res = await sendMessage(app(service));
    expect(res.status).toBe(404);
    expect(service.db.claimConversationRun).not.toHaveBeenCalled();
  });
});

describe("POST /conversations/:id/regenerate — run lease", () => {
  it("claims, deletes, and releases on success", async () => {
    const service = fakeService();
    const res = await regenerate(app(service));
    expect(res.status).toBe(200);
    expect(service.db.claimConversationRun).toHaveBeenCalledTimes(1);
    expect(service.db.deleteMessagesFromAndAfter).toHaveBeenCalledWith("c1", "m1");
    expect(service.db.releaseConversationRun).toHaveBeenCalledTimes(1);
  });

  it("409s and never deletes when another run holds the lease", async () => {
    const service = fakeService({ claimResult: false });
    const res = await regenerate(app(service));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "对话正在处理另一条消息，请稍候再试" });
    expect(service.db.deleteMessagesFromAndAfter).not.toHaveBeenCalled();
    expect(service.db.releaseConversationRun).not.toHaveBeenCalled();
  });

  it("releases the lease even when the delete finds no matching boundary (404)", async () => {
    const service = fakeService({ deleteResult: false });
    const res = await regenerate(app(service));
    expect(res.status).toBe(404);
    expect(service.db.releaseConversationRun).toHaveBeenCalledTimes(1);
  });
});
