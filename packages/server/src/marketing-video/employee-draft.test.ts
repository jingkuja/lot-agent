import { describe, expect, it, vi } from "vitest";
import { createEmployeeMarketingDrafts } from "./employee-draft.js";

function fakeStore(existing = false) {
  return { get: vi.fn(async () => (existing ? { id: "old" } : null)), save: vi.fn(async () => ({})) };
}

describe("createEmployeeMarketingDrafts", () => {
  it("writes only the brief", async () => {
    const store = fakeStore();
    await createEmployeeMarketingDrafts({} as never, store as never).create("u1", { requestKey: "k", topic: "代销方案", durationSec: 30, ratio: "1:1" });
    const [owner, , version, draft] = store.save.mock.calls[0] as unknown as [string, string, number, Record<string, unknown>];
    expect([owner, version]).toEqual(["u1", 0]);
    expect(draft).toMatchObject({ topic: "代销方案", durationSec: 30, ratio: "1:1", script: "", storyboard: [] });
  });

  it("gives the same request the same draft and does not write it twice", async () => {
    const first = fakeStore();
    const second = fakeStore(true);
    const a = await createEmployeeMarketingDrafts({} as never, first as never).create("u1", { requestKey: "k", topic: "t" });
    const b = await createEmployeeMarketingDrafts({} as never, second as never).create("u1", { requestKey: "k", topic: "t" });
    expect(a).toEqual({ projectId: b.projectId, reused: false });
    expect(b.reused).toBe(true);
    expect(second.save).not.toHaveBeenCalled();
    expect(a.projectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("keeps accounts apart", async () => {
    const store = fakeStore();
    const drafts = createEmployeeMarketingDrafts({} as never, store as never);
    const a = await drafts.create("u1", { requestKey: "k", topic: "t" });
    const b = await drafts.create("u2", { requestKey: "k", topic: "t" });
    expect(a.projectId).not.toBe(b.projectId);
  });
});
