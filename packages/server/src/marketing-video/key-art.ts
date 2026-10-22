import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type pg from "pg";
import { fetchPublicBinary, isRealPersonRejection, type ImageGenerationProvider } from "@lot-agent/core";
import { marketingKeyArtIssue, marketingReferenceImageIssue, type MarketingDraft, type MarketingKeyArt, type MarketingVideoProfile } from "@lot-agent/core/marketing-video";
import { imageInfo } from "./image-size.js";
import { ownedAssetPath } from "./media.js";
import { marketingKeyArtPrompt, marketingKeyArtReferences } from "./prompt.js";
import { MarketingError } from "./repository.js";

/** A `running` still older than this is shown as failed; it is only made again when asked. */
export const KEY_ART_STALE_MS = 300_000;
const MAX_BYTES = 20 * 1024 * 1024;
const SIZES: Record<MarketingDraft["ratio"], string> = { "9:16": "1024x1536", "16:9": "1536x1024", "1:1": "1024x1024" };
export const marketingKeyArtModel = () => process.env.MARKETING_KEY_ART_MODEL || "gpt-image-2.5-flare";

/** Covers everything the still shows, so an edit to the look leaves the old still unused. */
export function keyArtBasis(draft: MarketingDraft, model: string) {
  return createHash("sha256").update(JSON.stringify([model, SIZES[draft.ratio], marketingKeyArtPrompt(draft), marketingKeyArtReferences(draft).map(reference => reference.assetId)])).digest("hex");
}

type Asset = { id: string; user_id: string; type: string; storage_key: string; url: string; mime: string; size_bytes: number | string; is_private?: boolean };
export interface KeyArtDeps {
  /** Image provider bound to the owner's own model key, so the gateway bills the owner. */
  provider(owner: string, model: string): Promise<ImageGenerationProvider>;
  getAsset(id: string): Promise<Asset | null | undefined>;
  createAsset(asset: { id: string; userId: string; type: "upload"; storageKey: string; url: string; mime: string; sizeBytes: number; width: number; height: number; originalName: string; isPrivate: true }): Promise<void>;
  storage: { put(input: { key: string; body: Buffer; contentType: string }): Promise<{ url: string }> };
  /** Short-lived link for previewing a private upload. */
  sign(asset: Asset): string;
  download?(url: string): Promise<{ body: Buffer; mime: string }>;
}
type Row = { id: string; status: "running" | "succeeded" | "failed"; asset_id: string | null; updated_at: Date };

/** Key-art stills of a draft. Each still is one paid image request through the owner's key,
 * written as an intent row first and never resent automatically. */
export class MarketingKeyArtist {
  constructor(private readonly pool: pg.Pool, private readonly dataRoot: string, private readonly deps: KeyArtDeps) {}

  private async rows(owner: string, projectId: string, basis: string): Promise<Row[]> {
    return (await this.pool.query<Row>(`SELECT id,status,asset_id,updated_at FROM marketing_video_key_arts
      WHERE owner_id=$1 AND project_id=$2 AND basis=$3 ORDER BY updated_at DESC LIMIT 20`, [owner, projectId, basis])).rows;
  }
  /** The newest still made for this look, and whether another is being made. */
  private current(rows: Row[]) {
    const running = rows.some(row => row.status === "running" && Date.now() - new Date(row.updated_at).getTime() <= KEY_ART_STALE_MS);
    return { running, succeeded: rows.find(row => row.status === "succeeded"), tried: rows.length > 0 };
  }
  private async view(owner: string, rows: Row[]): Promise<MarketingKeyArt> {
    const { running, succeeded, tried } = this.current(rows);
    const asset = succeeded?.asset_id ? await this.deps.getAsset(succeeded.asset_id) : undefined;
    const url = asset && asset.user_id === owner ? this.deps.sign(asset) : undefined;
    return { status: running ? "running" : url ? "succeeded" : tried ? "failed" : "missing", ...(url ? { url } : {}) };
  }

  async status(owner: string, projectId: string, draft: MarketingDraft): Promise<MarketingKeyArt> {
    return this.view(owner, await this.rows(owner, projectId, keyArtBasis(draft, marketingKeyArtModel())));
  }

  /** Makes a still for the current look when there is none, or another one on `redo`. A
   * failure keeps an earlier still of the same look and is returned as `error`. */
  async generate(owner: string, projectId: string, draft: MarketingDraft, profile: MarketingVideoProfile, redo: boolean): Promise<{ keyArt: MarketingKeyArt; error: string }> {
    const issue = marketingKeyArtIssue(draft, profile);
    if (issue) throw new MarketingError(issue === "video" ? "已选择参考视频，定妆图不参与生成。" : `定妆图占用 1 张参考图，当前视频模型合计最多 ${profile.referenceImages.total} 张，请先移除一张参考图。`, 409);
    const model = marketingKeyArtModel();
    const basis = keyArtBasis(draft, model);
    const where = "owner_id=$1 AND project_id=$2 AND basis=$3";
    await this.pool.query(`UPDATE marketing_video_key_arts SET status='failed',updated_at=now() WHERE ${where} AND status='running'
      AND updated_at < now() - $4::double precision * interval '1 millisecond'`, [owner, projectId, basis, KEY_ART_STALE_MS]);
    const before = this.current(await this.rows(owner, projectId, basis));
    if (before.running || (!redo && before.tried)) return { keyArt: await this.status(owner, projectId, draft), error: "" };
    const id = randomUUID();
    const claim = await this.pool.query(`INSERT INTO marketing_video_key_arts(id,owner_id,project_id,basis,status) VALUES($1,$2,$3,$4,'running')
      ON CONFLICT (owner_id,project_id,basis) WHERE status='running' DO NOTHING RETURNING id`, [id, owner, projectId, basis]);
    let error = "";
    if (claim.rowCount) {
      try {
        const assetId = await this.make(owner, draft, model);
        await this.pool.query("UPDATE marketing_video_key_arts SET status='succeeded',asset_id=$2,updated_at=now() WHERE id=$1 AND status='running'", [id, assetId]);
      } catch (failure) {
        await this.pool.query("UPDATE marketing_video_key_arts SET status='failed',updated_at=now() WHERE id=$1 AND status='running'", [id]);
        error = this.message(projectId, failure);
      }
    }
    return { keyArt: await this.status(owner, projectId, draft), error };
  }

  /** One billed image request; the reference images are read from the owner's own files. */
  private async make(owner: string, draft: MarketingDraft, model: string): Promise<string> {
    const media = await Promise.all(marketingKeyArtReferences(draft).map(async ({ assetId }) => {
      const asset = await this.deps.getAsset(assetId);
      if (!asset || asset.user_id !== owner) throw new MarketingError("素材不存在", 404);
      const body = await readFile(await ownedAssetPath(this.dataRoot, asset));
      const info = imageInfo(body);
      if (!info) throw new MarketingError("素材格式或大小不支持");
      return { type: "reference_image" as const, url: `data:${info.mime};base64,${body.toString("base64")}` };
    }));
    const provider = await this.deps.provider(owner, model);
    // Not tied to the browser connection: a closed tab must not discard a billed still.
    const created = await provider.create({ prompt: marketingKeyArtPrompt(draft), model, size: SIZES[draft.ratio], n: 1, ...(media.length ? { media } : {}) });
    const result = await provider.poll(created.taskId);
    const source = result.urls?.[0] ?? result.url;
    if (result.status !== "completed" || !source) throw new Error("image generation returned no image");
    const download = this.deps.download ?? (async (url: string) => {
      if (url.startsWith("data:")) return { body: Buffer.from(url.slice(url.indexOf(",") + 1), "base64"), mime: "" };
      return fetchPublicBinary(url, { maxBytes: MAX_BYTES, timeoutMs: 60_000 });
    });
    const { body } = await download(source);
    const info = imageInfo(body);
    if (!info || !info.width || !info.height || body.length > MAX_BYTES) throw new MarketingError("定妆图无法读取，请重新生成。");
    const assetId = randomUUID();
    const key = `${assetId}.${info.mime === "image/jpeg" ? "jpg" : info.mime.slice(6)}`;
    const { url } = await this.deps.storage.put({ key, body, contentType: info.mime });
    await this.deps.createAsset({ id: assetId, userId: owner, type: "upload", storageKey: key, url, mime: info.mime, sizeBytes: body.length,
      width: info.width, height: info.height, originalName: "key-art", isPrivate: true });
    return assetId;
  }

  private message(projectId: string, error: unknown) {
    if (error instanceof MarketingError) return error.message;
    const message = error instanceof Error ? error.message : "";
    // Logged without the vendor text, which can quote private material.
    console.warn("[marketing-video] key art failed", { projectId, errorType: (error as Error)?.name, realPerson: isRealPersonRejection(message) });
    if (isRealPersonRejection(message)) return "图片模型拒绝了真人肖像参考，可换一张肖像，或不生成定妆图直接制作。";
    if (/HTTP (401|402|403)\b/.test(message)) return "模型账号余额不足或未开通图片生成。";
    return "定妆图生成失败，请稍后重新生成。";
  }

  /** The still a new job submits after the chosen images, when one was made for this look.
   * Its real file is checked against the clip model like any other reference image. */
  async frozen(owner: string, projectId: string, draft: MarketingDraft, profile: MarketingVideoProfile): Promise<Asset | undefined> {
    if (marketingKeyArtIssue(draft, profile)) return undefined;
    const { succeeded } = this.current(await this.rows(owner, projectId, keyArtBasis(draft, marketingKeyArtModel())));
    if (!succeeded?.asset_id) return undefined;
    const asset = await this.deps.getAsset(succeeded.asset_id);
    if (!asset || asset.user_id !== owner) return undefined;
    const body = await readFile(await ownedAssetPath(this.dataRoot, asset)).catch(() => null);
    const info = body && imageInfo(body);
    const problem = marketingReferenceImageIssue(profile, { mime: info?.mime ?? "", size: body?.length ?? 0, width: info?.width ?? 0, height: info?.height ?? 0 });
    if (problem) throw new MarketingError(`定妆图不符合当前视频模型的要求：${problem}`, 409);
    return asset;
  }
}
