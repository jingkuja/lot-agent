import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { GROK_MARKETING_PROFILE, KLING_MARKETING_PROFILE, MarketingDraftSchema } from "@lot-agent/core/marketing-video";
import { keyArtBasis, MarketingKeyArtist, type KeyArtDeps } from "./key-art.js";
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

type Row = { id: string; owner_id: string; project_id: string; basis: string; status: string; asset_id: string | null; updated_at: Date };
/** Just enough of the key-art table: the running-row claim is unique per look. */
function pool(rows: Row[] = []) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith("SELECT")) {
      const found = rows.filter(row => row.owner_id === params[0] && row.project_id === params[1] && row.basis === params[2])
        .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());
      return { rows: found, rowCount: found.length };
    }
    if (sql.startsWith("INSERT")) {
      if (rows.some(row => row.owner_id === params[1] && row.project_id === params[2] && row.basis === params[3] && row.status === "running")) return { rows: [], rowCount: 0 };
      rows.push({ id: params[0] as string, owner_id: params[1] as string, project_id: params[2] as string, basis: params[3] as string, status: "running", asset_id: null, updated_at: new Date() });
      return { rows: [{ id: params[0] }], rowCount: 1 };
    }
    if (sql.includes("SET status='succeeded'")) {
      const row = rows.find(item => item.id === params[0] && item.status === "running");
      if (row) Object.assign(row, { status: "succeeded", asset_id: params[1], updated_at: new Date() });
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("SET status='failed'") && sql.includes("WHERE id=$1")) {
      const row = rows.find(item => item.id === params[0] && item.status === "running");
      if (row) Object.assign(row, { status: "failed", updated_at: new Date() });
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
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
    poll: vi.fn(async () => ({ status: "completed", progress: 100, urls: [`data:image/png;base64,${image.toString("base64")}`] })) };
  const deps = {
    provider: vi.fn(async () => provider),
    getAsset: vi.fn(async (id: string) => assets[id] ?? null),
    createAsset: vi.fn(async (asset: { id: string; userId: string; storageKey: string; url: string; mime: string; sizeBytes: number }) => {
      assets[asset.id] = { id: asset.id, user_id: asset.userId, type: "upload", storage_key: asset.storageKey, url: asset.url, mime: asset.mime, size_bytes: asset.sizeBytes };
      await writeFile(join(root, "uploads", asset.storageKey), image);
    }),
    storage: { put: vi.fn(async ({ key }: { key: string }) => ({ url: `/static/uploads/${key}` })) },
    sign: vi.fn((asset: { storage_key: string }) => `/static/uploads/${asset.storage_key}?material_token=t`),
  };
  const db = pool(rows);
  const artist = new MarketingKeyArtist(db.pool, root, deps as unknown as KeyArtDeps);
  const draft = MarketingDraftSchema.parse({ continuity: "短发女店员，米色针织衫，木质吧台，暖光", assets: { portrait: [portrait], product: [product] } });
  return { root, artist, deps, provider, db, draft, cleanup: () => rm(root, { recursive: true, force: true }) };
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
  it("writes the intent row before the one paid request and keeps the still private", async () => {
    const f = await fixture();
    try {
      const result = await f.artist.generate("owner", projectId, f.draft, GROK_MARKETING_PROFILE, false);
      expect(result).toMatchObject({ error: "", keyArt: { status: "succeeded", url: expect.stringContaining("material_token=") } });
      expect(f.provider.create).toHaveBeenCalledOnce();
      const insert = f.db.query.mock.calls.findIndex(([sql]) => sql.startsWith("INSERT"));
      expect(insert).toBeGreaterThan(-1);
      expect(f.deps.provider).toHaveBeenCalledWith("owner", "gpt-image-2.5-flare");
      const request = f.provider.create.mock.calls[0][0] as { size: string; media: { url: string }[] };
      expect(request.size).toBe("1024x1536");
      expect(request.media.map(item => item.url.slice(0, 22))).toEqual(["data:image/png;base64,", "data:image/png;base64,"]);
      expect(f.deps.createAsset).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner", type: "upload", isPrivate: true, mime: "image/png", width: 1024, height: 1536 }));
      // The same look is never paid for twice without an explicit redo.
      await f.artist.generate("owner", projectId, f.draft, GROK_MARKETING_PROFILE, false);
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
      expect((await f.artist.generate("owner", projectId, f.draft, GROK_MARKETING_PROFILE, true)).keyArt.status).toBe("running");
      expect(f.provider.create).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });
  it("records a failure without resending, keeps an earlier still and hides the vendor text", async () => {
    const f = await fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await f.artist.generate("owner", projectId, f.draft, GROK_MARKETING_PROFILE, false);
      f.provider.create.mockRejectedValueOnce(new Error("upstream: input may contain real person (portrait.png)"));
      const result = await f.artist.generate("owner", projectId, f.draft, GROK_MARKETING_PROFILE, true);
      expect(result.error).toBe("图片模型拒绝了真人肖像参考，可换一张肖像，或不生成定妆图直接制作。");
      expect(result.keyArt.status).toBe("succeeded");
      expect(f.provider.create).toHaveBeenCalledTimes(2);
      expect(f.db.rows.map(row => row.status)).toEqual(["succeeded", "failed"]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("portrait.png");
    } finally { warn.mockRestore(); await f.cleanup(); }
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
