import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SecretBox } from "../auth/secret-box.js";
import { DB } from "../db/database.js";
import { runMigrations } from "../db/migration-runner.js";
import { migrations } from "../db/migrations/index.js";
import { createDailyScanFollowUp, deliverBriefs } from "./jobs.js";
import { OpportunityService } from "./opportunity-service.js";
import { DigitalEmployeeService } from "./service.js";

// Explicit opt-in; never use DATABASE_URL or the application's configured database.
const testUrl = process.env.DIGITAL_EMPLOYEE_SCAN_TEST_DATABASE_URL;

describe.skipIf(!testUrl)("digital employee daily scan on PostgreSQL", () => {
  let db: DB;
  let service: DigitalEmployeeService;
  const owner = "scan-owner";
  let profileId: string;

  const settingsRow = async (userId: string) => (await db.pool.query(
    "SELECT enabled, discovery_mode, next_run_at FROM de_follow_up_automation_settings WHERE user_id=$1", [userId]
  )).rows[0];

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!/^\/lot_de_scan_test_[a-z0-9_]+$/.test(url.pathname)) throw new Error("Requires a dedicated lot_de_scan_test_* database");
    db = new DB({
      host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password), database: url.pathname.slice(1),
    }, new SecretBox(undefined));
    const { rows } = await db.pool.query("SELECT to_regclass('public.conversations') AS existing");
    if (rows[0].existing) throw new Error("Test database must be empty; refusing to modify existing data");
    await runMigrations(db.pool, migrations.filter((migration) => migration.version < 70));
    await db.pool.query(
      `INSERT INTO de_follow_up_automation_settings (user_id, enabled, next_run_at)
       VALUES ('opted-in', true, now()), ('turned-off', false, NULL)`
    );
    await runMigrations(db.pool, migrations);
    service = new DigitalEmployeeService(db, new SecretBox(undefined));
    profileId = (await service.createProfile(owner, { displayName: "李静", relationshipStage: "customer" })).profile.id;
    await service.createProfile("turned-off", { displayName: "王总" });
  });
  afterAll(async () => { await db?.pool.end(); });

  it("keeps the model step for accounts that opted in, and nothing else changes", async () => {
    await expect(settingsRow("opted-in")).resolves.toMatchObject({ enabled: true, discovery_mode: "hybrid" });
    await expect(settingsRow("turned-off")).resolves.toMatchObject({ enabled: false, discovery_mode: "rules" });
  });

  it("switches on accounts with customers and leaves a turned-off account alone", async () => {
    await service.opportunities.ensureScanSettings();
    const added = await settingsRow(owner);
    expect(added).toMatchObject({ enabled: true, discovery_mode: "rules" });
    expect(added.next_run_at).toBeInstanceOf(Date);
    await expect(settingsRow("turned-off")).resolves.toMatchObject({ enabled: false });
    await expect(settingsRow("nobody")).resolves.toBeUndefined();
  });

  function queued() {
    const enqueue = vi.fn(async () => randomUUID());
    return { enqueue, opportunities: new OpportunityService(db, { enqueue } as never) };
  }
  const makeDue = () => db.pool.query("UPDATE de_follow_up_automation_settings SET next_run_at=now() - interval '1 minute' WHERE enabled=true");
  const scanned = (enqueue: ReturnType<typeof queued>["enqueue"]) => (enqueue.mock.calls as unknown[][]).map((call) => [call[2], call[1]]);

  it("queues only hybrid accounts while the scan is off", async () => {
    await makeDue();
    const { enqueue, opportunities } = queued();
    await opportunities.enqueueDueDiscoveries(new Date("2026-11-10T01:00:00Z"), false);
    expect(scanned(enqueue)).toEqual([["opted-in", expect.objectContaining({ useModel: true, daily: false })]]);
  });

  it("queues rules accounts without the model, and never a turned-off one", async () => {
    await db.pool.query("DELETE FROM de_follow_up_suggestion_runs");
    await makeDue();
    const { enqueue, opportunities } = queued();
    await opportunities.enqueueDueDiscoveries(new Date(Date.now() + 86_400_000), true);
    expect(Object.fromEntries(scanned(enqueue))).toEqual({
      "opted-in": expect.objectContaining({ useModel: true, daily: true }),
      [owner]: expect.objectContaining({ useModel: false, daily: true }),
    });
  });

  it("stops queueing once the owner turns the scan off", async () => {
    const current = await service.opportunities.getSettings(owner);
    vi.stubEnv("DIGITAL_EMPLOYEE_WORKSPACE", "1");
    vi.stubEnv("DIGITAL_EMPLOYEE_DAILY_SCAN", "1");
    await service.opportunities.saveSettings(owner, { ...current, enabled: false, discoveryMode: "rules" });
    await makeDue();
    const { enqueue, opportunities } = queued();
    await opportunities.enqueueDueDiscoveries(new Date(Date.now() + 2 * 86_400_000), true);
    expect(scanned(enqueue).map(([userId]) => userId)).not.toContain(owner);
    await expect(service.opportunities.getSettings(owner)).resolves.toMatchObject({ enabled: false, nextRunAt: null });
    await service.opportunities.saveSettings(owner, { ...current, version: current.version + 1, enabled: true, discoveryMode: "rules" });
    vi.unstubAllEnvs();
  });

  it("finds work without any model and writes one brief a day", async () => {
    await service.marketingMaterials.createProduct(owner, { name: "代销方案", positioning: "低门槛", coreValues: ["起步低"] } as never);
    await db.pool.query(`UPDATE de_customer_profiles SET last_contact_at=now() - interval '45 days' WHERE id=$1`, [profileId]);
    const runId = randomUUID();
    await db.pool.query(
      `INSERT INTO de_follow_up_suggestion_runs (id, user_id, idempotency_key, scan_date, prompt_version, status)
       VALUES ($1,$2,$3,'2026-11-09','opportunity-rules/v1','pending')`,
      [runId, owner, `daily:${runId}`]
    );
    const enhance = vi.fn();
    const opportunities = new OpportunityService(db, undefined, { enhance } as never);
    const result = await opportunities.runDiscovery(owner, runId, undefined, { useModel: false });
    expect(result).toMatchObject({ status: "succeeded", discoveryMethod: "rules" });
    expect(result.created).toBeGreaterThan(0);
    expect(enhance).not.toHaveBeenCalled();

    const followUp = createDailyScanFollowUp(db, opportunities);
    await followUp(owner, { scanned: 1, created: result.created ?? 0 });
    await followUp(owner, { scanned: 99, created: 99 });
    const { rows } = await db.pool.query("SELECT counts, item_refs FROM de_employee_briefs WHERE user_id=$1", [owner]);
    expect(rows).toHaveLength(1);
    expect(rows[0].counts).toMatchObject({ scanned: 1, created: result.created });
    expect(rows[0].counts.pending).toBeGreaterThan(0);
    expect(rows[0].item_refs.length).toBe(rows[0].counts.pending);

    const today = await service.today.get(owner);
    expect(today.brief?.counts.scanned).toBe(1);
    expect(today.items.some((item) => item.kind === "recommendation")).toBe(true);
    await expect(service.today.summary(owner)).resolves.toMatchObject({ pending: today.items.length });
  });

  it("does not bring back ignored proposals the next morning", async () => {
    const before = await service.customerAcquisition.listRecommendations(owner, "pending");
    await service.customerAcquisition.updateRecommendation(owner, before.items[0].id, "ignored");
    await expect(service.customerAcquisition.seedRuleRecommendations(owner)).resolves.toBe(false);
    const after = await service.customerAcquisition.listRecommendations(owner, "pending");
    expect(after.items.map((item) => item.id)).not.toContain(before.items[0].id);
  });

  it("marks the brief read for its owner only", async () => {
    const brief = await service.briefs.latest(owner);
    await service.briefs.markRead("someone-else", brief!.id);
    await expect(service.briefs.latest(owner)).resolves.toMatchObject({ readAt: null });
    await service.briefs.markRead(owner, brief!.id);
    expect((await service.briefs.latest(owner))?.readAt).toEqual(expect.any(String));
  });

  it("sends Feishu once, to the account that asked for it", async () => {
    vi.stubEnv("DIGITAL_EMPLOYEE_WORKSPACE", "1");
    vi.stubEnv("DIGITAL_EMPLOYEE_DAILY_SCAN", "1");
    const sendToOwner = vi.fn(async () => undefined);
    await deliverBriefs(service, { sendToOwner, english: false });
    expect(sendToOwner).not.toHaveBeenCalled();

    await service.settings.save(owner, { employeeName: "小灵", feishuReminder: true, desktopReminder: false, version: 0 });
    await Promise.all([deliverBriefs(service, { sendToOwner, english: false }), deliverBriefs(service, { sendToOwner, english: false })]);
    await deliverBriefs(service, { sendToOwner, english: false });
    expect(sendToOwner).toHaveBeenCalledOnce();
    expect(sendToOwner).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ requestId: expect.stringMatching(/^employee-brief:scan-owner:\d{4}-\d{2}-\d{2}$/) })
    );
    const { rows } = await db.pool.query("SELECT delivered_at FROM de_employee_briefs WHERE user_id=$1", [owner]);
    expect(rows[0].delivered_at).toBeInstanceOf(Date);
    vi.unstubAllEnvs();
  });

  it("asks how a publication went after three days, until the owner answers", async () => {
    const asset = await db.pool.query(
      `INSERT INTO de_marketing_asset_library (id,user_id,asset_type,title,source,generation_status,status)
       VALUES ($1,$2,'text','双十一文案','workspace','ready','ready') RETURNING id`,
      [randomUUID(), owner]
    );
    const assetId = asset.rows[0].id;
    const recent = await service.customerAcquisition.saveDeployment(owner, assetId, { platform: "moments", status: "deployed", deployedAt: new Date().toISOString() });
    expect(await service.customerAcquisition.listDeploymentsAwaitingFeedback(owner)).toEqual([]);
    await db.pool.query("UPDATE de_asset_deployments SET deployed_at=now() - interval '4 days' WHERE id=$1", [recent.id]);
    await expect(service.customerAcquisition.listDeploymentsAwaitingFeedback("someone-else")).resolves.toEqual([]);
    const today = await service.today.get(owner);
    expect(today.items.find((item) => item.source.id === recent.id)).toMatchObject({ kind: "result", subject: { type: "asset", label: "双十一文案" } });
    await service.customerAcquisition.addFeedback(owner, recent.id, { impressions: 10, feedbackText: "" });
    expect((await service.today.get(owner)).items.some((item) => item.source.id === recent.id)).toBe(false);
  });
});
