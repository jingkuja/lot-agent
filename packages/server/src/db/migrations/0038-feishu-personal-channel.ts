import type { Migration } from "../migration-runner.js";

export const feishuPersonalChannel: Migration = {
  version: 38, name: "feishu-personal-channel",
  async up(client) {
    await client.query(`
      ALTER TABLE feishu_connections ADD COLUMN app_secret TEXT;
      CREATE TABLE feishu_setups (
        user_id VARCHAR(100) PRIMARY KEY, id UUID NOT NULL UNIQUE,
        phase TEXT NOT NULL, data TEXT NOT NULL, expires_at DOUBLE PRECISION NOT NULL,
        poll_after DOUBLE PRECISION NOT NULL, interval INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
      );
      DELETE FROM feishu_oauth_states;
      ALTER TABLE conversations ADD COLUMN channel TEXT;
      ALTER TABLE feishu_inbox ADD COLUMN conversation_id UUID REFERENCES conversations(id);
      ALTER TABLE feishu_inbox ADD COLUMN user_message_id UUID REFERENCES messages(id);
      ALTER TABLE feishu_inbox ADD COLUMN result_message_id UUID REFERENCES messages(id);
      ALTER TABLE feishu_inbox ADD COLUMN run_id UUID;
      ALTER TABLE feishu_inbox ADD COLUMN cancel_requested BOOLEAN NOT NULL DEFAULT false;

      -- Preserve historical messages and run/trace references while collapsing old per-task chats.
      CREATE TEMP TABLE feishu_merge ON COMMIT DROP AS
      SELECT c.id AS old_id, c.metadata->>'messageId' AS message_id,
        first_value(c.id) OVER (PARTITION BY c.user_id ORDER BY c.created_at,c.id) AS target_id,
        (SELECT id FROM messages WHERE conversation_id=c.id AND role='user' ORDER BY seq,created_at,id LIMIT 1) AS input_id,
        (SELECT id FROM messages WHERE conversation_id=c.id AND role='assistant' ORDER BY seq DESC,created_at DESC,id DESC LIMIT 1) AS output_id
      FROM conversations c WHERE metadata->>'source'='feishu' AND status='active' AND agent_id='general';
      CREATE TEMP TABLE feishu_message_order ON COMMIT DROP AS
        SELECT m.id,m.seq,c.created_at AS turn_at,c.id AS turn_id
        FROM messages m JOIN conversations c ON c.id=m.conversation_id
        WHERE c.id IN (SELECT old_id FROM feishu_merge);
      UPDATE messages SET seq=NULL WHERE conversation_id IN (SELECT old_id FROM feishu_merge);
      UPDATE messages m SET conversation_id=f.target_id FROM feishu_merge f WHERE m.conversation_id=f.old_id;
      UPDATE traces t SET conversation_id=f.target_id FROM feishu_merge f WHERE t.conversation_id=f.old_id;
      UPDATE agent_runs r SET conversation_id=f.target_id FROM feishu_merge f WHERE r.conversation_id=f.old_id;
      UPDATE conversations c SET status='deleted', metadata=c.metadata || jsonb_build_object('feishuMergedInto',f.target_id)
        FROM feishu_merge f WHERE c.id=f.old_id AND f.old_id<>f.target_id;
      UPDATE conversations SET channel='feishu', title='飞书', project_id=NULL,
        active_run_id=NULL, run_started_at=NULL, metadata=metadata-'contextSummary'
        WHERE id IN (SELECT target_id FROM feishu_merge);
      WITH ordered AS (
        SELECT m.id,row_number() OVER (PARTITION BY m.conversation_id ORDER BY o.turn_at,o.turn_id,o.seq,m.created_at,m.id) AS seq
        FROM messages m JOIN feishu_message_order o ON o.id=m.id
      ) UPDATE messages m SET seq=o.seq FROM ordered o WHERE m.id=o.id;
      UPDATE conversations c SET next_seq=COALESCE((SELECT max(seq) FROM messages WHERE conversation_id=c.id),0)
        WHERE channel='feishu';
      CREATE UNIQUE INDEX conversations_feishu_owner ON conversations(user_id) WHERE channel='feishu';
      INSERT INTO conversations(id,user_id,title,agent_id,channel,metadata)
        SELECT gen_random_uuid(),u.user_id,'飞书','general','feishu','{"source":"feishu"}'::jsonb
        FROM (SELECT user_id FROM feishu_connections UNION SELECT user_id FROM feishu_inbox) u
        WHERE NOT EXISTS(SELECT 1 FROM conversations c WHERE c.user_id=u.user_id AND c.channel='feishu');
      UPDATE feishu_inbox i SET conversation_id=c.id FROM conversations c WHERE c.user_id=i.user_id AND c.channel='feishu';
      UPDATE feishu_inbox SET status='unknown' WHERE status='running';

      -- Commands in v1 had no messages. Preserve their input and explicitly label unavailable historical output.
      DO $$ DECLARE j RECORD; input_id UUID; output_id UUID; n BIGINT; BEGIN
        FOR j IN SELECT i.* FROM feishu_inbox i ORDER BY created_at,message_id LOOP
          SELECT f.input_id,f.output_id INTO input_id,output_id FROM feishu_merge f
            WHERE f.message_id=j.message_id AND f.target_id=j.conversation_id LIMIT 1;
          IF input_id IS NULL THEN
            input_id:=gen_random_uuid();
            UPDATE conversations SET next_seq=next_seq+1 WHERE id=j.conversation_id RETURNING next_seq INTO n;
            INSERT INTO messages(id,conversation_id,role,content,seq,created_at,metadata)
              VALUES(input_id,j.conversation_id,'user',j.text,n,j.created_at,jsonb_build_object('source','feishu','feishuMessageId',j.message_id));
          END IF;
          UPDATE messages SET metadata=metadata || jsonb_build_object('source','feishu','feishuMessageId',j.message_id,'feishuStatus',j.status)
            WHERE id IN (input_id,output_id);
          IF output_id IS NULL THEN
            output_id:=gen_random_uuid();
            UPDATE conversations SET next_seq=next_seq+1 WHERE id=j.conversation_id RETURNING next_seq INTO n;
            INSERT INTO messages(id,conversation_id,role,content,seq,created_at,metadata)
              VALUES(output_id,j.conversation_id,'assistant',CASE WHEN j.status='pending' THEN '飞书任务待处理…'
                ELSE '历史飞书任务（'||j.status||'）：原版本未保存结果正文。' END,n,j.created_at,
                jsonb_build_object('source','feishu','feishuMessageId',j.message_id,'feishuStatus',j.status));
          END IF;
          UPDATE feishu_inbox SET user_message_id=input_id,result_message_id=output_id WHERE message_id=j.message_id;
          input_id:=NULL; output_id:=NULL;
        END LOOP;
      END $$;
      -- Reorder backfilled command pairs chronologically without losing original turn order.
      CREATE TEMP TABLE feishu_final_order ON COMMIT DROP AS
        SELECT m.id,row_number() OVER (PARTITION BY m.conversation_id ORDER BY
          COALESCE(o.turn_at,i.created_at,m.created_at),COALESCE(o.turn_id::text,i.message_id,m.id::text),
          COALESCE(o.seq,CASE WHEN m.role='user' THEN 1 ELSE 2 END),m.created_at,m.id) AS seq
        FROM messages m JOIN conversations c ON c.id=m.conversation_id
        LEFT JOIN feishu_message_order o ON o.id=m.id
        LEFT JOIN feishu_inbox i ON i.message_id=m.metadata->>'feishuMessageId'
        WHERE c.channel='feishu';
      UPDATE messages SET seq=NULL WHERE id IN (SELECT id FROM feishu_final_order);
      UPDATE messages m SET seq=o.seq FROM feishu_final_order o WHERE m.id=o.id;
      CREATE UNIQUE INDEX feishu_inbox_one_running ON feishu_inbox(user_id) WHERE status='running';
    `);
  },
};
