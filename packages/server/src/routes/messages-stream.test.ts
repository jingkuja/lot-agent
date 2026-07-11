import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createConversationRoutes } from "./conversations.js";

/** Parse an SSE body into the ordered list of event objects. */
function parseSse(body: string): Record<string, unknown>[] {
  return body
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
}

function fakeService(opts?: { titleDelayMs?: number }) {
  return {
    db: {
      getConversation: vi.fn(async () => ({ id: "c1", user_id: "u1", agent_id: "general" })),
      // Run-lease CAS (report #20 concurrency half) — not the concern of
      // these tests (see conversations-run-lease.test.ts), default to
      // "always claims, no-op release".
      claimConversationRun: vi.fn(async () => true),
      releaseConversationRun: vi.fn(async () => {}),
    },
    streamAgentResponse: vi.fn(async function* () {
      yield { type: "text", content: "请选择" };
      yield {
        type: "tool_call",
        id: "t1",
        name: "ask_user",
        input: { question: "要哪种?", options: ["A", "B"] },
      };
      yield { type: "tool_result", name: "ask_user", output: "[等待用户回答]", isError: false };
      yield { type: "done", iterations: 1, totalTokens: 1, inputTokens: 1, outputTokens: 0 };
    }),
    generateTitle: vi.fn(async () => {
      if (opts?.titleDelayMs) await new Promise((r) => setTimeout(r, opts.titleDelayMs));
      return "标题";
    }),
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

describe("POST /conversations/:id/messages (SSE)", () => {
  it("sends stream_end immediately after the agent turn, before the title", async () => {
    // Title generation is a whole LLM round-trip; if stream_end waited for it,
    // the client would keep the turn locked (ask_user cards unclickable) for
    // seconds after the agent already finished.
    const service = fakeService({ titleDelayMs: 30 });
    const res = await app(service).request("/conversations/c1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "你好" }),
    });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    const types = events.map((e) => e.type);

    const endIdx = types.indexOf("stream_end");
    const titleIdx = types.indexOf("title");
    expect(endIdx).toBeGreaterThan(types.indexOf("done"));
    expect(titleIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeLessThan(titleIdx);
    expect(events[titleIdx].title).toBe("标题");
  });

  it("still closes cleanly when title generation fails", async () => {
    const service = fakeService();
    service.generateTitle = vi.fn(async () => {
      throw new Error("boom");
    });
    const res = await app(service).request("/conversations/c1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "你好" }),
    });
    const types = parseSse(await res.text()).map((e) => e.type);
    expect(types).toContain("done");
    expect(types).toContain("stream_end");
    expect(types).not.toContain("title");
  });
});
