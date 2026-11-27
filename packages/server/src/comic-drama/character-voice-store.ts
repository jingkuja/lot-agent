import { createHash, randomUUID } from "node:crypto";
import type { ComicCharacterDesignVoice, ComicVoiceBind } from "@lot-agent/core/comic-drama";
import { loadTwinVoiceConfig } from "../digital-twin/voices.js";
import { ComicLibraryError, type ComicQuery } from "./library-db.js";

export function comicVoiceCredentialScope(config: ReturnType<typeof loadTwinVoiceConfig>) {
  return createHash("sha256").update(JSON.stringify([config.baseUrl.replace(/\/+$/, ""), config.apiKey])).digest("hex");
}

export async function readComicCharacterDesignVoice(db: ComicQuery, owner: string, character: string) {
  const { rows: [voice] } = await db.query<ComicCharacterDesignVoice>(`SELECT v.id,v.name,v.status,
    v.voice_id AS "voiceId",v.preview_media_id AS "previewMediaId"
    FROM lot_comic_drama.cd_character_voice b JOIN lot_comic_drama.cd_voices v
      ON v.owner_id=b.owner_id AND v.id=(b.binding->>'voiceId')::uuid
    WHERE b.owner_id=$1 AND b.character_id=$2 AND b.binding->>'kind'='library' AND v.kind='design'`, [owner, character]);
  return voice ?? null;
}

/** Caller holds the character row lock or has inserted the character in this transaction. */
export async function writeComicCharacterVoice(db: ComicQuery, owner: string, character: string, binding: ComicVoiceBind, fingerprint: string | null) {
  if (binding.kind === "none") {
    await db.query(`DELETE FROM lot_comic_drama.cd_character_voice WHERE owner_id=$1 AND character_id=$2`, [owner, character]);
    return;
  }
  await db.query(`INSERT INTO lot_comic_drama.cd_character_voice AS v(owner_id,character_id,binding,voice_version,clone_fingerprint,authorized_at)
    VALUES($1,$2,$3,$4,$5,CASE WHEN $5::text IS NOT NULL THEN now() END)
    ON CONFLICT (owner_id,character_id) DO UPDATE SET binding=excluded.binding,voice_version=excluded.voice_version,
      clone_fingerprint=excluded.clone_fingerprint,authorized_at=excluded.authorized_at
    WHERE v.binding IS DISTINCT FROM excluded.binding OR v.clone_fingerprint IS DISTINCT FROM excluded.clone_fingerprint`,
  [owner, character, binding, randomUUID(), fingerprint]);
}

export async function bindComicCharacterDesignVoice(db: ComicQuery, owner: string, character: string, voiceId: string) {
  const config = loadTwinVoiceConfig();
  const ready = config.apiKey && (await db.query(`SELECT 1 FROM lot_comic_drama.cd_voices
    WHERE owner_id=$1 AND id=$2 AND kind='design' AND status='OK' AND archived_at IS NULL AND credential_scope=$3 FOR SHARE`,
  [owner, voiceId, comicVoiceCredentialScope(config)])).rowCount;
  if (!ready) throw new ComicLibraryError("EDIT_VOICE_UNAVAILABLE", 404);
  await writeComicCharacterVoice(db, owner, character, { kind: "library", voiceId }, null);
}
