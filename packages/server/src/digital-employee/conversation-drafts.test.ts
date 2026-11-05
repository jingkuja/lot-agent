import { describe, expect, it, vi } from "vitest";
import { ConversationActionDrafts, DRAFT_TTL_MS } from "./conversation-drafts.js";

const row = (status: string) => ({
  id: "d1", user_id: "u1", feature_scope: "employee", kind: "k", payload: { a: 1 }, preview: {}, options: [], status,
  applied_entity_id: status === "applied" ? "e1" : null, created_at: new Date(), expires_at: new Date(Date.now() + 60_000),
});

describe("ConversationActionDrafts", () => {
  it("keeps proposals for seven days", async () => {
    const query = vi.fn(async (_sql: string, params: unknown[]) => ({ rows: [{ ...row("awaiting_confirmation"), expires_at: params[11] }] }));
    const draft = await new ConversationActionDrafts({ query } as any).create({
      userId: "u1", featureScope: "employee", kind: "k", payload: {}, preview: {}, question: "q", options: [],
    });
    expect(DRAFT_TTL_MS).toBe(7 * 24 * 60 * 60 * 1_000);
    expect(Date.parse(draft.expiresAt)).toBeGreaterThan(Date.now() + DRAFT_TTL_MS - 5_000);
  });

  const handlers = () => ({ applied: vi.fn(() => "done"), apply: vi.fn(async () => "fresh") });

  it("applies once it holds the claim", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith("SELECT") ? [row("awaiting_confirmation")] : [{ id: "d1" }] }));
    const steps = handlers();
    await expect(new ConversationActionDrafts({ query } as any).commit("u1", "d1", "k", steps)).resolves.toBe("fresh");
    expect(steps.applied).not.toHaveBeenCalled();
  });

  it("reports the winner's outcome when a racing request already applied it", async () => {
    let reads = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT")) return { rows: [row(++reads === 1 ? "awaiting_confirmation" : "applied")] };
      return { rows: [] };
    });
    const steps = handlers();
    await expect(new ConversationActionDrafts({ query } as any).commit("u1", "d1", "k", steps)).resolves.toBe("done");
    expect(steps.apply).not.toHaveBeenCalled();
  });

  it("says a commit is running rather than writing twice", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith("SELECT") ? [row("awaiting_confirmation")] : [] }));
    const steps = handlers();
    await expect(new ConversationActionDrafts({ query } as any).commit("u1", "d1", "k", steps)).rejects.toThrow("正在处理");
    expect(steps.apply).not.toHaveBeenCalled();
  });

  it("gives the claim back when the commit fails, so the user can retry", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith("SELECT") ? [row("awaiting_confirmation")] : [{ id: "d1" }] }));
    const steps = { applied: vi.fn(), apply: vi.fn(async () => { throw new Error("boom"); }) };
    await expect(new ConversationActionDrafts({ query } as any).commit("u1", "d1", "k", steps)).rejects.toThrow("boom");
    expect(query.mock.calls.at(-1)?.[0]).toContain("claimed_at = NULL");
  });

  it("treats a dismissed draft as no longer valid", async () => {
    const query = vi.fn(async () => ({ rows: [row("dismissed")] }));
    await expect(new ConversationActionDrafts({ query } as any).get("u1", "d1", "k")).rejects.toThrow("失效");
  });
});
