import type { Pool } from "pg";
import type { TwinVoiceRecord, TwinVoiceScope, TwinVoiceStore } from "@lot-agent/core";
import { KnowledgeError } from "../knowledge/errors.js";

const fields = 'target_model AS "targetModel",credential_scope AS "credentialScope",prefix,voice_id AS "voiceId",status';
const args = (scope: TwinVoiceScope) => [scope.ownerId, scope.itemId, scope.revisionId];
export class PgTwinVoiceStore implements TwinVoiceStore {
  constructor(private readonly pool: Pool) {}
  async get(scope: TwinVoiceScope): Promise<TwinVoiceRecord | null> {
    return (await this.pool.query(`SELECT ${fields} FROM digital_twin_voices WHERE owner_id=$1 AND item_id=$2 AND revision_id=$3`, args(scope))).rows[0] ?? null;
  }
  async claim(scope: TwinVoiceScope, record: TwinVoiceRecord) {
    const inserted = await this.pool.query(`INSERT INTO digital_twin_voices(owner_id,item_id,revision_id,target_model,credential_scope,prefix)
      SELECT i.owner_id,i.id,r.id,$4,$5,$6 FROM rag_items i
      JOIN rag_item_revisions r ON r.owner_id=i.owner_id AND r.item_id=i.id
      WHERE i.owner_id=$1 AND i.id=$2 AND r.id=$3 AND i.deleted_at IS NULL AND r.id IN (i.active_revision_id,i.pending_revision_id)
      ON CONFLICT (owner_id,item_id,revision_id) DO NOTHING RETURNING item_id`, [...args(scope), record.targetModel, record.credentialScope, record.prefix]);
    const saved = await this.get(scope);
    if (!saved) throw new KnowledgeError("NOT_FOUND", 404, "声音样例不存在");
    return { created: inserted.rows.length === 1, record: saved };
  }
  async save(scope: TwinVoiceScope, record: TwinVoiceRecord) {
    const result = await this.pool.query(`UPDATE digital_twin_voices SET voice_id=$4,status=$5,updated_at=now()
      WHERE owner_id=$1 AND item_id=$2 AND revision_id=$3 AND credential_scope=$6 AND target_model=$7
        AND (voice_id IS NULL OR voice_id=$4) AND status IN ('unknown','DEPLOYING') RETURNING item_id`,
    [...args(scope), record.voiceId, record.status, record.credentialScope, record.targetModel]);
    if (!result.rows.length) {
      const current = await this.get(scope);
      if (!current || current.voiceId !== record.voiceId || current.credentialScope !== record.credentialScope) throw new KnowledgeError("CONFLICT", 409, "音色记录已变化，请刷新后重试");
    }
  }
  async release(scope: TwinVoiceScope, record: TwinVoiceRecord) {
    await this.pool.query(`DELETE FROM digital_twin_voices
      WHERE owner_id=$1 AND item_id=$2 AND revision_id=$3 AND prefix=$4 AND voice_id IS NULL AND status='unknown'`, [...args(scope), record.prefix]);
  }
}
