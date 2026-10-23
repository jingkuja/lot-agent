import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB } from "../db/database.js";
import { migrations } from "../db/migrations/index.js";
import { runMigrations } from "../db/migration-runner.js";
import { SecretBox } from "../auth/secret-box.js";
import { UNKNOWN_SUBMISSION } from "../marketing-video/recovery.js";
import { marketingMetrics } from "./metrics.js";
import { marketingReconciliation } from "./reconciliation.js";

// Explicit opt-in; never use DATABASE_URL or the application's configured database.
const testUrl = process.env.ADMIN_METRICS_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("admin marketing metrics and reconciliation on PostgreSQL", () => {
  let db: DB;
  const owner = "metrics-owner";
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!/^\/lot_admin_test_[a-z0-9_]+$/.test(url.pathname)) throw new Error("Requires a dedicated lot_admin_test_* database");
    db = new DB({ host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1) }, new SecretBox(undefined));
    const { rows } = await db.pool.query("SELECT to_regclass('public.conversations') AS existing");
    if (rows[0].existing) throw new Error("Test database must be empty; refusing to modify existing data");
    await runMigrations(db.pool, migrations);
  });
  afterAll(async () => { await db?.pool.end(); });

  const times = async (id: string) => (await db.pool.query("SELECT started_at, run_started_at, finished_at FROM tasks WHERE id=$1", [id])).rows[0];
  async function task(type: string, input: Record<string, unknown>, status = "pending") {
    const id = randomUUID();
    await db.pool.query("INSERT INTO tasks(id,type,input,user_id,status,queue_name) VALUES($1,$2,$3,$4,$5,'lot-marketing-video')", [id, type, JSON.stringify(input), owner, status]);
    return id;
  }

  it("keeps the first claim, the latest run and the finish across a resume", async () => {
    const id = await task("marketing.video", { modelId: "m" });
    expect(await times(id)).toEqual({ started_at: null, run_started_at: null, finished_at: null });
    await db.markTaskRunning(id, 1);
    const first = await times(id);
    expect(first.started_at).toBeInstanceOf(Date);
    await db.markTaskRunning(id, 1); // a stalled reclaim is the same run
    expect(await times(id)).toEqual(first);
    await db.setTaskError(id, "boom", "GENERATION_FAILED");
    expect((await times(id)).finished_at).toBeInstanceOf(Date);
    await db.pool.query("UPDATE tasks SET status='pending' WHERE id=$1", [id]);
    expect((await times(id)).finished_at).toBeNull();
    await db.markTaskRunning(id, 2);
    await db.setTaskResult(id, {});
    const resumed = await times(id);
    expect(resumed.started_at).toEqual(first.started_at);
    expect(resumed.run_started_at.getTime()).toBeGreaterThanOrEqual(first.run_started_at.getTime());
    expect(resumed.finished_at).toBeInstanceOf(Date);
    // Reused clips are inserted finished and never started.
    const reused = await task("marketing.segment", { parentId: id }, "succeeded");
    expect(await times(reused)).toMatchObject({ started_at: null });
  });

  it("reports rates, timings and unknown backlog", async () => {
    await db.pool.query("TRUNCATE tasks CASCADE");
    const at = (sec: number) => new Date(Date.now() - sec * 1000);
    const parent = await task("marketing.video", { modelId: "grok" });
    // The trigger stamps status changes with now(); set past times without touching status.
    await db.pool.query("UPDATE tasks SET status='succeeded' WHERE id=$1", [parent]);
    await db.pool.query("UPDATE tasks SET created_at=$2, started_at=$3, run_started_at=$3, finished_at=$4 WHERE id=$1", [parent, at(300), at(290), at(100)]);
    const clip = await task("marketing.segment", { parentId: parent });
    await db.pool.query("UPDATE tasks SET status='succeeded' WHERE id=$1", [clip]);
    await db.pool.query("UPDATE tasks SET run_started_at=$2, finished_at=$3 WHERE id=$1", [clip, at(280), at(160)]);
    await task("marketing.segment", { parentId: parent }, "pending"); // never attempted
    const reused = await task("marketing.segment", { parentId: parent }, "succeeded");
    await db.pool.query(`UPDATE tasks SET output='{"reusedFrom":"x"}' WHERE id=$1`, [reused]);

    const failed = await task("marketing.video", { modelId: "grok", revisedFrom: parent });
    await db.markTaskRunning(failed, 1);
    await db.setTaskError(failed, "unknown", "SUBMISSION_UNKNOWN");
    const unknownClip = await task("marketing.segment", { parentId: failed });
    await db.pool.query("UPDATE tasks SET status='failed', error_code='SUBMISSION_UNKNOWN', vendor_task_id=$2 WHERE id=$1", [unknownClip, UNKNOWN_SUBMISSION]);
    await task("digital-presenter.video", {}); // waiting in the queue
    const project = randomUUID();
    await db.pool.query("INSERT INTO marketing_video_projects(id,user_id,draft) VALUES($1,$2,'{}')", [project, owner]);
    for (const [status, sec] of [["succeeded", 40], ["unknown", 0]] as const) {
      await db.pool.query(`INSERT INTO marketing_text_operations(id,user_id,project_id,project_version,kind,input_hash,model,protocol,status,created_at)
        VALUES($1,$2,$3,1,'copy','h','kimi-k3','openai',$4,now() - make_interval(secs => $5))`, [randomUUID(), owner, project, status, sec]);
    }
    await db.pool.query("INSERT INTO marketing_clip_gateway_failures(owner_id,project_id,task_id,http_status) VALUES($1,$2,$3,502)", [owner, project, failed]);

    const m = await marketingMetrics(db.pool, 24, {});
    expect(m.renders).toEqual([
      expect.objectContaining({ type: "digital-presenter.video", kind: "generate", total: 1, active: 1, successRate: null }),
      expect.objectContaining({ type: "marketing.video", kind: "generate", total: 1, succeeded: 1, successRate: 1,
        queueWaitSec: { n: 1, p50: 10, p95: 10, max: 10 }, lastRunSec: { n: 1, p50: 190, p95: 190, max: 190 }, endToEndSec: expect.objectContaining({ p95: 200 }) }),
      expect.objectContaining({ type: "marketing.video", kind: "revise", total: 1, failed: 1, successRate: 0 }),
    ]);
    expect(m.renders.map(r => r.failures)).toEqual([{}, {}, { SUBMISSION_UNKNOWN: 1 }]);
    expect(m.composeSec).toMatchObject({ n: 1, p95: 60 });
    expect(m.clips).toEqual([expect.objectContaining({ model: "grok", total: 2, succeeded: 1, failed: 1, successRate: 0.5,
      failures: { SUBMISSION_UNKNOWN: 1 }, lastRunSec: expect.objectContaining({ n: 1, p95: 120 }) })]);
    expect(m.queue).toEqual([{ type: "digital-presenter.video", pending: 1, running: 0, oldestPendingSec: expect.any(Number) }]);
    expect(m.unknownBacklog.marketingClips).toMatchObject({ count: 1 });
    expect(m.unknownBacklog.presenterClips).toEqual({ count: 0, oldestSec: null });
    expect(m.concurrency).toEqual({ concurrency: 2, perUser: 1, segments: 2 });
    expect(m.gateway5xx).toEqual({ 502: 1 });
    expect(m.textRequests).toEqual([{ kind: "copy", model: "kimi-k3", total: 2, statuses: { succeeded: 1, unknown: 1 },
      respondedSec: expect.objectContaining({ n: 1, p95: expect.closeTo(40, 0) }) }]);
    expect(m.unknownBacklog.textRequests).toMatchObject({ count: 1 });
  });

  it("lists charges to check against the gateway logs, with gateway account IDs and no keys", async () => {
    await db.pool.query("TRUNCATE tasks, marketing_text_operations, marketing_clip_gateway_failures CASCADE");
    const user = randomUUID();
    await db.pool.query("INSERT INTO users(id,name,external_user_id,managed_token_id,managed_api_key) VALUES($1,'gateway user',42,7,'sk-secret')", [user]);
    const project = randomUUID();
    await db.pool.query("INSERT INTO marketing_video_projects(id,user_id,draft) VALUES($1,$2,'{}')", [project, user]);
    const text = async (status: string, extra: Record<string, unknown> = {}) => {
      const id = randomUUID();
      await db.pool.query(`INSERT INTO marketing_text_operations(id,user_id,project_id,project_version,kind,input_hash,model,protocol,status,receipt,updated_at,released_at)
        VALUES($1,$2,$3,1,'review','h','flash','openai',$4,$5,COALESCE($6::timestamptz, now()),$7)`,
        [id, user, project, status, JSON.stringify({ outcome: status, gatewayRequestId: `req-${status}` }), extra.updatedAt ?? null, extra.releasedAt ?? null]);
      return id;
    };
    const noResponse = await text("cancelled");
    await text("cancelled", { updatedAt: new Date(Date.now() - 10 * 86_400_000) }); // outside the window
    await text("unknown");
    await text("released", { releasedAt: new Date() });
    const parent = await task("marketing.video", { modelId: "grok", projectId: project });
    await db.pool.query("UPDATE tasks SET user_id=$2, status='failed' WHERE id=$1", [parent, user]);
    const clip = await task("marketing.segment", { parentId: parent });
    await db.pool.query("UPDATE tasks SET user_id=$2, status='failed', vendor_task_id=$3 WHERE id=$1", [clip, user, UNKNOWN_SUBMISSION]);
    await db.pool.query("INSERT INTO marketing_video_segments(project_id,slot,task_id,script,duration_sec) VALUES($1,2,$2,'s',5)", [project, clip]);
    await db.pool.query("INSERT INTO marketing_clip_gateway_failures(owner_id,project_id,task_id,http_status,gateway_request_id) VALUES($1,$2,$3,503,'req-5xx')", [user, project, clip]);
    await db.pool.query(`INSERT INTO marketing_video_narrations(owner_id,project_id,slot,narration_key,status,updated_at)
      VALUES($1,$2,0,'k','running',now() - interval '1 hour'),($1,$2,1,'k','running',now())`, [user, project]);

    const r = await marketingReconciliation(db.pool, 24);
    expect(r.counts).toEqual({ text_no_response: 1, text_unknown: 1, text_released: 1, clip_gateway_5xx: 1, clip_unknown: 1, narration_stuck: 1 });
    expect(r.truncated).toEqual([]);
    expect(r.items.find(i => i.category === "text_no_response")).toMatchObject({ expectedCharge: "none", open: false, recordId: noResponse,
      gatewayRequestId: "req-cancelled", gatewayUserId: "42", gatewayTokenId: "7", requestKind: "review", model: "flash" });
    expect(r.items.find(i => i.category === "clip_gateway_5xx")).toMatchObject({ expectedCharge: "none", taskId: clip, model: "grok", httpStatus: 503, gatewayRequestId: "req-5xx" });
    expect(r.items.find(i => i.category === "clip_unknown")).toMatchObject({ expectedCharge: "unknown", open: true, projectId: project, taskId: clip, slot: 2, model: "grok" });
    expect(r.items.find(i => i.category === "narration_stuck")).toMatchObject({ slot: 0, ageHours: 1 });
    expect(JSON.stringify(r)).not.toContain("sk-secret");
  });
});
