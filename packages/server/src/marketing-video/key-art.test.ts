import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { spawnSync } from "node:child_process";
import type { PollResult } from "@lot-agent/core";
import { GROK_MARKETING_PROFILE, KLING_MARKETING_PROFILE, MarketingDraftSchema } from "@lot-agent/core/marketing-video";
import { KEY_ART_STALE_MS, keyArtBasis, keyArtReference, MarketingKeyArtist, type KeyArtDeps } from "./key-art.js";
import { imageInfo, jpegOrientation } from "./image-size.js";
import { marketingKeyArtPrompt, marketingKeyArtReferences } from "./prompt.js";

/** A PNG header with an IHDR size, enough for the signature check. */
const png = (width: number, height: number) => {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.write("IHDR", 12, "ascii"); buffer.writeUInt32BE(width, 16); buffer.writeUInt32BE(height, 20);
  return buffer;
};
const portrait = "11111111-1111-4111-8111-111111111111";
const product = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";

type Row = {
  id: string; owner_id: string; project_id: string; basis: string; status: string; asset_id: string | null; updated_at: Date;
  vendor_task_id?: string | null; result_url?: string | null; resumable?: boolean; error?: string | null;
};
/** Just enough of the key-art table: the running-row claim is unique per look. */
function pool(rows: Row[] = []) {
  // PG's now() differs between statements; Date.now() can repeat within a millisecond.
  let last = 0;
  const now = () => new Date(last = Math.max(Date.now(), last + 1));
  const byId = (id: unknown) => rows.find(row => row.id === id);
  const running = (row: Row) => rows.some(other => other !== row && other.owner_id === row.owner_id && other.project_id === row.project_id
    && other.basis === row.basis && other.status === "running");
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const done = (row?: Row) => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
    if (sql.startsWith("SELECT result_url")) return done(byId(params[0]));
    if (sql.startsWith("SELECT")) {
      const found = rows.filter(row => row.owner_id === params[0] && row.project_id === params[1] && row.basis === params[2])
        .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
        .map(row => ({ vendor_task_id: null, result_url: null, resumable: false, error: null, ...row }));
      return { rows: found, rowCount: found.length };
    }
    if (sql.startsWith("INSERT")) {
      const [id, owner_id, project_id, basis] = params as string[];
      const row = { id, owner_id, project_id, basis, status: "running", asset_id: null, updated_at: now() };
      if (running(row)) return done();
      rows.push(row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }
    if (sql.includes("WHERE owner_id=$1")) {
      // Stale running stills are cut short.
      for (const row of rows.filter(item => item.owner_id === params[0] && item.project_id === params[1] && item.basis === params[2] && item.status === "running"
        && Date.now() - item.updated_at.getTime() > (params[3] as number))) {
        const paid = !!(row.vendor_task_id || row.result_url);
        Object.assign(row, { status: "failed", resumable: paid, error: paid ? params[4] : params[5], updated_at: now() });
      }
      return done();
    }
    const row = byId(params[0]);
    if (sql.includes("SET status='running'")) {
      if (!row || row.status !== "failed" || !row.resumable) return done();
      if (running(row)) throw Object.assign(new Error("duplicate"), { code: "23505" });
      Object.assign(row, { status: "running", error: null, updated_at: now() });
      return done(row);
    }
    if (!row || row.status !== "running") return done();
    if (sql.includes("SET status='succeeded'")) Object.assign(row, { status: "succeeded", asset_id: params[1], resumable: false, error: null });
    else if (sql.includes("SET status='failed'")) Object.assign(row, { status: "failed", resumable: params[1], error: params[2] });
    else if (sql.includes("vendor_task_id=$2")) row.vendor_task_id = params[1] as string;
    else if (sql.includes("result_url=$2")) row.result_url = params[1] as string;
    row.updated_at = now();
    return done(row);
  });
  return { rows, query, pool: { query } as unknown as pg.Pool };
}

async function fixture(rows: Row[] = [], image = png(1024, 1536)) {
  const root = await mkdtemp(join(tmpdir(), "marketing-key-art-"));
  await mkdir(join(root, "uploads"));
  await writeFile(join(root, "uploads", "portrait.png"), png(800, 800));
  await writeFile(join(root, "uploads", "product.png"), png(600, 600));
  const assets: Record<string, { id: string; user_id: string; type: string; storage_key: string; url: string; mime: string; size_bytes: number }> = {
    [portrait]: { id: portrait, user_id: "owner", type: "upload", storage_key: "portrait.png", url: "/static/uploads/portrait.png", mime: "image/png", size_bytes: 33 },
    [product]: { id: product, user_id: "owner", type: "upload", storage_key: "product.png", url: "/static/uploads/product.png", mime: "image/png", size_bytes: 33 },
  };
  const provider = { create: vi.fn(async (_request: unknown) => ({ taskId: "images_1", status: "completed", progress: 100 })),
    poll: vi.fn(async (_taskId: string): Promise<PollResult> => ({ status: "completed", progress: 100, urls: [`data:image/png;base64,${image.toString("base64")}`] })) };
  const deps = {
    provider: vi.fn(async () => provider),
    getAsset: vi.fn(async (id: string) => assets[id] ?? null),
    createAsset: vi.fn(async (asset: { id: string; userId: string; storageKey: string; url: string; mime: string; sizeBytes: number }) => {
      assets[asset.id] = { id: asset.id, user_id: asset.userId, type: "upload", storage_key: asset.storageKey, url: asset.url, mime: asset.mime, size_bytes: asset.sizeBytes };
      await writeFile(join(root, "uploads", asset.storageKey), image);
    }),
    storage: { put: vi.fn(async ({ key }: { key: string }) => ({ url: `/static/uploads/${key}` })) },
    sign: vi.fn((asset: { storage_key: string }) => `/static/uploads/${asset.storage_key}?material_token=t`),
    download: vi.fn(async (url: string) => ({ body: url.startsWith("data:") ? Buffer.from(url.slice(url.indexOf(",") + 1), "base64") : image, mime: "" })),
    sleep: vi.fn(async () => {}),
  };
  const db = pool(rows);
  const artist = new MarketingKeyArtist(db.pool, root, deps as unknown as KeyArtDeps);
  const draft = MarketingDraftSchema.parse({ continuity: "短发女店员，米色针织衫，木质吧台，暖光", assets: { portrait: [portrait], product: [product] } });
  /** Starts a still and waits for its background work. */
  const make = async (redo = false, profile = GROK_MARKETING_PROFILE) => {
    const started = await artist.generate("owner", projectId, draft, profile, redo);
    await artist.settled();
    return { started: started.keyArt, keyArt: await artist.status("owner", projectId, draft) };
  };
  return { root, artist, deps, provider, db, draft, make, assets, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("key-art stills", () => {
  it("keys a still by everything it shows", () => {
    const draft = MarketingDraftSchema.parse({ continuity: "短发", assets: { portrait: [portrait] } });
    const basis = keyArtBasis(draft, "gpt-image-2.5-flare");
    expect(keyArtBasis(MarketingDraftSchema.parse({ ...draft, storyboard: [], script: "新的口播" }), "gpt-image-2.5-flare")).toBe(basis);
    for (const changed of [{ ...draft, continuity: "长发" }, { ...draft, ratio: "16:9" }, { ...draft, assets: { portrait: [product] } }, { ...draft, background: "海边" }]) {
      expect(keyArtBasis(MarketingDraftSchema.parse(changed), "gpt-image-2.5-flare")).not.toBe(basis);
    }
    expect(keyArtBasis(draft, "qwen-image-2.0")).not.toBe(basis);
  });
  it("makes the still from at most five owned references and names their roles", () => {
    const ids = Array.from({ length: 4 }, (_, i) => `4444444${i}-4444-4444-8444-444444444444`);
    const draft = MarketingDraftSchema.parse({ continuity: "红色围裙", assets: { portrait: ids.slice(0, 2), product: ids, background: [portrait], scene: [product] } });
    expect(marketingKeyArtReferences(draft).map(reference => reference.role)).toEqual(["portrait", "product", "product", "background", "scene"]);
    const prompt = marketingKeyArtPrompt(draft);
    expect(prompt).toContain("image 1 is the presenter's face");
    expect(prompt).toContain("image 2, image 3 show the product");
    expect(prompt).toContain("image 4, image 5 show the setting");
    expect(prompt).toContain("Presenter, product and setting (follow exactly): 红色围裙");
    expect(prompt).not.toContain("one specific, realistic design");
    expect(marketingKeyArtPrompt(MarketingDraftSchema.parse({}))).toContain("Invent one ordinary, natural-looking presenter");
  });
  it("shows the product in the still, and fixes one design for it when no product image is chosen", () => {
    const draft = MarketingDraftSchema.parse({ topic: "登山鞋，防滑耐磨", continuity: "米色针织短袖", assets: { portrait: [portrait] } });
    const prompt = marketingKeyArtPrompt(draft);
    expect(prompt).toContain("holding or beside the featured product");
    expect(prompt).toContain("only to tell which product it is): 登山鞋，防滑耐磨");
    expect(prompt).toContain("one specific, realistic design");
    expect(keyArtBasis(MarketingDraftSchema.parse({ ...draft, topic: "徒步背包" }), "gpt-image-2.5-flare")).not.toBe(keyArtBasis(draft, "gpt-image-2.5-flare"));
  });
  it("writes the intent row before the one paid request, makes it in the background and keeps the still private", async () => {
    const f = await fixture();
    try {
      const { started, keyArt } = await f.make();
      expect(started.status).toBe("running");
      expect(keyArt).toEqual({ status: "succeeded", url: expect.stringContaining("material_token=") });
      expect(f.provider.create).toHaveBeenCalledOnce();
      const insert = f.db.query.mock.calls.findIndex(([sql]) => sql.startsWith("INSERT"));
      expect(insert).toBeGreaterThan(-1);
      expect(f.deps.provider).toHaveBeenCalledWith("owner", "gpt-image-2.5-flare");
      const request = f.provider.create.mock.calls[0][0] as { size: string; media: { url: string }[] };
      expect(request.size).toBe("1024x1536");
      expect(request.media.map(item => item.url.slice(0, 22))).toEqual(["data:image/png;base64,", "data:image/png;base64,"]);
      expect(f.deps.createAsset).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner", type: "upload", isPrivate: true, mime: "image/png", width: 1024, height: 1536 }));
      // The task ID is saved before waiting; an inline image is not kept in the row.
      expect(f.db.rows[0]).toMatchObject({ vendor_task_id: "images_1", status: "succeeded" });
      expect(f.db.rows[0].result_url).toBeUndefined();
      // The same look is never paid for twice without an explicit redo.
      await f.make();
      expect(f.provider.create).toHaveBeenCalledOnce();
      const frozen = await f.artist.frozen("owner", projectId, f.draft, GROK_MARKETING_PROFILE);
      expect(frozen?.url).toMatch(/^\/static\/uploads\/.+\.png$/);
      // A changed look has no still yet.
      expect(await f.artist.frozen("owner", projectId, { ...f.draft, continuity: "长发" }, GROK_MARKETING_PROFILE)).toBeUndefined();
    } finally { await f.cleanup(); }
  });
  it("does not start another still while one is being made", async () => {
    const f = await fixture();
    try {
      const basis = keyArtBasis(f.draft, "gpt-image-2.5-flare");
      f.db.rows.push({ id: "running", owner_id: "owner", project_id: projectId, basis, status: "running", asset_id: null, updated_at: new Date() });
      expect((await f.make(true)).keyArt.status).toBe("running");
      expect(f.provider.create).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });
  it("records a failure without resending, keeps an earlier still and hides the vendor text", async () => {
    const f = await fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await f.make();
      f.provider.create.mockRejectedValueOnce(new Error("upstream: input may contain real person (portrait.png)"));
      const { keyArt } = await f.make(true);
      expect(keyArt).toMatchObject({ status: "succeeded", error: "图片模型拒绝了真人肖像参考，可换一张肖像，或不生成定妆图直接制作。" });
      expect(keyArt.resumable).toBeUndefined();
      expect(f.provider.create).toHaveBeenCalledTimes(2);
      expect(f.db.rows.map(row => row.status)).toEqual(["succeeded", "failed"]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("portrait.png");
    } finally { warn.mockRestore(); await f.cleanup(); }
  });
  it("saves the result link before downloading and retries only the download, once, without paying again", async () => {
    const f = await fixture();
    const link = "https://cdn.example.com/still.png";
    f.provider.poll.mockResolvedValue({ status: "completed", progress: 100, urls: [link] });
    f.deps.download.mockRejectedValueOnce(new Error("timeout"));
    try {
      const failed = (await f.make()).keyArt;
      expect(failed).toMatchObject({ status: "failed", resumable: true, error: expect.stringContaining("不收费") });
      expect(f.db.rows[0]).toMatchObject({ result_url: link, vendor_task_id: "images_1" });
      // Even a paid redo request fetches the saved result first.
      const { keyArt } = await f.make(true);
      expect(keyArt.status).toBe("succeeded");
      expect(f.provider.create).toHaveBeenCalledOnce();
      expect(f.deps.download).toHaveBeenLastCalledWith(link);
      expect(f.db.rows).toHaveLength(1);
      // A second failed download of the same result is not free again: the next try is a new paid still.
      const g = await fixture();
      g.provider.poll.mockResolvedValue({ status: "completed", progress: 100, urls: [link] });
      g.deps.download.mockRejectedValue(new Error("expired"));
      try {
        await g.make();
        expect((await g.make()).keyArt).toMatchObject({ status: "failed", error: "定妆图生成失败，请稍后重新生成。" });
        expect((await g.make()).keyArt.resumable).toBeUndefined();
        expect(g.provider.create).toHaveBeenCalledOnce();
      } finally { await g.cleanup(); }
    } finally { await f.cleanup(); }
  });
  it("waits for a slow image task, and asks the saved task again after a cut-short wait", async () => {
    const f = await fixture();
    const done = f.provider.poll.getMockImplementation()!;
    f.provider.create.mockResolvedValue({ taskId: "task-9", status: "pending", progress: 0 });
    f.provider.poll.mockResolvedValueOnce({ status: "pending", progress: 10 }).mockRejectedValueOnce(new Error("socket hang up"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await f.make()).keyArt).toMatchObject({ status: "failed", resumable: true });
      expect(f.deps.sleep).toHaveBeenCalledOnce();
      f.provider.poll.mockImplementation(done);
      expect((await f.make()).keyArt.status).toBe("succeeded");
      expect(f.provider.create).toHaveBeenCalledOnce();
      expect(f.provider.poll).toHaveBeenLastCalledWith("task-9");
      // A failure the model confirms is final.
      f.provider.poll.mockResolvedValueOnce({ status: "failed", progress: 0, error: "bad prompt" });
      expect((await f.make(true)).keyArt).toMatchObject({ status: "succeeded", error: "定妆图生成失败，请稍后重新生成。" });
    } finally { warn.mockRestore(); await f.cleanup(); }
  });
  it("shows a still cut short by a restart as failed, free to fetch again only when its task was saved", async () => {
    const f = await fixture();
    const basis = keyArtBasis(f.draft, "gpt-image-2.5-flare");
    const old = new Date(Date.now() - KEY_ART_STALE_MS - 1000);
    f.db.rows.push({ id: "lost", owner_id: "owner", project_id: projectId, basis, status: "running", asset_id: null, updated_at: old });
    try {
      expect(await f.artist.status("owner", projectId, f.draft)).toMatchObject({ status: "failed", error: expect.stringContaining("结果未知") });
      f.db.rows[0] = { ...f.db.rows[0], status: "running", vendor_task_id: "task-1", updated_at: old };
      expect(await f.artist.status("owner", projectId, f.draft)).toMatchObject({ status: "failed", resumable: true });
      expect((await f.make()).keyArt.status).toBe("succeeded");
      expect(f.provider.create).not.toHaveBeenCalled();
      expect(f.provider.poll).toHaveBeenCalledWith("task-1");
    } finally { await f.cleanup(); }
  });
  it("is not made or submitted when the clip model cannot take one more image", async () => {
    const f = await fixture();
    try {
      const video = { ...f.draft, assets: { ...f.draft.assets, video: product } };
      await expect(f.artist.generate("owner", projectId, video, GROK_MARKETING_PROFILE, false)).rejects.toMatchObject({ status: 409 });
      const full = MarketingDraftSchema.parse({ ...f.draft, assets: { portrait: [portrait, portrait, portrait], product: [product, product, product], scene: [product] } });
      await expect(f.artist.generate("owner", projectId, full, KLING_MARKETING_PROFILE, false)).rejects.toThrow("合计最多 7 张");
      expect(await f.artist.frozen("owner", projectId, full, KLING_MARKETING_PROFILE)).toBeUndefined();
      expect(f.provider.create).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });
});

/** APP1 "Exif" with a big-endian TIFF header and one IFD0 entry: Orientation (0x0112). */
const exif = (orientation: number) => {
  const tiff = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([0, 2 + 6 + tiff.length]), Buffer.from("Exif\0\0", "latin1"), tiff]);
};

describe("key-art reference images", () => {
  const ffmpegInstalled = spawnSync("ffmpeg", ["-version"]).status === 0;
  it.skipIf(!ffmpegInstalled)("scales a large photo to 1536 px on the long edge and keeps a small one as it is", async () => {
    const root = await mkdtemp(join(tmpdir(), "marketing-key-art-ref-"));
    try {
      const big = join(root, "big.png");
      spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=3000x2000", "-frames:v", "1", big]);
      const body = await readFile(big);
      const sent = await keyArtReference(big, body, imageInfo(body)!);
      expect(imageInfo(sent.body)).toEqual({ mime: "image/png", width: 1536, height: 1024 });
      expect(sent.body.length).toBeLessThan(body.length);
      const tall = join(root, "tall.jpg");
      spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=1000x2400", "-frames:v", "1", tall]);
      const jpeg = await readFile(tall);
      expect(imageInfo((await keyArtReference(tall, jpeg, imageInfo(jpeg)!)).body)).toEqual({ mime: "image/jpeg", width: 640, height: 1536 });
      // A phone photo stored sideways with EXIF orientation 6 comes out upright, turned once.
      const sideways = join(root, "sideways.jpg");
      spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=green:s=2400x1000", "-frames:v", "1", join(root, "plain.jpg")]);
      const plain = await readFile(join(root, "plain.jpg"));
      await writeFile(sideways, Buffer.concat([plain.subarray(0, 2), exif(6), plain.subarray(2)]));
      const rotated = await readFile(sideways);
      expect(imageInfo((await keyArtReference(sideways, rotated, imageInfo(rotated)!)).body)).toEqual({ mime: "image/jpeg", width: 640, height: 1536 });
      const small = png(800, 800);
      expect(await keyArtReference(join(root, "missing.png"), small, imageInfo(small)!)).toEqual({ body: small, mime: "image/png" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("sends the original when it cannot be scaled", async () => {
    const broken = png(4000, 4000);
    expect(await keyArtReference("/nonexistent/big.png", broken, imageInfo(broken)!)).toEqual({ body: broken, mime: "image/png" });
  });
  it("reads the EXIF orientation of a JPEG", () => {
    const app1 = exif(6);
    expect(jpegOrientation(Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xda])]))).toBe(6);
    expect(jpegOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xda]))).toBe(1);
    expect(jpegOrientation(Buffer.concat([Buffer.from([0xff, 0xd8]), app1.subarray(0, 14)]))).toBe(1);
    expect(jpegOrientation(png(10, 10))).toBe(1);
  });
});
