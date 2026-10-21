import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "@lot-agent/core";
import { runDigitalPresenter, type PresenterRunDeps } from "./run.js";
import type { ClipRow } from "./repository.js";

const store = vi.hoisted(() => ({ get: vi.fn(), clips: vi.fn() }));
const root = vi.hoisted(() => ({ dir: "" }));
vi.mock("./repository.js", () => ({ presenterLockKey: (id: string) => `digital-presenter:${id}`, PgPresenterStore: class { get = store.get; clips = store.clips; } }));
vi.mock("./files.js", async () => {
  const { join } = await import("node:path");
  return {
    presenterPath: (_root: string, _project: string, file: string) => join(root.dir, file),
    presenterFile: async (_root: string, _project: string, file: unknown) => { if (typeof file !== "string") throw new Error("文件不可用。"); return join(root.dir, file); },
  };
});
vi.mock("./media.js", async () => {
  const { writeFile } = await import("node:fs/promises");
  // Prepared inputs are real files: the worker moves each into place once.
  const write = (output: string) => writeFile(output, "prepared");
  return {
  buildTrack: vi.fn(async (_takes: string[], output: string) => write(output)), preparePortrait: vi.fn(async (_input: string, output: string) => write(output)),
  prepareFootage: vi.fn(async (_input: string, output: string) => write(output)), prepareFace: vi.fn(async (_input: string, output: string) => write(output)),
  portraitFrame: () => ({ width: 720, height: 1280 }), composeImageMode: vi.fn(), composeVideoMode: vi.fn(),
  };
});
vi.mock("../marketing-video/media.js", () => ({
  mediaCapabilities: vi.fn(async () => ({ composition: true })),
  inspectMedia: vi.fn(async () => ({ video: true, audio: true, duration: 4.2 })),
  ownedAssetPath: vi.fn(async () => "/tmp/upload.png"),
}));

const PROJECT = "11111111-1111-4111-8111-111111111111";
const takes = [{ slot: 0, text: "大家好。", file: "a.wav", durationMs: 4200 }, { slot: 1, text: "欢迎光临。", file: "b.wav", durationMs: 3100 }];

function fixture(clips: Partial<ClipRow>[], provider: { create: ReturnType<typeof vi.fn>; poll: ReturnType<typeof vi.fn> }, mode: "image" | "video" = "image") {
  const rows = clips.map((clip, slot) => ({ task_id: "job", slot, model: mode === "image" ? "wan2.2-s2v" : "videoretalk", status: "pending", vendor_task_id: null, file: null, seconds: null, error: null, ...clip }) as ClipRow);
  store.get.mockResolvedValue({ id: PROJECT, taskId: "job" });
  store.clips.mockImplementation(async () => rows.map(row => ({ ...row })));
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    connect: vi.fn(async () => ({ query: vi.fn(async () => ({ rows: [{ locked: true }] })), release: vi.fn() })),
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      // Keep the in-memory clip rows in step with the worker's updates.
      const match = /UPDATE digital_presenter_clips SET (.+),updated_at=now\(\) WHERE task_id=\$1 AND slot=\$2/.exec(sql);
      if (match) {
        const row = rows[values[1] as number];
        if (sql.includes("status IN ('pending','failed')") && !["pending", "failed"].includes(row.status)) return { rows: [], rowCount: 0 };
        const status = /status='(\w+)'/.exec(match[1])?.[1];
        if (status) row.status = status as ClipRow["status"];
        if (match[1].includes("vendor_task_id=$3")) row.vendor_task_id = values[2] as string;
        if (match[1].includes("file=$3")) row.file = values[2] as string;
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  const db = { pool, getTaskStatus: vi.fn(async () => "running"), updateTaskProgress: vi.fn(), getAsset: vi.fn(async () => ({ id: "upload", user_id: "owner", type: "upload" })), createAsset: vi.fn() };
  const compose = {
    image: vi.fn(async () => ({ body: Buffer.from("video"), durationSec: 7.55, width: 720, height: 1280 })),
    video: vi.fn(async () => ({ body: Buffer.from("video"), durationSec: 9, width: 1080, height: 1920 })),
  };
  const deps: PresenterRunDeps = {
    db: db as never, dataRoot: root.dir, provider: vi.fn(async () => provider as never),
    download: vi.fn(async () => ({ body: Buffer.from("clip"), mime: "video/mp4" })),
    storage: { put: vi.fn(async ({ key }) => ({ url: `/static/assets/${key}` })) },
    sleep: async () => {}, compose, sign: vi.fn(async (_root: string, _project: string, file: string) => `https://pub.example/${file}`),
  };
  const input = { presenterInputVersion: 1, projectId: PROJECT, mode, model: rows[0].model, resolution: "720P", ratio: "9:16", takes,
    ...(mode === "image" ? { portrait: "portrait-id" } : { baseVideo: "video-id" }) };
  return { deps, rows, queries, db, compose, job: { id: "job", userId: "owner", input } };
}

beforeEach(async () => { root.dir = await mkdtemp(join(tmpdir(), "presenter-run-")); });
afterEach(async () => { await rm(root.dir, { recursive: true, force: true }); });

describe("digital presenter worker", () => {
  it("submits one s2v clip per take, downloads them and composes the voice track", async () => {
    const provider = { create: vi.fn(async () => ({ taskId: `vendor-${provider.create.mock.calls.length}`, status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "https://oss.example/out.mp4" })) };
    const f = fixture([{}, {}], provider);
    const output = await runDigitalPresenter(f.deps, f.job, new AbortController().signal);
    expect(provider.create.mock.calls.map(call => call[0])).toEqual([
      { prompt: "", model: "wan2.2-s2v", resolution: "720P", durationSec: 4.2, input_reference: "https://pub.example/jobs/job/portrait.jpg", reference_audio: "https://pub.example/a.wav" },
      { prompt: "", model: "wan2.2-s2v", resolution: "720P", durationSec: 3.1, input_reference: "https://pub.example/jobs/job/portrait.jpg", reference_audio: "https://pub.example/b.wav" },
    ]);
    expect(f.rows.map(row => [row.status, row.vendor_task_id])).toEqual([["succeeded", "vendor-1"], ["succeeded", "vendor-2"]]);
    expect(f.compose.image).toHaveBeenCalledWith(expect.objectContaining({ takeMs: [4200, 3100], frame: { width: 720, height: 1280 } }));
    expect(f.db.createAsset).toHaveBeenCalledWith(expect.objectContaining({ taskId: "job", userId: "owner", type: "video", mime: "video/mp4" }));
    expect(output.assets[0]).toMatchObject({ mime: "video/mp4", durationSec: 7.55 });
    // The intent is recorded before the paid request.
    const claim = f.queries.findIndex(q => q.sql.includes("status='submitting'"));
    const submitted = f.queries.findIndex(q => q.sql.includes("status='running',vendor_task_id=$3"));
    expect(claim).toBeGreaterThanOrEqual(0);
    expect(submitted).toBeGreaterThan(claim);
  });

  it("leaves an unanswered submission unknown and never resends it", async () => {
    const provider = { create: vi.fn(async () => { throw new ProviderError("generation", "create", "TRANSPORT_ERROR"); }), poll: vi.fn() };
    const f = fixture([{}], provider);
    f.job.input.takes = [takes[0]];
    await expect(runDigitalPresenter(f.deps, f.job, new AbortController().signal)).rejects.toMatchObject({ errorCode: "SUBMISSION_UNKNOWN" });
    expect(f.rows[0].status).toBe("submitting");
    provider.create.mockClear();
    await expect(runDigitalPresenter(f.deps, f.job, new AbortController().signal)).rejects.toMatchObject({ errorCode: "SUBMISSION_UNKNOWN" });
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("marks an explicit rejection retry-safe", async () => {
    const provider = { create: vi.fn(async () => { throw new ProviderError("generation", "create", "HTTP_ERROR", { httpStatus: 400 }); }), poll: vi.fn() };
    const f = fixture([{}], provider);
    f.job.input.takes = [takes[0]];
    await expect(runDigitalPresenter(f.deps, f.job, new AbortController().signal)).rejects.toMatchObject({ errorCode: "REJECTED" });
    expect(f.rows[0].status).toBe("failed");
  });

  it("polls a known vendor task on recovery and keeps finished clips", async () => {
    const provider = { create: vi.fn(), poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "https://oss.example/out.mp4" })) };
    const { writeFile } = await import("node:fs/promises");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root.dir, "jobs", "job"), { recursive: true });
    await writeFile(join(root.dir, "jobs/job/clip-0-done.mp4"), "clip");
    const f = fixture([{ status: "succeeded", file: "jobs/job/clip-0-done.mp4" }, { status: "running", vendor_task_id: "vendor-known" }], provider);
    await runDigitalPresenter(f.deps, f.job, new AbortController().signal);
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.poll).toHaveBeenCalledWith("vendor-known");
    expect(f.rows[1].status).toBe("succeeded");
  });

  it("sends VideoRetalk the trimmed footage and the whole voice track once", async () => {
    const provider = { create: vi.fn(async () => ({ taskId: "vendor-r", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "https://oss.example/out.mp4" })) };
    const media = await import("../marketing-video/media.js");
    vi.mocked(media.inspectMedia).mockResolvedValue({ video: true, audio: true, duration: 7.55 } as never);
    const f = fixture([{}], provider, "video");
    await runDigitalPresenter(f.deps, f.job, new AbortController().signal);
    expect(provider.create).toHaveBeenCalledOnce();
    expect(provider.create.mock.calls[0][0]).toEqual({ prompt: "", model: "videoretalk", durationSec: 7.55,
      reference_video: "https://pub.example/jobs/job/footage.mp4", reference_audio: "https://pub.example/jobs/job/track.wav" });
    expect(f.compose.video).toHaveBeenCalledWith(expect.objectContaining({ trackSec: 7.55 }));
  });
});
