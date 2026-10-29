import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { MarketingDraftSchema, storyboardScript } from "@lot-agent/core/marketing-video";
import { PgMarketingProjectStore, renderKey } from "./repository.js";

describe("persisting confirmed marketing shots", () => {
  it("snapshots all directions and reserves the edited narration boundaries, also for unchecked copy", async () => {
    const storyboard = [
      { durationSec: 6, script: "欢迎来店里。", visual: "吧台特写", action: "端起杯子", camera: "缓慢推进" },
      { durationSec: 11, script: "享受咖啡时光，看看明亮的空间。", visual: "明亮座位区", action: "轻轻招手", camera: "平稳横移" },
    ];
    const draft = MarketingDraftSchema.parse({ durationSec: 17, storyboard, script: storyboardScript(storyboard) });
    const row = { id: "project", user_id: "owner", version: 2, draft, task_id: null, review: null, reviewed_script: null };
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

describe("the last made video of a redone draft", () => {
  const draft = MarketingDraftSchema.parse({ script: "欢迎到店" });
  const PREVIOUS = "SELECT t.id, t.output FROM tasks t WHERE", BASE = "SELECT t.id, t.output FROM tasks c JOIN";
  const read = (status: string, previewOf = false) => {
    const row = { id: "project", user_id: "owner", version: 3, draft, task_id: "redo", status, progress: 40, review: null, reviewed_script: null,
      updated_at: "2026-10-27T00:00:00Z" };
    const query = vi.fn(async (sql: string, _params?: unknown[]) => ({ rows: sql.startsWith("SELECT p.*") ? [row]
      : sql.startsWith(PREVIOUS) || (previewOf && sql.startsWith(BASE)) ? [{ id: "made", output: { assetIds: ["a"], assets: [{ url: "https://cdn.example/made.mp4" }] } }]
        : [] }));
    return { query, store: new PgMarketingProjectStore({ query } as unknown as pg.Pool) };
  };
  it("stays reachable while a redo runs or after it fails", async () => {
    for (const status of ["running", "failed"]) {
      const { query, store } = read(status);
      expect((await store.get("owner", "project"))?.previousResult).toEqual({ taskId: "made", url: "https://cdn.example/made.mp4" });
      expect(query.mock.calls.find(([sql]) => sql.startsWith(PREVIOUS))?.[1]).toEqual(["owner", "project", "redo"]);
    }
  });
  it("is replaced once the redo made its own video", async () => {
    const { query, store } = read("succeeded");
    expect((await store.get("owner", "project"))?.previousResult).toBeUndefined();
    expect(query.mock.calls.some(([sql]) => sql.startsWith(PREVIOUS))).toBe(false);
  });
  it("is the video a preview may replace while the preview waits for a choice", async () => {
    for (const status of ["running", "succeeded"]) {
      const { query, store } = read(status, true);
      const p = await store.get("owner", "project");
      expect(p?.previewBase).toEqual({ taskId: "made", url: "https://cdn.example/made.mp4" });
      expect(p?.previousResult).toBeUndefined();
      expect(query.mock.calls.find(([sql]) => sql.startsWith(BASE))?.[1]).toEqual(["owner", "redo"]);
    }
  });
});

describe("deleting marketing drafts", () => {
  type Busy = { lock: boolean; text: number; analyses: Record<string, unknown>[]; unknown: string[]; inUse: string[] };
  const store = (row: Record<string, unknown> | undefined, options: Partial<Busy> = {}) => {
    const busy: Busy = { lock: true, text: 0, analyses: [], unknown: [], inUse: [], ...options };
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FOR UPDATE OF p")) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      if (sql.includes("FOR UPDATE OF a")) return { rows: busy.analyses, rowCount: busy.analyses.length };
      if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: busy.lock }], rowCount: 1 };
      if (sql.startsWith("SELECT 1 FROM marketing_text_operations")) return { rows: [], rowCount: busy.text };
      if (sql.startsWith("SELECT 1 FROM marketing_analysis_steps")) return { rows: [], rowCount: busy.unknown.includes(params![0] as string) ? 1 : 0 };
      if (sql.startsWith("SELECT 1 FROM marketing_video_projects")) return { rows: [], rowCount: busy.inUse.includes(params![0] as string) ? 1 : 0 };
      if (sql.startsWith("DELETE FROM assets") && sql.includes("marketing_video_key_arts")) return { rows: [{ storage_key: "still.png", size_bytes: 500 }], rowCount: 1 };
      if (sql.startsWith("DELETE FROM assets")) return { rows: [{ storage_key: "final.mp4", size_bytes: 3000 }, { storage_key: "clip.mp4", size_bytes: "1500" }], rowCount: 2 };
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    return { query, client, store: new PgMarketingProjectStore({ connect: async () => client } as unknown as pg.Pool) };
  };
  const analysis = (id: string, status = "ready") => ({ id, source_id: `source-${id}`, status, lease_until: null });
  it("removes the draft, its generated videos and its reference analyses in one transaction", async () => {
    const f = store({ id: "project", task_id: "task", status: "succeeded" }, { analyses: [analysis("current"), analysis("old"), analysis("unknown", "needs_review"), analysis("shared")], unknown: ["unknown"], inUse: ["shared"] });
    expect(await f.store.remove("owner", "project")).toEqual({ files: ["final.mp4", "clip.mp4"], keyArtFiles: ["still.png"], removedBytes: 5000, removedAnalyses: ["current", "old"], keptAnalyses: 2 });
    // Text lock, then the analysis jobs' order: owner lock, analysis rows, project row.
    const at = (match: (sql: string, params?: unknown[]) => boolean) => f.query.mock.calls.findIndex(([sql, params]) => match(sql, params));
    const order = [at((_, params) => params?.[0] === "marketing-text:owner"), at((_, params) => params?.[0] === "media-analysis-budget:owner"),
      at(sql => sql.includes("FOR UPDATE OF a")), at(sql => sql.includes("FOR UPDATE OF p"))];
    expect(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1]))).toBe(true);
    const deletes = f.query.mock.calls.filter(([text]) => text.startsWith("DELETE"));
    expect(deletes.map(([text, params]) => [text.split(/\s+WHERE/)[0], params])).toEqual([
      ["DELETE FROM assets", ["owner", "task", "project"]], ["DELETE FROM assets", ["owner", "project"]],
      ["DELETE FROM marketing_text_operations", ["owner", "project"]], ["DELETE FROM marketing_draft_snapshots", ["owner", "project"]],
      ["DELETE FROM marketing_video_projects", ["owner", "project"]],
      ["DELETE FROM marketing_analysis_revisions", ["current"]], ["DELETE FROM marketing_analysis_revisions", ["old"]]]);
    expect(f.query.mock.calls.filter(([text]) => text.startsWith("UPDATE marketing_reference_analyses SET deleted_at")).map(([, params]) => params)).toEqual([["current"], ["old"]]);
    expect(f.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(f.client.release).toHaveBeenCalledOnce();
  });
  it("does not look for generated videos on a draft that was never submitted, only its key-art stills", async () => {
    const f = store({ id: "project", task_id: null });
    expect(await f.store.remove("owner", "project")).toEqual({ files: [], keyArtFiles: ["still.png"], removedBytes: 500, removedAnalyses: [], keptAnalyses: 0 });
    expect(f.query.mock.calls.filter(([text]) => text.startsWith("DELETE FROM assets")).map(([text]) => text.includes("marketing_video_key_arts"))).toEqual([true]);
  });
  it("refuses missing, generating, finishing or pending creation drafts without deleting", async () => {
    const cases: [Record<string, unknown> | undefined, Partial<Busy>, number][] = [
      [undefined, {}, 404],
      [{ task_id: "task", status: "running" }, {}, 409],
      [{ task_id: "task", status: "cancelled" }, { lock: false }, 409],
      [{ task_id: null }, { text: 1 }, 409],
      [{ task_id: null }, { analyses: [analysis("running", "running")] }, 409],
    ];
    for (const [row, busy, status] of cases) {
      const f = store(row, busy);
      await expect(f.store.remove("owner", "project")).rejects.toMatchObject({ status });
      expect(f.query.mock.calls.some(([sql]) => sql.startsWith("DELETE") || sql.includes("deleted_at=now()"))).toBe(false);
      expect(f.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    }
  });
});

describe("marketing draft space usage", () => {
  it("converts PG sums to numbers", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [{ video_bytes: "52428800", material_bytes: "0" }] }));
    expect(await new PgMarketingProjectStore({ query } as unknown as pg.Pool).usage("owner")).toEqual({ videoBytes: 52428800, materialBytes: 0 });
    expect(query.mock.calls[0][1]).toEqual(["owner"]);
  });
});

describe("paging marketing drafts", () => {
  const row = (id: string, at: string) => ({ id, user_id: "owner", version: 1, draft: {}, updated_at: at, cursor_at: `${at}+00`, status: null });
  it("returns an exact cursor for the next page and escapes search wildcards", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [row("b", "2026-10-20 10:00:00.123456"), row("a", "2026-10-20 09:00:00.5")] }));
    const store = new PgMarketingProjectStore({ query } as unknown as pg.Pool);
    const first = await store.page("owner", { limit: 1, query: " 100%_咖啡 " });
    expect(first.data.map(p => p.id)).toEqual(["b"]);
    expect(JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString())).toEqual(["2026-10-20 10:00:00.123456+00", "b"]);
    expect(query.mock.calls[0][1]).toEqual(["owner", "%100\\%\\_咖啡%", 2]);
    await store.page("owner", { cursor: first.nextCursor });
    expect(query.mock.calls[1][0]).toContain("(p.updated_at, p.id::text) < ($2::timestamptz, $3)");
    expect(query.mock.calls[1][1]).toEqual(["owner", "2026-10-20 10:00:00.123456+00", "b", 21]);
  });
  it("rejects a malformed cursor and caps the page size", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const store = new PgMarketingProjectStore({ query } as unknown as pg.Pool);
    await expect(store.page("owner", { cursor: "not-json" })).rejects.toMatchObject({ status: 400 });
    expect((await store.page("owner", { limit: 500 })).nextCursor).toBeUndefined();
    expect((query.mock.calls[0] as unknown[])[1]).toEqual(["owner", 51]);
  });
});
