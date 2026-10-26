import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type pg from "pg";
import { ProviderError } from "@lot-agent/core";
import { marketingNarrationFits, type MarketingDraft, type MarketingNarration, type MarketingNarrationClip, type MarketingSegment } from "@lot-agent/core/marketing-video";
import type { ReadyTwinVoice, TwinVoices } from "../digital-twin/voices.js";
import { KnowledgeError } from "../knowledge/errors.js";
import { inspectMedia } from "./media.js";
import { MarketingError } from "./repository.js";

/** The take each shot of a version 4 job uses. The file is never replaced: a new take of
 * the same shot gets a new file, so a frozen job always composes what was confirmed. */
export interface FrozenNarration { slot: number; key: string; storageKey: string; durationMs: number }

/** A `running` take older than the speech request deadline is shown as failed; it is only
 * synthesized again when the user asks for it. */
export const NARRATION_STALE_MS = 120_000;
const CONCURRENCY = 3;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export const narrationRoot = (dataRoot: string) => resolve(dataRoot, "marketing-narration");
/** Covers everything that changes the audio, so an edit leaves the old take unused. */
export function narrationKey(voice: ReadyTwinVoice, settings: MarketingNarration, script: string) {
  return createHash("sha256").update(JSON.stringify([voice.targetModel, settings.twinItemId, voice.voiceId, settings.speed, settings.instructions, script, "wav"])).digest("hex");
}

/** A frozen take's file, only inside the draft's own folder. */
export async function narrationFile(dataRoot: string, projectId: string, storageKey: unknown) {
  if (!uuid.test(projectId) || typeof storageKey !== "string" || !new RegExp(`^${projectId}/[a-f0-9-]{36}\\.wav$`, "i").test(storageKey)) throw new Error("配音文件不可用");
  const root = await realpath(narrationRoot(dataRoot));
  const path = await realpath(resolve(root, storageKey));
  if (!path.startsWith(root + sep)) throw new Error("配音文件不可用");
  return path;
}

/** Narration frozen into a job input, checked against its clip count. */
export function frozenNarration(value: unknown, count: number): FrozenNarration[] {
  const list = Array.isArray(value) ? value as FrozenNarration[] : [];
  if (list.length !== count || list.some((item, slot) => !item || item.slot !== slot || typeof item.key !== "string" || typeof item.storageKey !== "string"
    || !Number.isInteger(item.durationMs) || item.durationMs <= 0)) throw new Error("配音记录不完整");
  return list;
}

type Row = { slot: number; narration_key: string; status: "running" | "succeeded" | "failed"; storage_key: string | null; duration_ms: number | null; updated_at: Date;
  error?: string | null };
const INTERRUPTED = "配音合成被中断，请重新生成该镜配音。";

/** Per-shot twin narration of a draft. Speech goes through the owner's own model key, so the
 * gateway bills the owner; every synthesis is one request, never resent automatically. */
export class MarketingNarrator {
  private readonly active = new Set<Promise<unknown>>();
  constructor(private readonly pool: pg.Pool, private readonly dataRoot: string,
    private readonly voices?: Pick<TwinVoices, "ready" | "speakAs">, private readonly inspect = inspectMedia) {}
  get available() { return !!this.voices; }

  private async plan(owner: string, draft: MarketingDraft, segments: MarketingSegment[]) {
    const settings = draft.narration;
    if (!this.voices) throw new MarketingError("数字分身配音服务未启用。", 503);
    if (!settings?.twinItemId) throw new MarketingError("请先选择数字分身音色。");
    let voice: ReadyTwinVoice;
    try { voice = await this.voices.ready(owner, settings.twinItemId); }
    catch (error) {
      if (error instanceof KnowledgeError) throw new MarketingError(error.status === 404 ? "数字分身音色不存在，请重新选择。" : "所选音色尚未复刻完成，请先在数字分身中复刻声音。", 409);
      throw error;
    }
    return { voice, settings, keys: segments.map(segment => narrationKey(voice, settings, segment.script)) };
  }
  private async rows(owner: string, projectId: string, keys: string[]): Promise<(Row | undefined)[]> {
    const { rows } = await this.pool.query<Row>(`SELECT slot,narration_key,status,storage_key,duration_ms,updated_at,error FROM marketing_video_narrations
      WHERE owner_id=$1 AND project_id=$2 AND narration_key=ANY($3::text[])`, [owner, projectId, keys]);
    return keys.map((key, slot) => rows.find(row => row.slot === slot && row.narration_key === key));
  }
  private clip(row: Row | undefined, slot: number): MarketingNarrationClip {
    if (!row) return { slot, status: "missing" };
    if (row.status === "running" && Date.now() - new Date(row.updated_at).getTime() > NARRATION_STALE_MS) return { slot, status: "failed", error: INTERRUPTED };
    return { slot, status: row.status, ...(row.status === "succeeded" ? { durationMs: Number(row.duration_ms) } : {}),
      ...(row.status === "failed" && row.error ? { error: row.error } : {}) };
  }

  async status(owner: string, projectId: string, draft: MarketingDraft, segments: MarketingSegment[]): Promise<MarketingNarrationClip[]> {
    const { keys } = await this.plan(owner, draft, segments);
    return (await this.rows(owner, projectId, keys)).map((row, slot) => this.clip(row, slot));
  }

  /** Synthesizes shots without a take for the current text and settings, plus `redo` shots.
   * A failed shot stays failed until the user asks for it again. With `background`, the takes are
   * claimed before it returns and their speech requests go on after it; callers poll `status`. */
  async synthesize(owner: string, projectId: string, draft: MarketingDraft, segments: MarketingSegment[], redo: number[] = [],
    options: { background?: boolean } = {}) {
    const { voice, settings, keys } = await this.plan(owner, draft, segments);
    const current = (await this.rows(owner, projectId, keys)).map((row, slot) => this.clip(row, slot));
    const targets = segments.filter(segment => current[segment.index].status === "missing"
      || (redo.includes(segment.index) && current[segment.index].status !== "running"));
    const claimed: MarketingSegment[] = [];
    for (const segment of targets) {
      if (await this.claim(owner, projectId, keys[segment.index], segment, current[segment.index].status !== "missing")) claimed.push(segment);
    }
    let error = "";
    let next = 0;
    const work = async () => {
      while (next < claimed.length) {
        const segment = claimed[next++];
        error ||= await this.take(owner, projectId, voice, settings, keys[segment.index], segment);
      }
    };
    const all = Promise.all(Array.from({ length: Math.min(CONCURRENCY, claimed.length) }, work));
    if (options.background) {
      const running = all.finally(() => this.active.delete(running));
      this.active.add(running);
    } else await all;
    return { clips: await this.status(owner, projectId, draft, segments), error };
  }

  /** Waits for takes this process synthesizes in the background; for tests and shutdown. */
  async settled() { await Promise.allSettled([...this.active]); }

  /** The intent row of one take, written before its billed request. Only an explicit redo may
   * replace an existing row, so concurrent requests never pay twice. */
  private async claim(owner: string, projectId: string, key: string, segment: MarketingSegment, redo: boolean) {
    const ids = [owner, projectId, segment.index, key];
    const claim = redo
      ? await this.pool.query(`UPDATE marketing_video_narrations SET status='running',storage_key=NULL,duration_ms=NULL,error=NULL,updated_at=now()
          WHERE owner_id=$1 AND project_id=$2 AND slot=$3 AND narration_key=$4
            AND (status<>'running' OR updated_at < now() - $5::double precision * interval '1 millisecond') RETURNING slot`, [...ids, NARRATION_STALE_MS])
      : await this.pool.query(`INSERT INTO marketing_video_narrations(owner_id,project_id,slot,narration_key,status) VALUES($1,$2,$3,$4,'running')
          ON CONFLICT (owner_id,project_id,slot,narration_key) DO NOTHING RETURNING slot`, ids);
    return !!claim.rowCount;
  }

  /** One billed take of a claimed row; a lost answer leaves it running. Never rejects: the outcome
   * is written to the row, and the message is returned. */
  private async take(owner: string, projectId: string, voice: ReadyTwinVoice, settings: MarketingNarration, key: string,
    segment: MarketingSegment): Promise<string> {
    const where = "owner_id=$1 AND project_id=$2 AND slot=$3 AND narration_key=$4";
    const ids = [owner, projectId, segment.index, key];
    try {
      if (Array.from(segment.script).length > 500) throw new MarketingError("单镜口播过长，请精简后再生成配音。");
      // Not tied to the browser connection: a closed tab must not discard a billed take.
      const started = Date.now();
      const result = await this.voices!.speakAs(owner, voice, { text: segment.script, speed: settings.speed, instructions: settings.instructions || undefined }, "wav");
      // Identifiers and timing only: a slow take is looked up in the gateway logs by this ID.
      console.log("[marketing-video] narration take", { projectId, slot: segment.index, requestMs: Date.now() - started, chars: Array.from(segment.script).length,
        gatewayRequestId: result.gatewayRequestId ?? null });
      const storageKey = `${projectId}/${randomUUID()}.wav`;
      const path = resolve(narrationRoot(this.dataRoot), storageKey);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, result.audio);
      const info = await this.inspect(path).catch(() => null);
      if (!info?.audio || info.video || info.duration < 0.3 || info.duration > 15) {
        await rm(path, { force: true });
        throw new MarketingError("配音音频无法读取或时长异常，请重新生成该镜配音。");
      }
      await this.pool.query(`UPDATE marketing_video_narrations SET status='succeeded',storage_key=$5,duration_ms=$6,updated_at=now() WHERE ${where} AND status='running'`,
        [...ids, storageKey, Math.round(info.duration * 1000)]);
      return "";
    } catch (error) {
      const message = this.message(projectId, segment, error);
      await this.pool.query(`UPDATE marketing_video_narrations SET status='failed',error=$5,updated_at=now() WHERE ${where} AND status='running'`, [...ids, message])
        .catch(() => console.warn("[marketing-video] narration state not saved", { projectId, slot: segment.index }));
      return message;
    }
  }

  private message(projectId: string, segment: MarketingSegment, error: unknown) {
    if (error instanceof ProviderError) {
      // The gateway request ID lets support reconcile a rare charge for a failed take.
      console.warn("[marketing-video] narration failed", { projectId, slot: segment.index, code: error.code, httpStatus: error.httpStatus,
        upstreamRequestId: error.requestId, gatewayRequestId: error.gatewayRequestId ?? null });
      if (error.httpStatus === 401 || error.httpStatus === 402 || error.httpStatus === 403) return "模型账号余额不足或未开通语音合成。";
      return "配音合成失败，请稍后重新生成该镜配音。";
    }
    if (error instanceof MarketingError || error instanceof KnowledgeError) return error.message;
    console.warn("[marketing-video] narration failed", { projectId, slot: segment.index, errorType: (error as Error)?.name });
    return "配音合成失败，请稍后重新生成该镜配音。";
  }

  /** What a new job freezes: a fitting take for every shot of the current draft. */
  async frozen(owner: string, projectId: string, draft: MarketingDraft, segments: MarketingSegment[]): Promise<FrozenNarration[]> {
    const { keys } = await this.plan(owner, draft, segments);
    const rows = await this.rows(owner, projectId, keys);
    return Promise.all(segments.map(async segment => {
      const row = rows[segment.index];
      if (row?.status !== "succeeded" || !row.storage_key || !row.duration_ms) throw new MarketingError("请先生成全部分镜的数字分身配音并试听。", 409);
      if (!marketingNarrationFits(row.duration_ms, segment.durationSec)) throw new MarketingError(`第 ${segment.index + 1} 镜配音长于镜头时长，请按配音调整分镜时长。`, 409);
      try { await narrationFile(this.dataRoot, projectId, row.storage_key); }
      catch { throw new MarketingError(`第 ${segment.index + 1} 镜配音文件不可用，请重新生成该镜配音。`, 409); }
      return { slot: segment.index, key: row.narration_key, storageKey: row.storage_key, durationMs: row.duration_ms };
    }));
  }

  /** The current take of one shot, for listening before paying for clips. */
  async audio(owner: string, projectId: string, draft: MarketingDraft, segments: MarketingSegment[], slot: number) {
    const { keys } = await this.plan(owner, draft, segments);
    const row = (await this.rows(owner, projectId, keys))[slot];
    if (row?.status !== "succeeded") throw new MarketingError("该镜配音尚未生成。", 404);
    try { return await readFile(await narrationFile(this.dataRoot, projectId, row.storage_key)); }
    catch { throw new MarketingError("该镜配音文件不可用，请重新生成。", 404); }
  }

  /** Space the takes of the owner's drafts hold on disk (every take, also replaced ones). */
  async ownerBytes(owner: string) {
    const { rows } = await this.pool.query<{ id: string }>("SELECT id FROM marketing_video_projects WHERE user_id=$1", [owner]);
    let bytes = 0;
    for (const { id } of rows) {
      if (!uuid.test(id)) continue;
      const folder = resolve(narrationRoot(this.dataRoot), id);
      const names = await readdir(folder).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return [] as string[]; throw error; });
      for (const name of names) {
        const info = await lstat(join(folder, name)).catch(() => null);
        if (info?.isFile()) bytes += info.size;
      }
    }
    return bytes;
  }

  /** Rows go with the draft (ON DELETE CASCADE); this removes the files. */
  async removeFiles(projectId: string) {
    if (!uuid.test(projectId)) return;
    await rm(resolve(narrationRoot(this.dataRoot), projectId), { recursive: true, force: true });
  }
}
