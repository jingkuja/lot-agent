import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ProviderError, type SpeechProvider, type SpeechRequest, type SpeechResult } from "@lot-agent/core";
import {
  COMIC_SPEECH_ESTIMATE_POINTS, COMIC_SPEECH_PRESET_CATALOG, comicDramaClipDraftSchema, comicSpeechPresets, comicVoiceBindSchema,
  estimateComicDialogueMs, matchComicCharacters,
  type ComicAutoDialogueItemOutcome, type ComicAutoDialogueNativeClip, type ComicAutoDialoguePlan, type ComicAutoDialoguePlanLine,
  type ComicAutoDialogueResult, type ComicEditAutoDialogue, type ComicEditAutoDialogueOverride, type ComicEditAutoDialoguePreview,
  type ComicSpeechLines, type ComicSpeechRequest, type ComicSpeechTake, type ComicTimeline, type ComicVoiceAudition,
  type ComicVoiceBind, type ComicVoiceSettings, type ComicSpeechPresetId, type ComicSpeechPresetMeta,
} from "@lot-agent/core/comic-drama";
import { readComicDictionary } from "./dictionary.js";
import { assertComicDramaCompliance } from "./compliance.js";
import { ComicEditConflict, type PgComicEdits } from "./edit-repository.js";
import { ComicLibraryError, libraryMissing, libraryTransaction } from "./library-db.js";
import { insertComicMedia } from "./library-repository.js";
import type { ComicMediaLibrary } from "./media-library.js";
import { DEFAULT_TTS_MODEL } from "../models/media-defaults.js";

// Keep the stored preset IDs valid across the switch to Qwen system voices.
const qwenVoiceIds: Record<ComicSpeechPresetId, string> = { alloy: "longanlingxin", nova: "longanlingxin", onyx: "longanlufeng" };
const qwenPresets: readonly ComicSpeechPresetMeta[] = [
  { id: "nova", gender: "female", age: "young_adult", tone: "balanced",
    labels: { zh: "龙安灵心 · 温暖女声", en: "Lingxin · Warm Female Voice", id: "Lingxin · Suara Wanita Hangat" },
    summary: { zh: "温暖自然，支持普通话与英语", en: "Warm and natural, supports Mandarin and English", id: "Hangat dan alami, mendukung Mandarin dan Inggris" } },
  { id: "onyx", gender: "male", age: "young_adult", tone: "bright",
    labels: { zh: "龙安鲁风 · 明亮男声", en: "Lufeng · Bright Male Voice", id: "Lufeng · Suara Pria Cerah" },
    summary: { zh: "明亮开朗，支持普通话与英语", en: "Bright and upbeat, supports Mandarin and English", id: "Cerah dan ceria, mendukung Mandarin dan Inggris" } },
];

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
type CacheRow = { status: string; mediaId: string | null; durationMs: number | null; activeAttemptId: string | null };
type SpeechAttemptMeta = { kind: "dialogue" | "audition"; editId?: string; lineId?: string };
const cd = "lot_comic_drama";
const digest = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const unavailable = () => new ComicLibraryError("EDIT_VOICE_UNAVAILABLE", 404);
const suggestedSpeedFor = (speed: number, audioMs: number, remainingMs: number) =>
  Math.min(2, Math.max(0.5, Number(((speed * audioMs) / Math.max(1, remainingMs)).toFixed(2))));

export class ComicEditSpeech {
  constructor(private readonly pool: Pool, private readonly edits: PgComicEdits, private readonly media: ComicMediaLibrary,
    private readonly deps: ComicSpeechDeps) {}

  private presets() {
    const presetCatalog = !this.deps.presetModel ? [] : this.deps.presetModel === DEFAULT_TTS_MODEL ? qwenPresets : COMIC_SPEECH_PRESET_CATALOG;
    return { presetCatalog, presets: presetCatalog.map(preset => preset.id) };
  }

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
    return {
      binding: current?.binding ?? { kind: "none" },
      ...this.presets(),
      clonesEnabled: !!this.deps.clones,
      clones,
    };
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
    const { presets, presetCatalog } = this.presets();
    if (!clipId) return { clipRevision: null, lines: [], characters: [], presets, presetCatalog };
    const { rows: [source] } = await this.pool.query<{ revision: number; draft: unknown; characters: ComicSpeechLines["characters"] }>(
      `SELECT c.revision,c.draft,coalesce((SELECT jsonb_agg(jsonb_build_object('id',x.character_id,'name',x.snapshot->>'name',
        'aliases',x.snapshot->'aliases') ORDER BY x.snapshot->>'name',x.character_id)
        FROM ${cd}.cd_series_cast x JOIN ${cd}.cd_character_voice v ON (v.owner_id,v.character_id)=(x.owner_id,x.character_id)
        WHERE (x.owner_id,x.series_id)=(s.owner_id,s.id)
          AND (($3::boolean AND v.binding->>'kind'='preset') OR ($4::boolean AND v.binding->>'kind'='clone'))),'[]'::jsonb) AS characters
      FROM ${cd}.cd_clips c JOIN ${cd}.cd_series s ON s.id=c.series_id WHERE c.id=$1 AND s.owner_id=$2 AND s.deleted_at IS NULL`,
      [clipId, owner, !!this.deps.presetModel, !!this.deps.clones]);
    return { clipRevision: source?.revision ?? null, presets, presetCatalog, characters: source?.characters ?? [],
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
      const targetModel = this.deps.presetModel;
      const voiceId = targetModel === DEFAULT_TTS_MODEL ? qwenVoiceIds[selected.preset] : selected.preset;
      return { voice: { targetModel, voiceId }, version: binding?.version ?? null, clone: false };
    }
    throw unavailable();
  }

  private async readCacheRow(owner: string, fingerprint: string): Promise<CacheRow | undefined> {
    const { rows: [row] } = await this.pool.query<CacheRow>(
      `SELECT CASE WHEN c.status='submitting' AND c.updated_at<now()-interval '5 minutes'
         THEN 'unknown' ELSE c.status END AS status,
         c.media_id AS "mediaId", m.duration_ms AS "durationMs", c.active_attempt_id AS "activeAttemptId"
       FROM ${cd}.cd_speech_cache c LEFT JOIN ${cd}.cd_media m ON (m.owner_id,m.id)=(c.owner_id,c.media_id)
       WHERE c.owner_id=$1 AND c.fingerprint=$2`,
      [owner, fingerprint],
    );
    return row;
  }

  private async cached(owner: string, fingerprint: string): Promise<ComicSpeechTake | null> {
    const row = await this.readCacheRow(owner, fingerprint);
    if (row?.status === "ready" && row.mediaId && row.durationMs) {
      return { mediaId: row.mediaId, durationMs: row.durationMs, cached: true };
    }
    if (row?.status === "submitting") throw new ComicLibraryError("EDIT_SPEECH_RUNNING", 409);
    if (row?.status === "unknown") throw new ComicLibraryError("EDIT_SPEECH_UNKNOWN", 409);
    return null;
  }

  private async prepare(owner: string, editId: string, itemId: string, lineId: string, fields: ComicSpeechRequest) {
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
    return { line, voice, clone, input, fingerprint };
  }

  private async prepareAudition(owner: string, fields: ComicVoiceAudition) {
    let resolved: { voice: CloneVoice; version: string | null; clone: boolean };
    if (fields.voice.kind === "clone") {
      const cloneVoice = await this.ready(owner, fields.voice.itemId);
      resolved = { voice: cloneVoice, version: null, clone: true };
    } else if (fields.voice.kind === "character") {
      const exists = await this.pool.query(`SELECT 1 FROM ${cd}.cd_characters WHERE owner_id=$1 AND id=$2`, [owner, fields.voice.characterId]);
      if (!exists.rowCount) libraryMissing();
      resolved = await this.resolve(owner, { kind: "character", characterId: fields.voice.characterId });
    } else {
      resolved = await this.resolve(owner, { kind: "preset", preset: fields.voice.preset });
    }
    const emotions = fields.emotionKey ? await readComicDictionary(this.pool, owner, "emotion") : [];
    const instructions = emotions.find(entry => entry.key === fields.emotionKey)?.labels.en;
    const input = { text: fields.text, instructions, speed: fields.speed };
    const fingerprint = digest(["audition", 1, fields.voice, resolved.version, resolved.voice, input, "wav"]);
    return { resolved, input, fingerprint };
  }

  private async releaseByFingerprint(owner: string, fingerprint: string) {
    await libraryTransaction(this.pool, async db => {
      const { rows: [row] } = await db.query<{ status: string; activeAttemptId: string | null }>(
        `SELECT status, active_attempt_id AS "activeAttemptId" FROM ${cd}.cd_speech_cache
         WHERE owner_id=$1 AND fingerprint=$2
           AND (status IN ('unknown','released') OR (status='submitting' AND updated_at<now()-interval '5 minutes'))
         FOR UPDATE`,
        [owner, fingerprint],
      );
      if (!row) throw new ComicLibraryError("EDIT_SPEECH_NOT_RELEASABLE", 409);
      if (row.activeAttemptId) {
        await db.query(
          `UPDATE ${cd}.cd_speech_attempts
           SET status='released', released_at=coalesce(released_at, now()), updated_at=now()
           WHERE id=$1 AND owner_id=$2 AND status IN ('submitting','unknown')`,
          [row.activeAttemptId, owner],
        );
      }
      await db.query(
        `UPDATE ${cd}.cd_speech_cache SET status='released', active_attempt_id=NULL, updated_at=now()
         WHERE owner_id=$1 AND fingerprint=$2`,
        [owner, fingerprint],
      );
    });
  }

  async release(owner: string, editId: string, itemId: string, lineId: string, fields: ComicSpeechRequest) {
    const { fingerprint } = await this.prepare(owner, editId, itemId, lineId, fields);
    await this.releaseByFingerprint(owner, fingerprint);
  }

  async releaseAudition(owner: string, fields: ComicVoiceAudition) {
    const { fingerprint } = await this.prepareAudition(owner, fields);
    await this.releaseByFingerprint(owner, fingerprint);
  }

  private async synthesizeCached(
    owner: string,
    fingerprint: string,
    voice: CloneVoice,
    clone: boolean,
    input: { text: string; instructions?: string; speed: number },
    signal: AbortSignal,
    accepting: (() => void) | undefined,
    meta: SpeechAttemptMeta,
  ): Promise<ComicSpeechTake> {
    const existing = await this.cached(owner, fingerprint);
    if (existing) return existing;
    accepting?.();
    this.media.assertAvailable();
    const provider = await this.deps.ownerSpeech(owner);
    if (!provider) throw new ComicLibraryError("EDIT_SPEECH_UNAVAILABLE", 503);
    signal.throwIfAborted();
    const attemptId = randomUUID();
    const claimed = await libraryTransaction(this.pool, async db => {
      const result = await db.query(
        `INSERT INTO ${cd}.cd_speech_cache AS c(owner_id,fingerprint,kind,status,active_attempt_id)
         VALUES($1,$2,$3,'submitting',$4)
         ON CONFLICT (owner_id,fingerprint) DO UPDATE
           SET kind=excluded.kind, status='submitting', active_attempt_id=$4, gateway_request_id=NULL, updated_at=now()
           WHERE c.status IN ('failed','released')`,
        [owner, fingerprint, meta.kind, attemptId],
      );
      if (!result.rowCount) return false;
      await db.query(
        `INSERT INTO ${cd}.cd_speech_attempts(id,owner_id,fingerprint,kind,edit_id,line_id,model_id,status)
         VALUES($1,$2,$3,$4,$5,$6,$7,'submitting')`,
        [attemptId, owner, fingerprint, meta.kind, meta.editId ?? null, meta.lineId ?? null, voice.targetModel],
      );
      return true;
    });
    if (!claimed) {
      const winner = await this.cached(owner, fingerprint);
      if (winner) return winner;
      throw new ComicLibraryError("EDIT_SPEECH_RUNNING", 409);
    }
    let trace: string | undefined;
    let output: SpeechResult;
    try {
      output = clone && this.deps.clones
        ? await this.deps.clones.speak(owner, voice, input, signal)
        : await provider.synthesize({ ...input, model: voice.targetModel, voice: voice.voiceId, format: "wav" }, signal);
      trace = output.gatewayRequestId;
    } catch (error) {
      const httpStatus = error instanceof ProviderError ? error.httpStatus : undefined;
      const rejected = error instanceof ProviderError && error.code === "HTTP_ERROR" && httpStatus
        && httpStatus >= 400 && httpStatus < 500 && ![408, 409, 425].includes(httpStatus);
      const nextStatus = rejected ? "failed" : "unknown";
      const errCode = error instanceof ProviderError ? error.code : error instanceof Error ? error.name : "SPEECH_FAILED";
      const errTrace = safeTrace(error instanceof ProviderError ? error.gatewayRequestId : trace);
      await libraryTransaction(this.pool, async db => {
        await db.query(
          `UPDATE ${cd}.cd_speech_attempts
           SET status=CASE WHEN status='submitting' THEN $3 ELSE status END,
               gateway_request_id=coalesce(gateway_request_id,$4),
               gateway_http_status=coalesce(gateway_http_status,$5),
               error=coalesce(error,$6),
               updated_at=now()
           WHERE id=$1 AND owner_id=$2`,
          [attemptId, owner, nextStatus, errTrace, httpStatus ?? null, errCode.slice(0, 120)],
        );
        await db.query(
          `UPDATE ${cd}.cd_speech_cache SET status=$3, gateway_request_id=$4, updated_at=now()
           WHERE owner_id=$1 AND fingerprint=$2 AND active_attempt_id=$5 AND status='submitting'`,
          [owner, fingerprint, nextStatus, errTrace, attemptId],
        );
      });
      throw rejected ? new ComicLibraryError("EDIT_SPEECH_UNAVAILABLE", 503) : new ComicLibraryError("EDIT_SPEECH_UNKNOWN", 409);
    }

    let superseded = false;
    try {
      const request = new Request("http://comic.local/speech", {
        method: "POST", signal, headers: { "Content-Type": output.mime }, body: new Uint8Array(output.audio),
      });
      const stored = await this.media.upload(request, owner, "other", file => libraryTransaction(this.pool, async db => {
        if (file.mime !== "audio/wav" || !file.durationMs) throw new ComicLibraryError("EDIT_SPEECH_UNAVAILABLE", 503);
        await insertComicMedia(db, file);
        const safeId = safeTrace(trace);
        const cacheUpdated = await db.query(
          `UPDATE ${cd}.cd_speech_cache SET status='ready', media_id=$3, gateway_request_id=$4, updated_at=now()
           WHERE owner_id=$1 AND fingerprint=$2 AND active_attempt_id=$5 AND status='submitting'`,
          [owner, fingerprint, file.id, safeId, attemptId],
        );
        if (cacheUpdated.rowCount) {
          await db.query(
            `UPDATE ${cd}.cd_speech_attempts
             SET status='ready', media_id=$3, gateway_request_id=coalesce(gateway_request_id,$4),
                 gateway_http_status=coalesce(gateway_http_status,200), updated_at=now()
             WHERE id=$1 AND owner_id=$2`,
            [attemptId, owner, file.id, safeId],
          );
          return { mediaId: file.id, durationMs: file.durationMs, cached: false, attemptId };
        }
        await db.query(
          `UPDATE ${cd}.cd_speech_attempts
           SET media_id=coalesce(media_id,$3), gateway_request_id=coalesce(gateway_request_id,$4),
               gateway_http_status=coalesce(gateway_http_status,200),
               error=coalesce(error,'LATE_RESULT_IGNORED'), updated_at=now()
           WHERE id=$1 AND owner_id=$2`,
          [attemptId, owner, file.id, safeId],
        );
        superseded = true;
        return null;
      }));
      if (superseded || !stored) throw new ComicLibraryError("EDIT_SPEECH_SUPERSEDED", 409);
      return stored;
    } catch (error) {
      if (error instanceof ComicLibraryError && error.code === "EDIT_SPEECH_SUPERSEDED") throw error;
      const errTrace = safeTrace(trace);
      await libraryTransaction(this.pool, async db => {
        await db.query(
          `UPDATE ${cd}.cd_speech_attempts
           SET status=CASE WHEN status='submitting' THEN 'unknown' ELSE status END,
               gateway_request_id=coalesce(gateway_request_id,$3),
               error=coalesce(error,$4), updated_at=now()
           WHERE id=$1 AND owner_id=$2`,
          [attemptId, owner, errTrace, error instanceof Error ? error.message.slice(0, 120) : "STORE_FAILED"],
        );
        await db.query(
          `UPDATE ${cd}.cd_speech_cache SET status='unknown', gateway_request_id=$3, updated_at=now()
           WHERE owner_id=$1 AND fingerprint=$2 AND active_attempt_id=$4 AND status='submitting'`,
          [owner, fingerprint, errTrace, attemptId],
        );
      });
      throw new ComicLibraryError("EDIT_SPEECH_UNKNOWN", 409);
    }
  }

  async audition(owner: string, fields: ComicVoiceAudition, signal: AbortSignal, accepting?: () => void): Promise<ComicSpeechTake> {
    assertComicDramaCompliance([{ field: "audition", text: fields.text }]);
    const { resolved, input, fingerprint } = await this.prepareAudition(owner, fields);
    return this.synthesizeCached(owner, fingerprint, resolved.voice, resolved.clone, input, signal, accepting, { kind: "audition" });
  }

  private resolveLineVoiceScope(
    speaker: string | null,
    clipLines: ComicSpeechLines,
    fallbackPreset?: typeof comicSpeechPresets[number],
  ): ComicSpeechRequest["voice"] | null {
    const matched = speaker ? matchComicCharacters(speaker, clipLines.characters) : [];
    if (matched.length === 1) return { kind: "character", characterId: matched[0].id };
    if (fallbackPreset && clipLines.presets.includes(fallbackPreset)) return { kind: "preset", preset: fallbackPreset };
    if (clipLines.presets[0]) return { kind: "preset", preset: clipLines.presets[0] as typeof comicSpeechPresets[number] };
    return null;
  }

  async previewAutoDialogue(
    owner: string, editId: string, fields: ComicEditAutoDialoguePreview,
  ): Promise<ComicAutoDialoguePlan> {
    const edit = await this.edits.get(owner, editId);
    if (edit.revision !== fields.expectedRevision) throw new ComicEditConflict(edit.revision);
    const emotions = await readComicDictionary(this.pool, owner, "emotion");
    const overrideMap = new Map<string, ComicEditAutoDialogueOverride>(
      (fields.overrides ?? []).map(entry => [`${entry.videoItemId}:${entry.lineId}`, entry]),
    );
    const replaceNativeSet = new Set(fields.replaceNativeAudioVideoItemIds ?? []);
    const lines: ComicAutoDialoguePlanLine[] = [];
    const nativeAudioClips: ComicAutoDialogueNativeClip[] = [];
    const newSyntheses = new Set<string>();
    let alreadyPlacedCount = 0;
    let cachedCount = 0;
    let toSynthesizeCount = 0;
    let blockedCount = 0;
    let skippedCount = 0;
    let overflowCount = 0;
    let nativeAudioSkippedCount = 0;

    for (const item of edit.timeline.video) {
      const source = edit.sources.find(entry => entry.takeId === item.takeId);
      const audioMode = source?.audioMode ?? "silent_tts";
      const hasNativeAudio = audioMode === "native_audio" || audioMode === "reference_audio";
      const replaceWithTts = !hasNativeAudio || replaceNativeSet.has(item.id);
      const clipLines = await this.linesForClip(owner, source?.clipId ?? null);
      if (!clipLines.lines.length) continue;
      if (hasNativeAudio) {
        nativeAudioClips.push({
          videoItemId: item.id,
          scene: source?.scene ?? "",
          audioMode,
          lineCount: clipLines.lines.length,
          replaceWithTts: replaceNativeSet.has(item.id),
        });
      }
      const clipDuration = item.outMs - item.inMs;
      let cursorMs = Math.max(0, ...edit.timeline.voice
        .filter(entry => entry.anchor.kind === "clip" && entry.anchor.videoItemId === item.id)
        .map(entry => entry.anchor.offsetMs + entry.durationMs));
      for (const line of clipLines.lines) {
        const override = overrideMap.get(`${item.id}:${line.id}`);
        const text = override?.text?.trim() || line.text;
        const speed = override?.speed ?? line.speed;
        const existingVoice = edit.timeline.voice.find(entry =>
          entry.lineId === line.id && entry.anchor.kind === "clip" && entry.anchor.videoItemId === item.id);
        const startOffset = existingVoice?.anchor.offsetMs ?? cursorMs;
        const remainingMs = Math.max(0, clipDuration - startOffset);
        const base = {
          videoItemId: item.id, clipId: source?.clipId ?? null, lineId: line.id,
          speaker: line.speaker, text, speed, audioMode, remainingMs,
        };
        if (existingVoice) {
          alreadyPlacedCount += 1;
          lines.push({ ...base, status: "already_placed", cachedDurationMs: existingVoice.durationMs });
          continue;
        }
        if (remainingMs <= 0 || override?.overflowAction === "skip") {
          skippedCount += 1;
          lines.push({ ...base, status: "no_room" });
          continue;
        }
        if (fields.includeVoice && hasNativeAudio && !replaceWithTts) {
          const est = Math.min(remainingMs, Math.max(800, estimateComicDialogueMs([{ ...line, text, speed }])));
          nativeAudioSkippedCount += 1;
          lines.push({ ...base, status: "native_audio_subtitle_only", cachedDurationMs: est });
          cursorMs = Math.max(cursorMs, startOffset + est);
          continue;
        }
        if (!fields.includeVoice) {
          const est = Math.min(remainingMs, Math.max(800, estimateComicDialogueMs([{ ...line, text, speed }])));
          alreadyPlacedCount += 1;
          lines.push({ ...base, status: "cached", cachedDurationMs: est });
          cursorMs = Math.max(cursorMs, startOffset + est);
          continue;
        }
        try {
          assertComicDramaCompliance([{ field: "dialogue", text }]);
        } catch {
          blockedCount += 1;
          lines.push({ ...base, status: "compliance_blocked", errorCode: "CONTENT_COMPLIANCE_REJECTED" });
          continue;
        }
        const scope = this.resolveLineVoiceScope(line.speaker, clipLines, fields.fallbackPreset);
        if (!scope) {
          skippedCount += 1;
          lines.push({ ...base, status: "no_voice", errorCode: "EDIT_VOICE_UNAVAILABLE" });
          continue;
        }
        let resolved: { voice: CloneVoice; version: string | null; clone: boolean };
        try {
          resolved = await this.resolve(owner, scope);
        } catch {
          blockedCount += 1;
          lines.push({ ...base, status: "no_voice", errorCode: "EDIT_VOICE_UNAVAILABLE" });
          continue;
        }
        const instructions = line.emotionKey ? emotions.find(entry => entry.key === line.emotionKey)?.labels.en : undefined;
        const synthInput = { text, instructions, speed };
        const fingerprint = digest([1, scope, resolved.version, resolved.voice, synthInput, "wav"]);
        const cacheRow = await this.readCacheRow(owner, fingerprint);
        if (cacheRow?.status === "ready" && cacheRow.mediaId && cacheRow.durationMs) {
          cachedCount += 1;
          const over = cacheRow.durationMs > remainingMs ? cacheRow.durationMs - remainingMs : 0;
          if (over > 0 && override?.overflowAction !== "trim") overflowCount += 1;
          lines.push({
            ...base,
            status: "cached",
            cachedDurationMs: cacheRow.durationMs,
            ...(over > 0 ? { overflowMs: over, suggestedSpeed: suggestedSpeedFor(speed, cacheRow.durationMs, remainingMs) } : {}),
          });
          cursorMs = Math.max(cursorMs, startOffset + Math.min(remainingMs, cacheRow.durationMs));
        } else if (cacheRow?.status === "unknown" || cacheRow?.status === "submitting") {
          blockedCount += 1;
          lines.push({
            ...base,
            status: "unknown_blocked",
            errorCode: cacheRow.status === "submitting" ? "EDIT_SPEECH_RUNNING" : "EDIT_SPEECH_UNKNOWN",
          });
        } else {
          toSynthesizeCount += 1;
          newSyntheses.add(fingerprint);
          const est = Math.max(800, estimateComicDialogueMs([{ ...line, text, speed }]));
          lines.push({ ...base, status: "to_synthesize" });
          cursorMs = Math.max(cursorMs, startOffset + Math.min(remainingMs, est));
        }
      }
    }

    return {
      totalLines: lines.length,
      alreadyPlacedCount,
      cachedCount,
      toSynthesizeCount,
      blockedCount,
      skippedCount,
      overflowCount,
      nativeAudioSkippedCount,
      nativeAudioClips,
      feeStatus: newSyntheses.size > 0 ? "fixed_points" : "free_cached",
      estimatedPoints: newSyntheses.size * COMIC_SPEECH_ESTIMATE_POINTS,
      lines,
    };
  }

  async autoDialogue(
    owner: string, editId: string, fields: ComicEditAutoDialogue, signal: AbortSignal, accepting?: () => void,
  ): Promise<ComicAutoDialogueResult> {
    const edit = await this.edits.get(owner, editId);
    if (edit.revision !== fields.expectedRevision) throw new ComicEditConflict(edit.revision);
    const emotions = await readComicDictionary(this.pool, owner, "emotion");
    const overrideMap = new Map<string, ComicEditAutoDialogueOverride>(
      (fields.overrides ?? []).map(entry => [`${entry.videoItemId}:${entry.lineId}`, entry]),
    );
    const replaceNativeSet = new Set(fields.replaceNativeAudioVideoItemIds ?? []);
    const nextVideo: ComicTimeline["video"] = edit.timeline.video.map(item => ({ ...item }));
    const nextVoice: ComicTimeline["voice"] = [...edit.timeline.voice];
    const nextSubtitles: ComicTimeline["subtitles"] = [...edit.timeline.subtitles];
    const mutedVideoItemIds = new Set<string>();
    const items: ComicAutoDialogueItemOutcome[] = [];
    let voicedCount = 0;
    let subtitledCount = 0;
    let cachedCount = 0;
    let synthesizedCount = 0;
    let skippedLines = 0;
    let overflowCount = 0;
    let failedCount = 0;
    let nativeAudioSkippedCount = 0;

    for (const item of edit.timeline.video) {
      signal.throwIfAborted();
      const source = edit.sources.find(entry => entry.takeId === item.takeId);
      const audioMode = source?.audioMode ?? "silent_tts";
      const hasNativeAudio = audioMode === "native_audio" || audioMode === "reference_audio";
      const replaceWithTts = !hasNativeAudio || replaceNativeSet.has(item.id);
      const clipLines = await this.linesForClip(owner, source?.clipId ?? null);
      if (!clipLines.lines.length) continue;
      const clipDuration = item.outMs - item.inMs;
      let cursorMs = Math.max(0, ...nextVoice
        .filter(entry => entry.anchor.kind === "clip" && entry.anchor.videoItemId === item.id)
        .map(entry => entry.anchor.offsetMs + entry.durationMs));
      for (const line of clipLines.lines) {
        signal.throwIfAborted();
        const override = overrideMap.get(`${item.id}:${line.id}`);
        const text = override?.text?.trim() || line.text;
        const speed = override?.speed ?? line.speed;
        const existingVoice = nextVoice.find(entry =>
          entry.lineId === line.id && entry.anchor.kind === "clip" && entry.anchor.videoItemId === item.id);
        const existingSub = nextSubtitles.find(entry =>
          entry.lineId === line.id && entry.anchor.kind === "clip" && entry.anchor.videoItemId === item.id);
        const startOffset = existingVoice?.anchor.offsetMs ?? existingSub?.anchor.offsetMs ?? cursorMs;
        const remaining = clipDuration - startOffset;
        const base = {
          videoItemId: item.id, clipId: source?.clipId ?? null, lineId: line.id,
          speaker: line.speaker, text, speed, audioMode,
        };

        if (override?.overflowAction === "skip") {
          skippedLines += 1;
          items.push({ ...base, status: "skipped", cached: false, remainingMs: Math.max(0, remaining) });
          continue;
        }
        if (remaining <= 0) {
          skippedLines += 1;
          items.push({ ...base, status: "skipped", cached: false, remainingMs: 0, errorCode: "NO_REMAINING_DURATION" });
          continue;
        }

        let lineDurationMs = existingVoice?.durationMs ?? Math.min(remaining, Math.max(800, estimateComicDialogueMs([{ ...line, text, speed }])));
        let linePlaced = !!existingVoice;
        let wasTrimmed = false;
        let lineCached = !!existingVoice;

        if (fields.includeVoice && !existingVoice && hasNativeAudio && !replaceWithTts) {
          nativeAudioSkippedCount += 1;
          if (fields.includeSubtitles && !existingSub) {
            nextSubtitles.push({
              id: randomUUID(), lineId: line.id, text,
              anchor: { kind: "clip", videoItemId: item.id, offsetMs: startOffset },
              durationMs: Math.max(1, Math.min(remaining, lineDurationMs)),
            });
            subtitledCount += 1;
          }
          items.push({
            ...base,
            status: "subtitle_only",
            cached: false,
            audioDurationMs: lineDurationMs,
            remainingMs: remaining,
          });
          cursorMs = Math.max(cursorMs, startOffset + lineDurationMs);
          continue;
        }

        if (fields.includeVoice && !existingVoice && replaceWithTts) {
          const scope = this.resolveLineVoiceScope(line.speaker, clipLines, fields.fallbackPreset);
          if (!scope) {
            skippedLines += 1;
            items.push({ ...base, status: "skipped", cached: false, remainingMs: remaining, errorCode: "EDIT_VOICE_UNAVAILABLE" });
            continue;
          }
          try {
            assertComicDramaCompliance([{ field: "dialogue", text }]);
            const { voice, version, clone } = await this.resolve(owner, scope);
            const instructions = line.emotionKey ? emotions.find(entry => entry.key === line.emotionKey)?.labels.en : undefined;
            const synthInput = { text, instructions, speed };
            const fingerprint = digest([1, scope, version, voice, synthInput, "wav"]);
            const take = await this.synthesizeCached(owner, fingerprint, voice, clone, synthInput, signal, accepting, {
              kind: "dialogue", editId, lineId: line.id,
            });
            lineCached = take.cached;
            if (take.cached) cachedCount += 1;
            else synthesizedCount += 1;
            if (take.durationMs > remaining) {
              const allowTrim = fields.overflowMode === "trim" || override?.overflowAction === "trim";
              if (!allowTrim) {
                overflowCount += 1;
                items.push({
                  ...base,
                  status: "overflow",
                  cached: take.cached,
                  audioDurationMs: take.durationMs,
                  remainingMs: remaining,
                  suggestedSpeed: suggestedSpeedFor(speed, take.durationMs, remaining),
                });
                continue;
              }
              lineDurationMs = remaining;
              wasTrimmed = true;
            } else {
              lineDurationMs = take.durationMs;
            }
            nextVoice.push({
              id: randomUUID(), mediaId: take.mediaId, lineId: line.id,
              anchor: { kind: "clip", videoItemId: item.id, offsetMs: startOffset },
              durationMs: lineDurationMs, sourceInMs: 0, volume: 1, fadeInMs: 0, fadeOutMs: 0, loop: false,
            });
            voicedCount += 1;
            linePlaced = true;
            // Automatically mute the original native/reference-audio video track when explicitly replaced by TTS.
            if (hasNativeAudio && replaceNativeSet.has(item.id)) {
              const videoEntry = nextVideo.find(entry => entry.id === item.id);
              if (videoEntry && videoEntry.volume > 0) {
                videoEntry.volume = 0;
                mutedVideoItemIds.add(item.id);
              }
            }
          } catch (error) {
            if (signal.aborted) throw error;
            failedCount += 1;
            const errorCode = error instanceof ComicLibraryError ? error.code : error instanceof Error ? error.message : "EDIT_SPEECH_UNAVAILABLE";
            items.push({ ...base, status: "failed", cached: false, remainingMs: remaining, errorCode });
            continue;
          }
        }

        if (fields.includeSubtitles && !existingSub && (linePlaced || !fields.includeVoice)) {
          nextSubtitles.push({
            id: randomUUID(), lineId: line.id, text,
            anchor: { kind: "clip", videoItemId: item.id, offsetMs: startOffset },
            durationMs: Math.max(1, Math.min(remaining, lineDurationMs)),
          });
          subtitledCount += 1;
        }
        if (linePlaced) {
          items.push({
            ...base,
            status: wasTrimmed ? "trimmed" : "applied",
            cached: lineCached,
            audioDurationMs: lineDurationMs,
            remainingMs: remaining,
          });
        }
        if (!existingVoice && linePlaced) cursorMs = Math.max(cursorMs, startOffset + lineDurationMs);
      }
    }
    const updated = voicedCount > 0 || subtitledCount > 0 || mutedVideoItemIds.size > 0
      ? await this.edits.update(owner, editId, {
        expectedRevision: fields.expectedRevision,
        title: edit.title,
        timeline: { ...edit.timeline, video: nextVideo, voice: nextVoice, subtitles: nextSubtitles },
      })
      : edit;
    return {
      edit: updated,
      voicedCount,
      subtitledCount,
      cachedCount,
      synthesizedCount,
      skippedLines,
      overflowCount,
      failedCount,
      nativeAudioSkippedCount,
      mutedVideoItemIds: [...mutedVideoItemIds],
      items,
    };
  }

  async speak(owner: string, editId: string, itemId: string, lineId: string, fields: ComicSpeechRequest, signal: AbortSignal, accepting?: () => void) {
    const { line, voice, clone, input, fingerprint } = await this.prepare(owner, editId, itemId, lineId, fields);
    assertComicDramaCompliance([{ field: "dialogue", text: line.text }]);
    return this.synthesizeCached(owner, fingerprint, voice, clone, input, signal, accepting, { kind: "dialogue", editId, lineId });
  }
}

function safeTrace(trace: string | undefined) {
  return trace && /^[\w.:-]{1,200}$/.test(trace) ? trace : null;
}
