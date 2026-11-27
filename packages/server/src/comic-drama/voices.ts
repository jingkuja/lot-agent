import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { HttpQwenVoiceProvider, isQwenCreateRejected } from "@lot-agent/core";
import {
  COMIC_VOICE_SAMPLE_BYTES, type ComicCharacterDesignVoice, type ComicCharacterVoiceDesignInput,
  type ComicLibraryVoice, type ComicLibraryVoiceCreate, type ComicLibraryVoiceList,
} from "@lot-agent/core/comic-drama";
import { loadTwinVoiceConfig } from "../digital-twin/voices.js";
import { inspectMedia } from "../marketing-video/media.js";
import { designComicCharacterVoice } from "./character-voice-design.js";
import { comicVoiceCredentialScope } from "./character-voice-store.js";
import { assertComicDramaCompliance } from "./compliance.js";
import type { ComicDirectorLlm } from "./director-model.js";
import { ComicLibraryError, libraryMissing, libraryTransaction } from "./library-db.js";
import { insertComicMedia } from "./library-repository.js";
import type { ComicMediaLibrary } from "./media-library.js";

const table = "lot_comic_drama.cd_voices";
const columns = `id,name,kind,voice_prompt AS "voicePrompt",preview_text AS "previewText",preview_media_id AS "previewMediaId",
  status,archived_at IS NOT NULL AS archived,target_model AS "targetModel",voice_id AS "voiceId",
  credential_scope AS "credentialScope",prefix`;
const pageSize = 24;
type VoiceRow = ComicLibraryVoice & { targetModel: string; voiceId: string | null; credentialScope: string; prefix: string };
const view = ({ id, name, kind, voicePrompt, previewText, previewMediaId, status, archived }: VoiceRow): ComicLibraryVoice =>
  ({ id, name, kind, voicePrompt, previewText, previewMediaId, status, archived });
const characterDesignView = ({ id, name, status, previewMediaId, voiceId }: VoiceRow): ComicCharacterDesignVoice =>
  ({ id, name, status, previewMediaId, voiceId });
const unavailable = () => new ComicLibraryError("EDIT_VOICE_UNAVAILABLE", 404);

function enabled(config: ReturnType<typeof loadTwinVoiceConfig>) {
  return !!config.apiKey && /^qwen-audio-3\.[01]-tts-(plus|flash)$/.test(config.targetModel);
}

async function sampleData(sample: File, signal: AbortSignal) {
  if (!sample.size) throw new ComicLibraryError("FILE_REQUIRED", 400);
  if (sample.size > COMIC_VOICE_SAMPLE_BYTES) throw new ComicLibraryError("MEDIA_TOO_LARGE", 413);
  const bytes = Buffer.from(await sample.arrayBuffer());
  const wav = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE";
  const mp3 = bytes.toString("ascii", 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  if (!wav && !mp3) throw new ComicLibraryError("UNSUPPORTED_MEDIA", 415);
  const dir = await mkdtemp(join(tmpdir(), "comic-voice-"));
  try {
    const file = join(dir, wav ? "sample.wav" : "sample.mp3");
    await writeFile(file, bytes, { signal, mode: 0o600 });
    const info = await inspectMedia(file, signal).catch(() => {
      signal.throwIfAborted();
      throw new ComicLibraryError("UNSUPPORTED_MEDIA", 415);
    });
    if (!info.audio || info.video || info.format !== (wav ? "wav" : "mp3") || (wav && info.audioCodec !== "pcm_s16le")
      || !(info.sampleRate >= 16_000) || ![1, 2].includes(info.channels) || info.duration < 5 || info.duration > 60) {
      throw new ComicLibraryError("COMIC_VOICE_SAMPLE_INVALID", 400);
    }
    return `data:${wav ? "audio/wav" : "audio/mpeg"};base64,${bytes.toString("base64")}`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export class ComicVoices {
  constructor(private readonly pool: Pool, private readonly media: ComicMediaLibrary) {}

  private async find(owner: string, id: string) {
    const { rows: [row] } = await this.pool.query<VoiceRow>(
      `SELECT ${columns} FROM ${table} WHERE owner_id=$1 AND id=$2`, [owner, id],
    );
    return row;
  }

  async list(owner: string, query: string, archived: boolean, page: number): Promise<ComicLibraryVoiceList> {
    const { rows } = await this.pool.query<VoiceRow>(
      `SELECT ${columns} FROM ${table} WHERE owner_id=$1 AND (archived_at IS NOT NULL)=$2
        AND (strpos(lower(name),lower($3))>0 OR strpos(lower(coalesce(voice_prompt,'')),lower($3))>0)
        ORDER BY created_at DESC,id DESC LIMIT $4 OFFSET $5`,
      [owner, archived, query, pageSize + 1, (page - 1) * pageSize],
    );
    return { entries: rows.slice(0, pageSize).map(view), more: rows.length > pageSize, enabled: enabled(loadTwinVoiceConfig()) };
  }

  async choices(owner: string, boundId: string | null) {
    const config = loadTwinVoiceConfig();
    if (!config.apiKey) return [];
    const { rows } = await this.pool.query<Pick<ComicLibraryVoice, "id" | "name" | "kind">>(
      `SELECT id,name,kind FROM ${table} WHERE owner_id=$1 AND credential_scope=$2
        AND status='OK' AND (archived_at IS NULL OR id=$3) ORDER BY name,id`, [owner, comicVoiceCredentialScope(config), boundId],
    );
    return rows;
  }

  async dialogueChoices(owner: string) {
    return { entries: await this.choices(owner, null), enabled: enabled(loadTwinVoiceConfig()) };
  }

  async ready(owner: string, id: string, allowArchived: boolean) {
    const row = await this.find(owner, id);
    const config = loadTwinVoiceConfig();
    if (!row?.voiceId || row.status !== "OK" || (!allowArchived && row.archived)
      || !config.apiKey || row.credentialScope !== comicVoiceCredentialScope(config)) throw unavailable();
    return { targetModel: row.targetModel, voiceId: row.voiceId };
  }

  async create(owner: string, input: ComicLibraryVoiceCreate, sample: File | undefined, signal: AbortSignal, accepting: () => void) {
    return view(await this.createVoice(owner, input, sample, signal, accepting));
  }

  async designCharacter(
    owner: string, input: ComicCharacterVoiceDesignInput, signal: AbortSignal,
    accepting: () => void, resolveModel: (owner: string) => Promise<ComicDirectorLlm>,
  ) {
    const prior = await this.find(owner, input.id);
    if (prior) {
      if (prior.kind !== "design") throw unavailable();
      return characterDesignView(prior);
    }
    accepting();
    if (!enabled(loadTwinVoiceConfig())) throw new ComicLibraryError("COMIC_VOICE_UNCONFIGURED", 503);
    this.media.assertAvailable();
    const design = await designComicCharacterVoice(owner, input, resolveModel, signal);
    const row = await this.createVoice(owner, design, undefined, signal, accepting);
    if (row.kind !== "design") throw unavailable();
    return characterDesignView(row);
  }

  async refreshCharacterDesign(owner: string, id: string, signal: AbortSignal) {
    const row = await this.find(owner, id);
    if (row?.kind !== "design") libraryMissing();
    return characterDesignView(await this.refreshVoice(owner, row, signal));
  }

  private async createVoice(owner: string, input: ComicLibraryVoiceCreate, sample: File | undefined, signal: AbortSignal, accepting: () => void) {
    const prior = await this.find(owner, input.id);
    if (prior) return prior;
    accepting();
    const config = loadTwinVoiceConfig();
    if (!enabled(config)) throw new ComicLibraryError("COMIC_VOICE_UNCONFIGURED", 503);
    const design = input.kind === "design";
    const voicePrompt = design ? input.voicePrompt : null;
    const previewText = design ? input.previewText : null;
    if (design) {
      assertComicDramaCompliance([{ field: "voicePrompt", text: input.voicePrompt }, { field: "previewText", text: input.previewText }]);
      this.media.assertAvailable();
    } else if (!sample) {
      throw new ComicLibraryError("FILE_REQUIRED", 400);
    }
    const audio = sample && !design ? await sampleData(sample, signal) : "";
    signal.throwIfAborted();
    const prefix = randomBytes(5).toString("hex");
    const claimed = await this.pool.query(
      `INSERT INTO ${table}(owner_id,id,name,kind,voice_prompt,preview_text,target_model,credential_scope,prefix,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'unknown') ON CONFLICT (owner_id,id) DO NOTHING`,
      [owner, input.id, input.name, input.kind, voicePrompt, previewText, config.targetModel, comicVoiceCredentialScope(config), prefix],
    );
    if (claimed.rowCount) {
      const provider = new HttpQwenVoiceProvider(config);
      const result = await provider.createCustom(design ? {
        prefix, voicePrompt: input.voicePrompt, previewText: input.previewText, language: input.language,
        sampleRate: input.sampleRate, previewFormat: input.previewFormat,
      } : { prefix, audio }, signal).catch(async error => {
        if (isQwenCreateRejected(error)) {
          await this.pool.query(`UPDATE ${table} SET status='failed' WHERE owner_id=$1 AND id=$2 AND status='unknown'`, [owner, input.id]);
        }
        signal.throwIfAborted();
        return null;
      });
      // Record the remote identity even if the preview cannot be saved.
      if (result) {
        await this.pool.query(`UPDATE ${table} SET voice_id=$3,status='DEPLOYING'
          WHERE owner_id=$1 AND id=$2 AND status='unknown'`, [owner, input.id, result.voiceId]);
        if (result.previewAudio) {
          await this.savePreview(owner, input.id, result.previewAudio, signal).catch(() => {
            if (!signal.aborted) console.warn("[comic-drama] unable to store voice design preview");
          });
        }
      }
    }
    return await this.find(owner, input.id) ?? libraryMissing();
  }

  private async savePreview(owner: string, id: string, { data, format }: { data: string; format: "wav" | "mp3" }, signal: AbortSignal) {
    if (data.length > Math.ceil(COMIC_VOICE_SAMPLE_BYTES / 3) * 4) return;
    const request = new Request("http://comic.local/voice-preview", {
      method: "POST", signal, headers: { "Content-Type": format === "mp3" ? "audio/mpeg" : "audio/wav" },
      body: new Uint8Array(Buffer.from(data, "base64")),
    });
    await this.media.upload(request, owner, "other", file => libraryTransaction(this.pool, async db => {
      await insertComicMedia(db, file);
      await db.query(`UPDATE ${table} SET preview_media_id=$3 WHERE owner_id=$1 AND id=$2`, [owner, id, file.id]);
    }));
  }

  async refresh(owner: string, id: string, signal: AbortSignal) {
    const row = await this.find(owner, id) ?? libraryMissing();
    return view(await this.refreshVoice(owner, row, signal));
  }

  private async refreshVoice(owner: string, row: VoiceRow, signal: AbortSignal) {
    if (row.status !== "unknown" && row.status !== "DEPLOYING") return row;
    const config = loadTwinVoiceConfig();
    if (!config.apiKey || row.credentialScope !== comicVoiceCredentialScope(config)) throw new ComicLibraryError("COMIC_VOICE_UNCONFIGURED", 503);
    const provider = new HttpQwenVoiceProvider({ ...config, targetModel: row.targetModel });
    const remote = row.voiceId ? await provider.query(row.voiceId, signal) : await provider.findCustom(row.prefix, row.kind === "design", signal);
    if (remote) {
      await this.pool.query(`UPDATE ${table} SET voice_id=$3,status=$4 WHERE owner_id=$1 AND id=$2
        AND status IN ('unknown','DEPLOYING') AND (voice_id IS NULL OR voice_id=$3)`, [owner, row.id, remote.voiceId, remote.status]);
    }
    return await this.find(owner, row.id) ?? libraryMissing();
  }

  async archive(owner: string, id: string, archived: boolean) {
    const result = await this.pool.query(
      `UPDATE ${table} SET archived_at=CASE WHEN $3 THEN coalesce(archived_at,now()) ELSE NULL END WHERE owner_id=$1 AND id=$2`,
      [owner, id, archived],
    );
    if (!result.rowCount) libraryMissing();
  }
}
