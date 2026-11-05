import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digitalEmployeeMetrics } from "../admin/metrics.js";
import { SecretBox } from "../auth/secret-box.js";
import { DB } from "../db/database.js";
import { runMigrations } from "../db/migration-runner.js";
import { migrations } from "../db/migrations/index.js";
import { DigitalEmployeeService } from "./service.js";

// Explicit opt-in; never use DATABASE_URL or the application's configured database.
const testUrl = process.env.DIGITAL_EMPLOYEE_TEST_DATABASE_URL;

describe.skipIf(!testUrl)("digital employee proposals on PostgreSQL", () => {
  let db: DB;
  let service: DigitalEmployeeService;
  const owner = "de-owner";
  const stranger = "de-stranger";
  let profileId: string;

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!/^\/lot_de_test_[a-z0-9_]+$/.test(url.pathname)) throw new Error("Requires a dedicated lot_de_test_* database");
    db = new DB({
      host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password), database: url.pathname.slice(1),
    }, new SecretBox(undefined));
    const { rows } = await db.pool.query("SELECT to_regclass('public.conversations') AS existing");
    if (rows[0].existing) throw new Error("Test database must be empty; refusing to modify existing data");
    await runMigrations(db.pool, migrations);
    service = new DigitalEmployeeService(db, new SecretBox(undefined));
    profileId = (await service.createProfile(owner, { displayName: "李静" })).profile.id;
  });
  afterAll(async () => { await db?.pool.end(); });

  const conversationWith = (metadata: Record<string, unknown>) => db.createConversation(
    randomUUID(), "对话", undefined, undefined, "digital_employee", owner, metadata
  );
  const scheduledAt = "2026-11-06T02:00:00.000Z";
  const prepareFollowUp = (title: string) => service.opportunities.prepareFollowUpAction(owner, {
    operation: "create", profileId, opportunityType: "prospect_progress", title, objective: "确认代销门槛", priority: "normal", scheduledAt,
  }, {});
  const taskCount = async (title: string) => Number((await db.pool.query(
    "SELECT count(*) FROM de_follow_up_tasks WHERE user_id=$1 AND title=$2", [owner, title]
  )).rows[0].count);

  it("confirms from the today page once, even when two requests race", async () => {
    const draft = await prepareFollowUp("并发确认");
    const results = await Promise.allSettled([service.proposals.confirm(owner, draft.id), service.proposals.confirm(owner, draft.id)]);
    expect(await taskCount("并发确认")).toBe(1);
    expect(results.filter((result) => result.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    for (const result of results) {
      if (result.status === "rejected") expect((result.reason as Error).message).toContain("正在处理");
    }
    await expect(service.proposals.confirm(owner, draft.id)).resolves.toMatchObject({ alreadyApplied: true });
    expect(await taskCount("并发确认")).toBe(1);
  });

  it("does not write again when the chat confirms after the today page", async () => {
    const draft = await prepareFollowUp("回到对话再点");
    await service.proposals.confirm(owner, draft.id);
    await expect(service.opportunities.commitFollowUpAction(owner, draft.id)).resolves.toMatchObject({ alreadyApplied: true });
    expect(await taskCount("回到对话再点")).toBe(1);
  });

  it("keeps a dismissed draft dismissed in the chat too", async () => {
    const draft = await prepareFollowUp("放弃");
    await expect(service.proposals.dismiss(owner, draft.id)).resolves.toEqual({ id: draft.id, status: "dismissed" });
    await expect(service.proposals.dismiss(owner, draft.id)).resolves.toEqual({ id: draft.id, status: "dismissed" });
    await expect(service.opportunities.commitFollowUpAction(owner, draft.id)).rejects.toThrow("失效");
    await expect(service.proposals.confirm(owner, draft.id)).rejects.toThrow("失效");
    expect(await taskCount("放弃")).toBe(0);
  });

  it("gives the claim back after a failed commit, so a retry works", async () => {
    const draft = await prepareFollowUp("重试");
    await db.pool.query(
      `UPDATE de_conversation_action_drafts SET payload = jsonb_set(payload, '{profileId}', to_jsonb($2::text)) WHERE id=$1`,
      [draft.id, randomUUID()]
    );
    await expect(service.proposals.confirm(owner, draft.id)).rejects.toThrow();
    await db.pool.query(
      `UPDATE de_conversation_action_drafts SET payload = jsonb_set(payload, '{profileId}', to_jsonb($2::text)) WHERE id=$1`,
      [draft.id, profileId]
    );
    await expect(service.proposals.confirm(owner, draft.id)).resolves.toMatchObject({ alreadyApplied: false });
    expect(await taskCount("重试")).toBe(1);
  });

  it("keeps each account's proposals to itself", async () => {
    const draft = await prepareFollowUp("隔离");
    await expect(service.proposals.confirm(stranger, draft.id)).rejects.toThrow("未找到");
    await expect(service.proposals.dismiss(stranger, draft.id)).rejects.toThrow("未找到");
    expect((await service.today.get(stranger)).items).toEqual([]);
    const today = await service.today.get(owner);
    expect(today.items.find((item) => item.source.id === draft.id)).toMatchObject({
      kind: "proposal", subject: { type: "customer", id: profileId, label: "李静" },
    });
    await service.proposals.dismiss(owner, draft.id);
  });

  it("dismisses customer records and profile changes in their own tables", async () => {
    const capture = await service.prepareCustomerCapture(owner, {
      customerMention: "没建档的客户", eventType: "requirement",
    } as never, { sourceText: "没建档的客户想了解价格", conversationId: undefined });
    const change = await service.prepareProfileChange(owner, {
      operation: "update", customerMention: "李静", displayName: "李静静",
    } as never, {});
    const pending = await service.proposals.listPending(owner);
    expect(pending.filter((item) => !item.confirmable).map((item) => item.id).sort()).toEqual([capture.draftId, change.draftId].sort());
    await expect(service.proposals.confirm(owner, capture.draftId)).rejects.toThrow("对话里选择");
    await service.proposals.dismiss(owner, capture.draftId);
    await service.proposals.dismiss(owner, change.draftId);
    await expect(service.commitProfileChange(owner, { draftId: change.draftId, confirm: true })).rejects.toThrow("失效");
    await expect(service.commitCustomerCapture(owner, { draftId: capture.draftId, createProfile: {} })).rejects.toThrow("不能提交");
    expect(await service.proposals.listPending(owner)).toEqual([]);
  });

  it("stores the employee's settings per account with a version check", async () => {
    const saved = await service.settings.save(owner, { employeeName: "阿灵", feishuReminder: false, desktopReminder: false, version: 0 });
    expect(saved).toMatchObject({ employeeName: "阿灵", version: 1 });
    await expect(service.settings.save(owner, { ...saved, employeeName: "别的", version: 0 })).rejects.toThrow("刷新");
    await expect(service.settings.save(owner, { ...saved, employeeName: "二灵" })).resolves.toMatchObject({ version: 2 });
    await expect(service.settings.get(stranger)).resolves.toMatchObject({ employeeName: "小灵", version: 0 });
    expect((await service.today.get(owner)).employee.name).toBe("二灵");
  });

  it("follows one object per conversation and checks who owns it", async () => {
    const conversation = await conversationWith({ digitalEmployeeFeatureScope: "employee" });
    await expect(service.setConversationFocus(owner, conversation.id, { type: "customer", id: profileId })).resolves.toEqual({
      type: "customer", id: profileId, label: "李静",
    });
    await expect(db.getConversationCustomerContext(conversation.id, owner)).resolves.toEqual({ id: profileId, displayName: "李静" });
    await expect(service.setConversationFocus(stranger, conversation.id, { type: "customer", id: profileId })).rejects.toThrow();
    await expect(service.setConversationFocus(owner, conversation.id, { type: "customer", id: randomUUID() })).rejects.toThrow("未找到");
    await service.clearCurrentProfile(owner, conversation.id);
    await expect(db.getConversationCustomerContext(conversation.id, owner)).resolves.toBeNull();
  });

  it("reads an older conversation's customer and replaces the field on the next write", async () => {
    const conversation = await conversationWith({
      digitalEmployeeFeatureScope: "employee", digitalEmployeeCurrentProfile: { id: profileId, displayName: "李静" },
    });
    await expect(db.getConversationCustomerContext(conversation.id, owner)).resolves.toEqual({ id: profileId, displayName: "李静" });
    await db.setConversationFocus(conversation.id, owner, { type: "campaign", id: randomUUID(), label: "双十一" });
    const stored = await db.getConversation(conversation.id);
    expect(stored?.metadata).not.toHaveProperty("digitalEmployeeCurrentProfile");
    await expect(db.getConversationCustomerContext(conversation.id, owner)).resolves.toBeNull();
  });

  it("refuses to change the object of a module conversation", async () => {
    const conversation = await conversationWith({ digitalEmployeeFeatureScope: "customer-profile" });
    await expect(service.setConversationFocus(owner, conversation.id, { type: "customer", id: profileId })).rejects.toThrow("不能切换");
  });

  it("reports the three adoption numbers", async () => {
    const metrics = await digitalEmployeeMetrics(db.pool, 24);
    expect(metrics.employeeInitiated).toEqual({ employee: 0, total: expect.any(Number), share: 0 });
    expect(metrics.proposalsHandled.handled).toBeGreaterThan(0);
    expect(metrics.proposalsHandled.rate).toBeLessThanOrEqual(1);
    expect(metrics.resultsFilled).toEqual({ filled: 0, executed: 0, rate: null });
  });
});
