/** Called only by the disposable local PostgreSQL integration harness. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { MarketingDraftSchema } from "@lot-agent/core/marketing-video";
import { PgMarketingTextOperations } from "../src/marketing-video/operations.js";
import { PgMarketingProjectStore } from "../src/marketing-video/repository.js";
import { parseTextResult } from "../src/marketing-video/text-result.js";

export async function checkTextResultRecovery(pool: pg.Pool) {
  const owner = randomUUID();
  await pool.query("INSERT INTO users(id,name) VALUES($1,'receipt recovery fixture')", [owner]);
  const store = new PgMarketingProjectStore(pool); const operations = new PgMarketingTextOperations(pool);
  const raw = { shots: [1, 2].map(() => ({ durationSec: 15, script: "欢迎到店喝咖啡。", visual: "咖啡店", action: "端起咖啡", camera: "中景" })), publishTitle: "咖啡时光", tags: "#咖啡", analysis: "介绍咖啡" };
  const fixture = async () => {
    const project = await store.save(owner, randomUUID(), 0, MarketingDraftSchema.parse({ topic: "咖啡" })); const id = randomUUID();
    await operations.begin(owner, id, project.id, project.version, "copy", { draft: project.draft, locale: "zh" }, project.draft);
    await operations.receipt(owner, id, { outcome: "completed", text: JSON.stringify(raw), responseId: "local-fixture", usage: { promptTokens: 5, completionTokens: 5 } });
    return { project, id, result: parseTextResult("copy", raw, project.draft) };
  };
  const rollback = await fixture();
  // Raise from PostgreSQL itself after the receipt transaction committed.
  await pool.query(`CREATE FUNCTION review_finish_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture finish rollback'; END $$;
    CREATE TRIGGER review_finish_failure BEFORE UPDATE ON marketing_video_projects
    FOR EACH ROW WHEN (OLD.id='${rollback.project.id}'::uuid) EXECUTE FUNCTION review_finish_failure();`);
  try {
    await assert.rejects(operations.finish(owner, rollback.id, rollback.result), /fixture finish rollback/);
    await operations.fail(owner, rollback.id);
    assert.equal((await operations.list(owner, rollback.project.id))[0].status, "needs_apply");
    assert.equal((await store.get(owner, rollback.project.id))!.version, 1);
    await assert.rejects(operations.begin(owner, randomUUID(), rollback.project.id, 1, "copy", {}), /已有创作请求/);
  } finally { await pool.query("DROP TRIGGER review_finish_failure ON marketing_video_projects; DROP FUNCTION review_finish_failure()"); }
  const restarted = new PgMarketingTextOperations(pool);
  await assert.rejects(restarted.recover("other-owner", rollback.project.id, rollback.id), /不存在/);
  const recovered = await Promise.all([restarted.recover(owner, rollback.project.id, rollback.id), restarted.recover(owner, rollback.project.id, rollback.id)]);
  assert(recovered.every(result => result.status === "succeeded"));
  assert.equal((await store.get(owner, rollback.project.id))!.version, 2);
  assert.deepEqual(recovered[0].result, rollback.result);

  const committed = await fixture();
  const uncertainPool = new Proxy(pool, { get(target, key) {
    if (key !== "connect") { const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; }
    return async () => {
      const client = await pool.connect();
      return new Proxy(client, { get(connection, property) {
        if (property === "query") return async (...args: unknown[]) => {
          const result = await Reflect.apply(connection.query, connection, args);
          if (args[0] === "COMMIT") throw new Error("fixture lost COMMIT response");
          return result;
        };
        const value = Reflect.get(connection, property); return typeof value === "function" ? value.bind(connection) : value;
      } });
    };
  } });
  await assert.rejects(new PgMarketingTextOperations(uncertainPool).finish(owner, committed.id, committed.result), /lost COMMIT/);
  await operations.fail(owner, committed.id);
  assert.equal((await restarted.recover(owner, committed.project.id, committed.id)).status, "succeeded");
  assert.equal((await store.get(owner, committed.project.id))!.version, 2);

  const conflict = await fixture();
  await store.save(owner, conflict.project.id, 1, { ...conflict.project.draft, topic: "新编辑" });
  assert.equal((await restarted.recover(owner, conflict.project.id, conflict.id)).status, "conflict");
  assert.equal((await store.get(owner, conflict.project.id))!.draft.topic, "新编辑");
  assert.deepEqual((await restarted.recover(owner, conflict.project.id, conflict.id)).result, conflict.result);
  const schema = await fixture();
  await pool.query("UPDATE marketing_text_operations SET parser_version='future-version' WHERE user_id=$1 AND id=$2", [owner, schema.id]);
  await assert.rejects(restarted.recover(owner, schema.project.id, schema.id), /原版本/);
  assert.equal((await operations.list(owner, schema.project.id))[0].status, "needs_apply");
  const malformed = await fixture();
  await pool.query("UPDATE marketing_text_operations SET receipt=jsonb_set(receipt,'{text}','\"{bad\"') WHERE user_id=$1 AND id=$2", [owner, malformed.id]);
  await assert.rejects(restarted.recover(owner, malformed.project.id, malformed.id), /不完整/);
  assert.equal((await operations.list(owner, malformed.project.id))[0].status, "failed");
  const unknown = await fixture();
  await pool.query("UPDATE marketing_text_operations SET receipt=NULL,status='unknown' WHERE user_id=$1 AND id=$2", [owner, unknown.id]);
  await assert.rejects(restarted.recover(owner, unknown.project.id, unknown.id), /尚未核实/);
  console.log("PASS: real PG receipt recovery after finish rollback and lost COMMIT response, concurrent idempotency, ownership, version conflict, parser version and malformed/unknown rejection; no provider calls");
}
