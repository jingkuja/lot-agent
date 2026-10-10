import type { Pool } from "pg";
import type { KlingVoiceCheckpoint, KlingVoiceScope, KlingVoiceStore } from "@lot-agent/core";

export class PgKlingVoiceStore implements KlingVoiceStore {
  constructor(private readonly pool: Pool) {}
  async claim(scope: KlingVoiceScope, externalTaskId: string) {
    const args = [scope.taskId, scope.userId, scope.slot, scope.fingerprint];
    const inserted = await this.pool.query(`
      INSERT INTO generation_voice_tasks (task_id, user_id, slot, fingerprint, external_task_id)
      SELECT id, user_id, $3, $4, $5 FROM tasks WHERE id=$1 AND user_id=$2
      ON CONFLICT (task_id, slot) DO NOTHING RETURNING external_task_id`, [...args, externalTaskId]);
    const result = await this.pool.query(`SELECT external_task_id, vendor_task_id, voice_id
      FROM generation_voice_tasks WHERE task_id=$1 AND user_id=$2 AND slot=$3 AND fingerprint=$4`, args);
    const row = result.rows[0];
    if (!row) throw new Error("音色任务归属或凭证已变化，请重新发起视频任务。");
    const checkpoint: KlingVoiceCheckpoint = { externalTaskId: row.external_task_id, vendorTaskId: row.vendor_task_id ?? undefined, voiceId: row.voice_id ?? undefined };
    return { created: inserted.rows.length === 1, checkpoint };
  }
  async save(scope: KlingVoiceScope, result: { vendorTaskId: string; voiceId?: string }) {
    const updated = await this.pool.query(`UPDATE generation_voice_tasks
      SET vendor_task_id=$5, voice_id=COALESCE($6,voice_id), updated_at=now()
      WHERE task_id=$1 AND user_id=$2 AND slot=$3 AND fingerprint=$4
        AND (vendor_task_id IS NULL OR vendor_task_id=$5)
      RETURNING task_id`, [scope.taskId, scope.userId, scope.slot, scope.fingerprint, result.vendorTaskId, result.voiceId ?? null]);
    if (!updated.rows.length) throw new Error("无法保存音色任务状态，请查询原任务。");
  }
}
