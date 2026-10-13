import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { MarketingDraftSchema, storyboardScript } from "@lot-agent/core/marketing-video";
import { PgMarketingProjectStore, renderKey, reviewText } from "./repository.js";

describe("persisting confirmed marketing shots", () => {
  it("snapshots all directions and reserves the edited narration boundaries", async () => {
    const storyboard = [
      { script: "欢迎来店里。", visual: "吧台特写", action: "端起杯子", camera: "缓慢推进" },
      { script: "享受咖啡时光，看看明亮的空间。", visual: "明亮座位区", action: "轻轻招手", camera: "平稳横移" },
    ];
    const draft = MarketingDraftSchema.parse({ storyboard, script: storyboardScript(storyboard) });
    const row = { id: "project", user_id: "owner", version: 2, draft, task_id: null, review: { verdict: "pass", issues: [] }, reviewed_script: reviewText(draft) };
    const query = vi.fn(async (sql: string, _params?: unknown[]) => ({ rows: sql.startsWith("SELECT * FROM marketing_video_projects") ? [row] : [], rowCount: 1 }));
    const client = { query, release: vi.fn() };
    const store = new PgMarketingProjectStore({ connect: async () => client } as unknown as pg.Pool);
    await store.reserve("owner", "project", 2, { modelId: "fixture" }, false);
    const parent = query.mock.calls.find(([sql]) => sql.includes("'marketing.video'"))!;
    expect(JSON.parse(parent[1]![1] as string).draft.storyboard).toEqual(storyboard);
    const segments = query.mock.calls.filter(([sql]) => sql.startsWith("INSERT INTO marketing_video_segments"));
    expect(segments.map(([, params]) => [params![1], params![3], params![4]])).toEqual([[0, storyboard[0].script, 15], [1, storyboard[1].script, 15]]);
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });
  it("keeps old draft rendering keys stable and locks storyboard edits after submission", () => {
    const old = { script: "欢迎到店" };
    expect(renderKey(old as never)).toBe(renderKey(MarketingDraftSchema.parse(old)));
    const draft = MarketingDraftSchema.parse(old);
    expect(renderKey({ ...draft, storyboard: [{ script: "欢迎到店", visual: "店铺", action: "招手", camera: "近景" }] })).not.toBe(renderKey(draft));
  });
});
