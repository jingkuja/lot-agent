/** Real digital employee UI with in-memory API fixtures; no user data or model calls.
 * PLAYWRIGHT_MODULE=/path/to/playwright node packages/server/scripts/check-digital-employee-ui.mjs
 * AGENT_SCREENSHOTS_DIR saves screenshots.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { createServer } = createRequire(resolve(root, "packages/web/package.json"))("vite");
const temp = await realpath(await mkdtemp(join(tmpdir(), "lot-digital-employee-")));
const screenshotDir = process.env.AGENT_SCREENSHOTS_DIR;
const PROFILE = "00000000-0000-4000-8000-000000000101";
const CAMPAIGN = "00000000-0000-4000-8000-000000000201";
const NOW = "2026-11-05T02:00:00.000Z";
const CHAT_INPUT = ".product-shell-view:not(.is-hidden) .chat-panel textarea";

const PRODUCT = "00000000-0000-4000-8000-000000000301";
const importStatusFixture = {
  id: "22222222-2222-4222-8222-222222222222", title: "焕颜手册.md", status: "ready", errorCode: null, draftId: "33333333-3333-4333-8333-333333333333",
  pagesRead: 0,
  createdAt: "2026-11-06T00:00:00.000Z",
  preview: { products: [{ name: "", target: null, items: 4 }], needsReview: 2, questions: 2, reviewUrl: "/digital-employee/materials/import/22222222-2222-4222-8222-222222222222" },
};
const importDraftFixture = {
  documentId: importStatusFixture.id, title: "焕颜手册.md", truncated: true, skippedPages: 0,
  products: [{
    key: "p1", name: "", suggestedName: "皮肤管理中心", targetProductId: null, targetName: null, positioning: "",
    items: [
      { id: "p1-1", field: "verifiableFacts", text: "小气泡单次 198 元", source: "明星项目", selected: true },
      { id: "p1-2", field: "faqs", text: "孕妇能做吗？", detail: "孕期不建议做", selected: true },
      { id: "p1-3", field: "currentBenefits", text: "新客体验价 99 元", selected: false, flag: "benefit" },
      { id: "p1-4", field: "verifiableFacts", text: "年卡 3999 元", selected: false, flag: "number" },
      { id: "p1-5", field: "verifiableFacts", text: "水光 680 元", selected: true, flag: "image" },
    ],
    questions: [{ id: "p1-name", field: "name", question: "这家店叫什么？" }, { id: "p1-q2", field: "notes", question: "优惠到什么时候？" }],
  }],
};
const documentFixture = (over) => ({
  id: "d1", productId: PRODUCT, title: "费用说明.docx", mime: "application/pdf", status: "ready", errorCode: null, chars: 3200,
  skippedPages: 0, usedInTalkTrack: true, createdAt: NOW, updatedAt: NOW, ...over,
});
const productFixture = { id: PRODUCT, userId: "u1", name: "API 网关", positioning: "统一接入", coreValues: [], verifiableFacts: [], commonObjections: [],
  currentBenefits: [], prohibitedExpressions: [], caseMaterials: [], faqs: [], productNotes: "", documentCount: 3, status: "active", version: 1,
  archivedAt: null, createdAt: NOW, updatedAt: NOW };

const opportunity = (over) => ({
  id: "o1", view: "pending", opportunityId: "o1", actionId: null, actionVersion: 1, profileId: PROFILE, customerName: "李静", organization: "云启",
  relationshipStage: "prospect", opportunityType: "prospect_progress", source: "ai", title: "确认代销门槛", objective: "了解顾虑", followUpMethod: "电话",
  suggestedAt: NOW, scheduledAt: null, priority: "high", reason: "问了代销价格", evidence: [{ sourceType: "observation", fact: "嫌门槛高", occurredAt: NOW }],
  readiness: "ready", riskFlags: [], productKey: null, productName: null, status: "suggested", snoozedUntil: null, decisionReason: null, updatedAt: null,
  resultCriteria: null, executedAt: null, completedAt: null, closeReason: null, outcome: null, customerQuote: null, nextAction: null, overdue: false, ...over,
});
const work = (kind, item) => ({
  id: `${kind}:${item.id}`, kind, subject: { type: "customer", id: PROFILE, label: "李静" }, title: item.title, reason: item.reason,
  evidence: item.evidence.map(({ fact }) => ({ fact })), priority: item.priority, dueAt: item.scheduledAt,
  source: item.actionId ? { type: "action", id: item.actionId, version: 1 } : { type: "opportunity", id: item.opportunityId }, opportunity: item,
});

function fixtures() {
  const followUp = opportunity({ id: "a1", opportunityId: "o2", actionId: "a1", status: "pending", view: "today", title: "回访王总", scheduledAt: NOW, overdue: true });
  const awaiting = opportunity({ id: "a2", opportunityId: "o3", actionId: "a2", status: "awaiting_result", view: "today", title: "等张姐回复", scheduledAt: NOW });
  return {
    settings: { employeeName: "小灵", feishuReminder: false, desktopReminder: false, workTone: null, preferredChannels: [], version: 0 },
    focusWrites: [], writes: [], assignmentQueries: [],
    assignments: [
      task({}),
      task({ id: "t2", title: "整理客户清单", goal: "整理本周客户", status: "succeeded", createdAt: TODAY, currentTool: null,
        result: { summary: "整理好了 12 位客户", assumptions: ["按最近联系排序"], skipped: ["两位王总没有更新"] } }),
      task({ id: "t3", title: "写活动海报", goal: "做一张海报", status: "queued", pausedReason: "quota", createdAt: TWO_DAYS_AGO, currentTool: null }),
      task({ id: "t4", title: "同步产品资料", goal: "把手册存进产品资料", status: "failed", failureReason: "unknown_outcome", createdAt: TWO_DAYS_AGO, currentTool: null }),
    ],
    work: {
      id: "c1", title: "李静的跟进", runs: [{
        id: "w1", goal: "记一下李静嫌门槛高", status: "completed", startedAt: NOW, finishedAt: NOW, outcome: "已记录。",
        steps: [
          { id: "st1", tool: "search_customer_profiles", status: "succeeded", startedAt: NOW, finishedAt: NOW, artifact: null },
          { id: "st2", tool: "prepare_follow_up_action", status: "failed", startedAt: NOW, finishedAt: NOW, artifact: null },
          { id: "st3", tool: "commit_customer_capture", status: "succeeded", startedAt: NOW, finishedAt: NOW,
            artifact: { label: "查看画像", url: `/digital-employee/customers/${PROFILE}` } },
        ],
      }],
    },
    schedules: [{ id: "s1", template: "weekly_review", timing: { kind: "weekly", weekday: 1, hour: 9, minute: 0 }, timezone: "Asia/Shanghai", enabled: true,
      nextRunAt: NOW, lastRunAt: null, version: 1 }],
    reports: [],
    runs: [
      { id: "r1", scheduleId: "s1", template: "follow_up_prep", scheduledFor: NOW, status: "succeeded", reason: null, acknowledgedAt: null, finishedAt: NOW,
        report: { summary: "今天 1 位客户要跟进", items: [{ title: "李静", body: "先问门槛" }], question: "李静这周还在考虑吗？" } },
      { id: "r2", scheduleId: "s1", template: "weekly_review", scheduledFor: NOW, status: "skipped", reason: "quota", acknowledgedAt: null, finishedAt: NOW, report: null },
    ],
    proposals: new Map([
      ["d1", {
        id: "d1", kind: "follow_up_action", confirmable: true, conversationId: "c1",
        preview: { operation: "create", profileId: PROFILE, customerName: "李静", title: "明天跟进", objective: "确认门槛" }, createdAt: NOW, expiresAt: NOW,
      }],
      ["d2", { id: "d2", kind: "customer_capture", confirmable: false, conversationId: "c1", preview: { customerMention: "新客户", excerpt: "想了解价格" }, createdAt: NOW, expiresAt: NOW }],
    ]),
    pending: [opportunity({})], followUps: [followUp], results: [awaiting],
    recommendations: [{
      id: "r1", type: "copy", segmentId: null, segmentName: null, productId: null, productName: null, targetSegmentDescription: "华东潜客", theme: "代销说明会",
      corePoints: [], suggestedChannels: ["朋友圈"], reasoning: ["集中问价"], creativeDirection: "", durationSeconds: null,
    }],
    running: [{ id: "t1", type: "image.generate", status: "running", progress: 40, stage: null, createdAt: NOW }],
    hasProfiles: true,
    brief: null, feedback: [], discovery: { ...opportunitySettings, enabled: true, version: 1 }, briefReads: [],
    conversations: [
      { id: "c1", title: "李静的跟进", agent_id: "digital_employee", created_at: NOW, updated_at: NOW, metadata: { digitalEmployeeFeatureScope: "employee" } },
      { id: "c2", title: "获客宝旧对话", agent_id: "digital_employee", created_at: NOW, updated_at: NOW, metadata: { digitalEmployeeFeatureScope: "customer-acquisition" } },
    ],
  };
}

const profile = {
  id: PROFILE,
  displayName: "李静",
  aliases: [],
  customerKind: "individual",
  organization: "云启",
  department: null,
  title: null,
  customerRegion: "上海",
  contact: null,
  source: null,
  relationshipStage: "prospect",
  overallHealth: "healthy",
  tags: [],
  manualLockFields: [],
  summary: "潜客",
  status: "active",
  version: 1,
  nextFollowUpAt: null,
  lastContactAt: null,
  updatedAt: NOW,
  createdAt: NOW,
};
const campaign = {
  id: CAMPAIGN,
  name: "双十一",
  objective: "获客",
  status: "draft",
  productId: null,
  productName: "边缘算力",
  audienceDescription: "华东",
  channels: ["朋友圈"],
  callToAction: "咨询",
  results: { impressions: 0, interactions: 0, conversions: 0, leads: 0 },
  assetCounts: { copy: 0, poster: 0, video: 0 },
  assets: { copy: [], poster: [], video: [] },
  selectedAssets: { copy: null, poster: null, video: null },
  createdAt: NOW,
  updatedAt: NOW,
};
const summary = {
  dueToday: 1,
  overdue: 1,
  highPriority: 1,
  awaitingResult: 1,
  viewCounts: { today: 2, pending: 1, snoozed: 0, in_progress: 1, awaiting_result: 1, completed: 0 },
};
const opportunitySettings = { enabled: false, discoveryMode: "rules", timezone: "Asia/Shanghai", dailyRunTime: "09:00", nextRunAt: null, lastRunAt: null, version: 0 };
const overview = {
  cohort: {
    source: "live",
    generationMethod: "logic",
    generatedAt: NOW,
    summary: "共 1 位客户",
    metrics: { totalProfiles: 1, activeLast7Days: 1, dueFollowUps: 1, relationshipStages: [], topTags: [] },
  },
  schedule: { enabled: false, version: 0, timeZone: "Asia/Shanghai", localTime: "23:00", nextRunAt: null },
  recentProfiles: [profile],
};

const TODAY = new Date(new Date().setHours(10, 0, 0, 0)).toISOString();
const TWO_DAYS_AGO = new Date(new Date().setHours(10, 0, 0, 0) - 2 * 86_400_000).toISOString();
const task = (over) => ({
  id: "t1", title: "写开业优惠方案", goal: "查同行开业活动，写优惠方案", mode: "autonomous", status: "running", pausedReason: null, modelId: "kimi-k3.1-pro",
  result: null, failureReason: null, createdAt: TODAY, finishedAt: null, creditsUsed: 120, creditLimit: null,
  subtasks: { done: 0, total: 0, missed: 0 }, subtaskLimit: null,
  currentTool: "web_search", waitingDecisions: 0, attachments: [], conversationId: "c-task", unverified: 0, decisions: [], subtaskList: [], board: [], ...over,
});
const decisionFixture = (over) => ({
  id: "q1", assignmentId: "t5", rootId: "t5", conversationId: "c-task", title: "给王总记跟进", kind: "question", question: "哪位王总？",
  options: ["华东的王总", "华南的王总"], multiSelect: false, failureReason: null, unverified: 0, createdAt: NOW, ...over,
});
const subtaskFixture = (over) => ({
  id: "s1", position: 1, title: "搜同行", goal: "搜同类店铺", status: "running", failureReason: null, result: null, summary: "搜到 3 家店", createdBy: "employee",
  retriesUsed: 0, unverified: 0, conversationId: "c-sub", finishedAt: null, ...over,
});
const boardFixture = (over) => ({
  id: "1", kind: "finding", title: "同行都送体验券", body: "折扣集中在七到八折", artifacts: [], event: null, author: 1, authorTitle: "搜同行", createdAt: NOW, ...over,
});
/** Three subtasks in different states, and a finished task that only partly got there. */
const teamTasks = (state) => {
  state.assignments.unshift(task({
    id: "team1", title: "开业活动", goal: "明天开业的优惠活动", status: "waiting_children", currentTool: null, subtasks: { done: 1, total: 3, missed: 1 }, subtaskLimit: 5,
    subtaskList: [
      subtaskFixture({}),
      subtaskFixture({ id: "s2", position: 2, title: "写方案", status: "failed", failureReason: "model_failed", summary: null }),
      subtaskFixture({ id: "s3", position: 3, title: "做海报", status: "succeeded", summary: null, result: { summary: "海报做好了", assumptions: [], skipped: [] } }),
    ],
    board: [
      boardFixture({}),
      boardFixture({ id: "2", kind: "status", event: "failed", title: "subtask 2 failed: 写方案", body: "", author: 2, authorTitle: "写方案" }),
      boardFixture({ id: "3", kind: "status", event: "added", title: "new subtask 3: 做海报", body: "做海报", author: 0, authorTitle: "开业活动" }),
    ],
  }), task({ id: "team2", title: "整理名单", goal: "整理名单", status: "succeeded", currentTool: null, subtasks: { done: 1, total: 2, missed: 1 } }));
  return state;
};
/** A question, a failure with an unconfirmed write, and a task stopped by quota. */
const decisionTasks = (state) => {
  const question = decisionFixture({});
  const failure = decisionFixture({ id: "f1", assignmentId: "t6", rootId: "t6", title: "同步价格", kind: "failure", question: "", options: ["retry", "skip", "change", "end"],
    failureReason: "unknown_outcome", unverified: 1 });
  state.assignments.unshift(
    task({ id: "t5", title: "给王总记跟进", goal: "给王总记一条跟进", mode: "responsive", status: "waiting_user", currentTool: null, waitingDecisions: 1, decisions: [question] }),
    task({ id: "t6", title: "同步价格", goal: "把价格改成 99", mode: "responsive", status: "waiting_user", failureReason: "unknown_outcome", currentTool: null,
      waitingDecisions: 1, unverified: 1, decisions: [failure] }),
  );
  state.attention = [
    { rootId: "t5", title: "给王总记跟进", createdAt: NOW, decision: question, pausedReason: null },
    { rootId: "t6", title: "同步价格", createdAt: NOW, decision: failure, pausedReason: null },
    { rootId: "t3", title: "写活动海报", createdAt: NOW, decision: null, pausedReason: "quota" },
  ];
  state.taskActivity = { open: 3, waiting: 3, events: [], cursor: "5" };
  return state;
};

function api(state, unexpected, dailyScan = false, schedules = false, assignments = false) {
  return async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (!path.startsWith("/api/")) return route.continue();
    const json = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    const de = path.replace("/api/digital-employee", "");
    if (method !== "GET") state.writes.push({ path, body: request.postData() });
    if (path === "/api/uploads") {
      state.uploads = (state.uploads ?? 0) + 1;
      if (state.failUpload) return json({ error: "上传失败" }, 500);
      return json({ assetId: `asset${state.uploads}`, filename: "手册.pdf", mime: "application/pdf", size: 5, url: "/x", kind: "doc" });
    }
    if (path === "/api/public/product") {
      return json({ globle: 1, digitalEmployeeDailyScan: dailyScan, digitalEmployeeSchedules: schedules, digitalEmployeeAssignments: assignments });
    }
    if (path === "/api/feishu/status") return json({ configured: true, connected: false });
    if (path === "/api/assets/links") return json({ links: {} });
    if (de === "/assignments" && method === "GET") {
      state.assignmentQueries.push(Object.fromEntries(url.searchParams));
      const searching = !url.searchParams.has("openBefore");
      const q = url.searchParams.get("q");
      const items = state.assignments.filter((item) => !q || item.title.includes(q) || item.goal.includes(q));
      if (searching) return json({ items, pinned: [], nextCursor: null });
      const open = (item) => !["succeeded", "failed", "cancelled"].includes(item.status);
      const older = (item) => open(item) && item.createdAt < url.searchParams.get("openBefore");
      return json({ items: items.filter((item) => !older(item)), pinned: items.filter(older), nextCursor: null });
    }
    if (de === "/assignments" && method === "POST") {
      const body = request.postDataJSON();
      const created = task({ id: `t${state.assignments.length + 1}`, title: body.goal, goal: body.goal, status: "queued", currentTool: null, creditsUsed: 0 });
      state.assignments.unshift(created);
      return json(created, 201);
    }
    const followUp = de.match(/^\/assignments\/([^/]+)\/follow-up$/);
    if (followUp) {
      const item = state.assignments.find((entry) => entry.id === followUp[1]);
      Object.assign(item, { status: "queued", failureReason: null });
      return json(item);
    }
    const subtask = de.match(/^\/assignments\/([^/]+)\/subtasks(?:\/([^/]+))?(?:\/(\w+))?$/);
    if (subtask) {
      const item = state.assignments.find((entry) => entry.id === subtask[1]);
      if (!subtask[2]) {
        const position = item.subtaskList.length + 1;
        item.subtaskList.push(subtaskFixture({ id: `s${position}`, position, title: request.postDataJSON().goal, status: "queued", summary: null }));
        return json(item, 201);
      }
      if (!subtask[3]) {
        return json({ runs: [{ id: "sr1", status: "completed", startedAt: NOW, finishedAt: NOW, steps: [
          { id: "ss1", tool: "post_team_update", status: "succeeded", startedAt: NOW, finishedAt: NOW, artifact: null },
        ] }] });
      }
      const child = item.subtaskList.find((entry) => entry.id === subtask[2]);
      Object.assign(child, subtask[3] === "cancel" ? { status: "cancelled" } : { status: "queued", failureReason: null });
      return json(item);
    }
    const subtaskLimit = de.match(/^\/assignments\/([^/]+)\/subtask-limit$/);
    if (subtaskLimit) {
      const item = state.assignments.find((entry) => entry.id === subtaskLimit[1]);
      Object.assign(item, { subtaskLimit: request.postDataJSON().subtaskLimit });
      return json(item);
    }
    if (de.match(/^\/assignments\/[^/]+\/board$/)) return json({ entries: [] });
    const answered = de.match(/^\/assignments\/decisions\/([^/]+)\/answer$/);
    if (answered) {
      const body = request.postDataJSON();
      const item = state.assignments.find((entry) => entry.decisions?.some((decision) => decision.id === answered[1]));
      if (!item) return json({ error: "决定不存在" }, 404);
      state.attention = (state.attention ?? []).filter((entry) => entry.decision?.id !== answered[1]);
      const status = { skip: "skipped", end: "cancelled" }[body.choice] ?? "queued";
      Object.assign(item, { waitingDecisions: 0, decisions: [], failureReason: null, status });
      return json(item);
    }
    const assignment = de.match(/^\/assignments\/([^/]+)(?:\/(\w+))?$/);
    if (assignment) {
      const item = state.assignments.find((entry) => entry.id === assignment[1]);
      if (!item) return json({ error: "任务不存在" }, 404);
      if (assignment[2] === "cancel") Object.assign(item, { status: "cancelled", pausedReason: null });
      if (assignment[2] === "retry") Object.assign(item, { status: "queued", failureReason: null });
      if (assignment[2] === "resume") Object.assign(item, { pausedReason: null });
      if (assignment[2] === "limit") Object.assign(item, { creditLimit: request.postDataJSON().creditLimit });
      const artifacts = [
        { id: "as2", tool: "generate_document", artifact: { label: "方案.docx", url: "/static/documents/abc.docx", download: true } },
        { id: "as3", tool: "commit_product_import", artifact: { label: "焕颜美学", url: "/digital-employee/materials/import/d1", needsReview: true } },
      ];
      return json(assignment[2] ? item : { ...item, artifacts, runs: [{ id: "run1", status: "completed", startedAt: NOW, finishedAt: NOW, steps: [
        { id: "as1", tool: "web_search", status: "succeeded", startedAt: NOW, finishedAt: NOW, artifact: null },
        { id: "as2", tool: "generate_document", status: "succeeded", startedAt: NOW, finishedAt: NOW,
          artifact: { label: "方案.docx", url: "/static/documents/abc.docx", download: true } },
        { id: "as3", tool: "commit_product_import", status: "succeeded", startedAt: NOW, finishedAt: NOW,
          artifact: { label: "焕颜美学", url: "/digital-employee/materials/import/d1", needsReview: true } },
      ] }] });
    }
    if (de.startsWith("/work-log/conversations/")) return json({ ...state.work, id: de.split("/").at(-1) });
    if (de === "/schedules" && method === "GET") return json({ schedules: state.schedules, runs: state.runs });
    if (de === "/schedules" && method === "POST") {
      const created = { id: `s${state.schedules.length + 1}`, ...JSON.parse(request.postData()), nextRunAt: NOW, lastRunAt: null, version: 1 };
      state.schedules.push(created);
      return json(created, 201);
    }
    if (de.startsWith("/schedules/") && method === "DELETE") {
      state.schedules = state.schedules.filter((item) => item.id !== de.slice("/schedules/".length));
      return json({ ok: true });
    }
    if (de === "/schedule-runs/r1") return json(state.runs[0]);
    if (de === "/schedule-runs/r1/acknowledge") {
      state.reports = [];
      return json({ ok: true });
    }
    if (path === "/api/agents") return json([
      { id: "general", name: "通用助手", description: "通用", type: "general", installed: true, sortOrder: 0 },
      { id: "digital_employee", name: "数字员工", description: "独立模块", type: "digital_employee", installed: true, sortOrder: 1 },
    ]);
    if (path === "/api/models") {
      const llm = ["test-llm", ...Array.from({ length: 11 }, (_, i) => `test-llm-${i + 2}`)].map((id) => ({ id, type: "llm", provider: "test" }));
      return json({ llm, image: [], video: [] });
    }
    if (path === "/api/usage/balance") return json({ balance: 100, totalUsed: 0, totalRecharged: 100, usedRatio: 0, allowBalanceFallback: true });
    if (path === "/api/conversations/projects") return json([]);
    if (path === "/api/conversations") {
      if (method === "POST") {
        const body = request.postDataJSON();
        const created = { id: "new-chat", title: "新对话", agent_id: body.agentId, created_at: NOW, updated_at: NOW, metadata: { digitalEmployeeFeatureScope: "employee" } };
        state.conversations.unshift(created);
        return json(created);
      }
      return json({ items: state.conversations, nextCursor: null });
    }
    if (path.endsWith("/messages") && method === "POST") {
      return route.fulfill({ contentType: "text/event-stream", body: 'event: stream_end\ndata: {}\n\n' });
    }
    if (path.startsWith("/api/conversations/")) {
      const conversation = state.conversations.find((item) => item.id === path.split("/")[3]);
      if (conversation) return json({ ...conversation, messages: [{ id: "m1", role: "user", content: `${conversation.title} 的内容` }, { id: "m2", role: "assistant", content: "好的" }] });
    }
    if (path === "/api/knowledge-bases") return json([]);
    if (path.startsWith("/api/rag/")) return json({ ingestionEnabled: false });
    if (path.startsWith("/api/tasks/") && path.endsWith("/cancel")) { state.running = []; return json({ ok: true, status: "cancelled" }); }
    if (!path.startsWith("/api/digital-employee")) { unexpected.push(path); return json({}, 404); }

    if (de === "/settings") {
      if (method === "PUT") {
        const body = request.postDataJSON();
        state.settings = { ...body, version: body.version + 1 };
      }
      return json(state.settings);
    }
    if (de === "/today/summary") {
      return json({
        pending:
          state.proposals.size +
          state.pending.length +
          state.recommendations.length +
          state.followUps.length +
          state.results.length +
          state.feedback.length,
        brief: state.brief,
        desktopReminder: state.settings.desktopReminder,
        assignments: (() => {
          state.summaryCursors = [...(state.summaryCursors ?? []), url.searchParams.get("after")];
          const activity = state.taskActivity ?? { open: 0, waiting: 0, events: [], cursor: "0" };
          if (state.taskActivity) state.taskActivity = { ...activity, events: [] };
          return activity;
        })(),
      });
    }
    if (de.match(/^\/today\/brief\/[^/]+\/read$/)) { state.briefReads.push(de); return json({ ok: true }); }
    if (de === "/today") {
      const items = [
        ...[...state.proposals.values()].map((proposal) => ({
          id: `proposal:${proposal.id}`, kind: "proposal", subject: null, title: "", reason: "", evidence: [], priority: "normal", dueAt: null,
          source: { type: proposal.kind, id: proposal.id }, proposal,
        })),
        ...state.pending.map((item) => work("opportunity", item)),
        ...state.recommendations.map((item) => ({
          id: `recommendation:${item.id}`, kind: "recommendation", subject: null, title: item.theme, reason: item.targetSegmentDescription,
          evidence: item.reasoning.map((fact) => ({ fact })), priority: "low", dueAt: null, source: { type: "recommendation", id: item.id }, recommendation: item,
        })),
        ...state.followUps.map((item) => work("follow_up", item)),
        ...state.results.map((item) => work("result", item)),
        ...state.reports,
        ...(state.attention ?? []).map((assignment) => ({
          id: `assignment:${assignment.decision?.id ?? assignment.rootId}`, kind: "assignment", subject: null, title: assignment.title, reason: "", evidence: [],
          priority: "high", dueAt: NOW, source: { type: "assignment", id: assignment.rootId }, assignment,
        })),
        ...state.feedback.map((item) => ({
          id: `result:${item.id}`, kind: "result", subject: { type: "asset", id: item.assetId, label: item.title }, title: item.title, reason: "", evidence: [],
          priority: "normal", dueAt: item.deployedAt, source: { type: "deployment", id: item.id }, deployment: item,
        })),
      ];
      return json({
        employee: { name: state.settings.employeeName },
        brief: state.brief,
        items,
        running: state.running,
        snoozedCount: 1,
        hasProfiles: state.hasProfiles,
        lastDiscoveredAt: NOW,
      });
    }
    const proposal = de.match(/^\/proposals\/([^/]+)\/(confirm|dismiss)$/);
    if (proposal) {
      state.proposals.delete(proposal[1]);
      return json({ id: proposal[1], kind: "follow_up_action", alreadyApplied: false, entityId: "a9", managementUrl: "/digital-employee/today", status: "dismissed" });
    }
    if (de === "/opportunities/discover") return json({ runId: "r", taskId: "t9", reused: false }, 202);
    if (de === "/opportunities") {
      const view = url.searchParams.get("view");
      const items = view === "pending" ? state.pending : view === "today" ? [...state.followUps, ...state.results] : view === "awaiting_result" ? state.results : [];
      return json({ items, total: items.length, summary, hasProfiles: true, lastDiscoveredAt: NOW, settings: opportunitySettings });
    }
    if (de.match(/^\/actions\/[^/]+\/results$/)) { state.results = []; return json({ recordId: "x", actionId: "a2", status: "completed", nextActionId: null }, 201); }
    if (de.match(/^\/actions\/[^/]+$/)) { state.followUps = []; return json(opportunity({})); }
    if (de === "/opportunity-settings") {
      if (method === "PUT") state.discovery = { ...request.postDataJSON(), version: request.postDataJSON().version + 1 };
      return json(state.discovery);
    }
    if (de.match(/^\/acquisition\/assets\/[^/]+$/)) {
      return json({
        id: "as1", title: "双十一海报", assetType: "poster", generationStatus: "ready", status: "ready", version: 1, deployments: state.feedback.map((item) => ({
          id: item.id, assetId: "as1", platform: "moments", customPlatform: null, status: "deployed", deployedAt: NOW, feedback: [],
        })),
      });
    }
    if (de.match(/^\/acquisition\/deployments\/[^/]+\/feedback$/)) {
      state.feedback = [];
      return json({ id: "f1", deploymentId: "dp1", impressions: 10, interactions: null, conversions: null, feedbackText: "", recordedAt: NOW }, 201);
    }
    if (de === "/overview") return json(overview);
    if (de === "/overview/schedule") return json({ ...overview.schedule, ...request.postDataJSON(), version: 1 });
    if (de === "/profiles") return json({ items: [profile], total: 1, page: 1, limit: 20 });
    if (de === `/profiles/${PROFILE}`) return json({ profile, productStates: [] });
    if (de === `/profiles/${PROFILE}/timeline`) return json({ observations: [], changes: [] });
    if (de === `/profiles/${PROFILE}/work`) return json({ opportunities: state.pending, actions: state.followUps, outreach: [] });
    if (de.startsWith("/conversation-context/")) {
      state.focusWrites.push({ method, body: method === "PUT" ? request.postDataJSON() : null, path: de });
      return json(method === "PUT" ? { ...request.postDataJSON(), label: "李静" } : { ok: true });
    }
    if (de === "/acquisition/segments") return json({ items: [] });
    if (de === "/acquisition/insights") return json({ overall: null, segments: [], commonNeeds: [], commonObjections: [] });
    if (de === "/acquisition/assets") return json({ items: [], total: 0 });
    if (de === "/acquisition/campaigns") return json({ items: [campaign], total: 1 });
    if (de === `/acquisition/campaigns/${CAMPAIGN}` && method === "PATCH") {
      state.campaignWrites = (state.campaignWrites ?? 0) + 1;
      await new Promise((done) => setTimeout(done, 150));
      if (state.failCampaignWrite) return json({ error: "保存失败" }, 500);
      return json({ ...campaign, name: JSON.parse(request.postData()).name ?? campaign.name });
    }
    if (de === `/acquisition/campaigns/${CAMPAIGN}`) return json(campaign);
    if (de === "/acquisition/campaign-opportunities") return json({ items: [], total: 0 });
    if (de === "/acquisition/recommendations") return json({ items: state.recommendations, generatedAt: NOW });
    if (de === "/acquisition/analytics") return json({
      totals: { assets: 0, deployedAssets: 0, impressions: 0, interactions: 0, conversions: 0 },
      assetTypes: [],
      platforms: [],
      segments: [],
      topAssets: [],
      campaigns: [],
    });
    if (de === "/acquisition/model-configuration") return json({
      llm: true,
      image: false,
      video: false,
      llmModelId: null,
      imageModelId: null,
      videoModelId: null,
      llmModels: [],
      imageModels: [],
      videoModels: [],
      configurationUrl: "https://example.com",
    });
    if (de === "/marketing/products") return json({ items: state.products ?? [], total: state.products?.length ?? 0, page: 1, limit: 20 });
    if (de.startsWith(`/marketing/products/${PRODUCT}/documents`)) {
      if (method === "GET") {
        // The document being read finishes on the second look, as the worker would.
        state.documentReads = (state.documentReads ?? 0) + 1;
        if (state.documentReads > 1) {
          state.documents = state.documents.map((item) => item.status === "processing" ? { ...item, status: "ready", usedInTalkTrack: true } : item);
        }
        return json({ items: state.documents, usage: { usedChars: 3200, limitChars: 15000 } });
      }
      if (method === "POST") {
        const added = documentFixture({ id: `d${state.documents.length + 10}`, title: "新手册.pdf", status: "processing", usedInTalkTrack: false });
        state.documents = [added, ...state.documents];
        state.documentReads = 0;
        return json(added, 201);
      }
      state.documents = state.documents.filter((item) => !de.endsWith(item.id));
      return json({ ok: true });
    }
    if (de === "/marketing/imports") {
      if (method === "POST") {
        state.imports = [{ ...importStatusFixture, status: "working", draftId: null, preview: null, pagesRead: 3 }];
        state.importReads = 0;
        return json(state.imports[0], 202);
      }
      state.importReads = (state.importReads ?? 0) + 1;
      if (state.importReads > 1) state.imports = (state.imports ?? []).map((item) => item.status === "working" ? importStatusFixture : item);
      return json({ items: state.imports ?? [] });
    }
    if (de === `/marketing/products/${PRODUCT}/documents/d1/import`) {
      state.imports = [{ ...importStatusFixture, status: "working", draftId: null, preview: null }];
      state.importReads = 0;
      return json(state.imports[0], 202);
    }
    if (de.endsWith("/commit") && de.startsWith("/marketing/imports/drafts/")) {
      state.commits = (state.commits ?? 0) + 1;
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (state.failCommit) return json({ error: "保存失败，可以重试" }, 500);
      state.imports = [];
      return json({ alreadyApplied: false, entityId: PRODUCT, managementUrl: "/digital-employee/materials", saved: [{ id: PRODUCT, name: "焕颜美学", created: true, items: 3 }], dropped: 0 });
    }
    if (de.startsWith("/marketing/imports/")) return json({ status: importStatusFixture, draft: importDraftFixture });
    if (de === "/marketing/brand-assets") return json(null);
    unexpected.push(`${method} ${path}`);
    return json({}, 404);
  };
}

let vite, browser;
const errors = [], unexpected = [];
try {
  await writeFile(join(temp, "index.html"), '<div id="root"></div><script type="module" src="/main.tsx"></script>');
  await writeFile(join(temp, "main.tsx"), `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {ProductShell} from ${JSON.stringify(resolve(root, "packages/web/src/shell/ProductShell.tsx"))};
    import {LanguageProvider} from ${JSON.stringify(resolve(root, "packages/web/src/i18n/index.tsx"))};
    import {setToken} from ${JSON.stringify(resolve(root, "packages/web/src/api/client.ts"))};
    import ${JSON.stringify(resolve(root, "packages/web/src/App.css"))};
    setToken('digital-employee-test');
    createRoot(document.getElementById('root')).render(<LanguageProvider><ProductShell user={{id:'fixture',name:'测试用户'}} onLogout={()=>{}} /></LanguageProvider>);`);
  vite = await createServer({
    configFile: false, root: temp, esbuild: { jsx: "automatic" },
    optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-markdown", "remark-gfm"] },
    resolve: { alias: {
      react: resolve(root, "packages/web/node_modules/react"), "react-dom": resolve(root, "packages/web/node_modules/react-dom"),
      "react-markdown": resolve(root, "packages/web/node_modules/react-markdown"), "remark-gfm": resolve(root, "packages/web/node_modules/remark-gfm"),
    } },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root, temp] } },
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, channel: "chrome" });

  async function open(path, {
    dailyScan = false, schedules = false, assignments = false, language = "zh", width = 1440, height = 1000, state = fixtures(), desktop = false,
  } = {}) {
    const context = await browser.newContext({ viewport: { width, height } });
    await context.addInitScript((value) => { try { localStorage.setItem("lot:language", value); } catch { /* opaque origin */ } }, language);
    if (desktop) await context.addInitScript(() => {
      window.notified = [];
      const notify = (title, body) => window.notified.push([title, body]);
      window.lotDesktop = new Proxy({ notify }, { get: (bridge, key) => bridge[key] ?? (async () => undefined) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => errors.push(`${path}: ${error.message}`));
    await page.route("**/api/**", api(state, unexpected, dailyScan, schedules, assignments));
    await page.goto(`${origin}${path}`);
    return { page, state, close: () => context.close() };
  }
  const snap = async (page, name) => {
    if (!screenshotDir) return;
    await mkdir(screenshotDir, { recursive: true });
    await page.screenshot({ path: join(screenshotDir, name), animations: "disabled" });
  };
  const noHorizontalScroll = (page) => page.evaluate(() => {
    const scroller = document.querySelector(".workspace-overlay") ?? document.documentElement;
    return scroller.scrollWidth <= scroller.clientWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1;
  });

  // The first screen is where work gets done: confirm, refuse, follow up and report a result.
  {
    const { page, state, close } = await open("/digital-employee");
    await page.waitForURL("**/digital-employee/today");
    await page.getByRole("heading", { name: "今日简报" }).waitFor();
    await page.getByText("3 件事等你确认", { exact: false }).waitFor().catch(() => {});
    await page.getByText("给李静安排跟进：明天跟进").waitFor();
    assert.equal(await page.locator(".de-employee-card small").innerText(), "工作中：生成海报");
    assert.equal(await page.getByText("确认创建", { exact: false }).count(), 0, "cards are written from preview fields, not the stored question");
    await snap(page, "today-zh-light.png");
    await page.getByText("给李静安排跟进：明天跟进").locator("xpath=ancestor::article").getByRole("button", { name: "确认", exact: true }).click();
    await page.getByText("已确认").waitFor();
    assert(!state.proposals.has("d1"));
    assert.equal(await page.getByText("给李静安排跟进：明天跟进").count(), 0);
    await page.getByText("记录新客户的动态").locator("xpath=ancestor::article").getByRole("button", { name: "不做" }).click();
    await page.getByText("记录新客户的动态").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "已联系" }).click();
    await page.getByText("李静：回访王总").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "有兴趣" }).click();
    await page.getByText("李静：等张姐回复").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("heading", { name: "我正在做" }).waitFor({ state: "detached" });
    await close();
  }

  // A customer record needs a choice, so its card returns to the conversation.
  {
    const { page, close } = await open("/digital-employee/today");
    await page.getByRole("button", { name: "去对话里选择" }).click();
    await page.waitForURL("**/digital-employee/chat/c1");
    await page.getByText("李静的跟进 的内容").waitFor();
    await page.goBack();
    await page.waitForURL("**/digital-employee/today");
    await page.getByRole("heading", { name: "今日简报" }).waitFor();
    await page.goForward();
    await page.waitForURL("**/digital-employee/chat/c1");
    await close();
  }

  // Without customers the first screen says what to do next.
  {
    const state = fixtures();
    Object.assign(state, { hasProfiles: false, proposals: new Map(), pending: [], followUps: [], results: [], recommendations: [], running: [] });
    const { page, close } = await open("/digital-employee/today", { state });
    await page.getByText("我还不认识你的客户").waitFor();
    await page.getByRole("button", { name: "新建客户" }).click();
    await page.waitForURL("**/digital-employee/customers");
    await close();
  }

  // Every old address lands somewhere real.
  for (const [old, expected, marker] of [
    ["/digital-employee", "/digital-employee/today", "今日简报"],
    ["/digital-employee/customer-profile", "/digital-employee/today", "今日简报"],
    ["/digital-employee/marketing-materials", "/digital-employee/materials", "营销资料"],
    ["/digital-employee/marketing-materials/manage", "/digital-employee/materials", "营销资料"],
    ["/digital-employee/profiles", "/digital-employee/customers", "客户档案"],
    [`/digital-employee/profiles/${PROFILE}`, `/digital-employee/customers/${PROFILE}`, "小灵的建议"],
    ["/digital-employee/acquisition", "/digital-employee/today", "今日简报"],
    ["/digital-employee/acquisition/chat", "/digital-employee/today", "今日简报"],
    ["/digital-employee/follow-ups", "/digital-employee/today", "今日简报"],
    ["/digital-employee/copy", "/digital-employee/marketing", "活动"],
    ["/digital-employee/copy/chat", "/digital-employee/chat", "在这里"],
  ]) {
    const { page, close } = await open(old);
    await page.waitForURL(`**${expected}`);
    await page.getByText(marker).first().waitFor();
    await close();
  }

  // A conversation from before the workspace still opens, under its old scope.
  {
    const { page, close } = await open("/digital-employee/chat/c2");
    await page.getByText("获客宝旧对话 的内容").waitFor();
    assert.equal(await page.locator(".de-employee-card").count(), 1);
    await close();
  }

  // Switching pages keeps an unsent message, and the customer on screen goes with it.
  {
    const { page, state, close } = await open(`/digital-employee/customers/${PROFILE}`);
    await page.getByText("小灵的建议").waitFor();
    await page.locator(".de-chat-current-customer strong").filter({ hasText: "李静" }).waitFor();
    const input = page.locator(CHAT_INPUT);
    await input.fill("给他写条微信");
    await page.locator(".de-employee-nav").getByRole("button", { name: "今天" }).click();
    await page.getByRole("heading", { name: "今日简报" }).waitFor();
    await page.locator(".de-chat-current-customer").waitFor({ state: "detached" }); // the object follows the open page
    assert.equal(await input.inputValue(), "给他写条微信");
    await page.locator(".de-employee-nav").getByRole("button", { name: "客户" }).click();
    await page.getByRole("button", { name: "客户档案" }).waitFor();
    await page.goBack();
    await page.getByRole("heading", { name: "今日简报" }).waitFor();
    await page.goBack();
    await page.locator(".de-chat-current-customer strong").filter({ hasText: "李静" }).waitFor();
    await input.press("Enter");
    await page.waitForURL("**/digital-employee/chat/**");
    await page.waitForFunction(() => document.querySelector(".workspace-overlay") === null);
    assert.deepEqual(state.focusWrites[0]?.body, { type: "customer", id: PROFILE });
    assert.equal(state.focusWrites[0]?.path, "/conversation-context/new-chat");
    await close();
  }

  // The owner can take the object away before sending.
  {
    const { page, state, close } = await open(`/digital-employee/customers/${PROFILE}`);
    await page.getByRole("button", { name: "移除当前对象" }).click();
    await page.locator(".de-chat-current-customer").waitFor({ state: "detached" });
    await page.locator(CHAT_INPUT).fill("随便问问");
    await page.locator(CHAT_INPUT).press("Enter");
    await page.waitForURL("**/digital-employee/chat/**");
    assert.equal(state.focusWrites.length, 0);
    await close();
  }

  // Selecting a campaign makes it the current object.
  {
    const { page, close } = await open("/digital-employee/marketing");
    await page.getByRole("button", { name: /双十一/ }).click();
    await page.locator(".de-chat-current-customer strong").filter({ hasText: "双十一" }).waitFor();
    await close();
  }

  // A rename reaches the card and the page at once.
  {
    const { page, state, close } = await open("/digital-employee/schedule");
    const name = page.getByRole("textbox", { name: "员工名字" });
    await name.fill("阿灵");
    await page.getByRole("button", { name: "保存" }).click();
    await page.locator(".de-employee-card strong").filter({ hasText: "阿灵" }).waitFor();
    assert.equal(state.settings.employeeName, "阿灵");
    await name.fill("x".repeat(21));
    assert(await page.getByRole("button", { name: "保存" }).isDisabled());
    await close();
  }

  // Work log: conversations from every scope, and the follow-up views that left the queue.
  {
    const { page, close } = await open("/digital-employee/work-log");
    await page.getByRole("button", { name: /李静的跟进/ }).waitFor();
    await page.getByRole("button", { name: /获客宝旧对话/ }).click();
    await page.waitForURL("**/digital-employee/work-log/c2");
    await page.getByRole("button", { name: "回到对话" }).click();
    await page.waitForURL("**/digital-employee/chat/c2");
    await page.getByText("获客宝旧对话 的内容").waitFor();
    await page.locator(".de-employee-nav").getByRole("button", { name: "工作记录" }).click();
    await page.getByRole("button", { name: "跟进中" }).click();
    await page.getByText("这个视图目前为空").waitFor();
    await close();
  }

  // The morning brief, the number in the brand area, and asking how a publication went.
  {
    const state = fixtures();
    state.brief = { id: "b1", date: "2026-11-05", counts: { scanned: 12, created: 3, confirm: 4, followUps: 1, results: 2, pending: 7 }, readAt: null };
    state.feedback = [{ id: "dp1", assetId: "as1", title: "双十一海报", platform: "moments", customPlatform: null, deployedAt: NOW }];
    const { page, close } = await open("/digital-employee/today", { state, dailyScan: true });
    await page.getByText("今天看了 12 位客户，新发现 3 条商机。").waitFor();
    await page.waitForFunction(() => document.querySelector(".product-shell-view:not(.is-hidden) .brand-module-badge")?.textContent === "7");
    const badge = page.locator(".product-shell-view:not(.is-hidden) .brand-module-badge");
    await page.waitForResponse("**/today/brief/b1/read").catch(() => {});
    assert.deepEqual(state.briefReads, ["/today/brief/b1/read"]);
    await snap(page, "today-brief-zh-light.png");
    const card = page.getByText("双十一海报 投放满 3 天了，效果怎么样？");
    await card.locator("xpath=ancestor::article").getByRole("button", { name: "回填效果" }).click();
    await page.getByRole("button", { name: "＋ 添加反馈" }).click();
    await page.locator(".de-subdialog input").first().fill("10");
    await page.getByRole("button", { name: "保存反馈" }).click();
    await card.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.querySelector(".product-shell-view:not(.is-hidden) .brand-module-badge")?.textContent === "6");
    assert.equal(await badge.innerText(), "6");
    await close();
  }

  // A desktop notification fires once per brief, even after the app restarts.
  {
    const state = fixtures();
    state.settings.desktopReminder = true;
    state.brief = { id: "b1", date: "2026-11-05", counts: { scanned: 1, created: 1, confirm: 2, followUps: 3, results: 4, pending: 9 }, readAt: null };
    const { page, close } = await open("/assistant", { state, dailyScan: true, desktop: true });
    await page.waitForFunction(() => window.notified?.length === 1);
    assert.deepEqual(await page.evaluate(() => window.notified), [["今日简报", "待确认 2 件，要跟进 3 位客户，等结果 4 个。"]]);
    await page.reload();
    await page.locator(".brand-module-badge").first().waitFor({ state: "attached" });
    assert.deepEqual(await page.evaluate(() => window.notified), []);
    await close();
  }

  // The owner can switch everything off, and the model step and the reminders are separate choices.
  {
    const { page, state, close } = await open("/digital-employee/schedule", { dailyScan: true });
    const toggled = () => page.waitForResponse((response) => response.url().endsWith("/opportunity-settings") && response.request().method() === "PUT");
    await page.getByText("每天看一遍客户").waitFor();
    const clickSwitch = async (name) => {
      const saved = toggled();
      await page.locator("label.de-switch").filter({ hasText: name }).click();
      await saved;
    };
    assert.equal(state.discovery.discoveryMode, "rules");
    await clickSwitch("用模型提前写好建议");
    assert.equal(state.discovery.discoveryMode, "hybrid");
    await page.waitForFunction(() => !document.querySelector(".de-schedule-time input")?.disabled);
    await clickSwitch("用模型提前写好建议");
    assert.equal(state.discovery.discoveryMode, "rules");
    await page.waitForFunction(() => !document.querySelector(".de-schedule-time input")?.disabled);
    await clickSwitch("每天看一遍客户");
    assert.equal(state.discovery.enabled, false);
    await page.waitForFunction(() => document.querySelector(".de-schedule-time input")?.disabled === true);
    const reminder = page.waitForResponse((response) => response.url().endsWith("/settings") && response.request().method() === "PUT");
    await page.locator("label.de-switch").filter({ hasText: "飞书提醒" }).click();
    await reminder;
    assert.equal(state.settings.feishuReminder, true);
    await close();
  }

  // Without the daily scan the page keeps its old promise: that switch costs model money.
  {
    const { page, close } = await open("/digital-employee/schedule");
    await page.getByText("每日自动发现").waitFor();
    assert.equal(await page.getByText("飞书提醒").count(), 0);
    assert.equal(await page.getByText("用模型提前写好建议").count(), 0);
    await close();
  }

  // A conversation in the work log opens as a record of the work, and leads back to the chat.
  {
    const { page, close } = await open("/digital-employee/work-log/c1");
    await page.getByRole("heading", { name: "李静的跟进" }).waitFor();
    await page.getByText("记一下李静嫌门槛高").waitFor();
    await page.getByText("查找客户").waitFor();
    await page.getByText("没有成功").waitFor();
    await page.getByRole("button", { name: "查看画像" }).click();
    await page.waitForURL(`**/digital-employee/customers/${PROFILE}`);
    await page.goBack();
    await page.getByRole("button", { name: "回到对话" }).click();
    await page.waitForURL("**/digital-employee/chat/c1");
    await close();
  }

  // Work preferences save with the settings row; closed lists only.
  {
    const { page, state, close } = await open("/digital-employee/schedule");
    await page.getByLabel("语气").selectOption("concise");
    await page.waitForFunction(() => !document.querySelector(".de-schedule-channels").disabled);
    await page.waitForTimeout(100);
    await page.getByLabel("微信", { exact: true }).click();
    await page.waitForTimeout(300);
    assert.deepEqual(JSON.parse(state.writes.findLast((write) => write.path.endsWith("/settings")).body).preferredChannels, ["wechat"]);
    assert.equal(state.settings.workTone, "concise");
    await close();
  }

  // A failed campaign write says so, keeps what was typed, and a double click sends once.
  {
    const state = fixtures();
    state.failCampaignWrite = true;
    const { page, close } = await open("/digital-employee/marketing", { state });
    await page.getByRole("button", { name: /双十一/ }).click();
    const name = page.locator(".de-campaign-name-row input");
    await name.fill("双十二");
    await page.getByRole("button", { name: "保存名称" }).dblclick();
    await page.getByRole("alert").getByText("保存失败").waitFor();
    assert.equal(state.campaignWrites, 1);
    assert.equal(await name.inputValue(), "双十二");
    state.failCampaignWrite = false;
    await page.getByRole("button", { name: "保存名称" }).click();
    await page.getByRole("alert").waitFor({ state: "detached" });
    assert.equal(state.campaignWrites, 2);
    await close();
  }

  // A dropped file shows what happened to it, a failed upload can be retried, and the list keeps working.
  {
    const documentState = () => ({ ...fixtures(), products: [productFixture], documents: [
      documentFixture({ skippedPages: 2 }),
      documentFixture({ id: "d2", title: "超长手册.pdf", usedInTalkTrack: false }),
      documentFixture({ id: "d3", title: "扫描件.pdf", status: "failed", errorCode: "OCR_REQUIRED", usedInTalkTrack: false }),
      documentFixture({ id: "d4", title: "超时.pdf", status: "failed", errorCode: "PARSE_STALLED", usedInTalkTrack: false }),
    ] });
    const state = documentState();
    state.failUpload = true;
    const { page, close } = await open("/digital-employee/materials", { state });
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "补充资料 3" }).click();
    const dialog = page.getByRole("dialog", { name: "补充资料" });
    await dialog.getByText("已用于话术").first().waitFor();
    await dialog.getByText("有 2 页是图片，暂未读取").waitFor();
    await dialog.getByText("内容太长，话术暂不使用，聊天中仍可查阅").waitFor();
    await dialog.getByText("这份文件是扫描件或图片，暂时读不了文字").waitFor();
    await dialog.getByText("话术可用 3,200 / 15,000 字符").waitFor();
    assert.equal(await dialog.locator("li", { hasText: "扫描件.pdf" }).getByRole("button", { name: "重试" }).count(), 0);
    await dialog.locator("li", { hasText: "超时.pdf" }).getByRole("button", { name: "重试" }).waitFor();

    const file = { name: "手册.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-") };
    await dialog.locator("input[type=file]").setInputFiles(file);
    const failed = dialog.locator("li", { hasText: "手册.pdf" }).filter({ hasText: "上传失败" });
    await failed.waitFor();
    state.failUpload = false;
    await failed.getByRole("button", { name: "重试" }).click();
    await dialog.locator("li", { hasText: "新手册.pdf" }).getByText("已用于话术").waitFor({ timeout: 8000 });
    assert.equal(state.uploads, 2);

    await dialog.locator("li", { hasText: "超长手册.pdf" }).getByRole("button", { name: "删除" }).click();
    await dialog.getByText("超长手册.pdf").waitFor({ state: "detached" });
    await snap(page, "materials-documents-zh-1440.png");
    await close();

    const phone = await open("/digital-employee/materials", { state: documentState(), language: "en", width: 390 });
    await phone.page.getByRole("button", { name: /Supplementary files/ }).click();
    const english = phone.page.getByRole("dialog");
    await english.getByText("Used in outreach messages").first().waitFor();
    await english.getByText("2 pages are images and weren't read").waitFor();
    await english.getByText("3,200 of 15,000 characters available to outreach messages").waitFor();
    assert(await noHorizontalScroll(phone.page), "documents dialog scrolls sideways at 390");
    const copy = (await english.innerText()).replace(/API 网关|费用说明\.docx|超长手册\.pdf|扫描件\.pdf|超时\.pdf/g, "");
    assert(!/[一-鿿]/.test(copy), `documents dialog: untranslated copy: ${copy}`);
    await snap(phone.page, "materials-documents-en-390-light.png");
    await phone.page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await snap(phone.page, "materials-documents-en-390-dark.png");
    await phone.close();
  }

  // A file becomes a one-screen review: blanks are fine, a name is the only thing it insists on.
  {
    const state = { ...fixtures(), products: [productFixture], documents: [documentFixture()] };
    const { page, close } = await open("/digital-employee/materials", { state });
    await page.getByRole("button", { name: "从文件导入" }).waitFor();
    await page.locator(".de-header-actions input[type=file]").setInputFiles({ name: "手册.md", mimeType: "text/markdown", buffer: Buffer.from("# 手册") });
    const row = page.locator(".product-import-strip li", { hasText: "焕颜手册.md" });
    await row.getByText("已读完 3 张图片，继续整理…").waitFor();
    await row.getByText("整理好了：1 个产品，4 条内容").waitFor({ timeout: 8000 });
    await row.getByRole("button", { name: "看一下" }).click();
    const review = page.getByRole("dialog", { name: "确认产品资料" });
    await review.getByText("这几条要你确认").waitFor();
    await review.getByText("文件里没找到这个数字，核对后再勾选").waitFor();
    await review.getByText("这个数字是从图片里读的，核对一下").waitFor();
    await review.getByText("将保存 3 条，空着的以后再补").waitFor();

    assert.equal(await review.getByPlaceholder("这家店叫什么？").inputValue(), "皮肤管理中心");
    await review.getByPlaceholder("这家店叫什么？").fill("焕颜美学");

    await review.getByRole("checkbox", { name: "新客体验价 99 元" }).check();
    await review.locator(".product-import-date input").fill("2026-12-31");
    await review.getByText("将保存 4 条，空着的以后再补").waitFor();
    await review.getByText("已整理 2 条").click();
    const fact = review.locator(".product-import-item", { hasText: "小气泡单次 198 元" });
    await fact.getByRole("button", { name: "修改" }).click();
    await fact.locator("textarea").first().fill("小气泡单次 198 元，60 分钟");
    await fact.getByRole("button", { name: "完成" }).click();

    state.failCommit = true;
    await review.getByRole("button", { name: "保存", exact: true }).click();
    await review.getByText("保存失败，可以重试").waitFor();
    await review.getByRole("checkbox", { name: "新客体验价 99 元" }).isChecked().then((checked) => assert(checked, "a failed save keeps the choices"));
    state.failCommit = false;
    state.commits = 0;
    await review.getByRole("button", { name: "保存", exact: true }).dblclick();
    await page.getByText("已保存到：焕颜美学").waitFor();
    await review.waitFor({ state: "detached" });
    assert.equal(state.commits, 1, "a double click saves once");
    const committed = JSON.parse(state.writes.filter((write) => write.path.endsWith("/commit")).at(-1).body);
    assert.deepEqual(committed.answers, [{ id: "p1-name", answer: "焕颜美学" }]);
    const [sent] = committed.products;
    assert.equal(sent.items.find((item) => item.id === "p1-1").text, "小气泡单次 198 元，60 分钟");
    assert.equal(sent.items.find((item) => item.id === "p1-3").validUntil, "2026-12-31");
    assert.equal(sent.items.find((item) => item.id === "p1-4").selected, false);
    assert.equal(await page.locator(".product-import-strip").count(), 0);
    await close();

    // The today page opens the same review, and a ready file on a product can be sorted later.
    const today = { ...fixtures(), products: [productFixture], documents: [documentFixture()], imports: [importStatusFixture] };
    today.proposals = new Map([["dr1", {
      id: "dr1", kind: "product_import", confirmable: false, conversationId: null, createdAt: "2026-11-06T00:00:00.000Z", expiresAt: "2026-11-13T00:00:00.000Z",
      preview: { title: "焕颜手册.md", products: [{ name: "", target: null, items: 4 }], reviewUrl: importStatusFixture.preview.reviewUrl },
    }]]);
    const home = await open("/digital-employee/today", { state: today });
    const card = home.page.locator(".de-today-card", { hasText: "整理好了：焕颜手册.md" });
    await card.getByText("1 个产品，4 条内容").waitFor();
    assert.equal(await card.getByRole("button", { name: "去对话里选择" }).count(), 0);
    await card.getByRole("button", { name: "看一下" }).click();
    await home.page.getByRole("dialog", { name: "确认产品资料" }).waitFor();
    await home.page.getByRole("button", { name: "关闭" }).first().click();
    await home.page.waitForFunction(() => !window.location.pathname.includes("import"));

    today.imports = [];
    await home.page.getByRole("button", { name: "补充资料 3" }).click();
    await home.page.getByRole("dialog", { name: "补充资料" }).getByRole("button", { name: "整理进资料" }).click();
    await home.page.locator(".product-import-strip").getByText("整理好了：1 个产品，4 条内容").waitFor({ timeout: 8000 });
    await home.close();

    const phone = await open(importStatusFixture.preview.reviewUrl, {
      state: { ...fixtures(), products: [productFixture], documents: [], imports: [importStatusFixture] }, language: "en", width: 390,
    });
    const english = phone.page.getByRole("dialog", { name: "Confirm product info" });
    await english.getByText("Please confirm these").waitFor();
    assert(await noHorizontalScroll(phone.page), "import review scrolls sideways at 390");
    await snap(phone.page, "materials-import-en-390-light.png");
    await phone.page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await snap(phone.page, "materials-import-en-390-dark.png");
    const chrome = (await english.locator(".de-modal-head, .product-import-footer, .product-import-identity, .product-import-group h3").allInnerTexts()).join(" ");
    assert(!/[一-鿿]/.test(chrome.replace(/焕颜手册\.md|API 网关/g, "")), `import review: untranslated copy: ${chrome}`);
    await phone.close();
    await (async () => {
      const wide = await open(importStatusFixture.preview.reviewUrl, {
        state: { ...fixtures(), products: [productFixture], documents: [], imports: [importStatusFixture] },
      });
      await wide.page.getByRole("dialog", { name: "确认产品资料" }).getByText("这几条要你确认").waitFor();
      await snap(wide.page, "materials-import-zh-1440.png");
      await wide.close();
    })();
  }

  // Scheduled work stays hidden until its own switch is on, whatever the daily scan does.
  {
    const { page, close } = await open("/digital-employee/schedule", { dailyScan: true });
    await page.getByText("工作偏好").waitFor();
    assert.equal(await page.getByRole("region", { name: "定时工作" }).count(), 0);
    await close();
    const log = await open("/digital-employee/work-log");
    await log.page.getByRole("heading", { name: "工作记录" }).waitFor();
    assert.equal(await log.page.getByRole("button", { name: "定时工作" }).count(), 0);
    await log.close();
  }

  // An owner adds and removes a schedule; a report waits on the today page; every run stays explained.
  {
    const { page, state, close } = await open("/digital-employee/schedule", { schedules: true });
    const section = page.getByRole("region", { name: "定时工作" });
    await section.getByText("每周一 09:00").waitFor();
    await section.getByLabel("工作内容").selectOption("follow_up_prep");
    await section.getByLabel("重复").selectOption("daily");
    await section.getByRole("button", { name: "添加" }).click();
    await section.getByText("每天 08:30").waitFor();
    await section.getByRole("button", { name: "删除" }).first().click();
    await section.getByText("每周一 09:00").waitFor({ state: "detached" });
    assert.equal(state.schedules.length, 1);
    assert.deepEqual(state.schedules[0].timing, { kind: "daily", hour: 8, minute: 30 });
    await close();

    const reportState = fixtures();
    const run = reportState.runs[0];
    reportState.reports = [{
      id: "report:r1", kind: "report", subject: null, title: run.template, reason: run.report.summary, evidence: [], priority: "high", dueAt: NOW,
      source: { type: "schedule_run", id: "r1" }, scheduleRun: run,
    }];
    const today = await open("/digital-employee/today", { schedules: true, state: reportState });
    const reports = today.page.getByRole("region", { name: "定时工作" });
    await reports.getByText("李静这周还在考虑吗？").waitFor();
    await reports.getByRole("button", { name: "查看" }).click();
    await today.page.waitForURL("**/digital-employee/work-log/scheduled/r1");
    await today.page.getByText("先问门槛").waitFor();
    await today.page.getByRole("button", { name: "返回" }).click();
    await today.page.getByText("已跳过 · 额度不足").waitFor();
    await today.page.goto(`${origin}/digital-employee/today`);
    await reports.getByRole("button", { name: "知道了" }).click();
    await reports.waitFor({ state: "detached" });
    await today.close();
  }

  // The model list opens upward from the composer and must not be cut off by what surrounds it.
  for (const [view, width, height] of [["today", 1440, 1000], ["today", 1440, 620], ["customers", 1280, 800], ["chat", 1440, 1000], ["chat", 1440, 620],
    ["chat", 390, 700]]) {
    const { page, close } = await open(`/digital-employee/${view}`, { width, height });
    await page.locator(".de-employee-card").waitFor({ state: "attached" });
    await page.locator(".product-shell-view:not(.is-hidden) .model-picker .media-trigger").click();
    const search = page.locator(".model-popup .model-search");
    await search.waitFor();
    await snap(page, `model-popup-${view}-${width}x${height}.png`);
    const cutOff = await page.locator(".model-popup").evaluate((popup) => {
      const { left, right, top, bottom } = popup.getBoundingClientRect();
      const x = (left + right) / 2;
      return [top + 6, (top + bottom) / 2, bottom - 6].filter((y) => !popup.contains(document.elementFromPoint(x, y)));
    });
    assert.deepEqual(cutOff, [], `${view} ${width}x${height}: model list is cut off`);
    await search.fill("llm-12");
    await page.locator(".model-popup .model-row").filter({ hasText: "test-llm-12" }).click();
    await page.locator(".model-popup").waitFor({ state: "detached" });
    await close();
  }

  // Off by default: nothing about tasks shows until a deployment opts in.
  {
    const { page, close } = await open("/digital-employee/today");
    await page.locator(".de-employee-card").waitFor();
    assert.equal(await page.locator(".de-employee-nav").getByRole("button", { name: "任务分派" }).count(), 0);
    await close();
  }

  // Tasks: cards by day, open ones carried up, search, and everything an owner can do to one.
  {
    const { page, state, close } = await open("/digital-employee/today", { assignments: true });
    await page.locator(".de-employee-nav").getByRole("button", { name: "任务分派" }).click();
    await page.waitForURL("**/digital-employee/assignments");
    await page.getByRole("heading", { name: "任务分派" }).waitFor();

    const days = page.locator(".de-assignment-day");
    await days.first().getByRole("heading", { name: "还没结束" }).waitFor();
    assert.deepEqual(await days.first().locator("strong").allTextContents(), ["写活动海报"]);
    assert.match(await days.first().locator(".de-assignment-card-main small").innerText(), /\d+\/\d+/);
    await days.nth(1).getByRole("heading", { name: /^今天/ }).waitFor();
    assert.deepEqual(await days.nth(1).locator("strong").allTextContents(), ["写开业优惠方案", "整理客户清单"]);
    await days.nth(1).getByText("正在：联网搜索").waitFor();
    await days.nth(2).getByText("有操作的结果没有确认").waitFor();

    await page.getByText("还没接入飞书").waitFor();
    await page.getByRole("button", { name: "附文件" }).waitFor();
    await page.locator('.de-assignment-composer input[type="file"]').setInputFiles({ name: "手册.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-") });
    await page.locator(".de-assignment-files").getByText("手册.pdf").waitFor();
    await page.getByText("更多设置").click();
    await page.getByLabel("费用上限（积分）").fill("500");
    await page.getByRole("textbox", { name: "交代一件事" }).fill("查查附近的开业活动");
    await page.getByRole("button", { name: "开始", exact: true }).click();
    await days.nth(1).getByText("查查附近的开业活动", { exact: true }).first().waitFor();
    const created = JSON.parse(state.writes.findLast((entry) => entry.path.endsWith("/assignments")).body);
    assert.deepEqual(created, {
      goal: "查查附近的开业活动", mode: "autonomous", attachments: [{ assetId: "asset1", filename: "手册.pdf" }], creditLimit: 500, subtasks: [], subtaskLimit: null,
    });

    await days.first().getByRole("button", { name: "继续", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".de-assignment-card em")?.textContent !== "已暂停");
    assert.equal(state.assignments.find((item) => item.id === "t3").pausedReason, null);

    await page.getByRole("button", { name: "最近 7 天" }).click();
    await page.getByLabel("关键词").fill("客户");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".de-assignment-card").length === 1);
    const query = state.assignmentQueries.at(-1);
    assert.equal(query.q, "客户");
    assert.equal(query.openBefore, undefined);
    assert.ok(new Date(query.to) - new Date(query.from) > 6 * 86_400_000 && !Number.isNaN(Date.parse(query.from)));
    await page.getByRole("button", { name: "清除" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".de-assignment-card").length > 1);

    await page.locator(".de-assignment-card-main").filter({ hasText: "整理客户清单" }).click();
    await page.waitForURL("**/digital-employee/assignments/t2");
    await page.getByRole("heading", { name: "整理客户清单" }).waitFor();
    await page.getByText("整理好了 12 位客户").waitFor();
    await page.getByText("按最近联系排序").waitFor();
    await page.getByText("两位王总没有更新").waitFor();
    assert.equal(await page.getByRole("link", { name: "下载" }).getAttribute("download"), "方案.docx");
    await page.getByRole("button", { name: "有内容等你审阅" }).click();
    await page.waitForURL("**/digital-employee/materials/import/d1");

    await page.goto(`${origin}/digital-employee/assignments/t1`);
    await page.getByRole("button", { name: "取消任务" }).click();
    await page.locator(".de-assignment-status").getByText("已取消").waitFor();
    assert.equal(await page.getByRole("button", { name: "取消任务" }).count(), 0);
    await close();

    const phone = await open("/digital-employee/assignments", { assignments: true, width: 390 });
    await phone.page.locator(".de-assignment-card").first().waitFor();
    assert.equal(await phone.page.locator(".de-assignment-filters").isVisible(), false);
    await phone.page.locator(".de-assignment-filter-toggle").click();
    await phone.page.locator(".de-assignment-filters").waitFor();
    assert.equal(await phone.page.evaluate(() => getComputedStyle(document.querySelector(".de-assignment-list")).gridTemplateColumns.split(" ").length), 1);
    await phone.close();
  }

  // Responsive tasks: choosing the mode, answering a question, a failure that needs checking first, and where an owner finds them.
  {
    const state = decisionTasks(fixtures());
    const { page, close } = await open("/digital-employee/assignments", { assignments: true, state });
    await page.locator(".de-employee-nav").getByRole("button", { name: /任务分派/ }).locator("b").getByText("3").waitFor();
    await page.getByRole("radio", { name: "及时响应" }).check();
    await page.getByText("员工停下来问你").waitFor();
    await page.getByText("要回到这里才能看到问题和结果").waitFor();
    await page.getByRole("textbox", { name: "交代一件事" }).fill("给张姐记跟进");
    await page.getByRole("button", { name: "开始", exact: true }).click();
    await page.getByRole("textbox", { name: "交代一件事" }).and(page.locator(":not(:disabled)")).waitFor();
    await page.waitForFunction(() => document.querySelector(".de-assignment-composer textarea")?.value === "");
    assert.equal(JSON.parse(state.writes.findLast((entry) => entry.path.endsWith("/assignments")).body).mode, "responsive");

    const card = page.locator(".de-assignment-card").filter({ hasText: "给王总记跟进" });
    await card.getByText("等你决定").waitFor();
    await card.getByText("及时响应").waitFor();
    await page.locator(".de-assignment-card").filter({ hasText: "同步价格" }).getByRole("button", { name: "回答" }).waitFor();
    await card.getByRole("button", { name: "回答" }).click();
    await page.waitForURL("**/digital-employee/assignments/t5");
    await page.getByText("哪位王总？").waitFor();
    await page.getByRole("button", { name: "华南的王总" }).click();
    await page.waitForFunction(() => !document.querySelector(".de-decision-card"));
    assert.deepEqual(JSON.parse(state.writes.findLast((entry) => entry.path.endsWith("/decisions/q1/answer")).body), { text: "华南的王总" });

    await page.goto(`${origin}/digital-employee/assignments/t6`);
    await page.getByText("有 1 项操作的结果没有确认").waitFor();
    assert.equal(await page.getByRole("button", { name: "重试" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "换个做法" }).isDisabled(), true);
    await page.getByText("核实操作结果").waitFor();
    Object.assign(state.assignments.find((item) => item.id === "t6"), {
      unverified: 0,
      decisions: [decisionFixture({
        id: "f1", assignmentId: "t6", rootId: "t6", kind: "failure", question: "", options: ["retry", "skip", "change", "end"], failureReason: "unknown_outcome",
      })],
    });
    await page.waitForFunction(() => [...document.querySelectorAll(".de-decision-card button")].find((item) => item.textContent === "重试")?.disabled === false);
    await page.getByRole("button", { name: "换个做法" }).click();
    await page.getByRole("textbox", { name: "换个做法" }).fill("先查现价再改");
    await page.getByRole("button", { name: "就这样做" }).click();
    await page.waitForFunction(() => !document.querySelector(".de-decision-card"));
    assert.deepEqual(JSON.parse(state.writes.findLast((entry) => entry.path.endsWith("/decisions/f1/answer")).body), { choice: "change", text: "先查现价再改" });
    await close();

    const today = decisionTasks(fixtures());
    const todayPage = await open("/digital-employee/today", { assignments: true, state: today });
    const section = todayPage.page.getByRole("region", { name: "任务等你决定" });
    await section.getByText("哪位王总？").waitFor();
    await section.getByText("额度不足或 Key 不可用").waitFor();
    await section.getByRole("button", { name: "华东的王总" }).click();
    await todayPage.page.waitForFunction(() => !document.body.textContent.includes("哪位王总？"));
    await section.getByRole("button", { name: "去核实" }).click();
    await todayPage.page.waitForURL("**/digital-employee/assignments/t6");
    await todayPage.close();

    const english = decisionTasks(fixtures());
    const phone = await open("/digital-employee/assignments/t6", { assignments: true, state: english, language: "en", width: 390 });
    await phone.page.locator(".de-decision-card").waitFor();
    assert.equal(/[\u4e00-\u9fa5]/.test(await phone.page.locator(".de-decision-card").innerText()), false, "untranslated decision card");
    assert.ok(await noHorizontalScroll(phone.page), "decision card overflows at phone width");
    await snap(phone.page, "assignment-decision-en-390-light.png");
    await phone.page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await snap(phone.page, "assignment-decision-en-390-dark.png");
    await phone.close();

    const notified = decisionTasks(fixtures());
    notified.taskActivity = { open: 1, waiting: 1, cursor: "9", events: [
      { id: "8", rootId: "t5", kind: "decision", title: "给王总记跟进", status: null },
      { id: "9", rootId: "t2", kind: "finished", title: "整理客户清单", status: "succeeded" },
    ] };
    const desktop = await open("/assistant", { assignments: true, state: notified, desktop: true });
    await desktop.page.waitForFunction(() => window.notified?.length === 2);
    assert.deepEqual(await desktop.page.evaluate(() => window.notified), [["任务等你决定", "给王总记跟进"], ["任务做完了", "整理客户清单"]]);
    assert.equal(await desktop.page.evaluate(() => localStorage.getItem("lot:employee-task-events")), "9");
    await desktop.page.reload();
    await desktop.page.waitForFunction(() => document.readyState === "complete");
    await desktop.page.waitForTimeout(300);
    assert.deepEqual(await desktop.page.evaluate(() => window.notified), []);
    assert.equal(notified.summaryCursors.at(-1), "9");
    await desktop.close();
  }

  // Subtasks: splitting at creation, watching them work, and acting on one without touching the rest.
  {
    const state = teamTasks(fixtures());
    const { page, close } = await open("/digital-employee/assignments", { assignments: true, state });
    await page.locator(".de-assignment-card").filter({ hasText: "整理名单" }).getByText("部分完成").waitFor();
    await page.getByText("更多设置").click();
    await page.getByLabel("子任务（一行一个").fill("搜同行\n\n写方案");
    await page.getByLabel("子任务数量上限").fill("5");
    await page.getByRole("textbox", { name: "交代一件事" }).fill("开业活动");
    await page.getByRole("button", { name: "开始", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".de-assignment-composer textarea")?.value === "");
    const created = JSON.parse(state.writes.findLast((entry) => entry.path.endsWith("/assignments")).body);
    assert.deepEqual(created.subtasks, ["搜同行", "写方案"]);
    assert.equal(created.subtaskLimit, 5);

    await page.goto(`${origin}/digital-employee/assignments/team1`);
    const list = page.locator(".de-subtasks");
    await list.getByText("子任务 1：搜同行").waitFor();
    await list.getByText("搜到 3 家店").waitFor();
    assert.equal(await list.getByText("海报做好了").isVisible(), false, "finished subtasks start folded");
    await list.getByText("已结束 1 个").click();
    await list.getByText("海报做好了").waitFor();

    await list.locator(".de-subtask-card").first().getByRole("button", { name: "执行步骤" }).click();
    await list.getByText("发布到工作板").waitFor();
    await list.locator(".de-subtask-card").filter({ hasText: "写方案" }).getByRole("button", { name: "重试" }).click();
    await page.waitForFunction(() => !document.querySelector(".de-subtasks")?.textContent.includes("模型调用失败"));
    assert.ok(state.writes.some((entry) => entry.path.endsWith("/subtasks/s2/retry")));
    await list.locator(".de-subtask-card").first().getByRole("button", { name: "取消" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".de-subtask-card")].some((card) => card.textContent.includes("搜同行") && card.textContent.includes("已取消")));
    assert.ok(state.writes.some((entry) => entry.path.endsWith("/subtasks/s1/cancel")));

    await list.getByLabel("加一个子任务").fill("查价格");
    await list.getByRole("button", { name: "添加" }).click();
    await list.getByText("子任务 4：查价格").waitFor();

    const board = page.locator(".de-board");
    await board.getByText("同行都送体验券").click();
    await board.getByText("折扣集中在七到八折").waitFor();
    await board.getByText("没有完成：写方案").waitFor();
    await board.getByText("新增子任务：做海报").waitFor();
    await close();

    const english = teamTasks(fixtures());
    const phone = await open("/digital-employee/assignments/team1", { assignments: true, state: english, language: "en", width: 390 });
    await phone.page.locator(".de-subtasks").waitFor();
    const ownText = (await phone.page.locator(".de-subtasks, .de-board").allInnerTexts()).join("\n").replace(/搜同行|写方案|做海报|搜到 3 家店|开业活动|同行都送体验券/g, "");
    assert.equal(/[\u4e00-\u9fa5]/.test(ownText), false, `untranslated team copy: ${ownText}`);
    assert.ok(await noHorizontalScroll(phone.page), "team view overflows at phone width");
    await snap(phone.page, "assignment-team-en-390-light.png");
    await phone.page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await snap(phone.page, "assignment-team-en-390-dark.png");
    await phone.close();
  }

  // Coming back to a finished task, and finding tasks in the work record.
  {
    const state = fixtures();
    const { page, close } = await open("/digital-employee/assignments/t2", { assignments: true, state });
    const form = page.locator(".de-assignment-follow-up");
    await form.getByRole("heading", { name: "继续追问" }).waitFor();
    assert.equal(await form.getByRole("button", { name: "继续做" }).isDisabled(), true);
    await form.getByRole("textbox").fill("再写一版更便宜的");
    await form.getByRole("button", { name: "继续做" }).click();
    await page.waitForFunction(() => !document.querySelector(".de-assignment-follow-up"));
    assert.deepEqual(JSON.parse(state.writes.findLast((entry) => entry.path.endsWith("/follow-up")).body), { text: "再写一版更便宜的" });
    await page.getByText("整理好了 12 位客户").waitFor();

    await page.goto(`${origin}/digital-employee/assignments/t1`);
    await page.getByRole("heading", { name: "写开业优惠方案" }).waitFor();
    assert.equal(await page.locator(".de-assignment-follow-up").count(), 0, "an open task has no follow-up");

    await page.goto(`${origin}/digital-employee/work-log/tasks`);
    const row = page.locator(".de-work-log-list article").filter({ hasText: "写活动海报" });
    await row.getByText("已暂停").waitFor();
    await row.getByRole("button").click();
    await page.waitForURL("**/digital-employee/assignments/t3");
    await close();

    const off = await open("/digital-employee/work-log", { assignments: false });
    await off.page.locator(".de-employee-tabs").waitFor();
    assert.equal(await off.page.locator(".de-employee-tabs").getByRole("button", { name: "任务", exact: true }).count(), 0);
    await off.close();
  }

  // Two languages, two themes, phone width.
  for (const [view, name] of [["assignments", "assignments"], ["assignments/t3", "assignment-detail"], ["assignments/t2", "assignment-result"], ["today", "today"], ["customers", "customers"], [`customers/${PROFILE}`, "detail"], ["marketing", "marketing"],
    ["materials", "materials"], ["work-log", "work-log"], ["work-log/c1", "work-detail"], ["work-log/scheduled", "work-scheduled"],
    ["work-log/scheduled/r1", "scheduled-run"], ["schedule", "schedule"], ["chat", "chat"]]) {
    const path = `/digital-employee/${view}`;
    const desktop = await open(path, { schedules: true, assignments: true });
    await desktop.page.locator(".de-employee-card").waitFor();
    await desktop.close();

    const { page, close } = await open(path, { language: "en", width: 390, schedules: true, assignments: true });
    await page.locator(".de-employee-card").waitFor({ state: "attached" });
    await page.waitForLoadState("networkidle");
    assert(await noHorizontalScroll(page), `${name} scrolls sideways at 390`);
    const leftovers = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.querySelector(".product-shell-view:not(.is-hidden) .workspace-main"), NodeFilter.SHOW_TEXT);
      const found = [];
      while (walker.nextNode()) {
        const text = walker.currentNode.textContent.trim();
        if (/[一-鿿]/.test(text)) found.push(text);
      }
      return found;
    });
    const taskFixtures = /整理本周客户|方案\.docx|焕颜美学|写开业优惠方案|查同行开业|整理客户清单|整理好了|按最近联系|两位王总|写活动海报|做一张海报|同步产品资料/;
    const fixtureText = /已记录。|先问门槛|今天 1 位客户|李静|王总|张姐|明天跟进|确认门槛|新客户|想了解价格|代销|云启|华东|集中问价|嫌门槛高|了解顾虑|问了代销|回访|双十一|边缘算力|咨询|获客|上海|潜客|共 1 位|朋友圈|小灵|的内容|好的/;
    assert.deepEqual(leftovers.filter((text) => !fixtureText.test(text) && !taskFixtures.test(text)), [], `${name}: untranslated copy`);
    await snap(page, `${name}-en-390-light.png`);
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await snap(page, `${name}-en-390-dark.png`);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await snap(page, `${name}-en-1440-dark.png`);
    await close();
  }

  assert.deepEqual(errors, []);
  assert.deepEqual([...new Set(unexpected)], []);
  console.log("Digital employee UI passed");
} catch (error) {
  // The first failure usually follows from an earlier unexpected request or page error.
  console.error({ errors, unexpected: [...new Set(unexpected)] });
  throw error;
} finally {
  await browser?.close();
  await vite?.close();
  await rm(temp, { recursive: true, force: true });
}
