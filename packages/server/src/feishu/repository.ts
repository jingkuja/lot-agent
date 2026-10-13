import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { FeishuRepository, FeishuUserStore, FeishuConnection, FeishuInboxJob, FeishuSetup } from "@lot-agent/core";

export class PgFeishuRepository implements FeishuRepository {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(userId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 37))", [userId]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async withUser<T>(userId: string, work: (store: FeishuUserStore) => Promise<T>): Promise<T> {
    return this.transaction(userId, async client => work({
        connection: async () => (await client.query("SELECT * FROM feishu_connections WHERE user_id=$1", [userId])).rows[0] ?? null,
        saveConnection: async (c) => {
          if (c.user_id !== userId) throw new Error("Feishu ownership mismatch");
          await client.query(`INSERT INTO feishu_connections
            (user_id,app_id,open_id,tenant_key,name,access_token,refresh_token,expires_at,scopes,revision,app_secret)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
            ON CONFLICT(user_id) DO UPDATE SET app_id=EXCLUDED.app_id,open_id=EXCLUDED.open_id,
            tenant_key=EXCLUDED.tenant_key,name=EXCLUDED.name,access_token=EXCLUDED.access_token,
            refresh_token=EXCLUDED.refresh_token,expires_at=EXCLUDED.expires_at,scopes=EXCLUDED.scopes,revision=EXCLUDED.revision,app_secret=EXCLUDED.app_secret`,
          [userId,c.app_id,c.open_id,c.tenant_key,c.name,c.access_token,c.refresh_token,c.expires_at,JSON.stringify(c.scopes),c.revision,c.app_secret ?? null]);
        },
        disconnect: async (preserveContacts = false) => {
          await client.query("DELETE FROM feishu_connections WHERE user_id=$1", [userId]);
          await client.query("DELETE FROM feishu_oauth_states WHERE user_id=$1", [userId]);
          if (!preserveContacts) await client.query("DELETE FROM feishu_contacts WHERE user_id=$1", [userId]);
          await client.query("DELETE FROM feishu_setups WHERE user_id=$1", [userId]);
          await this.cancelJobs(client, userId);
        },
        contact: async (alias) => (await client.query("SELECT open_id FROM feishu_contacts WHERE user_id=$1 AND alias=$2", [userId,alias])).rows[0]?.open_id ?? null,
        saveContact: async (alias, openId) => {
          await client.query(`INSERT INTO feishu_contacts(user_id,alias,open_id) VALUES($1,$2,$3)
            ON CONFLICT(user_id,alias) DO UPDATE SET open_id=EXCLUDED.open_id`, [userId,alias,openId]);
        },
        deleteContact: async alias => { await client.query("DELETE FROM feishu_contacts WHERE user_id=$1 AND alias=$2", [userId,alias]); },
        sendRecord: async (id) => (await client.query("SELECT * FROM feishu_sends WHERE user_id=$1 AND request_id=$2", [userId,id])).rows[0] ?? null,
        saveSend: async (r) => {
          await client.query(`INSERT INTO feishu_sends(user_id,request_id,fingerprint,status,message_id) VALUES($1,$2,$3,$4,$5)
            ON CONFLICT(user_id,request_id) DO UPDATE SET status=EXCLUDED.status,message_id=EXCLUDED.message_id`,
          [userId,r.request_id,r.fingerprint,r.status,r.message_id]);
        },
        setup: async () => (await client.query("SELECT * FROM feishu_setups WHERE user_id=$1", [userId])).rows[0] ?? null,
        saveSetup: async (s: FeishuSetup) => {
          if (s.user_id !== userId) throw new Error("Feishu ownership mismatch");
          await client.query(`INSERT INTO feishu_setups(user_id,id,phase,data,expires_at,poll_after,interval,attempts)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id) DO UPDATE SET
            id=EXCLUDED.id,phase=EXCLUDED.phase,data=EXCLUDED.data,expires_at=EXCLUDED.expires_at,
            poll_after=EXCLUDED.poll_after,interval=EXCLUDED.interval,attempts=EXCLUDED.attempts`,
          [userId,s.id,s.phase,s.data,s.expires_at,s.poll_after,s.interval,s.attempts]);
        },
        conversation: () => this.conversation(client, userId),
      }));
  }

  private async conversation(client: PoolClient, userId: string): Promise<string> {
    return (await client.query(`INSERT INTO conversations(id,user_id,title,agent_id,channel,metadata)
      VALUES($1,$2,'飞书','general','feishu','{"source":"feishu"}'::jsonb)
      ON CONFLICT(user_id) WHERE channel='feishu' DO UPDATE SET status='active',project_id=NULL
      RETURNING id`, [randomUUID(),userId])).rows[0].id;
  }

  private async cancelJobs(client: PoolClient, userId: string) {
    await client.query(`WITH cancelled AS (
      UPDATE feishu_inbox SET status='cancelled' WHERE user_id=$1 AND status='pending' RETURNING result_message_id
    ) UPDATE messages SET content='任务已取消。',metadata=metadata || '{"feishuStatus":"cancelled"}'::jsonb
      WHERE id IN (SELECT result_message_id FROM cancelled)`, [userId]);
    // Keep the running slot occupied until its worker has stopped. Cancellation is observed across instances.
    await client.query("UPDATE feishu_inbox SET cancel_requested=true WHERE user_id=$1 AND status='running'", [userId]);
  }

  async findSender(appId: string, tenant: string, openId: string): Promise<FeishuConnection | null> {
    return (await this.pool.query("SELECT * FROM feishu_connections WHERE app_id=$1 AND tenant_key=$2 AND open_id=$3", [appId,tenant,openId])).rows[0] ?? null;
  }
  async contacts(userId: string) {
    return (await this.pool.query("SELECT alias,open_id FROM feishu_contacts WHERE user_id=$1 ORDER BY alias", [userId])).rows;
  }
  async saveContact(userId: string, alias: string, openId: string) {
    await this.withUser(userId, async store => {
      if (!await store.connection()) throw new Error("Feishu connection unavailable");
      await store.saveContact(alias,openId);
    });
  }
  async deleteContact(userId: string, alias: string) {
    await this.withUser(userId, store => store.deleteContact(alias));
  }
  async connections(): Promise<FeishuConnection[]> {
    return (await this.pool.query("SELECT * FROM feishu_connections")).rows;
  }
  async enqueue(job: FeishuInboxJob) {
    return this.transaction(job.user_id, async client => {
      const connection = (await client.query("SELECT 1 FROM feishu_connections WHERE user_id=$1 AND revision=$2", [job.user_id,job.revision])).rowCount;
      if (!connection || (await client.query("SELECT 1 FROM feishu_inbox WHERE message_id=$1", [job.message_id])).rowCount) return false;
      const cancelling = ["/cancel","取消任务"].includes(job.text.trim());
      const limited = Number((await client.query("SELECT count(*) FROM feishu_inbox WHERE user_id=$1 AND created_at>now()-interval '1 minute'", [job.user_id])).rows[0].count) >= 30;
      if (cancelling) await this.cancelJobs(client,job.user_id);
      const conversationId = await this.conversation(client,job.user_id);
      const userMessageId = randomUUID(), resultMessageId = randomUUID();
      const seq = Number((await client.query("UPDATE conversations SET next_seq=next_seq+2,updated_at=now() WHERE id=$1 RETURNING next_seq", [conversationId])).rows[0].next_seq);
      const status = limited && !cancelling ? "rate_limited" : "pending";
      const metadata = JSON.stringify({ source:"feishu",feishuMessageId:job.message_id,feishuStatus:status });
      await client.query(`INSERT INTO messages(id,conversation_id,role,content,seq,metadata) VALUES
        ($1,$3,'user',$4,$5,$7::jsonb),($2,$3,'assistant',$6,$5+1,$7::jsonb)`,
      [userMessageId,resultMessageId,conversationId,job.text,seq-1,status === "pending" ? "飞书任务待处理…" : "飞书任务过于频繁，本次未执行，请稍后重试。",metadata]);
      await client.query(`INSERT INTO feishu_inbox(message_id,user_id,revision,text,chat_id,conversation_id,user_message_id,result_message_id,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [job.message_id,job.user_id,job.revision,job.text,job.chat_id,conversationId,userMessageId,resultMessageId,status]);
      return true;
    });
  }

  async claim(): Promise<FeishuInboxJob | null> {
    // A crashed worker is never replayed. Its transcript explains the unknown outcome.
    await this.pool.query(`WITH expired AS (
      UPDATE feishu_inbox SET status='unknown' WHERE status='running' AND started_at<now()-interval '5 minutes'
      RETURNING result_message_id,conversation_id,run_id
    ), released AS (
      UPDATE conversations c SET active_run_id=NULL,run_started_at=NULL FROM expired e
      WHERE c.id=e.conversation_id AND c.active_run_id=e.run_id
    ) UPDATE messages SET content=CASE WHEN content='飞书任务处理中…' THEN '' ELSE content || E'\n\n' END || '任务执行中断，结果待核实；不会自动重试。',
      metadata=metadata || '{"feishuStatus":"unknown"}'::jsonb WHERE id IN (SELECT result_message_id FROM expired)`);
    const candidates = (await this.pool.query(`SELECT i.user_id FROM feishu_inbox i
      WHERE i.status='pending' AND NOT EXISTS(SELECT 1 FROM feishu_inbox r WHERE r.user_id=i.user_id AND r.status='running')
      GROUP BY i.user_id ORDER BY min(i.created_at),i.user_id LIMIT 64`)).rows;
    for (const candidate of candidates) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const locked = (await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,37)) AS locked", [candidate.user_id])).rows[0].locked;
        if (!locked) { await client.query("ROLLBACK"); continue; }
        const job = (await client.query(`SELECT i.* FROM feishu_inbox i JOIN messages m ON m.id=i.user_message_id
          WHERE i.user_id=$1 AND i.status='pending'
          AND NOT EXISTS(SELECT 1 FROM feishu_inbox r WHERE r.user_id=$1 AND r.status='running')
          ORDER BY m.seq,i.created_at,i.message_id LIMIT 1 FOR UPDATE OF i`, [candidate.user_id])).rows[0];
        if (!job) { await client.query("ROLLBACK"); continue; }
        const runId = randomUUID();
        const claimed = await client.query(`UPDATE conversations SET active_run_id=$2,run_started_at=now()
          WHERE id=$1 AND (active_run_id IS NULL OR run_started_at<now()-interval '35 minutes')`, [job.conversation_id,runId]);
        if (!claimed.rowCount) { await client.query("ROLLBACK"); continue; }
        await client.query("UPDATE feishu_inbox SET status='running',started_at=now(),run_id=$2 WHERE message_id=$1", [job.message_id,runId]);
        await client.query(`UPDATE messages SET content='飞书任务处理中…',metadata=metadata || '{"feishuStatus":"running"}'::jsonb WHERE id=$1`, [job.result_message_id]);
        await client.query("COMMIT");
        return { ...job,run_id:runId };
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    return null;
  }

  async recordResult(job: FeishuInboxJob, text: string, status: string) {
    await this.pool.query(`UPDATE messages m SET content=$3,metadata=m.metadata || jsonb_build_object('feishuStatus',$4::text)
      FROM feishu_inbox i WHERE i.message_id=$1 AND i.user_id=$2 AND i.result_message_id=m.id
      AND i.status='running' AND i.run_id=$5`, [job.message_id,job.user_id,text,status,job.run_id]);
  }
  async finish(messageId: string, status: string) {
    await this.pool.query(`WITH finished AS (
      UPDATE feishu_inbox SET status=$2 WHERE message_id=$1 AND status='running' RETURNING conversation_id,run_id,result_message_id
    ), messages_updated AS (
      UPDATE messages m SET metadata=m.metadata || jsonb_build_object('feishuStatus',$2::text)
      FROM finished f WHERE m.id=f.result_message_id
    ) UPDATE conversations c SET active_run_id=NULL,run_started_at=NULL,updated_at=now()
      FROM finished f WHERE c.id=f.conversation_id AND c.active_run_id=f.run_id`, [messageId,status]);
  }
  async active(job: FeishuInboxJob) {
    return (await this.pool.query(`UPDATE conversations v SET run_started_at=now()
      FROM feishu_inbox i JOIN feishu_connections c ON c.user_id=i.user_id
      WHERE i.message_id=$1 AND i.user_id=$2 AND i.status='running' AND NOT i.cancel_requested AND c.revision=$3
      AND v.id=i.conversation_id AND v.active_run_id=i.run_id RETURNING v.id`, [job.message_id,job.user_id,job.revision])).rowCount === 1;
  }
  async recent(userId: string) {
    return (await this.pool.query("SELECT message_id,status,created_at FROM feishu_inbox WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10", [userId])).rows;
  }
}
