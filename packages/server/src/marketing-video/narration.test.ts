import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "@lot-agent/core";
import { MarketingDraftSchema, type MarketingSegment } from "@lot-agent/core/marketing-video";
import { frozenNarration, MarketingNarrator, narrationFile, narrationKey } from "./narration.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const twinItemId = "33333333-3333-4333-8333-333333333333";
const voice = { targetModel: "qwen-audio-3.0-tts-plus", voiceId: "voice-1" };
const draft = MarketingDraftSchema.parse({ narration: { twinItemId, instructions: "热情" } });
const segments: MarketingSegment[] = [{ index: 0, script: "第一句", durationSec: 6 }, { index: 1, script: "第二句", durationSec: 6 }];

/** Just enough of PG for the narration table: claim, finish and read. */
function fakePool() {
  const rows = new Map<string, Record<string, any>>();
  const id = (p: unknown[]) => JSON.stringify(p.slice(0, 4));
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.startsWith("SELECT")) {
      const keys = params[2] as string[];
      return { rows: [...rows.values()].filter(row => keys.includes(row.narration_key)), rowCount: 0 };
    }
    if (sql.startsWith("INSERT")) {
      const old = rows.get(id(params));
      if (old) return { rows: [], rowCount: 0 };
      rows.set(id(params), { slot: params[2], narration_key: params[3], status: "running", storage_key: null, duration_ms: null, updated_at: new Date() });
      return { rows: [{}], rowCount: 1 };
    }
    const row = rows.get(id(params));
    if (sql.includes("SET status='running'")) {
      if (!row || row.status === "running") return { rows: [], rowCount: 0 };
      Object.assign(row, { status: "running", storage_key: null, duration_ms: null, updated_at: new Date() });
      return { rows: [{}], rowCount: 1 };
    }
    if (row?.status === "running") {
      Object.assign(row, sql.includes("'succeeded'") ? { status: "succeeded", storage_key: params[4], duration_ms: params[5] } : { status: "failed", error: params[4] });
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  });
  return { rows, query };
}

async function setup(speakAs = vi.fn(async () => ({ audio: new Uint8Array([1, 2, 3]), mime: "audio/wav" }))) {
  const root = await mkdtemp(join(tmpdir(), "marketing-narration-"));
  const pool = fakePool();
  const inspect = vi.fn(async () => ({ audio: true, video: false, duration: 2.5, width: 0, height: 0, fps: 0, format: "wav" }));
  const narrator = new MarketingNarrator(pool as never, root, { ready: vi.fn(async () => voice), speakAs } as never, inspect as never);
  return { root, pool, narrator, speakAs, inspect };
}

describe("marketing twin narration", () => {
  it("records intent, synthesizes each missing shot once as WAV and stores it in the draft's folder", async () => {
    const f = await setup();
    try {
      const result = await f.narrator.synthesize("owner", projectId, draft, segments);
      expect(result).toEqual({ error: "", clips: [{ slot: 0, status: "succeeded", durationMs: 2500 }, { slot: 1, status: "succeeded", durationMs: 2500 }] });
      expect(f.speakAs).toHaveBeenCalledTimes(2);
      expect(f.speakAs).toHaveBeenCalledWith("owner", voice, { text: "第一句", speed: 1, instructions: "热情" }, "wav");
      expect(await readdir(join(f.root, "marketing-narration", projectId))).toHaveLength(2);
      // Unchanged text and voice settings reuse the takes.
      await f.narrator.synthesize("owner", projectId, draft, segments);
      expect(f.speakAs).toHaveBeenCalledTimes(2);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("keeps a moved shot's take and gives a redo of it its own row (assessment M03)", async () => {
    const f = await setup();
    try {
      await f.narrator.synthesize("owner", projectId, draft, segments);
      const swapped = [{ ...segments[1], index: 0 }, { ...segments[0], index: 1 }];
      expect(await f.narrator.status("owner", projectId, draft, swapped)).toEqual([{ slot: 0, status: "succeeded", durationMs: 2500 },
        { slot: 1, status: "succeeded", durationMs: 2500 }]);
      expect((await f.narrator.frozen("owner", projectId, draft, swapped)).map(take => take.slot)).toEqual([0, 1]);
      expect(f.speakAs).toHaveBeenCalledTimes(2);
      // Redoing a borrowed take makes a new one for this place; the shot it came from keeps its own.
      await f.narrator.synthesize("owner", projectId, draft, swapped, [0]);
      expect(f.speakAs).toHaveBeenCalledTimes(3);
      expect(f.pool.rows.size).toBe(3);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("leaves a failed take failed until the user asks for that shot again", async () => {
    const speakAs = vi.fn(async () => { throw new ProviderError("speech", "create", "TRANSPORT_ERROR", {}); });
    const f = await setup(speakAs as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = await f.narrator.synthesize("owner", projectId, draft, segments.slice(0, 1));
      expect(first).toEqual({ clips: [{ slot: 0, status: "failed", error: "配音合成失败，请稍后重新生成该镜配音。" }], error: "配音合成失败，请稍后重新生成该镜配音。" });
      await f.narrator.synthesize("owner", projectId, draft, segments.slice(0, 1));
      expect(speakAs).toHaveBeenCalledOnce();
      await f.narrator.synthesize("owner", projectId, draft, segments.slice(0, 1), [0]);
      expect(speakAs).toHaveBeenCalledTimes(2);
    } finally { warn.mockRestore(); await rm(f.root, { recursive: true, force: true }); }
  });
  it("redoes only failed takes of the named shots with failedOnly", async () => {
    let calls = 0;
    const speakAs = vi.fn(async () => {
      if (calls++ === 1) throw new ProviderError("speech", "create", "TRANSPORT_ERROR", {});
      return { audio: new Uint8Array([1]), mime: "audio/wav" };
    });
    const f = await setup(speakAs as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = await f.narrator.synthesize("owner", projectId, draft, segments);
      expect(first.clips.map(clip => clip.status)).toEqual(["succeeded", "failed"]);
      // A repeated confirmation names both shots; the succeeded take is not paid for again.
      const again = await f.narrator.synthesize("owner", projectId, draft, segments, [0, 1], { failedOnly: true });
      expect(again.clips.map(clip => clip.status)).toEqual(["succeeded", "succeeded"]);
      expect(speakAs).toHaveBeenCalledTimes(3);
      await f.narrator.synthesize("owner", projectId, draft, segments, [0, 1], { failedOnly: true });
      expect(speakAs).toHaveBeenCalledTimes(3);
    } finally { warn.mockRestore(); await rm(f.root, { recursive: true, force: true }); }
  });
  it("claims every take before answering and makes them after it in the background", async () => {
    let finish!: () => void;
    const speakAs = vi.fn(async () => { await new Promise<void>(done => { finish = done; }); return { audio: new Uint8Array([1]), mime: "audio/wav" }; });
    const f = await setup(speakAs as never);
    try {
      const started = await f.narrator.synthesize("owner", projectId, draft, segments.slice(0, 1), [], { background: true });
      expect(started).toEqual({ clips: [{ slot: 0, status: "running" }], error: "" });
      // Asking again while it runs neither waits nor pays again.
      await f.narrator.synthesize("owner", projectId, draft, segments.slice(0, 1), [], { background: true });
      await vi.waitFor(() => expect(speakAs).toHaveBeenCalledOnce());
      finish();
      await f.narrator.settled();
      expect(await f.narrator.status("owner", projectId, draft, segments.slice(0, 1))).toEqual([{ slot: 0, status: "succeeded", durationMs: 2500 }]);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("freezes takes only when every shot has one that fits its duration", async () => {
    const f = await setup();
    try {
      await expect(f.narrator.frozen("owner", projectId, draft, segments)).rejects.toThrow("请先生成全部分镜");
      await f.narrator.synthesize("owner", projectId, draft, segments);
      const takes = await f.narrator.frozen("owner", projectId, draft, segments);
      expect(takes.map(take => [take.slot, take.durationMs])).toEqual([[0, 2500], [1, 2500]]);
      await expect(f.narrator.frozen("owner", projectId, draft, segments.map(s => ({ ...s, durationSec: 2 })))).rejects.toThrow("第 1 镜配音长于镜头时长");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("keys a take by voice, settings and text", () => {
    const base = narrationKey(voice, draft.narration!, "第一句");
    expect(narrationKey(voice, draft.narration!, "第一句。")).not.toBe(base);
    expect(narrationKey({ ...voice, voiceId: "voice-2" }, draft.narration!, "第一句")).not.toBe(base);
    expect(narrationKey(voice, { ...draft.narration!, speed: 1.1 }, "第一句")).not.toBe(base);
  });
  it("opens frozen takes only inside the draft's own folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "marketing-narration-"));
    try {
      const key = `${projectId}/22222222-2222-4222-8222-222222222222.wav`;
      await mkdir(join(root, "marketing-narration", projectId), { recursive: true });
      await writeFile(join(root, "marketing-narration", key), "x");
      await expect(narrationFile(root, projectId, key)).resolves.toContain(projectId);
      await expect(narrationFile(root, "44444444-4444-4444-8444-444444444444", key)).rejects.toThrow();
      await expect(narrationFile(root, projectId, `${projectId}/../../secret.wav`)).rejects.toThrow();
      expect(() => frozenNarration([{ slot: 1, key: "k", storageKey: key, durationMs: 10 }], 1)).toThrow();
      expect(frozenNarration([{ slot: 0, key: "k", storageKey: key, durationMs: 10 }], 1)).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("narration space", () => {
  it("counts every take file of the owner's drafts and ignores other folders", async () => {
    const root = await mkdtemp(join(tmpdir(), "narration-bytes-"));
    try {
      const other = "22222222-2222-4222-8222-222222222222";
      for (const [folder, bytes] of [[projectId, 300], [other, 50]] as const) {
        await mkdir(join(root, "marketing-narration", folder), { recursive: true });
        await writeFile(join(root, "marketing-narration", folder, "a.wav"), Buffer.alloc(bytes));
      }
      await writeFile(join(root, "marketing-narration", projectId, "b.wav"), Buffer.alloc(200));
      const query = vi.fn(async () => ({ rows: [{ id: projectId }, { id: "44444444-4444-4444-8444-444444444444" }] }));
      const narrator = new MarketingNarrator({ query } as never, root);
      expect(await narrator.ownerBytes("owner")).toBe(500);
      expect(query).toHaveBeenCalledWith(expect.stringContaining("WHERE user_id=$1"), ["owner"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
