import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { fetchPublicBinary, isRealPersonRejection, type ImageGenerationProvider } from "@lot-agent/core";
import { marketingKeyArtIssue, marketingReferenceImageIssue, type MarketingDraft, type MarketingKeyArt, type MarketingVideoProfile } from "@lot-agent/core/marketing-video";
import { imageInfo, jpegOrientation, type ImageInfo } from "./image-size.js";
import { ffmpeg, mediaProcess, ownedAssetPath } from "./media.js";
import { marketingKeyArtPrompt, marketingKeyArtReferences } from "./prompt.js";
import { MarketingError } from "./repository.js";

/** A `running` still not touched for this long was cut short, e.g. by a restart. Waiting for a still
 * touches its row, so only a lost one goes stale. */
export const KEY_ART_STALE_MS = 300_000;
/** The longest wait for one image task; its ID stays, so a later try asks again without paying. */
export const KEY_ART_WAIT_MS = 600_000;
const POLL_MS = 3000;
/** Long edge of a reference image sent with the request: a larger photo only adds bytes, and base64 adds a third. */
export const KEY_ART_REFERENCE_EDGE = 1536;
const MAX_BYTES = 20 * 1024 * 1024;
const SIZES: Record<MarketingDraft["ratio"], string> = { "9:16": "1024x1536", "16:9": "1536x1024", "1:1": "1024x1024" };
/** Raw single-image demuxers: an image path is never read as a pattern or playlist. */
const IMAGE_DEMUXER = { "image/jpeg": "jpeg_pipe", "image/png": "png_pipe", "image/webp": "webp_pipe" } as const;
/** FFmpeg filters that turn a JPEG upright by its EXIF orientation (2–8). */
const ORIENTATION_FILTERS = ["", "", "hflip", "hflip,vflip", "vflip", "transpose=0", "transpose=1", "transpose=3", "transpose=2"];
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
  /** Pause between status queries of an image task. */
  sleep?(ms: number): Promise<void>;
}
type Row = {
  id: string; status: "running" | "succeeded" | "failed"; asset_id: string | null; updated_at: Date;
  vendor_task_id: string | null; result_url: string | null; resumable: boolean; error: string | null;
};
/** Where a still stopped: before the paid request was answered, waiting for its task, or saving its image. */
type Stage = "create" | "wait" | "save";
/** A failure the image model confirmed; asking again would not change it. */
class ConfirmedFailure extends Error {}

const INTERRUPTED_PAID = "定妆图生成被中断，已保存原任务；点击「继续获取」查询原结果，不收费。";
const INTERRUPTED_UNKNOWN = "定妆图生成被中断，结果未知；重新生成会再次产生费用。";
const SAVE_RESUMABLE = "定妆图已生成，保存未完成；点击「继续获取」重新下载，不收费。";
const WAIT_RESUMABLE = "定妆图暂时无法查询结果；点击「继续获取」查询原任务，不收费。";

/** Key-art stills of a draft. Each still is one paid image request through the owner's key, written as an
 * intent row first and never resent automatically. The request runs in the background so a closed tab or a
 * slow model never holds the HTTP request; the studio polls `status`. The image task's ID and result URL are
 * saved as soon as they are known: a cut-short wait or a failed download is retried once without paying. */
export class MarketingKeyArtist {
  private readonly active = new Set<Promise<void>>();
  constructor(private readonly pool: pg.Pool, private readonly dataRoot: string, private readonly deps: KeyArtDeps) {}

  private async rows(owner: string, projectId: string, basis: string): Promise<Row[]> {
    return (await this.pool.query<Row>(`SELECT id,status,asset_id,updated_at,vendor_task_id,result_url,resumable,error FROM marketing_video_key_arts
      WHERE owner_id=$1 AND project_id=$2 AND basis=$3 ORDER BY updated_at DESC LIMIT 20`, [owner, projectId, basis])).rows;
  }
  /** The newest still made for this look, and whether another is being made. */
  private current(rows: Row[]) {
    const running = rows.some(row => row.status === "running" && Date.now() - new Date(row.updated_at).getTime() <= KEY_ART_STALE_MS);
    return { running, succeeded: rows.find(row => row.status === "succeeded"), tried: rows.length > 0, newest: rows[0] as Row | undefined };
  }
  private async view(owner: string, rows: Row[]): Promise<MarketingKeyArt> {
    const { running, succeeded, tried, newest } = this.current(rows);
    const asset = succeeded?.asset_id ? await this.deps.getAsset(succeeded.asset_id) : undefined;
    const url = asset && asset.user_id === owner ? this.deps.sign(asset) : undefined;
    const failed = !running && newest?.status === "failed" ? newest : undefined;
    return { status: running ? "running" : url ? "succeeded" : tried ? "failed" : "missing", ...(url ? { url } : {}),
      ...(failed?.error ? { error: failed.error } : {}), ...(failed?.resumable ? { resumable: true } : {}) };
  }
  /** A still whose row was not touched for KEY_ART_STALE_MS was cut short. With a saved task ID or result it
   * is fetched again for free; without one it may have been charged, so it is only made again when asked. */
  private async expire(owner: string, projectId: string, basis: string) {
    await this.pool.query(`UPDATE marketing_video_key_arts SET status='failed',updated_at=now(),
        resumable=(vendor_task_id IS NOT NULL OR result_url IS NOT NULL),
        error=CASE WHEN vendor_task_id IS NOT NULL OR result_url IS NOT NULL THEN $5 ELSE $6 END
      WHERE owner_id=$1 AND project_id=$2 AND basis=$3 AND status='running' AND updated_at < now() - $4::double precision * interval '1 millisecond'`,
    [owner, projectId, basis, KEY_ART_STALE_MS, INTERRUPTED_PAID, INTERRUPTED_UNKNOWN]);
  }

  async status(owner: string, projectId: string, draft: MarketingDraft): Promise<MarketingKeyArt> {
    const basis = keyArtBasis(draft, marketingKeyArtModel());
    await this.expire(owner, projectId, basis);
    return this.view(owner, await this.rows(owner, projectId, basis));
  }

  /** Starts a still for the current look when there is none, or another one on `redo`, and returns at once
   * with `running`. A newest attempt that was paid for and cut short is fetched again instead, whatever
   * `redo` says, so it is never paid for twice. A failure keeps an earlier still of the same look. */
  async generate(owner: string, projectId: string, draft: MarketingDraft, profile: MarketingVideoProfile, redo: boolean): Promise<{ keyArt: MarketingKeyArt }> {
    const issue = marketingKeyArtIssue(draft, profile);
    if (issue) throw new MarketingError(issue === "video" ? "已选择动作参考视频，定妆图不参与生成。" : `定妆图占用 1 张参考图，当前视频模型合计最多 ${profile.referenceImages.total} 张，请先移除一张参考图。`, 409);
    const model = marketingKeyArtModel();
    const basis = keyArtBasis(draft, model);
    await this.expire(owner, projectId, basis);
    const { running, tried, newest } = this.current(await this.rows(owner, projectId, basis));
    if (running) return { keyArt: await this.status(owner, projectId, draft) };
    if (newest?.status === "failed" && newest.resumable) {
      // Another request may claim the same look first; the unique running index refuses the second.
      const claim = await this.pool.query(`UPDATE marketing_video_key_arts SET status='running',error=NULL,updated_at=now()
        WHERE id=$1 AND status='failed' AND resumable RETURNING id`, [newest.id]).catch(uniqueViolation);
      if (claim?.rowCount) this.start(owner, projectId, draft, model, newest.id, newest);
    } else if (redo || !tried) {
      const id = randomUUID();
      const claim = await this.pool.query(`INSERT INTO marketing_video_key_arts(id,owner_id,project_id,basis,status) VALUES($1,$2,$3,$4,'running')
        ON CONFLICT (owner_id,project_id,basis) WHERE status='running' DO NOTHING RETURNING id`, [id, owner, projectId, basis]);
      if (claim.rowCount) this.start(owner, projectId, draft, model, id);
    }
    return { keyArt: await this.status(owner, projectId, draft) };
  }

  /** Waits for the stills this process is making; for tests and shutdown. */
  async settled() { await Promise.allSettled([...this.active]); }

  private start(owner: string, projectId: string, draft: MarketingDraft, model: string, id: string, resume?: Row) {
    const work = this.run(owner, projectId, draft, model, id, resume).finally(() => this.active.delete(work));
    this.active.add(work);
  }

  /** Never rejects: every outcome is written to the row. */
  private async run(owner: string, projectId: string, draft: MarketingDraft, model: string, id: string, resume?: Row) {
    let stage: Stage = resume?.result_url ? "save" : resume?.vendor_task_id ? "wait" : "create";
    try {
      let source = resume?.result_url ?? undefined;
      if (!source) {
        const provider = await this.deps.provider(owner, model);
        let taskId = resume?.vendor_task_id ?? undefined;
        if (!taskId) {
          const media = await this.references(owner, draft);
          const request = { prompt: marketingKeyArtPrompt(draft), model, size: SIZES[draft.ratio], n: 1, ...(media.length ? { media } : {}) };
          ({ taskId } = await provider.create(request));
          stage = "wait";
          await this.touch(id, ",vendor_task_id=$2", [taskId]);
        }
        source = await this.wait(id, provider, taskId);
        // An image returned inline cannot fail to download, and is too large to keep in the row.
        if (!source.startsWith("data:")) await this.touch(id, ",result_url=$2", [source]);
      }
      stage = "save";
      const assetId = await this.save(owner, source);
      await this.pool.query(`UPDATE marketing_video_key_arts SET status='succeeded',asset_id=$2,resumable=false,error=NULL,updated_at=now()
        WHERE id=$1 AND status='running'`, [id, assetId]);
    } catch (failure) {
      // One free retry: a second cut-short attempt of the same result may be an expired link or a lost task.
      const row = await this.pool.query<{ result_url: string | null }>("SELECT result_url FROM marketing_video_key_arts WHERE id=$1", [id]).catch(() => null);
      const resumable = !resume && !(failure instanceof ConfirmedFailure) && !(failure instanceof MarketingError)
        && (stage === "wait" || (stage === "save" && !!row?.rows[0]?.result_url));
      const error = resumable ? (stage === "save" ? SAVE_RESUMABLE : WAIT_RESUMABLE) : this.message(projectId, failure);
      await this.pool.query("UPDATE marketing_video_key_arts SET status='failed',resumable=$2,error=$3,updated_at=now() WHERE id=$1 AND status='running'",
        [id, resumable, error]).catch(() => console.warn("[marketing-video] key art state not saved", { projectId }));
    }
  }

  /** Writes `set` on a still being made, which also keeps it from going stale. */
  private async touch(id: string, set = "", values: unknown[] = []) {
    await this.pool.query(`UPDATE marketing_video_key_arts SET updated_at=now()${set} WHERE id=$1 AND status='running'`, [id, ...values]);
  }

  /** The image of a task, asked for until it is done; a slow task touches its row between queries. */
  private async wait(id: string, provider: ImageGenerationProvider, taskId: string): Promise<string> {
    const deadline = Date.now() + KEY_ART_WAIT_MS;
    const sleep = this.deps.sleep ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
    for (;;) {
      const result = await provider.poll(taskId);
      const source = result.urls?.[0] ?? result.url;
      if (result.status === "completed") {
        if (!source) throw new ConfirmedFailure("image generation returned no image");
        return source;
      }
      if (result.status === "failed") {
        if (result.failureUnconfirmed) throw new Error("image task status unconfirmed");
        throw new ConfirmedFailure(result.error ?? "image generation failed");
      }
      if (Date.now() > deadline) throw new Error("image task still running");
      await this.touch(id);
      await sleep(POLL_MS);
    }
  }

  /** The reference images, read from the owner's own files and scaled down when large. */
  private async references(owner: string, draft: MarketingDraft) {
    return Promise.all(marketingKeyArtReferences(draft).map(async ({ assetId }) => {
      const asset = await this.deps.getAsset(assetId);
      if (!asset || asset.user_id !== owner) throw new MarketingError("素材不存在", 404);
      const path = await ownedAssetPath(this.dataRoot, asset);
      const body = await readFile(path);
      const info = imageInfo(body);
      if (!info) throw new MarketingError("素材格式或大小不支持");
      const sent = await keyArtReference(path, body, info);
      return { type: "reference_image" as const, url: `data:${sent.mime};base64,${sent.body.toString("base64")}` };
    }));
  }

  /** Downloads the still and keeps it as the owner's private upload. */
  private async save(owner: string, source: string): Promise<string> {
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

/** A claim refused by the unique running index means another request is making this still. */
function uniqueViolation(error: unknown) {
  if ((error as { code?: string })?.code === "23505") return null;
  throw error;
}

/** A reference image as sent with the request: a photo whose long edge exceeds KEY_ART_REFERENCE_EDGE is
 * turned upright by its EXIF orientation and scaled down. JPEG stays JPEG; PNG and WebP become PNG to keep
 * transparency. When FFmpeg cannot do it, the original is sent as before. */
export async function keyArtReference(path: string, body: Buffer, info: ImageInfo): Promise<{ body: Buffer; mime: string }> {
  if (Math.max(info.width, info.height) <= KEY_ART_REFERENCE_EDGE) return { body, mime: info.mime };
  const jpeg = info.mime === "image/jpeg";
  const edge = KEY_ART_REFERENCE_EDGE;
  const upright = jpeg ? ORIENTATION_FILTERS[jpegOrientation(body)] : "";
  const dir = await mkdtemp(join(tmpdir(), "marketing-key-art-"));
  try {
    const output = join(dir, jpeg ? "reference.jpg" : "reference.png");
    await mediaProcess(ffmpeg(), ["-nostdin", "-y", "-v", "error", "-noautorotate", "-f", IMAGE_DEMUXER[info.mime], "-i", path,
      "-vf", `${upright ? `${upright},` : ""}scale='min(${edge},iw)':'min(${edge},ih)':force_original_aspect_ratio=decrease`,
      "-frames:v", "1", ...(jpeg ? ["-q:v", "2"] : []), output], { timeoutMs: 60_000 });
    const resized = await readFile(output);
    const resizedInfo = imageInfo(resized);
    return resizedInfo && resizedInfo.width && resizedInfo.height ? { body: resized, mime: resizedInfo.mime } : { body, mime: info.mime };
  } catch { return { body, mime: info.mime }; }
  finally { await rm(dir, { recursive: true, force: true }); }
}
