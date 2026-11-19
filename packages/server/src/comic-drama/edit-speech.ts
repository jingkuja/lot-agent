import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ProviderError, type SpeechProvider, type SpeechRequest, type SpeechResult } from "@lot-agent/core";
import {
  comicDramaClipDraftSchema, comicSpeechPresets, comicVoiceBindSchema,
  type ComicSpeechLines, type ComicSpeechRequest, type ComicSpeechTake, type ComicVoiceBind, type ComicVoiceSettings,
} from "@lot-agent/core/comic-drama";
import { readComicDictionary } from "./dictionary.js";
import { ComicEditConflict, type PgComicEdits } from "./edit-repository.js";
import { ComicLibraryError, libraryMissing, libraryTransaction } from "./library-db.js";
import { insertComicMedia } from "./library-repository.js";
import type { ComicMediaLibrary } from "./media-library.js";

type CloneVoice = { targetModel: string; voiceId: string };
export type ComicSpeechDeps = {
  presetModel?: string;
  ownerSpeech(owner: string): Promise<SpeechProvider | null>;
  clones?: {
    list(owner: string): Promise<{ id: string; title: string }[]>;
    ready(owner: string, itemId: string): Promise<CloneVoice>;
    speak(owner: string, voice: CloneVoice, input: Omit<SpeechRequest, "voice" | "model" | "format">, signal: AbortSignal): Promise<SpeechResult>;
  };
};
type BindingRow = { binding: ComicVoiceBind; version: string; fingerprint: string | null };
type CacheRow = { status: string; mediaId: string | null; durationMs: number | null };
const cd = "lot_comic_drama";
const digest = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const unavailable = () => new ComicLibraryError("EDIT_VOICE_UNAVAILABLE", 404);

export class ComicEditSpeech {
  constructor(private readonly pool: Pool, private readonly edits: PgComicEdits, private readonly media: ComicMediaLibrary,
    private readonly deps: ComicSpeechDeps) {}

  private async binding(owner: string, id: string) {
    const { rows: [row] } = await this.pool.query<BindingRow>(`SELECT binding,voice_version AS version,clone_fingerprint AS fingerprint
      FROM ${cd}.cd_character_voice WHERE owner_id=$1 AND character_id=$2`, [owner, id]);
    return row && { ...row, binding: comicVoiceBindSchema.parse(row.binding) };
  }

  private async ready(owner: string, item: string) {
    if (!this.deps.clones) throw unavailable();
    return this.deps.clones.ready(owner, item).catch(() => { throw unavailable(); });
  }

  async settings(owner: string, id: string): Promise<ComicVoiceSettings> {
    if (!(await this.pool.query(`SELECT 1 FROM ${cd}.cd_characters WHERE owner_id=$1 AND id=$2`, [owner, id])).rowCount) libraryMissing();
    const [current, clones] = await Promise.all([this.binding(owner, id), this.deps.clones?.list(owner) ?? []]);
    return { binding: current?.binding ?? { kind: "none" }, presets: this.deps.presetModel ? comicSpeechPresets : [],
      clonesEnabled: !!this.deps.clones, clones };
  }

  async bind(owner: string, id: string, binding: ComicVoiceBind) {
    const exists = await this.pool.query(`SELECT 1 FROM ${cd}.cd_characters WHERE owner_id=$1 AND id=$2 AND archived_at IS NULL`, [owner, id]);
    if (!exists.rowCount) libraryMissing();
    if (binding.kind === "preset" && !this.deps.presetModel) throw unavailable();
    const fingerprint = binding.kind === "clone" ? digest(await this.ready(owner, binding.itemId)) : null;
    await libraryTransaction(this.pool, async db => {
      const locked = await db.query(`SELECT 1 FROM ${cd}.cd_characters WHERE owner_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`, [owner, id]);
      if (!locked.rowCount) libraryMissing();
      if (binding.kind === "none") {
        await db.query(`DELETE FROM ${cd}.cd_character_voice WHERE owner_id=$1 AND character_id=$2`, [owner, id]);
        return;
      }
      await db.query(`INSERT INTO ${cd}.cd_character_voice AS v(owner_id,character_id,binding,voice_version,clone_fingerprint,authorized_at)
        VALUES($1,$2,$3,$4,$5,CASE WHEN $5::text IS NOT NULL THEN now() END)
        ON CONFLICT (owner_id,character_id) DO UPDATE SET binding=excluded.binding,voice_version=excluded.voice_version,
          clone_fingerprint=excluded.clone_fingerprint,authorized_at=excluded.authorized_at
        WHERE v.binding IS DISTINCT FROM excluded.binding OR v.clone_fingerprint IS DISTINCT FROM excluded.clone_fingerprint`,
      [owner, id, binding, randomUUID(), fingerprint]);
    });
  }

  private async linesForClip(owner: string, clipId: string | null): Promise<ComicSpeechLines> {
    const presets = this.deps.presetModel ? comicSpeechPresets : [];
    if (!clipId) return { clipRevision: null, lines: [], characters: [], presets };
    const { rows: [source] } = await this.pool.query<{ revision: number; draft: unknown; characters: ComicSpeechLines["characters"] }>(
      `SELECT c.revision,c.draft,coalesce((SELECT jsonb_agg(jsonb_build_object('id',x.character_id,'name',x.snapshot->>'name',
        'aliases',x.snapshot->'aliases') ORDER BY x.snapshot->>'name',x.character_id)
        FROM ${cd}.cd_series_cast x JOIN ${cd}.cd_character_voice v ON (v.owner_id,v.character_id)=(x.owner_id,x.character_id)
        WHERE (x.owner_id,x.series_id)=(s.owner_id,s.id)
          AND (($3::boolean AND v.binding->>'kind'='preset') OR ($4::boolean AND v.binding->>'kind'='clone'))),'[]'::jsonb) AS characters
      FROM ${cd}.cd_clips c JOIN ${cd}.cd_series s ON s.id=c.series_id WHERE c.id=$1 AND s.owner_id=$2 AND s.deleted_at IS NULL`,
      [clipId, owner, !!this.deps.presetModel, !!this.deps.clones]);
    return { clipRevision: source?.revision ?? null, presets, characters: source?.characters ?? [],
      lines: source ? comicDramaClipDraftSchema.parse(source.draft).lines.filter(line => line.text) : [] };
  }

  async lines(owner: string, editId: string, itemId: string, expected?: number) {
    const edit = await this.edits.get(owner, editId);
    if (expected !== undefined && edit.revision !== expected) throw new ComicEditConflict(edit.revision);
    const item = edit.timeline.video.find(item => item.id === itemId);
    if (!item) libraryMissing();
    return this.linesForClip(owner, edit.sources.find(source => source.takeId === item.takeId)?.clipId ?? null);
  }

  private async resolve(owner: string, scope: ComicSpeechRequest["voice"]) {
    const binding = scope.kind === "character" ? await this.binding(owner, scope.characterId) : undefined;
    const selected = scope.kind === "preset" ? scope : binding?.binding;
    if (selected?.kind === "clone" && this.deps.clones) {
      const voice = await this.ready(owner, selected.itemId);
      if (digest(voice) !== binding?.fingerprint) throw unavailable();
      return { voice, version: binding.version, clone: true };
    }
    if (selected?.kind === "preset" && this.deps.presetModel) {
      return { voice: { targetModel: this.deps.presetModel, voiceId: selected.preset }, version: binding?.version ?? null, clone: false };
    }
    throw unavailable();
  }

  private async cached(owner: string, fingerprint: string): Promise<ComicSpeechTake | null> {
    const { rows: [row] } = await this.pool.query<CacheRow>(`SELECT CASE WHEN c.status='submitting' AND c.updated_at<now()-interval '5 minutes'
      THEN 'unknown' ELSE c.status END AS status,c.media_id AS "mediaId",m.duration_ms AS "durationMs"
      FROM ${cd}.cd_speech_cache c LEFT JOIN ${cd}.cd_media m ON (m.owner_id,m.id)=(c.owner_id,c.media_id)
      WHERE c.owner_id=$1 AND c.fingerprint=$2`, [owner, fingerprint]);
    if (row?.status === "ready" && row.mediaId && row.durationMs) return { mediaId: row.mediaId, durationMs: row.durationMs, cached: true };
    if (row?.status === "submitting") throw new ComicLibraryError("EDIT_SPEECH_RUNNING", 409);
    if (row?.status === "unknown") throw new ComicLibraryError("EDIT_SPEECH_UNKNOWN", 409);
    return null;
  }

  async speak(owner: string, editId: string, itemId: string, lineId: string, fields: ComicSpeechRequest, signal: AbortSignal) {
    const source = await this.lines(owner, editId, itemId, fields.expectedRevision);
    if (source.clipRevision !== fields.expectedClipRevision) throw new ComicLibraryError("EDIT_DIALOGUE_CHANGED", 409);
    const line = source.lines.find(line => line.id === lineId);
    if (!line) libraryMissing();
    const scope = fields.voice;
    if (scope.kind === "character" && !source.characters.some(character => character.id === scope.characterId)) throw unavailable();
    const { voice, version, clone } = await this.resolve(owner, scope);
    const emotions = line.emotionKey ? await readComicDictionary(this.pool, owner, "emotion") : [];
    const instructions = emotions.find(entry => entry.key === line.emotionKey)?.labels.en;
    const input = { text: line.text, instructions, speed: line.speed };
    const fingerprint = digest([1, scope, version, voice, input, "wav"]);
    const existing = await this.cached(owner, fingerprint);
    if (existing) return existing;
    this.media.assertAvailable();
    const provider = await this.deps.ownerSpeech(owner);
    if (!provider) throw new ComicLibraryError("EDIT_SPEECH_UNAVAILABLE", 503);
    signal.throwIfAborted();
    const claimed = await this.pool.query(`INSERT INTO ${cd}.cd_speech_cache AS c(owner_id,fingerprint,status) VALUES($1,$2,'submitting')
      ON CONFLICT (owner_id,fingerprint) DO UPDATE SET status='submitting',updated_at=now(),gateway_request_id=NULL WHERE c.status='failed'`,
    [owner, fingerprint]);
    if (!claimed.rowCount) {
      const winner = await this.cached(owner, fingerprint);
      if (winner) return winner;
      throw new ComicLibraryError("EDIT_SPEECH_RUNNING", 409);
    }
    let trace: string | undefined;
    try {
      const output = clone && this.deps.clones ? await this.deps.clones.speak(owner, voice, input, signal)
        : await provider.synthesize({ ...input, model: voice.targetModel, voice: voice.voiceId, format: "wav" }, signal);
      trace = output.gatewayRequestId;
      const request = new Request("http://comic.local/speech", { method: "POST", signal, headers: { "Content-Type": output.mime },
        body: new Uint8Array(output.audio) });
      return await this.media.upload(request, owner, "other", file => libraryTransaction(this.pool, async db => {
        if (file.mime !== "audio/wav" || !file.durationMs) throw new ComicLibraryError("EDIT_SPEECH_UNAVAILABLE", 503);
        await insertComicMedia(db, file);
        const result = await db.query(`UPDATE ${cd}.cd_speech_cache SET status='ready',media_id=$3,gateway_request_id=$4,updated_at=now()
          WHERE owner_id=$1 AND fingerprint=$2 AND status='submitting'`, [owner, fingerprint, file.id, safeTrace(trace)]);
        if (!result.rowCount) throw new ComicLibraryError("EDIT_SPEECH_UNAVAILABLE", 503);
        return { mediaId: file.id, durationMs: file.durationMs, cached: false };
      }));
    } catch (error) {
      const status = error instanceof ProviderError ? error.httpStatus : undefined;
      const rejected = error instanceof ProviderError && error.code === "HTTP_ERROR" && status &&
        status >= 400 && status < 500 && ![408, 409, 425].includes(status);
      await this.pool.query(`UPDATE ${cd}.cd_speech_cache SET status=$3,gateway_request_id=$4,updated_at=now()
        WHERE owner_id=$1 AND fingerprint=$2 AND status='submitting'`,
      [owner, fingerprint, rejected ? "failed" : "unknown", safeTrace(error instanceof ProviderError ? error.gatewayRequestId : trace)]);
      throw rejected ? new ComicLibraryError("EDIT_SPEECH_UNAVAILABLE", 503) : new ComicLibraryError("EDIT_SPEECH_UNKNOWN", 409);
    }
  }
}

function safeTrace(trace: string | undefined) {
  return trace && /^[\w.:-]{1,200}$/.test(trace) ? trace : null;
}
