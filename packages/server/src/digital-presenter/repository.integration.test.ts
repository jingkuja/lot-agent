import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PresenterDraftSchema } from "@lot-agent/core/digital-presenter";
import { DB } from "../db/database.js";
import { migrations } from "../db/migrations/index.js";
import { runMigrations } from "../db/migration-runner.js";
import { SecretBox } from "../auth/secret-box.js";
import { PgPresenterStore } from "./repository.js";

// Explicit opt-in; never use DATABASE_URL or the application's configured database.
const testUrl = process.env.PRESENTER_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("digital presenter store on PostgreSQL", () => {
  let db: DB; let store: PgPresenterStore;
  const owner = "presenter-owner";
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!/^\/lot_presenter_test_[a-z0-9_]+$/.test(url.pathname)) throw new Error("Requires a dedicated lot_presenter_test_* database");
    db = new DB({ host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1) }, new SecretBox(undefined));
    const { rows } = await db.pool.query("SELECT to_regclass('public.conversations') AS existing");
    if (rows[0].existing) throw new Error("Test database must be empty; refusing to modify existing data");
    await runMigrations(db.pool, migrations);
    store = new PgPresenterStore(db.pool);
  });
  afterAll(async () => { await db?.pool.end(); });

  async function finished() {
    const id = randomUUID(); const taskId = randomUUID();
    const draft = PresenterDraftSchema.parse({ script: "大家好。欢迎光临。", consent: true });
    await db.pool.query("INSERT INTO tasks(id,type,input,user_id,status,progress) VALUES($1,'digital-presenter.video',$2,$3,'succeeded',100)",
      [taskId, JSON.stringify({ projectId: id, mode: "image", subtitles: true }), owner]);
    await db.pool.query("INSERT INTO digital_presenter_projects(id,user_id,version,draft,task_id) VALUES($1,$2,4,$3,$4)", [id, owner, JSON.stringify(draft), taskId]);
    for (const slot of [0, 1]) {
      await db.pool.query("INSERT INTO digital_presenter_clips(task_id,slot,model,status,vendor_task_id,file,seconds) VALUES($1,$2,'wan2.2-s2v','succeeded',$3,$4,4.2)",
        [taskId, slot, `vendor-${slot}`, `jobs/${taskId}/clip-${slot}.mp4`]);
    }
    await db.pool.query("INSERT INTO assets(task_id,user_id,type,storage_key,url,mime) VALUES($1,$2,'video',$3,'/v','video/mp4')", [taskId, owner, `${taskId}.mp4`]);
    return { id, taskId };
  }

  it("recomposes from copies of the finished clips and keeps the new captions in the draft", async () => {
    const { id, taskId } = await finished();
    const captions = { size: "large" as const, position: "medium" as const, offsetSec: 0.1, shots: [] };
    const next = await store.recompose(owner, id, 4, taskId, { mode: "image", subtitles: true, captions }, captions);
    const clips = await store.clips(next);
    expect(clips.map(clip => [clip.slot, clip.status, clip.file])).toEqual([[0, "succeeded", `jobs/${taskId}/clip-0.mp4`], [1, "succeeded", `jobs/${taskId}/clip-1.mp4`]]);
    const task = (await db.pool.query("SELECT type,status,input,queue_name FROM tasks WHERE id=$1", [next])).rows[0];
    expect(task).toMatchObject({ type: "digital-presenter.video", status: "pending", queue_name: "lot-marketing-video", input: { projectId: id, recomposedFrom: taskId, captions, draft: { captions } } });
    const project = await store.get(owner, id);
    expect(project).toMatchObject({ taskId: next, version: 5, status: "pending", draft: { captions } });
    // A stale page or an unfinished job cannot start another one.
    await expect(store.recompose(owner, id, 4, taskId, {}, captions)).rejects.toMatchObject({ status: 409 });
    await expect(store.recompose(owner, id, 5, next, {}, captions)).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a video whose clips are not all finished", async () => {
    const { id, taskId } = await finished();
    await db.pool.query("UPDATE digital_presenter_clips SET status='failed' WHERE task_id=$1 AND slot=1", [taskId]);
    await expect(store.recompose(owner, id, 4, taskId, {}, undefined)).rejects.toMatchObject({ status: 409 });
    expect((await store.get(owner, id))?.taskId).toBe(taskId);
  });

  it("removes the videos of every job of the draft", async () => {
    const { id, taskId } = await finished();
    const next = await store.recompose(owner, id, 4, taskId, { mode: "image" }, undefined);
    await db.pool.query("UPDATE tasks SET status='succeeded' WHERE id=$1", [next]);
    await db.pool.query("INSERT INTO assets(task_id,user_id,type,storage_key,url,mime) VALUES($1,$2,'video',$3,'/v','video/mp4')", [next, owner, `${next}.mp4`]);
    const { files } = await store.remove(owner, id);
    expect(files.sort()).toEqual([`${next}.mp4`, `${taskId}.mp4`].sort());
  });
});
