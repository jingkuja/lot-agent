import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { MarketingDraftSchema, storyboardScript } from "@lot-agent/core/marketing-video";
import { PgMarketingProjectStore, renderKey, reviewText } from "./repository.js";

describe("persisting confirmed marketing shots", () => {
  it("snapshots all directions and reserves the edited narration boundaries", async () => {
    const storyboard = [
      { durationSec: 6, script: "欢迎来店里。", visual: "吧台特写", action: "端起杯子", camera: "缓慢推进" },
      { durationSec: 11, script: "享受咖啡时光，看看明亮的空间。", visual: "明亮座位区", action: "轻轻招手", camera: "平稳横移" },
    ];
    const draft = MarketingDraftSchema.parse({ durationSec: 17, storyboard, script: storyboardScript(storyboard) });
    const row = { id: "project", user_id: "owner", version: 2, draft, task_id: null, review: { verdict: "pass", issues: [] }, reviewed_script: reviewText(draft) };
    const query = vi.fn(async (sql: string, _params?: unknown[]) => ({ rows: sql.startsWith("SELECT * FROM marketing_video_projects") ? [row] : [], rowCount: 1 }));
    const client = { query, release: vi.fn() };
    const store = new PgMarketingProjectStore({ connect: async () => client } as unknown as pg.Pool);
    await store.reserve("owner", "project", 2, { modelId: "grok-imagine-video-1.5" }, false);
    const parent = query.mock.calls.find(([sql]) => sql.includes("'marketing.video'"))!;
    expect(JSON.parse(parent[1]![1] as string).draft.storyboard).toEqual(storyboard);
    const segments = query.mock.calls.filter(([sql]) => sql.startsWith("INSERT INTO marketing_video_segments"));
    expect(segments.map(([, params]) => [params![1], params![3], params![4]])).toEqual([[0, storyboard[0].script, 6], [1, storyboard[1].script, 11]]);
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });
  it("keeps old draft rendering keys stable and locks storyboard edits after submission", () => {
    const old = { script: "欢迎到店" };
    expect(renderKey(old as never)).toBe(renderKey(MarketingDraftSchema.parse(old)));
    const draft = MarketingDraftSchema.parse(old);
    expect(renderKey(MarketingDraftSchema.parse({ ...draft, storyboard: [{ script: "欢迎到店", visual: "店铺", action: "招手", camera: "近景" }] }))).not.toBe(renderKey(draft));
  });
});

describe("deleting marketing drafts", () => {
  const store = (row: Record<string, unknown> | undefined, busy = { lock: true, text: 0, analysis: 0 }) => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("FOR UPDATE OF p")) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: busy.lock }], rowCount: 1 };
      if (sql.startsWith("SELECT 1 FROM marketing_text_operations")) return { rows: [], rowCount: busy.text };
      if (sql.startsWith("SELECT 1 FROM marketing_reference_analyses")) return { rows: [], rowCount: busy.analysis };
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    return { query, client, store: new PgMarketingProjectStore({ connect: async () => client } as unknown as pg.Pool) };
  };
  it("removes the owner's operation records and project in one transaction", async () => {
    const f = store({ id: "project", task_id: "task", status: "succeeded" });
    await f.store.remove("owner", "project");
    const deletes = f.query.mock.calls.filter(([sql]) => sql.startsWith("DELETE"));
    expect(deletes.map(([sql, params]) => [sql.split(" WHERE")[0], params])).toEqual([
      ["DELETE FROM marketing_text_operations", ["owner", "project"]], ["DELETE FROM marketing_video_projects", ["owner", "project"]]]);
    expect(f.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(f.client.release).toHaveBeenCalledOnce();
  });
  it("refuses missing, generating, finishing or pending creation drafts without deleting", async () => {
    for (const [row, busy, status] of [
      [undefined, undefined, 404],
      [{ task_id: "task", status: "running" }, undefined, 409],
      [{ task_id: "task", status: "cancelled" }, { lock: false, text: 0, analysis: 0 }, 409],
      [{ task_id: null }, { lock: true, text: 1, analysis: 0 }, 409],
      [{ task_id: null, reference_analysis_id: "analysis" }, { lock: true, text: 0, analysis: 1 }, 409],
    ] as const) {
      const f = store(row, busy);
      await expect(f.store.remove("owner", "project")).rejects.toMatchObject({ status });
      expect(f.query.mock.calls.some(([sql]) => sql.startsWith("DELETE"))).toBe(false);
      expect(f.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    }
  });
});
