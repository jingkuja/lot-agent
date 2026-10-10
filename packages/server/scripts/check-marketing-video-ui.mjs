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
    const json = (data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (request.method() !== 'GET') writes.push({ path, body: request.headers()["content-type"]?.includes("application/json") ? request.postDataJSON() : null });
    if (path === '/api/public/product') return json({ globle: 1 });
    if (path === '/api/video-drafts') return json({ script: '镜头从店铺门头推进，介绍招牌咖啡，邀请顾客到店。', mainTitle: '转角咖啡', subtitle: '一杯好心情', publishTitle: '来发现你的下一杯咖啡', tags: '#探店 #咖啡' });
    if (path === '/api/uploads') return json({ assetId: `upload-${++sequence}`, filename: 'asset', mime: 'image/png', url: `/static/upload-${sequence}.png`, size: 100 });
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
  const chooseAgent = async (name) => { await page.locator('.agent-grid-toggle').click(); await page.locator('.agent-launcher-grid').getByRole('button', { name, exact: true }).click(); };
  await page.locator('.agent-launcher-item').nth(2).waitFor();
  assert.deepEqual(await page.locator('.agent-launcher-item > span:nth-child(2)').allTextContents(), ['通用助手', '营销影像', '图片生成']);
  await page.locator('.agent-grid-toggle').click();
  assert.equal(await page.locator('.agent-launcher-item > span:nth-child(2)').nth(1).textContent(), '营销影像');
  await page.locator('.agent-grid-toggle').click();
  await chooseAgent('营销影像');
  await page.getByRole('heading', { name: '创作方向与文案', exact: true }).waitFor();
  assert.equal(await page.locator('.mv-steps button').count(), 9);
  await snap('marketing-video-start.png');
  await page.getByRole('button', { name: '下一步 ›', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '请先填写' }).waitFor();
  await page.getByLabel('这次想拍什么', { exact: true }).fill('为转角咖啡店拍摄探店介绍，突出手冲咖啡和明亮的店内环境。');
  await page.getByRole('button', { name: '智能生成文案与标题' }).click();
  await page.waitForFunction(() => document.querySelector('.mv-field textarea[rows="6"]')?.value.includes('店铺门头'));
  await page.getByRole('button', { name: '下一步 ›', exact: true }).click();
  assert.equal(await page.getByLabel('封面主标题', { exact: true }).inputValue(), '转角咖啡');
  await page.getByRole('button', { name: '下一步 ›', exact: true }).click();
  await page.getByRole('button', { name: '选择数字分身素材', exact: true }).click();
  const twin = page.getByRole('dialog', { name: '选择数字分身素材' });
  await twin.locator('.twin-asset').filter({ hasText: '我的肖像' }).getByRole('button', { name: '用于视频制作' }).click();
  await twin.locator('.twin-asset').filter({ hasText: '我的声音' }).getByRole('button', { name: '用于视频制作' }).click();
  await twin.getByRole('status').filter({ hasText: '我的声音' }).waitFor();
  await twin.getByRole('button', { name: '完成', exact: true }).click();
  assert.equal(await page.locator('.mv-twin audio').count(), 1);
  assert.equal(await page.locator('.mv-twin img').count(), 1);
  await snap('marketing-video-twin.png');
  await page.getByRole('button', { name: '下一步 ›', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '无配音', exact: true }).count(), 0);
  await page.getByRole('button', { name: '下一步 ›', exact: true }).click();
  await page.getByRole('button', { name: '自定义背景', exact: true }).click();
  await page.getByRole('button', { name: '下一步 ›', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '请描述自定义背景' }).waitFor();
  await page.getByLabel('背景补充描述').fill('保留木质吧台、明亮落地窗和店铺招牌');
  await page.getByLabel('上传背景图片（选填）').setInputFiles({ name: 'store.png', mimeType: 'image/png', buffer: png });
  await page.locator('.mv-asset-preview img').waitFor();
  await snap('marketing-video-background.png');
  await page.getByRole('button', { name: '下一步 ›', exact: true }).click();
  assert.equal(await page.getByLabel('选择模型', { exact: true }).count(), 0);
  assert.deepEqual(await page.getByRole('group', { name: '视频质量', exact: true }).getByRole('button').allTextContents(), ['默认', '高清', '超清']);
  await page.getByRole('button', { name: '超清', exact: true }).click();
  assert.equal(await page.getByLabel('视频时长').getAttribute('max'), '15');
  await page.getByLabel('视频时长').press('End');
  assert.equal(await page.getByLabel('视频时长').inputValue(), '15');
  await page.getByRole('button', { name: '下一步 ›', exact: true }).click();
  await page.getByRole('button', { name: '轻快', exact: true }).click();
  await page.getByRole('button', { name: '下一步 ›', exact: true }).click();
  await page.getByLabel('选择封面图（选填）').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: '检查生成设置' }).click();
  await snap('marketing-video-review.png');
  await page.getByRole('button', { name: '确认设置并生成视频' }).evaluate((button) => { button.click(); button.click(); });
  await page.getByRole('heading', { name: '生成结果', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.gen-card'));
  assert.equal(writes.filter(r => r.path.endsWith('/generations')).length, 1);
  const submission = writes.find(r => r.path.endsWith('/generations')).body;
  assert.equal(submission.mediaType, 'video');
  assert.equal(submission.model, 'kling-video-v3-omni');
  assert.equal(submission.settings.quality, '4k');
  assert.equal(submission.settings.size, '2160x3840');
  assert.equal(submission.input_reference.length, 2);
  assert.equal(submission.reference_audio.length, 1);
  assert(submission.first_frame);
  assert.match(submission.prompt, /外貌参考 图片1/);
  assert.match(submission.prompt, /空间布局参考 图片2/);
  assert.match(submission.prompt, /音频1/);
  assert.equal(submission.settings.durationSec, 15);
  assert.equal(submission.settings.generate_audio, true);
  assert(!submission.prompt.includes('#探店'));
  assert.equal(writes.find(r => r.path === '/api/conversations').body.agentId, 'marketing_video');
  assert.equal(writes.find(r => r.path === '/api/conversations').body.videoPublication.tags, '#探店 #咖啡');
  // Leave a running task, then recover it from this agent's own history.
  await chooseAgent('通用助手');
  await page.getByRole('button', { name: '离开并切换', exact: true }).click();
  await chooseAgent('营销影像');
  await page.locator('.sidebar-conversation-link').filter({ hasText: '新对话' }).last().click();
  await page.getByRole('heading', { name: '生成结果', exact: true }).waitFor();
  taskState = 'succeeded';
  await page.locator('.mv-results video').waitFor();
  await page.getByRole('button', { name: '复制发布文案', exact: true }).waitFor();
  assert.equal(writes.filter(r => r.path.endsWith('/generations')).length, 1);
  await page.getByRole('button', { name: '开始新视频', exact: true }).click();
  assert.equal(await page.getByLabel('视频文案 / 分镜').inputValue(), '');
  await page.getByRole('button', { name: '主播宣传演讲' }).click();
  await page.getByLabel('视频文案 / 分镜').fill('大家好，欢迎了解我们的品牌。');
  await page.locator('.mv-steps button').nth(4).click();
  assert.equal(await page.getByRole('button', { name: '简约演播室', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await snap('marketing-video-dark.png');
  await page.evaluate(() => localStorage.setItem('lot:language', 'en'));
  await page.reload();
  await chooseAgent('Marketing video');
  await page.getByRole('heading', { name: 'Direction & script', exact: true }).waitFor();
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await snap('marketing-video-en-compact.png');
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpectedRequests, []);
  console.log('PASS: agent navigation, nine-step workflow, AI copy, portrait/voice selection, custom background validation/upload, cover, settings, single video submission, saved publication, task recovery, new draft, presenter direction, dark and English responsive layouts.');
} catch (error) {
  console.error({ errors, unexpectedRequests, body: await page?.locator('body').innerText() });
  throw error;
} finally {
  await browser?.close(); await vite?.close(); await rm(temp, { recursive: true, force: true });
}
