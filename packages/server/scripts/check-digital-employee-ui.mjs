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
    settings: { employeeName: "小灵", feishuReminder: false, desktopReminder: false, version: 0 },
    focusWrites: [], writes: [],
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

function api(state, unexpected, dailyScan = false) {
  return async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (!path.startsWith("/api/")) return route.continue();
    const json = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    const de = path.replace("/api/digital-employee", "");
    if (method !== "GET") state.writes.push({ path, body: request.postData() });
    if (path === "/api/public/product") return json({ globle: 1, digitalEmployeeDailyScan: dailyScan });
    if (path === "/api/agents") return json([
      { id: "general", name: "通用助手", description: "通用", type: "general", installed: true, sortOrder: 0 },
      { id: "digital_employee", name: "数字员工", description: "独立模块", type: "digital_employee", installed: true, sortOrder: 1 },
    ]);
    if (path === "/api/models") return json({ llm: [{ id: "test-llm", type: "llm", provider: "test" }], image: [], video: [] });
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
    if (de === "/marketing/products") return json({ items: [], total: 0, page: 1, limit: 20 });
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

  async function open(path, { dailyScan = false, language = "zh", width = 1440, state = fixtures(), desktop = false } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.addInitScript((value) => { try { localStorage.setItem("lot:language", value); } catch { /* opaque origin */ } }, language);
    if (desktop) await context.addInitScript(() => {
      window.notified = [];
      const notify = (title, body) => window.notified.push([title, body]);
      window.lotDesktop = new Proxy({ notify }, { get: (bridge, key) => bridge[key] ?? (async () => undefined) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => errors.push(`${path}: ${error.message}`));
    await page.route("**/api/**", api(state, unexpected, dailyScan));
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

  // Two languages, two themes, phone width.
  for (const [view, name] of [["today", "today"], ["customers", "customers"], [`customers/${PROFILE}`, "detail"], ["marketing", "marketing"],
    ["materials", "materials"], ["work-log", "work-log"], ["schedule", "schedule"], ["chat", "chat"]]) {
    const path = `/digital-employee/${view}`;
    const desktop = await open(path);
    await desktop.page.locator(".de-employee-card").waitFor();
    await desktop.close();

    const { page, close } = await open(path, { language: "en", width: 390 });
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
    const fixtureText = /李静|王总|张姐|明天跟进|确认门槛|新客户|想了解价格|代销|云启|华东|集中问价|嫌门槛高|了解顾虑|问了代销|回访|双十一|边缘算力|咨询|获客|上海|潜客|共 1 位|朋友圈|小灵|的内容|好的/;
    assert.deepEqual(leftovers.filter((text) => !fixtureText.test(text)), [], `${name}: untranslated copy`);
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
