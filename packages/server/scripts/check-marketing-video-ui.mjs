/** Real Workspace UI with in-memory API fixtures; no user data or model calls.
 * PLAYWRIGHT_MODULE=/path/to/playwright node packages/server/scripts/check-marketing-video-ui.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const { planMarketingSegments, storyboardScript, marketingReviewText } = await import(new URL("../../../packages/core/dist/marketing-video/index.js", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { createServer } = createRequire(resolve(root, "packages/web/package.json"))("vite");
const temp = await realpath(await mkdtemp(join(tmpdir(), "lot-marketing-video-")));
let vite, browser, page;
const errors = [], writes = [], unexpectedRequests = [];
const screenshotDir = process.env.MARKETING_SCREENSHOTS_DIR;
try {
  await writeFile(join(temp, "index.html"), '<div id="root"></div><script type="module" src="/main.tsx"></script>');
  await writeFile(join(temp, "main.tsx"), `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {Workspace} from ${JSON.stringify(resolve(root, "packages/web/src/pages/Workspace.tsx"))};
    import {LanguageProvider} from ${JSON.stringify(resolve(root, "packages/web/src/i18n/index.tsx"))};
    import {setToken} from ${JSON.stringify(resolve(root, "packages/web/src/api/client.ts"))};
    import ${JSON.stringify(resolve(root, "packages/web/src/App.css"))};
    setToken('agent-navigation-test');
    const modelCatalog = {llm:[{id:'test-llm',type:'llm',provider:'test'}],image:[{id:'gpt-image-2',type:'image',provider:'test'}],video:[{id:'doubao-seedance-2.5',type:'video',provider:'test'}]};
    createRoot(document.getElementById('root')).render(<LanguageProvider><Workspace user={{id:'fixture',name:'测试用户'}} modelCatalog={modelCatalog} onLogout={()=>{}} /></LanguageProvider>);`);
  vite = await createServer({ configFile: false, root: temp, esbuild: { jsx: "automatic" }, optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-markdown", "remark-gfm"] }, resolve: { alias: { react: resolve(root, "packages/web/node_modules/react"), "react-dom": resolve(root, "packages/web/node_modules/react-dom"), "react-markdown": resolve(root, "packages/web/node_modules/react-markdown"), "remark-gfm": resolve(root, "packages/web/node_modules/remark-gfm") } }, server: { host: "127.0.0.1", port: 0, fs: { allow: [root, temp] } } });
  await vite.listen();
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => { if (!localStorage.getItem("lot:language")) localStorage.setItem("lot:language", "zh"); });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  const agents = [
    ["general", "通用助手", "通用 AI 助手"],
    ["image", "图片生成", "文字描述生成配图/封面/海报"],
    ["video", "视频生成", "脚本/描述生成短视频"],
    ["marketing_video", "营销影像", "分步制作探店店铺介绍、主播宣传演讲视频"],
    ["ppt", "PPT 制作", "明确受众与目标，确认可编辑大纲，生成带图表的 PPT 并逐页预览修改"],
    ["contract", "合同对比", "上传新旧两版合同，找出条款增删、内容变化与主体变更"],
    ["digital_employee", "数字员工", "独立模块"],
  ].map(([id, name, description], sortOrder) => ({ id, name, description, type: id, installed: true, sortOrder }));
  const conversations = agents.filter((a) => a.id !== 'digital_employee').map((a) => ({ id: `history-${a.id}`, title: `${a.id} 历史记录`, agent_id: a.id, created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z' }));
  let taskState = 'running', sequence = 0;
  let apiUnavailable = true;
  let failNextReview = false, failNextStoryboard = false;
  let holdNextSave = false, releaseSave;
  const projects = new Map();
  const script = '欢迎来到转角咖啡店。我们用现磨咖啡迎接每一位客人，明亮的空间适合休息和聊天。你可以选择喜欢的位置，点上一杯手冲咖啡，慢慢享受今天的时光。欢迎来店里坐一坐，发现属于你的咖啡时刻。';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const wav = Buffer.alloc(44 + 16000 * 3 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  const library = [
    { id: 'portrait', title: '我的肖像', mime: 'image/png', sourceType: 'image', tags: ['digital-twin:portrait'], size: png.length },
    { id: 'voice', title: '我的声音', mime: 'audio/wav', sourceType: 'audio', tags: ['digital-twin:voice'], size: wav.length },
  ];
  const generated = new Map();
  const resultAssets = [{ url: '/static/fixture.mp4', mime: 'video/mp4' }];
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    // Simulate older responses omitting optional/new empty fields, including copy and publication.
    const json = (data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data, (key, value) => key === 'storyboard' && Array.isArray(value) && !value.length ? undefined : value) });
    if (request.method() !== 'GET') writes.push({ path, body: request.headers()["content-type"]?.includes("application/json") ? request.postDataJSON() : null });
    if (path === '/api/public/product') return json({ globle: 1 });
    if (path === '/api/marketing-video-analyses/capabilities') return json({ enabled: false });
    if (apiUnavailable && path.startsWith('/api/marketing-videos')) return route.fulfill({ status: 404, contentType: 'text/plain', body: '404 Not Found' });
    if (path === '/api/marketing-videos/capabilities') return json({ composition: true, subtitles: false, knowledge: true, douyinPublish: false });
    if (path === '/api/marketing-videos') return json({ data: [...projects.values()] });
    if (path.endsWith('/text-operations')) return json({ data: [] });
    if (path === '/api/marketing-videos/copy') {
      const body = request.postDataJSON(), p = projects.get(body.projectId);
      assert(p); assert.equal(body.version, p.version);
      p.version++; p.draft = { ...body.draft, storyboard: planMarketingSegments(script, body.draft.durationSec).map(part => ({ durationSec: part.durationSec, script: part.script, visual: '咖啡店', action: '展示咖啡', camera: '中景' })), script, publishTitle: '来发现你的下一杯咖啡', tags: '#探店 #咖啡' };
      return json({ project: p, analysis: '开场介绍店铺，展示卖点，邀请到店。' });
    }
    if (path.startsWith('/api/marketing-videos/')) {
      const [, , , id, action] = path.split('/');
      if (request.method() === 'PUT') {
        if (holdNextSave) { holdNextSave = false; await new Promise(resolve => { releaseSave = resolve; }); }
        const body = request.postDataJSON(), old = projects.get(id);
        assert.equal(body.version, old?.version ?? 0);
        const p = { ...(old ?? { id, status: 'draft', progress: 0, taskId: null, review: null, reviewedScript: null, knowledgeItemId: null }), version: body.version + 1, draft: body.draft, updatedAt: new Date().toISOString() };
        if (p.reviewedScript !== marketingReviewText(p.draft)) p.review = null;
        projects.set(id, p); return json(p);
      }
      const p = projects.get(id); assert(p, `project ${id} missing`);
      if (action === 'storyboard') {
        if (failNextStoryboard) { failNextStoryboard = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'AI 分镜生成失败，原分镜已保留，请重试。' }) }); }
        const body = request.postDataJSON(); assert.equal(body.version, p.version);
        const current = p.draft.storyboard.length ? p.draft.storyboard : planMarketingSegments(p.draft.script, p.draft.durationSec).map(part => ({ durationSec: part.durationSec, script: part.script, visual: '木质吧台和咖啡产品特写', action: '自然讲述并展示咖啡', camera: '缓慢推近' }));
        const shots = current.map((shot, index) => body.instruction && (body.index === undefined || body.index === index) ? { ...shot, camera: 'AI 调整镜头' } : shot);
        p.version++; p.draft = { ...p.draft, storyboard: shots, script: storyboardScript(shots) }; p.review = null;
        return json(p);
      }
      if (action === 'review') {
        if (failNextReview) { failNextReview = false; return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ code: 'MARKETING_TEXT_TRUNCATED', error: '模型输出未完成，请重试；当前文案已保留。' }) }); }
        p.review = { verdict: 'pass', issues: [] }; p.reviewedScript = marketingReviewText(p.draft); return json(p);
      }
      if (action === 'publication') { p.version++; p.draft.publishTitle = '手冲咖啡与惬意时光'; p.draft.tags = '#咖啡'; p.review = null; return json(p); }
      if (action === 'generate') { p.taskId = 'fixture-task'; p.status = taskState; p.progress = 35; p.stage = '片段完成 1/2'; return json(p); }
      if (action === 'archive') { p.knowledgeItemId = 'knowledge-video'; p.knowledgeVersion = p.version; return json({ itemId: p.knowledgeItemId, version: p.version }); }
      if (p.taskId) { p.status = taskState; if (taskState === 'succeeded') p.output = { assets: resultAssets, assetIds: ['video-asset'] }; }
      return json(p);
    }
    if (path === '/api/uploads') { sequence++; return json({ assetId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`, filename: 'asset', mime: request.postDataBuffer()?.includes(Buffer.from('audio/wav')) ? 'audio/wav' : 'image/png', url: `/static/upload-${sequence}.png`, size: 100 }); }
    if (path.endsWith('/items')) return json({ data: library.filter((item) => item.tags.includes(new URL(request.url()).searchParams.get('tag'))), nextCursor: null });
    if (path.endsWith('/content')) { const voice = path.includes('/voice/'); return route.fulfill({ contentType: voice ? 'audio/wav' : 'image/png', body: voice ? wav : png }); }
    if (path === '/api/agents') return json(agents);
    if (path === '/api/conversations/projects') return json([]);
    if (path === '/api/conversations') {
      if (request.method() === 'POST') {
        const conv = { id: 'new-chat', title: '新对话', agent_id: request.postDataJSON().agentId, metadata: { videoPublication: request.postDataJSON().videoPublication }, created_at: '', updated_at: '' };
        conversations.unshift(conv); return json(conv);
      }
      return json({ items: conversations, nextCursor: null });
    }
    if (path.startsWith('/api/conversations/')) {
      const id = path.split('/')[3];
      if (path.endsWith('/generations')) {
        generated.set(id, request.postDataJSON());
        return json({ taskId: 'fixture-task', userMessage: { id: 'new-user' }, assistantMessage: { id: 'new-generation', metadata: {} } });
      }
      if (generated.has(id)) return json({ ...conversations.find(c => c.id === id), messages: [
        { id: 'new-user', role: 'user', content: generated.get(id).prompt },
        { id: 'new-generation', role: 'assistant', content: '', metadata: { kind: 'generation', mediaType: 'video', status: taskState === 'running' ? 'generating' : 'completed', taskId: 'fixture-task', assets: resultAssets } },
      ] });
      const conv = conversations.find((c) => c.id === id);
      if (conv) return json({ ...conv, messages: [
        { id: `${id}-user`, role: 'user', content: `${conv.agent_id} 之前的问题` },
        { id: `${id}-answer`, role: 'assistant', content: conv.agent_id === 'video' ? '' : `${conv.agent_id} 之前的回答`,
          ...(conv.agent_id === 'video' ? { metadata: { kind: 'generation', mediaType: 'video', status: 'generating', taskId: 'fixture-task' } } : {}) },
      ] });
    }
    if (path === '/api/tasks/fixture-task') return json({ id: 'fixture-task', status: taskState, progress: 35, output: { assets: resultAssets } });
    if (path === '/api/usage/balance') return json({ balance: 100, totalUsed: 0, totalRecharged: 100, usedRatio: 0 });
    if (path === '/api/knowledge-bases') return json([]);
    if (path.endsWith('/status')) return json({ ingestionEnabled: false });
    if (path.endsWith('/storage')) return json({ storedBytes: 0 });
    if (path.endsWith('/collections') || path.endsWith('/items')) return json({ data: [], nextCursor: null });
    unexpectedRequests.push(path);
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}`);
  const snap = async (name) => { if (screenshotDir) { await mkdir(screenshotDir, { recursive: true }); await page.screenshot({ path: join(screenshotDir, name), animations: 'disabled' }); } };
  const chooseAgent = async (name) => { await page.locator('.agent-grid-toggle[aria-controls]').click(); await page.locator('.agent-launcher-grid').getByRole('button', { name, exact: true }).click(); };
  await page.locator('.agent-launcher-item').nth(2).waitFor();
  assert.deepEqual(await page.locator('.agent-launcher-item > span:nth-child(2)').allTextContents(), ['通用助手', '营销影像', '图片生成']);
  await page.locator('.agent-grid-toggle[aria-controls]').click();
  assert.equal(await page.locator('.agent-launcher-item > span:nth-child(2)').nth(1).textContent(), '营销影像');
  await page.locator('.agent-grid-toggle[aria-controls]').click();
  await chooseAgent('营销影像');
  await page.getByRole('heading', { name: '确定文案', exact: true }).waitFor();
  assert.equal(await page.locator('.mv-steps button').count(), 3);
  await page.getByRole('alert').filter({ hasText: '当前服务器尚不支持新版营销视频' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '生成文案和分镜', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '保存草稿', exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel('产品、卖点和目标顾客', { exact: true }).isDisabled(), true);
  assert.equal(writes.filter(r => r.path.startsWith('/api/marketing-videos')).length, 0);
  await snap('marketing-video-unavailable.png');
  apiUnavailable = false;
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  await page.getByRole('button', { name: '重新连接', exact: true }).waitFor({ state: 'hidden' });
  await snap('marketing-video-start.png');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '请先填写' }).waitFor();
  await page.getByLabel('产品、卖点和目标顾客', { exact: true }).fill('为转角咖啡店介绍手冲咖啡和明亮的环境。');
  await page.getByRole('button', { name: '拆解爆款文案', exact: true }).click();
  await page.getByRole('checkbox', { name: '文字文案', exact: true }).check();
  await page.getByLabel('视频链接或参考文案').fill('先展示店铺环境，再讲特色，最后邀请到店。');
  failNextReview = true;
  await page.getByRole('button', { name: '一键拆解并生成', exact: true }).click();
  await page.getByRole('heading', { name: '生成分镜', exact: true }).waitFor();
  await page.getByRole('button', { name: '检查当前文案', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '模型输出未完成，请重试；当前文案已保留。' }).waitFor();
  assert.equal(await page.getByLabel('视频口播文案').inputValue(), script);
  await page.getByRole('button', { name: '检查当前文案', exact: true }).click();
  await page.getByText('未发现明显风险', { exact: true }).waitFor();
  assert.equal(writes.filter(r => r.path.endsWith('/copy')).length, 1);
  assert.equal(await page.getByLabel('视频口播文案').inputValue(), script);
  for (const [invalidScript, reason] of [
    ['长'.repeat(180), '文案过长，请精简文案或增加视频时长。'],
    ['短', '文案过短，请补充内容。'],
  ]) {
    await page.getByLabel('视频口播文案').fill(invalidScript);
    await page.getByRole('alert').filter({ hasText: reason }).waitFor();
    await page.getByRole('button', { name: '配音与字幕', exact: false }).click();
    await page.getByRole('alert').filter({ hasText: reason }).waitFor();
    assert.equal(await page.getByRole('button', { name: '生成分镜并预览' }).isDisabled(), true);
    assert.equal(await page.getByText('查看自动分段（0 段）').count(), 0);
    await snap('marketing-video-plan-error.png');
    await page.getByRole('button', { name: '修改文案或时长' }).click();
    assert.equal(await page.getByLabel('视频口播文案').inputValue(), invalidScript);
  }
  await page.getByLabel('视频口播文案').fill('长'.repeat(180));
  await page.getByRole('slider', { name: '整片时长（秒）', exact: true }).focus();
  await page.getByRole('slider', { name: '整片时长（秒）', exact: true }).press('End');
  await page.getByRole('button', { name: '配音与字幕', exact: false }).click();
  assert.equal(await page.getByRole('button', { name: '生成分镜并预览' }).isDisabled(), false);
  await page.getByRole('button', { name: '确定文案', exact: false }).click();
  await page.getByLabel('视频口播文案').fill(script);
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '实拍对口型（待接入）' }).isDisabled(), true);
  await page.getByRole('button', { name: '选择数字分身素材', exact: true }).click();
  const twin = page.getByRole('dialog', { name: '选择数字分身素材' });
  await twin.locator('.twin-asset').filter({ hasText: '我的肖像' }).getByRole('button', { name: '用于视频制作' }).click();
  await twin.getByRole('status').filter({ hasText: '我的肖像' }).waitFor();
  await twin.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByLabel('背景补充描述').fill('木质吧台和明亮落地窗');
  await page.getByLabel('上传背景图片（选填）').setInputFiles({ name: 'store.png', mimeType: 'image/png', buffer: png });
  await page.locator('.mv-asset-preview img').nth(1).waitFor();
  await snap('marketing-video-assets.png');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  assert.equal(await page.getByLabel('添加字幕', { exact: true }).isChecked(), true);
  assert.equal(await page.getByText('当前环境不支持字幕，可关闭字幕后生成。').count(), 0);
  assert.equal(await page.getByLabel('上传音色样例（选填，2–15 秒）').isVisible(), true);
  await page.getByRole('button', { name: '选择数字分身音色', exact: true }).click();
  const voicePicker = page.getByRole('dialog', { name: '选择数字分身音色' });
  assert.equal(await voicePicker.getByRole('heading', { name: '个人肖像库' }).count(), 0);
  await voicePicker.locator('.twin-asset').filter({ hasText: '我的声音' }).getByRole('button', { name: '用于视频制作' }).click();
  await voicePicker.getByRole('status').filter({ hasText: '我的声音' }).waitFor();
  await voicePicker.getByRole('button', { name: '完成', exact: true }).click();
  await page.locator('.mv-asset-preview audio').waitFor();
  await page.getByText('更多设置', { exact: true }).click();
  holdNextSave = true;
  const savingRequest = page.waitForRequest(request => request.method() === 'PUT' && request.url().includes('/api/marketing-videos/'));
  await page.getByRole('group', { name: '视频质量', exact: true }).getByRole('button', { name: '高清', exact: true }).click();
  await savingRequest;
  assert.equal(await page.getByRole('button', { name: '生成分镜并预览' }).isDisabled(), false);
  await page.getByText(`查看自动分段（${planMarketingSegments(script, 60).length} 段）`).click();
  await snap('marketing-video-review.png');
  await page.getByRole('button', { name: '生成分镜并预览' }).evaluate(button => { button.click(); button.click(); });
  await page.getByRole('button', { name: '正在保存…', exact: true }).waitFor();
  assert.equal(writes.filter(r => r.path.endsWith('/generate')).length, 0);
  releaseSave();
  await page.getByRole('heading', { name: '确认分镜', exact: true }).waitFor();
  assert.equal(writes.filter(r => r.path.endsWith('/generate')).length, 0);
  assert.equal(writes.filter(r => r.path.endsWith('/storyboard')).length, 1);
  assert.equal(await page.locator('.mv-shot').count(), planMarketingSegments(script, 60).length);
  const firstShot = page.getByRole('article', { name: '第 1 镜', exact: true });
  const secondShot = page.getByRole('article', { name: '第 2 镜', exact: true });
  await firstShot.getByLabel('分镜口播').fill('欢迎来到转角咖啡店，一起喝杯咖啡。');
  await secondShot.getByLabel('人物与产品动作').fill('轻轻转动咖啡杯');
  await page.getByLabel('AI 修改范围').selectOption('0');
  await page.getByLabel('分镜修改要求').fill('改为产品特写，口播不变');
  failNextStoryboard = true;
  await page.getByRole('button', { name: 'AI 修改分镜', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'AI 分镜生成失败' }).waitFor();
  assert.equal(await secondShot.getByLabel('人物与产品动作').inputValue(), '轻轻转动咖啡杯');
  await page.getByRole('button', { name: 'AI 修改分镜', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '分镜已保存' }).waitFor();
  assert.equal(await firstShot.getByLabel('景别与镜头运动').inputValue(), 'AI 调整镜头');
  assert.equal(await secondShot.getByLabel('景别与镜头运动').inputValue(), '缓慢推近');
  assert.equal(await secondShot.getByLabel('人物与产品动作').inputValue(), '轻轻转动咖啡杯');
  await page.reload(); await chooseAgent('营销影像');
  await page.getByRole('heading', { name: '确认分镜', exact: true }).waitFor();
  assert.equal(await firstShot.getByLabel('分镜口播').inputValue(), '欢迎来到转角咖啡店，一起喝杯咖啡。');
  assert.equal(await firstShot.getByLabel('景别与镜头运动').inputValue(), 'AI 调整镜头');
  await page.getByRole('heading', { name: '确认分镜', exact: true }).scrollIntoViewIfNeeded();
  await snap('marketing-video-storyboard.png');
  await page.getByRole('button', { name: '确认分镜并生成视频' }).evaluate(button => { button.click(); button.click(); });
  await page.getByRole('heading', { name: '生成结果', exact: true }).waitFor();
  assert.equal(writes.filter(r => r.path.endsWith('/generate')).length, 1);
  const p = [...projects.values()][0];
  assert.equal(p.draft.durationSec, 60); assert.equal(p.draft.quality, '1080p');
  assert(p.draft.assets.voice); assert(p.draft.assets.background); assert(p.draft.assets.portrait);
  assert.equal(writes.filter(r => r.path.endsWith('/generations')).length, 0);
  // Recover by account-scoped project ID, even after the whole page reloads.
  await page.reload(); await chooseAgent('营销影像');
  await page.getByRole('heading', { name: '生成结果', exact: true }).waitFor();
  taskState = 'succeeded';
  await page.locator('.mv-results video').waitFor();
  assert.equal(writes.filter(r => r.path.endsWith('/generate')).length, 1);
  assert.equal(await page.getByRole('button', { name: '发布到抖音', exact: true }).isDisabled(), true);
  await page.getByLabel('视频发布标题').fill('欢迎到转角咖啡坐坐');
  await page.getByRole('button', { name: '存草稿到知识库', exact: true }).click();
  await page.getByRole('button', { name: '已存入知识库', exact: true }).waitFor();
  assert.equal(p.draft.publishTitle, '来发现你的下一杯咖啡'); // PUT replaces the fixture, not mutation.
  assert.equal(projects.get(p.id).draft.publishTitle, '欢迎到转角咖啡坐坐');
  await page.getByLabel('短视频检索标签').fill('#转角咖啡 #探店');
  await page.getByRole('button', { name: '更新知识库草稿', exact: true }).click();
  await page.getByRole('button', { name: '已存入知识库', exact: true }).waitFor();
  assert.equal(writes.filter(r => r.path.endsWith('/archive')).length, 2);
  assert.equal(await page.locator('.mv-results .mv-shot').count(), p.draft.storyboard.length);
  assert.equal(await firstShot.getByLabel('分镜口播').getAttribute('readonly'), '');
  await page.getByRole('button', { name: '修改分镜并重新制作', exact: true }).click();
  await page.getByRole('button', { name: '确定文案', exact: false }).click();
  await page.getByRole('heading', { name: '确定文案', exact: true }).waitFor();
  assert.equal(await page.getByLabel('视频口播文案').inputValue(), p.draft.script);
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.getByRole('button', { name: '配音与字幕', exact: false }).click();
  await page.getByRole('button', { name: '选择数字分身音色', exact: true }).click();
  await voicePicker.locator('.twin-asset').filter({ hasText: '我的声音' }).getByRole('button', { name: '用于视频制作' }).click();
  await voicePicker.getByRole('status').filter({ hasText: '我的声音' }).waitFor();
  await voicePicker.getByRole('button', { name: '完成', exact: true }).click();
  await page.locator('.mv-asset-preview').filter({ has: page.locator('audio') }).getByRole('button', { name: '移除', exact: true }).click();
  assert.equal(await page.locator('.mv-asset-preview audio').count(), 0);
  await page.getByRole('heading', { name: '确认分镜', exact: true }).scrollIntoViewIfNeeded();
  await snap('marketing-video-dark.png');
  await page.getByRole('button', { name: '确认分镜并生成视频' }).click();
  await page.getByRole('heading', { name: '生成结果', exact: true }).waitFor();
  assert.equal(writes.filter(r => r.path.endsWith('/generate')).length, 2);
  assert.equal([...projects.values()].filter(item => item.taskId && !item.draft.assets.voice).length, 1);
  await page.getByRole('button', { name: '开始新视频', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('textarea[rows="6"]')?.value === '');
  await page.evaluate(() => localStorage.setItem('lot:language', 'en'));
  await page.reload(); await chooseAgent('Marketing video');
  await page.getByRole('heading', { name: 'Write copy', exact: true }).waitFor();
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByLabel('Spoken script').fill(script);
  await page.getByRole('button', { name: 'Voice & captions', exact: false }).click();
  assert.equal(await page.getByLabel('Upload voice sample (optional, 2–15 seconds)').isVisible(), true);
  await snap('marketing-video-en-compact.png');
  await page.getByRole('button', { name: 'Choose digital twin voice', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose digital twin voice' }).getByRole('heading', { name: 'Personal voice library' }).waitFor();
  await snap('marketing-video-voice-picker-en-dark.png');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Create storyboard manually', exact: true }).click();
  await page.getByRole('heading', { name: 'Review storyboard', exact: true }).waitFor();
  assert.equal(await page.locator('.mv-shot').count(), planMarketingSegments(script, 30).length);
  await page.getByLabel('AI revision scope').selectOption('all');
  await page.getByLabel('Storyboard revision request').fill('Make all shots close-ups');
  await page.getByRole('button', { name: 'Revise storyboard with AI', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Storyboard saved.' }).waitFor();
  assert.deepEqual(await page.getByLabel('Framing and camera movement').evaluateAll(inputs => inputs.map(input => input.value)), planMarketingSegments(script, 30).map(() => 'AI 调整镜头'));
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.getByRole('heading', { name: 'Review storyboard', exact: true }).scrollIntoViewIfNeeded();
  await snap('marketing-video-storyboard-en-compact.png');

  await page.getByRole('button', { name: 'Write copy', exact: false }).click();
  await page.getByLabel('Spoken script').fill('word '.repeat(100));
  await page.getByRole('button', { name: 'Voice & captions', exact: false }).click();
  await page.getByRole('alert').filter({ hasText: 'Shorten the script or increase the video duration.' }).waitFor();
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await snap('marketing-video-plan-error-en-dark.png');
  await page.getByRole('button', { name: 'Edit script or duration' }).click();
  assert.equal(await page.getByLabel('Spoken script').inputValue(), 'word '.repeat(100));
  // Pre-storyboard API records omit the field entirely. Loading must not mutate them.
  const { storyboard: omittedStoryboard, ...legacyDraft } = p.draft;
  const legacyId = '11111111-1111-4111-8111-111111111111';
  projects.set(legacyId, { id: legacyId, version: 1, draft: { ...legacyDraft, assets: {} }, status: 'draft', taskId: null, progress: 0, review: null, reviewedScript: null, knowledgeItemId: null });
  await page.evaluate(id => localStorage.setItem('lot:marketing-video:fixture', id), legacyId);
  await page.reload(); await chooseAgent('Marketing video');
  await page.getByRole('heading', { name: 'Write copy', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.mv-studio button.mv-soft')?.disabled === false);
  assert.equal(await page.getByLabel('Spoken script').inputValue(), legacyDraft.script);
  await page.waitForTimeout(1100);
  assert.equal(writes.filter(r => r.path === `/api/marketing-videos/${legacyId}`).length, 0, 'defaulting a missing storyboard must not autosave');
  await page.getByRole('button', { name: 'Voice & captions', exact: false }).click();
  await page.getByRole('button', { name: 'Create storyboard manually', exact: true }).click();
  await page.getByRole('heading', { name: 'Review storyboard', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save draft', exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Save draft' && button.disabled));
  await page.reload(); await chooseAgent('Marketing video');
  await page.getByRole('heading', { name: 'Review storyboard', exact: true }).waitFor();
  assert.equal(await page.locator('.mv-shot').count(), planMarketingSegments(legacyDraft.script, legacyDraft.durationSec).length);
  const legacyResultId = '22222222-2222-4222-8222-222222222222';
  projects.set(legacyResultId, { ...projects.get(legacyId), id: legacyResultId, draft: { ...legacyDraft, assets: {} }, taskId: 'legacy-task', status: 'succeeded', output: { assets: resultAssets } });
  await page.evaluate(id => localStorage.setItem('lot:marketing-video:fixture', id), legacyResultId);
  await page.reload(); await chooseAgent('Marketing video');
  await page.getByRole('heading', { name: 'Production storyboard', exact: true }).waitFor({ state: 'hidden' });
  await page.getByText('This older video has no saved storyboard. Copy its draft to add shots and create a new video.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Edit storyboard for a new video', exact: true }).click();
  await page.getByRole('button', { name: 'Create storyboard manually', exact: true }).waitFor();
  apiUnavailable = true;
  await page.reload(); await chooseAgent('Marketing video');
  await page.getByRole('alert').filter({ hasText: 'This server does not support the new marketing video workflow yet.' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Create copy and storyboard', exact: true }).isDisabled(), true);
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await snap('marketing-video-unavailable-en-dark.png');
  assert.deepEqual(errors, []); assert.deepEqual(unexpectedRequests, []);
  console.log('PASS: legacy drafts/results without storyboard, no spurious autosave, legacy-to-storyboard editing and reload, unavailable-server guard and reconnect, generated copy preserved after review failure, three-step workflow, reference rewrite and review, avatar/background selection, optional voice library selection and removal, generation without a voice sample, visible plan errors and edit recovery, generation during pending autosave, model subtitles without local subtitle support, 60s plan, editable storyboard, scoped/all AI edits, failure preservation, manual storyboard, double-click safety, reload recovery, editable publication, archive/update, duplicated/new drafts, dark and English responsive layouts.');
} catch (error) {
  console.error({ errors, unexpectedRequests, body: await page?.locator('body').innerText() });
  throw error;
} finally {
  await browser?.close(); await vite?.close(); await rm(temp, { recursive: true, force: true });
}
