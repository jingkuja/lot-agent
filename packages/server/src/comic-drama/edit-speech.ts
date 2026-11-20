import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ProviderError, type SpeechProvider, type SpeechRequest, type SpeechResult } from "@lot-agent/core";
import {
  COMIC_SPEECH_PRESET_CATALOG, comicDramaClipDraftSchema, comicSpeechPresets, comicVoiceBindSchema, estimateComicDialogueMs, matchComicCharacters,
  type ComicAutoDialogueResult, type ComicEditAutoDialogue, type ComicSpeechLines, type ComicSpeechRequest, type ComicSpeechTake,
  type ComicTimeline, type ComicVoiceAudition, type ComicVoiceBind, type ComicVoiceSettings,
} from "@lot-agent/core/comic-drama";
import { readComicDictionary } from "./dictionary.js";
import { assertComicDramaCompliance } from "./compliance.js";
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
    return {
      binding: current?.binding ?? { kind: "none" },
      presets: this.deps.presetModel ? comicSpeechPresets : [],
      presetCatalog: this.deps.presetModel ? COMIC_SPEECH_PRESET_CATALOG : [],
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
    const presets = this.deps.presetModel ? comicSpeechPresets : [];
    const presetCatalog = this.deps.presetModel ? COMIC_SPEECH_PRESET_CATALOG : [];
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

  async release(owner: string, editId: string, itemId: string, lineId: string, fields: ComicSpeechRequest) {
    const { fingerprint } = await this.prepare(owner, editId, itemId, lineId, fields);
    const result = await this.pool.query(`UPDATE ${cd}.cd_speech_cache SET status='released',updated_at=now()
      WHERE owner_id=$1 AND fingerprint=$2
        AND (status IN ('unknown','released') OR (status='submitting' AND updated_at<now()-interval '5 minutes'))`,
    [owner, fingerprint]);
    if (!result.rowCount) throw new ComicLibraryError("EDIT_SPEECH_NOT_RELEASABLE", 409);
  }

  private async synthesizeCached(
    owner: string,
    fingerprint: string,
    voice: CloneVoice,
    clone: boolean,
    input: { text: string; instructions?: string; speed: number },
    signal: AbortSignal,
    accepting?: () => void,
  ): Promise<ComicSpeechTake> {
    const existing = await this.cached(owner, fingerprint);
    if (existing) return existing;
    accepting?.();
    this.media.assertAvailable();
    const provider = await this.deps.ownerSpeech(owner);
    if (!provider) throw new ComicLibraryError("EDIT_SPEECH_UNAVAILABLE", 503);
    signal.throwIfAborted();
    const claimed = await this.pool.query(`INSERT INTO ${cd}.cd_speech_cache AS c(owner_id,fingerprint,status) VALUES($1,$2,'submitting')
      ON CONFLICT (owner_id,fingerprint) DO UPDATE SET status='submitting',updated_at=now(),gateway_request_id=NULL WHERE c.status IN ('failed','released')`,
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

  async audition(owner: string, fields: ComicVoiceAudition, signal: AbortSignal, accepting?: () => void): Promise<ComicSpeechTake> {
    assertComicDramaCompliance([{ field: "audition", text: fields.text }]);
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
    return this.synthesizeCached(owner, fingerprint, resolved.voice, resolved.clone, input, signal, accepting);
  }

  async autoDialogue(
    owner: string, editId: string, fields: ComicEditAutoDialogue, signal: AbortSignal, accepting?: () => void,
  ): Promise<ComicAutoDialogueResult> {
    const edit = await this.edits.get(owner, editId);
    if (edit.revision !== fields.expectedRevision) throw new ComicEditConflict(edit.revision);
    const emotions = await readComicDictionary(this.pool, owner, "emotion");
    const nextVoice: ComicTimeline["voice"] = [...edit.timeline.voice];
    const nextSubtitles: ComicTimeline["subtitles"] = [...edit.timeline.subtitles];
    let voicedCount = 0;
    let subtitledCount = 0;
    let skippedLines = 0;

    for (const item of edit.timeline.video) {
      signal.throwIfAborted();
      const source = edit.sources.find(entry => entry.takeId === item.takeId);
      const clipLines = await this.linesForClip(owner, source?.clipId ?? null);
      if (!clipLines.lines.length) continue;
      const clipDuration = item.outMs - item.inMs;
      let cursorMs = Math.max(0, ...nextVoice
        .filter(entry => entry.anchor.kind === "clip" && entry.anchor.videoItemId === item.id)
        .map(entry => entry.anchor.offsetMs + entry.durationMs));
      for (const line of clipLines.lines) {
        const existingVoice = nextVoice.find(entry => entry.lineId === line.id && entry.anchor.kind === "clip" && entry.anchor.videoItemId === item.id);
        const existingSub = nextSubtitles.find(entry => entry.lineId === line.id && entry.anchor.kind === "clip" && entry.anchor.videoItemId === item.id);
        const startOffset = existingVoice?.anchor.offsetMs ?? cursorMs;
        const remaining = clipDuration - startOffset;
        if (remaining <= 0) { skippedLines += 1; continue; }
        let lineDurationMs = existingVoice?.durationMs ?? Math.min(remaining, Math.max(800, estimateComicDialogueMs([line])));
        if (fields.includeVoice && !existingVoice) {
          const matched = line.speaker ? matchComicCharacters(line.speaker, clipLines.characters) : [];
          const scope: ComicSpeechRequest["voice"] | null = matched.length === 1
            ? { kind: "character", characterId: matched[0].id }
            : fields.fallbackPreset && clipLines.presets.includes(fields.fallbackPreset)
              ? { kind: "preset", preset: fields.fallbackPreset }
              : clipLines.presets[0] ? { kind: "preset", preset: clipLines.presets[0] as typeof comicSpeechPresets[number] } : null;
          if (scope) {
            assertComicDramaCompliance([{ field: "dialogue", text: line.text }]);
            const { voice, version, clone } = await this.resolve(owner, scope);
            const instructions = line.emotionKey ? emotions.find(entry => entry.key === line.emotionKey)?.labels.en : undefined;
            const synthInput = { text: line.text, instructions, speed: line.speed };
            const fingerprint = digest([1, scope, version, voice, synthInput, "wav"]);
            const take = await this.synthesizeCached(owner, fingerprint, voice, clone, synthInput, signal, accepting);
            lineDurationMs = Math.min(remaining, take.durationMs);
            nextVoice.push({
              id: randomUUID(), mediaId: take.mediaId, lineId: line.id,
              anchor: { kind: "clip", videoItemId: item.id, offsetMs: startOffset },
              durationMs: lineDurationMs, sourceInMs: 0, volume: 1, fadeInMs: 0, fadeOutMs: 0, loop: false,
            });
            voicedCount += 1;
          } else {
            skippedLines += 1;
          }
        }
        if (fields.includeSubtitles && !existingSub) {
          nextSubtitles.push({
            id: randomUUID(), lineId: line.id, text: line.text,
            anchor: { kind: "clip", videoItemId: item.id, offsetMs: startOffset },
            durationMs: Math.max(1, Math.min(remaining, lineDurationMs)),
          });
          subtitledCount += 1;
        }
        if (!existingVoice) cursorMs = Math.max(cursorMs, startOffset + lineDurationMs);
      }
    }
    const updated = voicedCount > 0 || subtitledCount > 0
      ? await this.edits.update(owner, editId, {
        expectedRevision: fields.expectedRevision,
        title: edit.title,
        timeline: { ...edit.timeline, voice: nextVoice, subtitles: nextSubtitles },
      })
      : edit;
    return { edit: updated, voicedCount, subtitledCount, skippedLines };
  }

  async speak(owner: string, editId: string, itemId: string, lineId: string, fields: ComicSpeechRequest, signal: AbortSignal, accepting?: () => void) {
    const { line, voice, clone, input, fingerprint } = await this.prepare(owner, editId, itemId, lineId, fields);
    assertComicDramaCompliance([{ field: "dialogue", text: line.text }]);
    return this.synthesizeCached(owner, fingerprint, voice, clone, input, signal, accepting);
  }
}

function safeTrace(trace: string | undefined) {
  return trace && /^[\w.:-]{1,200}$/.test(trace) ? trace : null;
}
