import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DB } from "../db/database.js";
import { migrations } from "../db/migrations/index.js";
import { runMigrations } from "../db/migration-runner.js";
import { SecretBox } from "../auth/secret-box.js";
import { PgFeishuRepository } from "./repository.js";
import type { FeishuConnection, FeishuInboxJob } from "@lot-agent/core";

// Explicit opt-in; never use DATABASE_URL or the application's configured database.
const testUrl = process.env.FEISHU_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("Feishu PostgreSQL migration and queue integration", () => {
  let db: DB, repo: PgFeishuRepository;
  const oldA=randomUUID(), oldB=randomUUID(), ua=randomUUID(), ub=randomUUID(), ra=randomUUID(), rb=randomUUID();
  const revision=randomUUID();
  const job=(user: string,text="hello"): FeishuInboxJob => ({ user_id:user,revision,text,chat_id:"oc_test",message_id:`om_${randomUUID()}` });
  const bind=async (user: string) => repo.withUser(user, async store => {
    const c: FeishuConnection={ user_id:user,app_id:`cli_${user}`,app_secret:"encrypted-fixture",open_id:`ou_${user}`,tenant_key:"tenant",name:user,access_token:"encrypted",refresh_token:"encrypted",expires_at:Date.now()+3600_000,scopes:[],revision };
    await store.saveConnection(c); return store.conversation();
  });
  beforeAll(async () => {
    const url=new URL(testUrl!);
    if (!/^\/lot_feishu_review_test_[a-z0-9_]+$/.test(url.pathname)) throw new Error("Requires a dedicated lot_feishu_review_test_* database");
    db=new DB({ host:url.hostname,port:Number(url.port || 5432),user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),database:url.pathname.slice(1) },new SecretBox(undefined));
    repo=new PgFeishuRepository(db.pool);
    const { rows }=await db.pool.query("SELECT to_regclass('public.conversations') AS existing");
    if (rows[0].existing) throw new Error("Test database must be empty; refusing to modify existing data");
    await runMigrations(db.pool,migrations.filter(m => m.version<=37));
    for (const [id,messageId,at] of [[oldA,"om_old_a","2026-01-01"],[oldB,"om_old_b","2026-01-03"]]) {
      await db.pool.query(`INSERT INTO conversations(id,user_id,agent_id,title,metadata,created_at,next_seq)
        VALUES($1,'legacy','general','飞书任务',$2::jsonb,$3,2)`,[id,JSON.stringify({ source:"feishu",messageId }),at]);
    }
    for (const [id,cid,role,content,seq] of [[ua,oldA,"user","same task",1],[ra,oldA,"assistant","answer A",2],[ub,oldB,"user","same task",1],[rb,oldB,"assistant","answer B",2]]) {
      // Deliberately identical timestamps: original seq must preserve user/assistant order.
      await db.pool.query("INSERT INTO messages(id,conversation_id,role,content,seq,created_at) VALUES($1,$2,$3,$4,$5,'2026-01-01')",[id,cid,role,content,seq]);
    }
    for (const [id,text,at] of [["om_old_a","same task","2026-01-01"],["om_old_cmd","/help","2026-01-02"],["om_old_b","same task","2026-01-03"]]) {
      await db.pool.query("INSERT INTO feishu_inbox(message_id,user_id,revision,text,chat_id,status,created_at) VALUES($1,'legacy',$2,$3,'oc_test','completed',$4)",[id,revision,text,at]);
    }
    await db.pool.query("INSERT INTO agent_runs(id,conversation_id,user_id,source_message_id,goal,status) VALUES($1,$2,'legacy',$3,'same task','completed')",[randomUUID(),oldB,ub]);
  },30_000);
  afterAll(async () => { await db?.pool.end(); });

  it("merges old chats and commands without confusing identical tasks or losing run references",async () => {
    await runMigrations(db.pool,migrations);
    await runMigrations(db.pool,migrations); // Startup retry is safe.
    const list=await db.listConversations("legacy");
    expect(list).toHaveLength(1); expect(list[0]).toMatchObject({ id:oldA,channel:"feishu",agent_id:"general",title:"飞书" });
    const messages=await db.getMessages(oldA);
    expect(messages.map(m => m.role)).toEqual(["user","assistant","user","assistant","user","assistant"]);
    expect(messages.map(m => m.seq)).toEqual([1,2,3,4,5,6]);
    expect(messages[0].id).toBe(ua); expect(messages[1].id).toBe(ra);
    expect(messages[4].id).toBe(ub); expect(messages[5].id).toBe(rb);
    expect(messages[3].content).toContain("原版本未保存结果");
    const { rows }=await db.pool.query("SELECT message_id,user_message_id,result_message_id FROM feishu_inbox WHERE user_id='legacy' ORDER BY message_id");
    expect(rows.find(r => r.message_id==="om_old_b")).toMatchObject({ user_message_id:ub,result_message_id:rb });
    expect((await db.pool.query("SELECT conversation_id FROM agent_runs WHERE source_message_id=$1",[ub])).rows[0].conversation_id).toBe(oldA);
  });
  it("keeps one pinned conversation across concurrent creates and paginates past it",async () => {
    const ids=await Promise.all([bind("pin"),bind("pin")]); expect(ids[0]).toBe(ids[1]);
    const ordinary=randomUUID(); await db.createConversation(ordinary,"ordinary",undefined,undefined,"general","pin");
    await db.addMessage(randomUUID(),ordinary,"user","newer conversation");
    const first=await db.listConversations("pin",{ limit:1 }); expect(first[0].id).toBe(ids[0]);
    const next=await db.listConversations("pin",{ limit:1,cursorId:first[0].id }); expect(next[0].id).toBe(ordinary);
    expect(await db.listConversations("someone-else",{ limit:1,cursorId:ids[0] })).toEqual([]);
  });
  it("deduplicates messages, preserves FIFO per user, and lets another user run concurrently",async () => {
    const ca=await bind("queue_a"),cb=await bind("queue_b");
    const a1=job("queue_a"),a2=job("queue_a"),b1=job("queue_b");
    expect((await Promise.all([repo.enqueue(a1),repo.enqueue(a1)])).sort()).toEqual([false,true]);
    await repo.enqueue(a2); await repo.enqueue(b1);
    // Transaction timestamps can precede lock acquisition; transcript sequence is authoritative.
    await db.pool.query("UPDATE feishu_inbox SET created_at=now()-interval '1 day' WHERE message_id=$1",[a2.message_id]);
    const claimed=(await Promise.all([repo.claim(),repo.claim(),repo.claim()])).filter((j): j is FeishuInboxJob => !!j);
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map(j => j.user_id)).size).toBe(2);
    expect(claimed.find(j => j.user_id==="queue_a")!.message_id).toBe(a1.message_id);
    expect((await db.getMessages(ca)).length).toBe(4); expect((await db.getMessages(cb)).length).toBe(2);
    for (const j of claimed) { await repo.recordResult(j,`result ${j.user_id}`,"completed"); await repo.finish(j.message_id,"completed"); }
    const last=(await repo.claim())!; expect(last.message_id).toBe(a2.message_id);
    await repo.recordResult(last,"reply result","completed"); await repo.finish(last.message_id,"reply_unknown");
    expect((await db.getMessages(ca)).at(-1)).toMatchObject({ content:"reply result",metadata:expect.objectContaining({ feishuStatus:"reply_unknown" }) });
  });
  it("cancels running and pending tasks across workers without releasing a live slot prematurely",async () => {
    const cid=await bind("cancel"); const first=job("cancel"),second=job("cancel");
    await repo.enqueue(first); const running=(await repo.claim())!; await repo.enqueue(second);
    const cancel=job("cancel","/cancel"); await repo.enqueue(cancel);
    expect(await repo.active(running)).toBe(false); expect(await repo.claim()).toBeNull();
    expect((await db.getMessages(cid))[3]).toMatchObject({ content:"任务已取消。" });
    await repo.recordResult(running,"任务已取消。","cancelled"); await repo.finish(running.message_id,"cancelled");
    const command=(await repo.claim())!; expect(command.message_id).toBe(cancel.message_id);
    await repo.recordResult(command,"cancelled","completed"); await repo.finish(command.message_id,"completed");
    const rebound=await bind("cancel"); expect(rebound).toBe(cid);
    const pending=job("cancel"); await repo.enqueue(pending);
    await repo.withUser("cancel",s => s.disconnect());
    expect(await repo.claim()).toBeNull(); expect(await repo.enqueue(job("cancel"))).toBe(false);
    expect((await db.getMessages(cid)).at(-1)?.metadata.feishuStatus).toBe("cancelled");
  });
  it("marks crashed work unknown and never replays it",async () => {
    const cid=await bind("crash"); const pending=job("crash"); await repo.enqueue(pending);
    const running=(await repo.claim())!;
    await db.pool.query("UPDATE feishu_inbox SET started_at=now()-interval '36 minutes' WHERE message_id=$1",[running.message_id]);
    expect(await repo.claim()).toBeNull();
    expect((await db.getMessages(cid)).at(-1)?.metadata.feishuStatus).toBe("unknown");
    expect((await db.pool.query("SELECT active_run_id FROM conversations WHERE id=$1",[cid])).rows[0].active_run_id).toBeNull();
    await repo.recordResult(running,"late stale worker","completed");
    expect((await db.getMessages(cid)).at(-1)?.content).toContain("不会自动重试");
  });
});
