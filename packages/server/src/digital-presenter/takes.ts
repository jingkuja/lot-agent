import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type pg from "pg";
import { ProviderError } from "@lot-agent/core";
import type { PresenterDraft, PresenterSegment, PresenterTake } from "@lot-agent/core/digital-presenter";
import type { ReadyTwinVoice, TwinVoices } from "../digital-twin/voices.js";
import { KnowledgeError } from "../knowledge/errors.js";
import { inspectMedia } from "../marketing-video/media.js";
import { PresenterError } from "./errors.js";
import { presenterFile, presenterPath } from "./files.js";

/** A take a job freezes. Its file is never replaced: a redone take gets a new file. */
export interface FrozenTake { slot: number; text: string; file: string; durationMs: number }

/** A `running` take older than the speech deadline is shown as failed; it is synthesized
 * again only when the user asks. */
export const TAKE_STALE_MS = 120_000;
const CONCURRENCY = 3;

/** Covers everything that changes the audio, so an edit leaves the old take unused. */
export function takeKey(voice: ReadyTwinVoice, draft: PresenterDraft, text: string) {
  return createHash("sha256").update(JSON.stringify([voice.targetModel, draft.voice.twinItemId, voice.voiceId, draft.voice.speed, draft.voice.instructions, text, "wav"])).digest("hex");
}

type Row = { slot: number; take_key: string; status: "running" | "succeeded" | "failed"; file: string | null; duration_ms: number | null; updated_at: Date };

/** Per-segment takes in the twin's own cloned voice. Speech goes through the owner's model
 * key, so the gateway bills the owner; every synthesis is one request, never resent automatically. */
export class PresenterVoicer {
  constructor(private readonly pool: pg.Pool, private readonly dataRoot: string,
    private readonly voices?: Pick<TwinVoices, "ready" | "speakAs">, private readonly inspect = inspectMedia) {}
  get available() { return !!this.voices; }

  private async plan(owner: string, draft: PresenterDraft, segments: PresenterSegment[]) {
    if (!this.voices) throw new PresenterError("数字分身配音服务未启用。", 503);
    if (!draft.voice.twinItemId) throw new PresenterError("请先选择数字分身音色。");
    let voice: ReadyTwinVoice;
    try { voice = await this.voices.ready(owner, draft.voice.twinItemId); }
    catch (error) {
      if (error instanceof KnowledgeError) throw new PresenterError(error.status === 404 ? "数字分身音色不存在，请重新选择。" : "所选音色尚未复刻完成，请先在数字分身中复刻声音。", 409);
      throw error;
    }
    return { voice, keys: segments.map(segment => takeKey(voice, draft, segment.text)) };
  }
  private async rows(projectId: string, keys: string[]): Promise<(Row | undefined)[]> {
    const { rows } = await this.pool.query<Row>(`SELECT slot,take_key,status,file,duration_ms,updated_at FROM digital_presenter_takes
      WHERE project_id=$1 AND take_key=ANY($2::text[])`, [projectId, keys]);
    return keys.map((key, slot) => rows.find(row => row.slot === slot && row.take_key === key));
  }
  private take(row: Row | undefined, slot: number): PresenterTake {
    if (!row) return { slot, status: "missing" };
    if (row.status === "running" && Date.now() - new Date(row.updated_at).getTime() > TAKE_STALE_MS) return { slot, status: "failed" };
    return { slot, status: row.status, ...(row.status === "succeeded" ? { durationMs: Number(row.duration_ms) } : {}) };
  }

  async status(owner: string, projectId: string, draft: PresenterDraft, segments: PresenterSegment[]): Promise<PresenterTake[]> {
    const { keys } = await this.plan(owner, draft, segments);
    return (await this.rows(projectId, keys)).map((row, slot) => this.take(row, slot));
  }

  /** Synthesizes segments without a take for the current text and voice, plus `redo` slots.
   * A failed take stays failed until the user asks for it again. */
  async synthesize(owner: string, projectId: string, draft: PresenterDraft, segments: PresenterSegment[], redo: number[] = []) {
    const { voice, keys } = await this.plan(owner, draft, segments);
    const current = (await this.rows(projectId, keys)).map((row, slot) => this.take(row, slot));
    const targets = segments.filter(segment => current[segment.index].status === "missing"
      || (redo.includes(segment.index) && current[segment.index].status !== "running"));
    let error = "";
    let next = 0;
    const work = async () => {
      while (next < targets.length) {
        const segment = targets[next++];
        error ||= await this.synthesizeOne(owner, projectId, voice, draft, keys[segment.index], segment, current[segment.index].status !== "missing");
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, work));
    return { takes: await this.status(owner, projectId, draft, segments), error };
  }

  /** One billed take. The intent row is written first; a lost answer leaves it running.
   * Only an explicit redo may replace an existing row, so concurrent requests never pay twice. */
  private async synthesizeOne(owner: string, projectId: string, voice: ReadyTwinVoice, draft: PresenterDraft, key: string, segment: PresenterSegment, redo: boolean): Promise<string> {
    const where = "project_id=$1 AND slot=$2 AND take_key=$3";
    const ids = [projectId, segment.index, key];
    const claim = redo
      ? await this.pool.query(`UPDATE digital_presenter_takes SET status='running',file=NULL,duration_ms=NULL,updated_at=now()
          WHERE ${where} AND (status<>'running' OR updated_at < now() - $4::double precision * interval '1 millisecond') RETURNING slot`, [...ids, TAKE_STALE_MS])
      : await this.pool.query(`INSERT INTO digital_presenter_takes(project_id,slot,take_key,status) VALUES($1,$2,$3,'running')
          ON CONFLICT (project_id,slot,take_key) DO NOTHING RETURNING slot`, ids);
    if (!claim.rowCount) return "";
    try {
      // Not tied to the browser connection: a closed tab must not discard a billed take.
      const result = await this.voices!.speakAs(owner, voice, { text: segment.text, speed: draft.voice.speed, instructions: draft.voice.instructions || undefined }, "wav");
      const file = `${randomUUID()}.wav`;
      const path = presenterPath(this.dataRoot, projectId, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, result.audio);
      const info = await this.inspect(path).catch(() => null);
      if (!info?.audio || info.video || info.duration < 0.3 || info.duration > 30) {
        await rm(path, { force: true });
        throw new PresenterError("配音音频无法读取或时长异常，请重新生成该段配音。");
      }
      await this.pool.query(`UPDATE digital_presenter_takes SET status='succeeded',file=$4,duration_ms=$5,updated_at=now() WHERE ${where} AND status='running'`,
        [...ids, file, Math.round(info.duration * 1000)]);
      return "";
    } catch (error) {
      await this.pool.query(`UPDATE digital_presenter_takes SET status='failed',updated_at=now() WHERE ${where} AND status='running'`, ids);
      if (error instanceof ProviderError) {
        // The gateway request ID lets support reconcile a rare charge for a failed take.
        console.warn("[digital-presenter] take failed", { projectId, slot: segment.index, code: error.code, httpStatus: error.httpStatus, upstreamRequestId: error.requestId });
        if (error.httpStatus === 401 || error.httpStatus === 402 || error.httpStatus === 403) return "模型账号余额不足或未开通语音合成。";
        return "配音合成失败，请稍后重新生成该段配音。";
      }
      if (error instanceof PresenterError || error instanceof KnowledgeError) return error.message;
      console.warn("[digital-presenter] take failed", { projectId, slot: segment.index, errorType: (error as Error)?.name });
      return "配音合成失败，请稍后重新生成该段配音。";
    }
  }

  /** What a new job freezes: a finished take for every segment of the current draft. */
  async frozen(owner: string, projectId: string, draft: PresenterDraft, segments: PresenterSegment[]): Promise<FrozenTake[]> {
    const { keys } = await this.plan(owner, draft, segments);
    const rows = await this.rows(projectId, keys);
    return Promise.all(segments.map(async segment => {
      const row = rows[segment.index];
      if (row?.status !== "succeeded" || !row.file || !row.duration_ms) throw new PresenterError("请先生成全部配音并试听。", 409);
      try { await presenterFile(this.dataRoot, projectId, row.file); }
      catch { throw new PresenterError(`第 ${segment.index + 1} 段配音文件不可用，请重新生成该段配音。`, 409); }
      return { slot: segment.index, text: segment.text, file: row.file, durationMs: row.duration_ms };
    }));
  }

  /** The current take of one segment, for listening; reading it is free. */
  async audio(owner: string, projectId: string, draft: PresenterDraft, segments: PresenterSegment[], slot: number) {
    const { keys } = await this.plan(owner, draft, segments);
    const row = (await this.rows(projectId, keys))[slot];
    if (row?.status !== "succeeded") throw new PresenterError("该段配音尚未生成。", 404);
    try { return await readFile(await presenterFile(this.dataRoot, projectId, row.file)); }
    catch { throw new PresenterError("该段配音文件不可用，请重新生成。", 404); }
  }
}
