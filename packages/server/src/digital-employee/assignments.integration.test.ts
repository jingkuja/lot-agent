import { randomUUID } from "node:crypto";
import type { AgentEvent, RunStatus } from "@lot-agent/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SecretBox } from "../auth/secret-box.js";
import { DB } from "../db/database.js";
import { runMigrations } from "../db/migration-runner.js";
import { migrations } from "../db/migrations/index.js";
import { RunRepository } from "../services/run-repository.js";
import { createFinishTaskTool, countedWebSearch } from "./assignment-tools.js";
import { AssignmentRunner, type AssignmentRunnerPorts, type AssignmentTurnInput } from "./assignment-runner.js";
import { InputError, ConflictError, NotFoundError, UnverifiedOperationsError } from "./errors.js";
import { DIGITAL_EMPLOYEE_LLM_UNAVAILABLE } from "./llm.js";
import type { ImportModelProduct } from "./product-import.js";
import { ProposalService } from "./proposal-service.js";
import { DigitalEmployeeService } from "./service.js";

// Explicit opt-in; never use DATABASE_URL or the application's configured database.
const testUrl = process.env.DIGITAL_EMPLOYEE_ASSIGNMENT_TEST_DATABASE_URL;

const done = (status: RunStatus): AgentEvent => ({
  type: "done", status, iterations: 1, totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedPromptTokens: 0,
});

describe.skipIf(!testUrl)("task dispatch on PostgreSQL", () => {
  let db: DB;
  let service: DigitalEmployeeService;
  const owner = () => `owner-${randomUUID()}`;
  const models = vi.fn(async () => ["kimi-k3.1-pro", "deepseek-v4.1-flash"]);
  const assignments = () => service.assignments;
  const repository = () => assignments().repository;
  const create = (userId: string, goal = "写开业活动", creditLimit: number | null = null) =>
    assignments().create(userId, { goal, mode: "autonomous", attachments: [], modelId: null, creditLimit });
  const raw = async (id: string) => (await db.pool.query(`SELECT * FROM de_assignments WHERE id=$1`, [id])).rows[0];
  /** Claimed ones are drained, so one test's queue cannot run another's task. */
  const clearQueue = () => db.pool.query(`UPDATE de_assignments SET status='cancelled' WHERE status IN ('queued', 'running')`);

  let script: Array<(input: AssignmentTurnInput) => AsyncIterable<AgentEvent>>;
  const inputs: AssignmentTurnInput[] = [];
  const sent: Array<{ userId: string; text: string }> = [];
  const held = new Set<string>();

  const ports: AssignmentRunnerPorts = {
    claimConversation: async (conversationId, runId) => db.claimConversationRun(conversationId, runId, 55_000),
    renewConversation: async (conversationId, runId) => db.renewConversationRun(conversationId, runId),
    releaseConversation: async (conversationId, runId) => db.releaseConversationRun(conversationId, runId),
    async *stream(input) {
      inputs.push(input);
      const runs = new RunRepository(db.pool);
      const message = randomUUID();
      await db.addMessage(message, input.conversationId, "user", input.message);
      await runs.begin(input.runId, input.conversationId, input.userId, message, input.message);
      let status: RunStatus = "failed";
      try {
        for await (const event of script.shift()!(input)) {
          if (event.type === "done") status = event.status ?? "completed";
          yield event;
        }
      } finally {
        await runs.finish(input.runId, status, { totalTokens: 100, totalCost: 0.01 });
      }
    },
    generateTitle: async () => "开业活动方案",
    employeeName: async () => "小灵",
    sendToOwner: async (userId, message) => {
      sent.push({ userId, text: message.text });
      return { messageId: `om_${sent.length}` };
    },
    english: false,
  };
  const runner = () => new AssignmentRunner(repository(), ports);
  const turn = async () => { const r = runner(); await r.pump(); await r.settled(); return r; };
  const finish = (summary = "写好了", outcome: "done" | "blocked" = "done") => async function* (input: AssignmentTurnInput): AsyncIterable<AgentEvent> {
    await createFinishTaskTool(repository()).execute({ outcome, summary, assumptions: ["按七折算"] }, {
      workingDirectory: "/", conversationId: input.conversationId, userId: input.userId,
    });
    yield { type: "tool_result", toolCallId: "1", name: "finish_task", output: "ok", isError: false };
    yield done("awaiting_input");
  };
  const ending = (status: RunStatus, events: AgentEvent[] = []) => async function* (): AsyncIterable<AgentEvent> {
    yield* events;
    yield done(status);
  };

  beforeAll(async () => {
    process.env.DIGITAL_EMPLOYEE_ASSIGNMENTS = "1";
    const url = new URL(testUrl!);
    if (!/^\/lot_de_assignment_test_[a-z0-9_]+$/.test(url.pathname)) throw new Error("Requires a dedicated lot_de_assignment_test_* database");
    db = new DB({
      host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password), database: url.pathname.slice(1),
    }, new SecretBox(undefined));
    const { rows } = await db.pool.query("SELECT to_regclass('public.conversations') AS existing");
    if (rows[0].existing) throw new Error("Test database must be empty; refusing to modify existing data");
    await runMigrations(db.pool, migrations);
    service = new DigitalEmployeeService(db, new SecretBox(undefined), undefined, { enqueue: async () => "task" } as any, undefined, {
      modelResolver: { get: async () => ({ llmModels: (await models()).map((id) => ({ id, label: id })) }) } as any,
    });
  });
  beforeEach(async () => {
    script = []; inputs.length = 0; sent.length = 0; held.clear();
    await clearQueue();
    await db.pool.query(`UPDATE de_assignment_events SET feishu_claimed_at=now() WHERE feishu_claimed_at IS NULL`);
  });
  afterEach(() => expect(script).toEqual([]));
  afterAll(async () => { await db?.pool.end(); });

  describe("creating a task", () => {
    it("defaults to the task model and hides its conversation from chat lists", async () => {
      const userId = owner();
      const task = await create(userId, "第一行是目标\n第二行");
      expect(task).toMatchObject({ title: "第一行是目标", status: "queued", mode: "autonomous", modelId: "kimi-k3.1-pro", creditsUsed: 0 });
      script.push(finish());
      await turn();
      expect(await db.listConversations(userId, { agentId: "digital_employee" })).toEqual([]);
    });

    it("falls back to the cheap model, and honours a model the account really has", async () => {
      const userId = owner();
      models.mockResolvedValueOnce(["deepseek-v4.1-flash", "claude-opus-5-5"]);
      expect((await create(userId)).modelId).toBe("deepseek-v4.1-flash");
      expect((await assignments().create(userId, { goal: "x", mode: "autonomous", attachments: [], modelId: "deepseek-v4.1-flash", creditLimit: null })).modelId).toBe("deepseek-v4.1-flash");
      expect((await assignments().create(userId, { goal: "x", mode: "autonomous", attachments: [], modelId: "not-a-model", creditLimit: null })).modelId).toBe("kimi-k3.1-pro");
    });

    it("says so when the account has no model", async () => {
      models.mockResolvedValueOnce([]);
      await expect(create(owner())).rejects.toBeInstanceOf(InputError);
    });

    it("takes attachment details from the owner's asset, and refuses someone else's", async () => {
      const userId = owner();
      const id = randomUUID();
      await db.createAsset({ id, taskId: null, userId, type: "upload", storageKey: `${id}.pdf`, url: `/static/uploads/${id}.pdf`, mime: "application/pdf", sizeBytes: 10, originalName: "手册.pdf" });
      const task = await assignments().create(userId, { goal: "", mode: "autonomous", attachments: [{ assetId: id, filename: "手册.pdf" }], modelId: null, creditLimit: null });
      expect(task).toMatchObject({ title: "手册.pdf", goal: "手册.pdf", attachments: ["手册.pdf"] });
      await expect(assignments().create(owner(), { goal: "x", mode: "autonomous", attachments: [{ assetId: id, filename: "手册.pdf" }], modelId: null, creditLimit: null }))
        .rejects.toBeInstanceOf(NotFoundError);
      script.push(finish());
      await turn();
      expect(inputs[0]!.attachments).toMatchObject([{ assetId: id, mime: "application/pdf", url: `/static/uploads/${id}.pdf` }]);
    });
  });

  describe("claiming", () => {
    it("gives a node to one claimant", async () => {
      await create(owner());
      const claims = await Promise.all(Array.from({ length: 8 }, () => repository().claim(8)));
      expect(claims.filter(Boolean)).toHaveLength(1);
    });

    it("keeps one account to its running limit without holding up another", async () => {
      const busy = owner();
      await create(busy); await create(busy); await create(busy);
      expect(await repository().claim(2)).not.toBeNull();
      expect(await repository().claim(2)).not.toBeNull();
      expect(await repository().claim(2)).toBeNull();
      const other = owner();
      await create(other);
      expect((await repository().claim(2))?.userId).toBe(other);
    });

    it("gives the node back if the conversation is still held by a dying run", async () => {
      const userId = owner();
      const task = await create(userId);
      const conversation = (await raw(task.id)).conversation_id;
      await db.claimConversationRun(conversation, randomUUID(), 55_000);
      await turn();
      const row = await raw(task.id);
      expect(row.status).toBe("queued");
      expect(row.not_before.getTime()).toBeGreaterThan(Date.now());
      expect(await repository().claim(8)).toBeNull();
    });
  });

  describe("how a turn ends", () => {
    it("finishes from finish_task, keeps the result and notifies once", async () => {
      const userId = owner();
      const task = await create(userId);
      script.push(finish("方案写好了"));
      const r = await turn();
      expect(await assignments().get(userId, task.id)).toMatchObject({
        status: "succeeded", title: "开业活动方案", creditsUsed: 1,
        result: { summary: "方案写好了", assumptions: ["按七折算"], skipped: [] },
      });
      expect(inputs[0]).toMatchObject({ message: "写开业活动", modelId: "kimi-k3.1-pro" });
      await r.deliver(); await r.deliver();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ userId });
      expect(sent[0]!.text).toContain("小灵做完了");
      expect(sent[0]!.text).toContain("方案写好了");
    });

    it("accepts a turn that ended with a plain answer", async () => {
      const userId = owner();
      const task = await create(userId);
      script.push(ending("completed", [{ type: "text", content: "前面的话" }, { type: "tool_call", id: "1", name: "x", input: {} }, { type: "text", content: "最终答复" }]));
      await turn();
      expect(await assignments().get(userId, task.id)).toMatchObject({ status: "succeeded", result: { summary: "最终答复" } });
    });

    it("fails a blocked task, says why, and lets the owner retry in the same conversation", async () => {
      const userId = owner();
      const task = await create(userId);
      script.push(finish("缺少门店地址", "blocked"));
      const r = await turn();
      expect(await assignments().get(userId, task.id)).toMatchObject({ status: "failed", failureReason: "blocked", result: { summary: "缺少门店地址" } });
      await r.deliver();
      expect(sent[0]!.text).toContain("没能完成");

      await assignments().retry(userId, task.id);
      script.push(finish("补齐了"));
      await turn();
      expect(await assignments().get(userId, task.id)).toMatchObject({ status: "succeeded", failureReason: null, result: { summary: "补齐了" } });
      expect(inputs[1]!.message).toContain("[Task continuation]");
      await expect(assignments().retry(userId, task.id)).rejects.toBeInstanceOf(ConflictError);
    });

    it("does not resend a failed call on its own", async () => {
      const userId = owner();
      const task = await create(userId);
      script.push(ending("failed", [{ type: "error", message: "LLM error" }]));
      await turn(); await turn();
      expect(inputs).toHaveLength(1);
      expect((await raw(task.id)).failure_reason).toBe("model_failed");
    });

    it("reports an unconfirmed write", async () => {
      const userId = owner();
      const task = await create(userId);
      script.push(ending("unknown_outcome"));
      const r = await turn();
      expect((await raw(task.id)).failure_reason).toBe("unknown_outcome");
      await r.deliver();
      expect(sent[0]!.text).toContain("核实");
    });

    it("continues in a new segment with no notification", async () => {
      const userId = owner();
      const task = await create(userId);
      script.push(ending("budget_exhausted", [{ type: "tool_result", toolCallId: "1", name: "web_search", output: "ok", isError: false }]));
      const r = await turn();
      expect((await raw(task.id)).status).toBe("queued");
      script.push(finish());
      await turn();
      expect(inputs).toHaveLength(2);
      expect(inputs[1]!.attachments).toEqual([]);
      expect((await raw(task.id)).status).toBe("succeeded");
      expect(await assignments().get(userId, task.id)).toMatchObject({ creditsUsed: 2 });
      await r.deliver();
      expect(sent).toHaveLength(1);
    });

    it("gives up after two segments with nothing new", async () => {
      const task = await create(owner());
      script.push(ending("budget_exhausted"));
      await turn();
      script.push(ending("budget_exhausted"));
      await turn();
      expect(await raw(task.id)).toMatchObject({ status: "failed", failure_reason: "stalled" });
    });
  });

  describe("pausing", () => {
    it("pauses on a quota error, keeps the task, and continues after a top-up", async () => {
      const userId = owner();
      const task = await create(userId);
      script.push(ending("failed", [{ type: "error", message: "额度不足", code: "quota" }]));
      await turn();
      expect(await assignments().get(userId, task.id)).toMatchObject({ status: "queued", pausedReason: "quota", failureReason: null });
      await turn();
      expect(inputs).toHaveLength(1);

      await assignments().resume(userId, task.id);
      script.push(finish());
      await turn();
      expect(inputs[1]!.message).toContain("[Task continuation]");
      expect((await raw(task.id)).status).toBe("succeeded");
    });

    it("pauses when an exhausted key fails before the first model call", async () => {
      const userId = owner();
      const task = await create(userId);
      script.push(async function* (): AsyncIterable<AgentEvent> { throw new Error(DIGITAL_EMPLOYEE_LLM_UNAVAILABLE); });
      await turn();
      expect(await assignments().get(userId, task.id)).toMatchObject({ status: "queued", pausedReason: "quota", failureReason: null });
    });

    it("pauses when a paid tool reports the account cannot pay", async () => {
      const userId = owner();
      const task = await create(userId);
      script.push(async function* (input) {
        yield { type: "tool_result", toolCallId: "1", name: "generate_campaign_poster", output: "余额不足", isError: true, errorKind: "quota" };
        expect(await input.beforeIteration({ tokens: 10, cost: 0 })).toEqual({ stop: true });
        yield done("budget_exhausted");
      });
      await turn();
      expect(await assignments().get(userId, task.id)).toMatchObject({ status: "queued", pausedReason: "quota" });
    });

    it("merges quota notices across tasks within a day", async () => {
      const userId = owner();
      const first = await create(userId, "一");
      const second = await create(userId, "二");
      await repository().pause(first.id, "quota");
      await repository().pause(second.id, "quota");
      await repository().pause(second.id, "quota");
      const r = runner();
      await db.pool.query(`UPDATE de_assignment_events SET created_at=now() - interval '1 minute' WHERE user_id=$1`, [userId]);
      await r.deliver();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toContain("2 个任务");

      await assignments().resume(userId, second.id);
      await repository().pause(second.id, "quota");
      await db.pool.query(`UPDATE de_assignment_events SET created_at=now() - interval '1 minute' WHERE user_id=$1`, [userId]);
      await r.deliver();
      expect(sent).toHaveLength(1);
    });

    it("stops at the owner's cost limit, and only continues with more room", async () => {
      const userId = owner();
      const task = await create(userId, "写开业活动", 50);
      script.push(async function* (input) {
        expect(await input.beforeIteration({ tokens: 10, cost: 0.2 })).toBeUndefined();
        expect(await input.beforeIteration({ tokens: 20, cost: 0.6 })).toEqual({ stop: true });
        yield { type: "error", message: "Stopped before the next model call" };
        yield done("budget_exhausted");
      });
      const r = await turn();
      expect(await assignments().get(userId, task.id)).toMatchObject({ status: "queued", pausedReason: "cost_limit", creditLimit: 50, creditsUsed: 60 });
      await expect(assignments().resume(userId, task.id)).rejects.toBeInstanceOf(InputError);
      await expect(assignments().resume(userId, task.id, 40)).rejects.toBeInstanceOf(InputError);
      expect(await assignments().resume(userId, task.id, 100)).toMatchObject({ pausedReason: null, creditLimit: 100 });
      await db.pool.query(`UPDATE de_assignment_events SET created_at=now() - interval '1 minute' WHERE user_id=$1`, [userId]);
      await r.deliver();
      expect(sent[0]!.text).toContain("费用上限");
      script.push(finish());
      await turn();
    });

    it("counts the posters and videos a task ordered", async () => {
      const userId = owner();
      const task = await create(userId, "做海报", 50);
      const conversationId = (await raw(task.id)).conversation_id;
      const taskId = randomUUID();
      await db.createTask(taskId, "image.generate", { sourceConversationId: conversationId }, userId);
      await db.writeUsageLog({ userId, taskId, modelId: "m", modelType: "image", inputCount: 0, outputCount: 1, totalCost: 0.7 });
      expect(await assignments().get(userId, task.id)).toMatchObject({ creditsUsed: 70 });
      script.push(async function* (input) {
        expect(await input.beforeIteration({ tokens: 0, cost: 0 })).toEqual({ stop: true });
        yield done("budget_exhausted");
      });
      await turn();
      expect((await raw(task.id)).paused_reason).toBe("cost_limit");
    });
  });

  describe("cancelling", () => {
    it("aborts a running turn within two seconds and stays cancelled", async () => {
      const userId = owner();
      const task = await create(userId);
      let startedAt = 0;
      script.push(async function* (input) {
        await assignments().cancel(userId, task.id);
        startedAt = Date.now();
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
        yield done("cancelled");
      });
      await turn();
      expect(Date.now() - startedAt).toBeLessThan(2_500);
      expect(await raw(task.id)).toMatchObject({ status: "cancelled", lease_until: null });
      await expect(assignments().cancel(userId, task.id)).rejects.toBeInstanceOf(ConflictError);
    });

    it("cannot be cancelled by another account", async () => {
      const task = await create(owner());
      await expect(assignments().cancel(owner(), task.id)).rejects.toBeInstanceOf(NotFoundError);
      expect((await raw(task.id)).status).toBe("queued");
    });
  });

  describe("a worker dying", () => {
    const orphan = async (userId: string) => {
      const task = await create(userId);
      const node = (await repository().claim(8))!;
      const runId = randomUUID();
      await db.claimConversationRun(node.conversationId, runId, 55_000);
      const message = randomUUID();
      await db.addMessage(message, node.conversationId, "user", node.goal);
      const runs = new RunRepository(db.pool);
      await runs.begin(runId, node.conversationId, userId, message, node.goal);
      await db.pool.query(`UPDATE de_assignments SET lease_until=now() - interval '1 second' WHERE id=$1`, [task.id]);
      return { task, node, runId, runs };
    };

    it("continues a turn with nothing unconfirmed, once per node", async () => {
      const userId = owner();
      const { task, node } = await orphan(userId);
      const r = runner();
      await r.sweep();
      expect(await raw(task.id)).toMatchObject({ status: "queued", auto_resumed: true });

      script.push(ending("budget_exhausted", [{ type: "text", content: "继续" }]));
      await turn();
      await repository().claim(8);
      await db.pool.query(`UPDATE de_assignments SET lease_until=now() - interval '1 second' WHERE id=$1`, [task.id]);
      await r.sweep();
      expect(await raw(task.id)).toMatchObject({ status: "failed", failure_reason: "interrupted" });
      const { rows: [conversation] } = await db.pool.query(`SELECT active_run_id FROM conversations WHERE id=$1`, [node.conversationId]);
      expect(conversation.active_run_id).toBeNull();
      await r.deliver();
      expect(sent[0]!.text).toContain("重启");
    });

    it("never reruns a turn whose write may have gone through", async () => {
      const userId = owner();
      const { task, node, runId, runs } = await orphan(userId);
      await runs.journal(runId, node.conversationId, userId).start({ id: "call-1", name: "commit_marketing_campaign", arguments: {} }, 1, "write");
      await runner().sweep();
      expect(await raw(task.id)).toMatchObject({ status: "failed", failure_reason: "unknown_outcome" });
      expect(await repository().claim(8)).toBeNull();
    });

    it("leaves a turn with a live lease alone", async () => {
      const task = await create(owner());
      await repository().claim(8);
      await runner().sweep();
      expect((await raw(task.id)).status).toBe("running");
    });
  });

  describe("web search", () => {
    const search = (execute: () => Promise<{ content: string; isError?: boolean }>) => countedWebSearch(
      { name: "web_search", description: "", parameters: { type: "object", properties: {} }, execute }, repository(), 10,
    );

    it("never passes the limit under parallel calls, and tells the model where it stands", async () => {
      const userId = owner();
      const task = await create(userId);
      const conversationId = (await raw(task.id)).conversation_id;
      const context = { workingDirectory: "/", userId, conversationId };
      const execute = vi.fn(async () => ({ content: "结果" }));
      const results = await Promise.all(Array.from({ length: 15 }, () => search(execute).execute({}, context)));
      expect(execute).toHaveBeenCalledTimes(10);
      expect(results.filter((item) => item.isError)).toHaveLength(5);
      expect(results.find((item) => item.isError)!.content).toContain("Do not search again");
      expect(results.find((item) => !item.isError)!.content).toMatch(/\[Web searches used on this task: \d+ of 10\]/);
      expect((await raw(task.id)).web_searches).toBe(10);
    });

    it("only counts searches that worked, and keeps the count across retries", async () => {
      const userId = owner();
      const task = await create(userId);
      const conversationId = (await raw(task.id)).conversation_id;
      const context = { workingDirectory: "/", userId, conversationId };
      await search(async () => ({ content: "超时", isError: true })).execute({}, context);
      await search(async () => { throw new Error("network"); }).execute({}, context).catch(() => {});
      expect((await raw(task.id)).web_searches).toBe(0);
      await search(async () => ({ content: "ok" })).execute({}, context);
      script.push(finish("缺资料", "blocked"));
      await turn();
      await assignments().retry(userId, task.id);
      script.push(finish());
      await turn();
      expect((await raw(task.id)).web_searches).toBe(1);
    });

    it("does not touch another account's count", async () => {
      const task = await create(owner());
      const conversationId = (await raw(task.id)).conversation_id;
      const result = await search(async () => ({ content: "ok" })).execute({}, { workingDirectory: "/", userId: owner(), conversationId });
      expect(result.isError).toBe(true);
      expect((await raw(task.id)).web_searches).toBe(0);
    });
  });

  describe("saving a product file with nobody to ask", () => {
    const entry: ImportModelProduct = {
      name: "焕颜美学", suggestedName: "", existing: "", positioning: "皮肤管理", coreValues: ["科技护肤"],
      facts: [{ statement: "小气泡清洁单次 198 元" }, { statement: "预约电话 13812345678" }],
      benefits: [{ title: "新客体验价 99 元" }], objections: [], faqs: [], prohibited: [], cases: [], notes: "", questions: [],
    };

    const sorted = async (userId: string, products: ImportModelProduct[] = [entry]) => {
      const id = randomUUID();
      await db.createAsset({ id, taskId: null, userId, type: "upload", storageKey: `${id}.pdf`, url: `/static/uploads/${id}.pdf`, mime: "application/pdf", sizeBytes: 10, originalName: "手册.pdf" });
      const started = await service.productImports.start(userId, { assetId: id });
      await service.productDocuments.parse(userId, started.id, async () => ({ parserVersion: "v1", diagnostics: [], blocks: [{ text: "手册正文" }] }));
      await service.productImports.run(userId, started.id, async () => products);
      return service.productImports.get(userId, started.id);
    };

    it("saves what is selected by default and keeps the doubtful items for review", async () => {
      const userId = owner();
      const status = await sorted(userId);
      const result = await service.productImports.commitUnattended(userId, status.draftId!);
      expect(result.saved).toHaveLength(1);
      expect(result.held).toBeGreaterThan(0);
      expect(result.reviewUrl).toMatch(/^\/digital-employee\/materials\/import\//);

      const product = await service.marketingMaterials.getProduct(userId, result.entityId!);
      expect(JSON.stringify(product)).toContain("科技护肤");
      expect(JSON.stringify(product)).not.toContain("13812345678");
      expect(JSON.stringify(product)).not.toContain("99 元");

      const reviewId = result.reviewUrl!.split("/").pop()!;
      const review = await service.productImports.review(userId, reviewId);
      expect(review.draft!.products[0]).toMatchObject({ targetProductId: product.id });
      expect(review.draft!.products[0]!.items.every((item) => !item.selected)).toBe(true);
      const pending = await new ProposalService(db.pool, {} as any, {} as any).listPending(userId);
      expect(pending.filter((item) => item.kind === "product_import")).toHaveLength(1);

      const saved = await service.productImports.commit(userId, review.status.draftId!, {
        confirmItemIds: review.draft!.products[0]!.items.map((item) => item.id),
      });
      expect(saved.entityId).toBe(product.id);
      expect(JSON.stringify(await service.marketingMaterials.getProduct(userId, product.id))).toContain("99 元");
      const { rows } = await db.pool.query(
        `SELECT id FROM marketing_product_documents WHERE user_id=$1 AND product_id=$2 AND deleted_at IS NULL`, [userId, product.id]
      );
      expect(rows).toHaveLength(1);
    });

    it("keeps a task from writing held items with the ordinary product tools", async () => {
      const userId = owner();
      const conversationId = (await raw((await create(userId)).id)).conversation_id;
      const id = randomUUID();
      await db.createAsset({ id, taskId: null, userId, type: "upload", storageKey: `${id}.pdf`, url: `/static/uploads/${id}.pdf`, mime: "application/pdf", sizeBytes: 10, originalName: "手册.pdf" });
      const started = await service.productImports.start(userId, { assetId: id, conversationId });
      await service.productDocuments.parse(userId, started.id, async () => ({ parserVersion: "v1", diagnostics: [], blocks: [{ text: "手册正文" }] }));
      await service.productImports.run(userId, started.id, async () => [entry]);
      const { draftId } = await service.productImports.get(userId, started.id);
      expect(await service.productImports.itemsHeldFor(userId, conversationId)).toBe(true);

      const result = await service.productImports.commitUnattended(userId, draftId!);
      const product = result.entityId!;
      expect(await service.productImports.itemsHeldFor(userId, conversationId, product)).toBe(true);
      expect(await service.productImports.itemsHeldFor(userId, conversationId, randomUUID())).toBe(false);
      expect(await service.productImports.itemsHeldFor(owner(), conversationId, product)).toBe(false);
      expect(await service.productImports.itemsHeldFor(userId, randomUUID(), product)).toBe(false);

      const review = await service.productImports.review(userId, result.reviewUrl!.split("/").pop()!);
      await service.productImports.commit(userId, review.status.draftId!);
      expect(await service.productImports.itemsHeldFor(userId, conversationId, product)).toBe(false);
    });

    it("is safe to call twice", async () => {
      const userId = owner();
      const status = await sorted(userId);
      await service.productImports.commitUnattended(userId, status.draftId!);
      expect(await service.productImports.commitUnattended(userId, status.draftId!)).toMatchObject({ alreadyApplied: true, held: 0 });
    });

    it("creates no empty product when nothing is safe to save", async () => {
      const userId = owner();
      const onlyDoubtful = { ...entry, coreValues: [], positioning: "", facts: [{ statement: "预约电话 13812345678" }], benefits: [] };
      const status = await sorted(userId, [onlyDoubtful]);
      const result = await service.productImports.commitUnattended(userId, status.draftId!);
      expect(result).toMatchObject({ saved: [], entityId: null });
      expect(result.reviewUrl).toContain(status.id);
      expect((await service.marketingMaterials.listProducts(userId, { page: 1, limit: 10, status: "active" })).items).toEqual([]);
      expect((await service.productImports.review(userId, status.id)).draft).not.toBeNull();
    });

    it("refuses another account's draft", async () => {
      const status = await sorted(owner());
      await expect(service.productImports.commitUnattended(owner(), status.draftId!)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("listing", () => {
    const at = (id: string, time: string) => db.pool.query(`UPDATE de_assignments SET created_at=$2 WHERE id=$1`, [id, time]);

    it("filters by time, keyword and status, and pages through older days", async () => {
      const userId = owner();
      const a = await create(userId, "写开业活动");
      const b = await create(userId, "整理王总的跟进");
      const c = await create(userId, "折扣 50% 的说明");
      await at(a.id, "2026-11-01T01:00:00.000Z");
      await at(b.id, "2026-11-02T01:00:00.000Z");
      await at(c.id, "2026-11-03T01:00:00.000Z");
      await db.pool.query(`UPDATE de_assignments SET status='succeeded' WHERE id=$1`, [b.id]);

      const list = (filters: Record<string, unknown>) => assignments().list(userId, { limit: 30, ...filters });
      expect((await list({ from: "2026-11-01T12:00:00.000Z", to: "2026-11-02T12:00:00.000Z" })).items.map((item) => item.id)).toEqual([b.id]);
      expect((await list({ q: "王总" })).items.map((item) => item.id)).toEqual([b.id]);
      expect((await list({ q: "50%" })).items.map((item) => item.id)).toEqual([c.id]);
      expect((await list({ q: "%" })).items.map((item) => item.id)).toEqual([c.id]);
      expect((await list({ status: "succeeded" })).items.map((item) => item.id)).toEqual([b.id]);
      expect((await list({ status: "active" })).items.map((item) => item.id)).toEqual([c.id, a.id]);

      const first = await list({ limit: 2 });
      expect(first.items.map((item) => item.id)).toEqual([c.id, b.id]);
      const second = await list({ limit: 2, cursor: first.nextCursor });
      expect(second.items.map((item) => item.id)).toEqual([a.id]);
      expect(second.nextCursor).toBeNull();
    });

    it("carries unfinished tasks up to today, and leaves a search alone", async () => {
      const userId = owner();
      const old = await create(userId, "昨天开始的");
      const oldDone = await create(userId, "昨天做完的");
      const today = await create(userId, "今天的");
      await at(old.id, "2026-11-01T01:00:00.000Z");
      await at(oldDone.id, "2026-11-01T02:00:00.000Z");
      await at(today.id, "2026-11-03T01:00:00.000Z");
      await db.pool.query(`UPDATE de_assignments SET status='succeeded' WHERE id=$1`, [oldDone.id]);

      const page = await assignments().list(userId, { limit: 30, openBefore: "2026-11-02T16:00:00.000Z" });
      expect(page.pinned.map((item) => item.id)).toEqual([old.id]);
      expect(page.items.map((item) => item.id)).toEqual([today.id, oldDone.id]);
      const search = await assignments().list(userId, { limit: 30 });
      expect(search.pinned).toEqual([]);
      expect(search.items).toHaveLength(3);
    });

    it("matches a subtask's words and counts its progress on the parent", async () => {
      const userId = owner();
      const root = await create(userId, "总目标");
      const conversation = randomUUID();
      await db.pool.query(`INSERT INTO conversations (id, title, agent_id, user_id, status) VALUES ($1,'x','digital_employee',$2,'hidden')`, [conversation, userId]);
      await db.pool.query(
        `INSERT INTO de_assignments (user_id, root_id, position, title, goal, mode, status, conversation_id, model_id) VALUES ($1,$2,1,'子任务','查同行门店','autonomous','succeeded',$3,'m')`,
        [userId, root.id, conversation]
      );
      const page = await assignments().list(userId, { limit: 30, q: "同行" });
      expect(page.items.map((item) => item.id)).toEqual([root.id]);
      expect(page.items[0]!.subtasks).toEqual({ done: 1, total: 1 });
    });

    it("shows an account only its own tasks", async () => {
      const task = await create(owner());
      expect((await assignments().list(owner(), { limit: 30 })).items).toEqual([]);
      await expect(assignments().get(owner(), task.id)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it("refuses work when the feature is off", async () => {
    process.env.DIGITAL_EMPLOYEE_ASSIGNMENTS = "0";
    try {
      await expect(create(owner())).rejects.toBeInstanceOf(NotFoundError);
    } finally {
      process.env.DIGITAL_EMPLOYEE_ASSIGNMENTS = "1";
    }
  });

  describe("responsive tasks", () => {
    const responsive = (userId: string, goal = "给王总记跟进") =>
      assignments().create(userId, { goal, mode: "responsive", attachments: [], modelId: null, creditLimit: null });
    /** Runs the first turn to a stop, so each test starts with the owner's decision open. */
    const asking = (question = "哪位王总？", options = ["华东的", "华南的"], multiSelect = false) => async function* (): AsyncIterable<AgentEvent> {
      yield { type: "tool_call", id: "ask1", name: "ask_user", input: { question, options, multiSelect } };
      yield { type: "tool_result", toolCallId: "ask1", name: "ask_user", output: "waiting", isError: false };
      yield done("awaiting_input");
    };
    const stopAt = async (userId: string, step: (input: AssignmentTurnInput) => AsyncIterable<AgentEvent> = asking()) => {
      const task = await responsive(userId);
      script.push(step);
      await turn();
      const [decision] = await repository().openDecisions(userId, task.id);
      return { task, decision: decision! };
    };
    const decisionRow = async (id: string) => (await db.pool.query(`SELECT * FROM de_assignment_decisions WHERE id=$1`, [id])).rows[0];
    const unconfirmedStep = async (conversationId: string) => {
      const { rows: [run] } = await db.pool.query(`SELECT id FROM agent_runs WHERE conversation_id=$1 ORDER BY started_at DESC LIMIT 1`, [conversationId]);
      const id = randomUUID();
      await db.pool.query(
        `INSERT INTO agent_steps (id, run_id, iteration, tool_call_id, tool_name, effect, input, input_hash, status)
         VALUES ($1,$2,1,$3,'update_marketing_product','write','{}'::jsonb,'h','unknown_outcome')`,
        [id, run.id, randomUUID()]
      );
      return id;
    };

    it("stops at a question, costs nothing while waiting, and carries the answer into the next turn", async () => {
      const userId = owner();
      const { task, decision } = await stopAt(userId);
      expect(await raw(task.id)).toMatchObject({ status: "waiting_user", mode: "responsive" });
      expect(decision).toMatchObject({ kind: "question", question: "哪位王总？", options: ["华东的", "华南的"], rootId: task.id });
      await turn();
      expect(inputs).toHaveLength(1);

      await assignments().answer(userId, decision.id, { text: "华东的" });
      expect(await raw(task.id)).toMatchObject({ status: "queued" });
      script.push(finish());
      await turn();
      expect(inputs[1]!.message).toBe("[Owner reply]\n华东的");
      expect(await raw(task.id)).toMatchObject({ status: "succeeded", next_message: null });
      expect(await decisionRow(decision.id)).toMatchObject({ answer: "华东的", answered_via: "web" });
    });

    it("keeps the answer if the worker dies before the turn ends", async () => {
      const userId = owner();
      const { task, decision } = await stopAt(userId);
      await assignments().answer(userId, decision.id, { text: "华东的" });
      await repository().claim(8);
      await db.pool.query(`UPDATE de_assignments SET lease_until=now() - interval '1 minute' WHERE id=$1`, [task.id]);
      await repository().sweepOrphans();
      expect(await raw(task.id)).toMatchObject({ status: "queued", next_message: "[Owner reply]\n华东的" });
      script.push(finish());
      await turn();
      expect(inputs.at(-1)!.message).toBe("[Owner reply]\n华东的");
    });

    it("only lets one answer through when the web and Feishu reply together", async () => {
      const userId = owner();
      const { task, decision } = await stopAt(userId);
      await db.pool.query(`UPDATE de_assignment_decisions SET feishu_message_id='om_q' WHERE id=$1`, [decision.id]);
      const results = await Promise.allSettled([
        assignments().answer(userId, decision.id, { text: "华东的" }),
        assignments().routeReply({ userId, parentId: "om_q", text: "2" }, false),
        assignments().answer(userId, decision.id, { text: "第三种" }),
        assignments().routeReply({ userId, parentId: "om_q", text: "1" }, false),
      ]);
      const row = await decisionRow(decision.id);
      expect(["华东的", "华南的", "第三种"]).toContain(row.answer);
      const node = await raw(task.id);
      expect(node).toMatchObject({ status: "queued", next_message: `[Owner reply]\n${row.answer}` });
      expect(node.version).toBe(4);
      const refused = results.filter((item) => item.status === "rejected"
        || (typeof item.value === "string" && item.value.includes("已经决定过了")));
      expect(refused).toHaveLength(3);
      script.push(finish());
      await turn();
      expect(script).toEqual([]);
    });

    it("hands a failure to the owner instead of ending the task, and offers all four choices", async () => {
      const userId = owner();
      const { task, decision } = await stopAt(userId, ending("failed"));
      expect(await raw(task.id)).toMatchObject({ status: "waiting_user", failure_reason: "model_failed", finished_at: null });
      expect(decision).toMatchObject({ kind: "failure", options: ["retry", "skip", "change", "end"], failureReason: "model_failed" });

      await assignments().answer(userId, decision.id, { choice: "retry" });
      expect(await raw(task.id)).toMatchObject({ status: "queued", failure_reason: null });
      script.push(finish());
      await turn();
      expect(inputs.at(-1)!.message).toContain("[Owner decision] Try again");
    });

    it("passes the owner's words on when the approach changes, and takes plain words as that choice", async () => {
      const userId = owner();
      const { decision } = await stopAt(userId, finish("查不到", "blocked"));
      expect(decision.kind).toBe("failure");
      await assignments().answer(userId, decision.id, { text: "换一组关键词" });
      expect(await decisionRow(decision.id)).toMatchObject({ answer: "change: 换一组关键词" });
      script.push(finish());
      await turn();
      expect(inputs.at(-1)!.message).toContain("换一组关键词");
    });

    it("skips one node, and ending closes the whole task", async () => {
      const skipper = owner();
      const skipped = await stopAt(skipper, ending("failed"));
      await assignments().answer(skipper, skipped.decision.id, { choice: "skip" });
      expect((await raw(skipped.task.id)).status).toBe("skipped");
      expect((await raw(skipped.task.id)).finished_at).not.toBeNull();
      const { items } = await assignments().list(skipper, { status: "cancelled", limit: 10 });
      expect(items.map((item) => item.id)).toEqual([skipped.task.id]);

      const ender = owner();
      const ended = await stopAt(ender, ending("failed"));
      await assignments().answer(ender, ended.decision.id, { choice: "end" });
      expect((await raw(ended.task.id)).status).toBe("cancelled");
      expect(await repository().openDecisions(ender)).toEqual([]);
      await turn();
    });

    it("refuses to run again until the owner confirms an unverified write, on every channel", async () => {
      const userId = owner();
      const { task, decision } = await stopAt(userId, ending("unknown_outcome"));
      const conversationId = (await raw(task.id)).conversation_id;
      const operation = await unconfirmedStep(conversationId);
      await db.pool.query(`UPDATE de_assignment_decisions SET feishu_message_id='om_u' WHERE id=$1`, [decision.id]);

      await expect(assignments().answer(userId, decision.id, { choice: "retry" })).rejects.toBeInstanceOf(UnverifiedOperationsError);
      await expect(assignments().answer(userId, decision.id, { choice: "change", text: "换个写法" })).rejects.toBeInstanceOf(UnverifiedOperationsError);
      expect(await assignments().routeReply({ userId, parentId: "om_u", text: "重试" }, false)).toContain("核实");
      expect((await decisionRow(decision.id)).answered_at).toBeNull();
      expect((await raw(task.id)).status).toBe("waiting_user");
      expect((await assignments().get(userId, task.id)).decisions[0]).toMatchObject({ unverified: 1 });

      expect(await new RunRepository(db.pool).resolve(conversationId, userId, operation, "failed")).toBe(true);
      await assignments().answer(userId, decision.id, { choice: "retry" });
      expect((await raw(task.id)).status).toBe("queued");
      script.push(finish());
      await turn();
    });

    it("lets the owner walk away from an unverified write without confirming it", async () => {
      const userId = owner();
      const { task, decision } = await stopAt(userId, ending("unknown_outcome"));
      await unconfirmedStep((await raw(task.id)).conversation_id);
      await assignments().answer(userId, decision.id, { choice: "end" });
      expect((await raw(task.id)).status).toBe("cancelled");
    });

    it("applies the same check to a full-autonomy retry", async () => {
      const userId = owner();
      const task = await create(userId);
      script.push(ending("unknown_outcome"));
      await turn();
      await unconfirmedStep((await raw(task.id)).conversation_id);
      await expect(assignments().retry(userId, task.id)).rejects.toBeInstanceOf(UnverifiedOperationsError);
    });

    it("puts a lost worker's task in front of the owner by the same rule", async () => {
      const clean = owner();
      const task = await responsive(clean);
      await repository().claim(8);
      await db.pool.query(`UPDATE de_assignments SET auto_resumed=true, lease_until=now() - interval '1 minute' WHERE id=$1`, [task.id]);
      await repository().sweepOrphans();
      expect(await raw(task.id)).toMatchObject({ status: "waiting_user", failure_reason: "interrupted" });
      const [decision] = await repository().openDecisions(clean);
      expect(decision).toMatchObject({ kind: "failure", failureReason: "interrupted" });
    });

    it("does not let a stranger see or answer a decision", async () => {
      const userId = owner();
      const { task, decision } = await stopAt(userId);
      await expect(assignments().answer(owner(), decision.id, { text: "华南的" })).rejects.toBeInstanceOf(NotFoundError);
      expect(await repository().openDecisions(owner(), task.id)).toEqual([]);
      expect(await assignments().attention(owner())).toEqual([]);
      expect((await raw(task.id)).status).toBe("waiting_user");
    });

    it("rejects an answer with nothing in it, and leaves the decision open", async () => {
      const userId = owner();
      const { decision } = await stopAt(userId);
      await expect(assignments().answer(userId, decision.id, { text: "  " })).rejects.toBeInstanceOf(InputError);
      await expect(assignments().answer(userId, decision.id, { choice: "retry" })).rejects.toBeInstanceOf(InputError);
      expect((await decisionRow(decision.id)).answered_at).toBeNull();
    });

    it("cancelling closes the decision, so nothing keeps asking", async () => {
      const userId = owner();
      const { task, decision } = await stopAt(userId);
      await assignments().cancel(userId, task.id);
      expect((await decisionRow(decision.id)).answered_via).toBe("cancelled");
      expect(await assignments().attention(userId)).toEqual([]);
      await expect(assignments().answer(userId, decision.id, { text: "华东的" })).rejects.toBeInstanceOf(ConflictError);
    });

    it("counts a real answer as the owner's reply, but not a continuation", async () => {
      const userId = owner();
      const { task, decision } = await stopAt(userId);
      const conversationId = (await raw(task.id)).conversation_id;
      const draftId = randomUUID();
      await db.pool.query(
        `INSERT INTO de_conversation_action_drafts (id, user_id, conversation_id, feature_scope, kind, expires_at, created_at)
         VALUES ($1,$2,$3,'employee','product_import',now() + interval '1 day',now() - interval '1 minute')`,
        [draftId, userId, conversationId]
      );
      await db.addMessage(randomUUID(), conversationId, "user", "[Task continuation] Carry on");
      expect(await repository().ownerAnsweredSince(userId, conversationId, draftId)).toBe(false);
      await assignments().answer(userId, decision.id, { text: "保存" });
      expect(await repository().ownerAnsweredSince(userId, conversationId, draftId)).toBe(true);
      expect(await repository().ownerAnsweredSince(owner(), conversationId, draftId)).toBe(false);
      script.push(finish());
      await turn();
    });

    describe("replying on Feishu", () => {
      const reply = (userId: string, text: string, parentId?: string) => assignments().routeReply({ userId, text, parentId }, false);

      it("sends the question with its choices and keeps the message id for quoted replies", async () => {
        const userId = owner();
        const { decision } = await stopAt(userId);
        await runner().deliver();
        const notice = sent.find((item) => item.userId === userId)!;
        expect(notice.text).toContain("哪位王总？");
        expect(notice.text).toContain("1. 华东的");
        expect(notice.text).toContain("引用这条消息");
        const { feishu_message_id: messageId } = await decisionRow(decision.id);
        expect(await reply(userId, "就华东那位吧", messageId)).toBe("收到，继续执行。");
        expect((await decisionRow(decision.id)).answer).toBe("就华东那位吧");
        expect(await reply(userId, "2", messageId)).toContain("已经决定过了");
        script.push(finish());
        await turn();
      });

      it("takes an unquoted clear answer when only one decision is open", async () => {
        const userId = owner();
        const { decision } = await stopAt(userId);
        expect(await reply(userId, "今天天气不错")).toBeNull();
        expect((await decisionRow(decision.id)).answered_at).toBeNull();
        expect(await reply(userId, "第二个")).toBe("收到，继续执行。");
        expect((await decisionRow(decision.id)).answer).toBe("华南的");
        script.push(finish());
        await turn();
      });

      it("asks for a quote when several decisions could match", async () => {
        const userId = owner();
        const first = await stopAt(userId);
        const second = await stopAt(userId);
        expect(await reply(userId, "1")).toContain("引用");
        expect((await decisionRow(first.decision.id)).answered_at).toBeNull();
        expect((await decisionRow(second.decision.id)).answered_at).toBeNull();
      });

      it("does not touch the assistant's messages or another account's decisions", async () => {
        const userId = owner();
        const { decision } = await stopAt(userId);
        await db.pool.query(`UPDATE de_assignment_decisions SET feishu_message_id='om_private' WHERE id=$1`, [decision.id]);
        expect(await reply(owner(), "1", "om_private")).toBeNull();
        expect(await reply(userId, "1", "om_something_else")).toBeNull();
        expect((await decisionRow(decision.id)).answered_at).toBeNull();
      });

      it("resumes every task a quota stopped when the owner says continue", async () => {
        const userId = owner();
        const tasks = [await create(userId), await create(userId)];
        for (const task of tasks) await repository().pause(task.id, "quota");
        expect(await reply(userId, "继续")).toBe("收到，继续执行。");
        for (const task of tasks) expect((await raw(task.id)).paused_at).toBeNull();
        expect(await reply(userId, "继续")).toBeNull();
        script.push(finish(), finish());
        await turn();
        await turn();
      });
    });

    describe("telling the owner", () => {
      it("reminds once after a day, and the reminder can be quoted", async () => {
        const userId = owner();
        const { decision } = await stopAt(userId);
        await runner().deliver();
        await db.pool.query(`UPDATE de_assignment_decisions SET created_at=now() - interval '25 hours' WHERE id=$1`, [decision.id]);
        await runner().sweep();
        await runner().sweep();
        await runner().deliver();
        const mine = sent.filter((item) => item.userId === userId);
        expect(mine).toHaveLength(2);
        expect(mine[1]!.text).toContain("已经等了一天");
        const row = await decisionRow(decision.id);
        expect(row.feishu_reminder_id).toBeTruthy();
        expect(row.feishu_reminder_id).not.toBe(row.feishu_message_id);
        expect(await assignments().routeReply({ userId, parentId: row.feishu_reminder_id, text: "1" }, false)).toBe("收到，继续执行。");
        script.push(finish());
        await turn();
      });

      it("does not send a notice for a decision already answered", async () => {
        const userId = owner();
        const { decision } = await stopAt(userId);
        await assignments().answer(userId, decision.id, { text: "华东的" });
        await runner().deliver();
        expect(sent.filter((item) => item.userId === userId)).toEqual([]);
        script.push(finish());
        await turn();
      });

      it("says how to go on when a failure has an unconfirmed write", async () => {
        const userId = owner();
        await stopAt(userId, ending("unknown_outcome"));
        await runner().deliver();
        expect(sent.find((item) => item.userId === userId)!.text).toContain("核实");
      });

      it("gives each device the events after its cursor, and a new device none", async () => {
        const userId = owner();
        const first = await assignments().activity(userId);
        expect(first).toMatchObject({ open: 0, waiting: 0, events: [], cursor: "0" });
        const { task } = await stopAt(userId);
        const other = await create(userId);
        await repository().pause(other.id, "quota");
        const activity = await assignments().activity(userId, first.cursor!);
        expect(activity).toMatchObject({ open: 2, waiting: 2 });
        expect(activity.events.map((event) => event.kind)).toEqual(["decision", "paused"]);
        expect(activity.events[0]).toMatchObject({ rootId: task.id });
        expect(await assignments().activity(userId, activity.cursor!)).toMatchObject({ events: [] });
        expect((await assignments().activity(userId)).events).toEqual([]);
        expect((await assignments().activity(owner(), first.cursor!)).events).toEqual([]);
      });

      it("shows decisions and stopped tasks on the today page", async () => {
        const userId = owner();
        const { task, decision } = await stopAt(userId);
        const stopped = await create(userId);
        await repository().pause(stopped.id, "quota");
        const today = await service.today.get(userId);
        const items = today.items.filter((item) => item.kind === "assignment");
        expect(items.map((item) => item.assignment?.rootId).sort()).toEqual([task.id, stopped.id].sort());
        expect(items.find((item) => item.assignment?.rootId === task.id)!.assignment!.decision!.id).toBe(decision.id);
        expect((await repository().get(userId, task.id)).waitingDecisions).toBe(1);
      });
    });
  });
});
