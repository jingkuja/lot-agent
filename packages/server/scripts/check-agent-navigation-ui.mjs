/** Real Workspace UI with in-memory API fixtures; no user data or model calls.
 * PLAYWRIGHT_MODULE=/path/to/playwright node packages/server/scripts/check-agent-navigation-ui.mjs
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
const temp = await realpath(await mkdtemp(join(tmpdir(), "lot-agent-navigation-")));
let vite, browser, page;
const errors = [], writes = [], unexpectedRequests = [];
const screenshotDir = process.env.AGENT_SCREENSHOTS_DIR;
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
  await context.addInitScript(() => localStorage.setItem("lot:language", "zh"));
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  const agents = [
    ["general", "通用助手", "通用 AI 助手"],
    ["image", "图片生成", "文字描述生成配图/封面/海报"],
    ["video", "视频生成", "脚本/描述生成短视频"],
    ["ppt", "PPT 制作", "明确受众与目标，确认可编辑大纲，生成带图表的 PPT 并逐页预览修改"],
    ["contract", "合同对比", "上传新旧两版合同，找出条款增删、内容变化与主体变更"],
    ["digital_employee", "数字员工", "独立模块"],
  ].map(([id, name, description], sortOrder) => ({ id, name, description, type: id, installed: true, sortOrder }));
  const conversations = agents.filter((a) => a.id !== 'digital_employee').map((a) => ({ id: `history-${a.id}`, title: `${a.id} 历史记录`, agent_id: a.id, created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z' }));
  let taskState = 'running';
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    const json = (data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (request.method() !== 'GET') writes.push({ path, body: request.postDataJSON() });
    if (path === '/api/public/product') return json({ globle: 1 });
    if (path === '/api/agents') return json(agents);
    if (path === '/api/conversations/projects') return json([]);
    if (path === '/api/conversations') {
      if (request.method() === 'POST') {
        const conv = { id: 'new-chat', title: '新对话', agent_id: request.postDataJSON().agentId, created_at: '', updated_at: '' };
        conversations.unshift(conv); return json(conv);
      }
      return json({ items: conversations, nextCursor: null });
    }
    if (path.startsWith('/api/conversations/')) {
      const id = path.split('/')[3];
      if (path.endsWith('/generations')) return json({ taskId: 'fixture-task', userMessage: { id: 'new-user' }, assistantMessage: { id: 'new-generation', metadata: {} } });
      const conv = conversations.find((c) => c.id === id);
      if (conv) return json({ ...conv, messages: [
        { id: `${id}-user`, role: 'user', content: `${conv.agent_id} 之前的问题` },
        { id: `${id}-answer`, role: 'assistant', content: conv.agent_id === 'video' ? '' : `${conv.agent_id} 之前的回答`,
          ...(conv.agent_id === 'video' ? { metadata: { kind: 'generation', mediaType: 'video', status: 'generating', taskId: 'fixture-task' } } : {}) },
      ] });
    }
    if (path === '/api/tasks/fixture-task') return json({ id: 'fixture-task', status: taskState, progress: 35, output: {} });
    if (path === '/api/usage/balance') return json({ balance: 100, totalUsed: 0, totalRecharged: 100, usedRatio: 0 });
    if (path === '/api/knowledge-bases') return json([]);
    if (path.endsWith('/status')) return json({ ingestionEnabled: false });
    if (path.endsWith('/storage')) return json({ storedBytes: 0 });
    if (path.endsWith('/collections') || path.endsWith('/items')) return json({ data: [], nextCursor: null });
    unexpectedRequests.push(path);
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}`);
  const current = page.locator('.sidebar-current-agent-copy strong');
  const header = page.locator('.workspace-agent-identity strong');
  const grid = page.locator('.agent-launcher-grid');
  const dialog = page.locator('.agent-switch-dialog');
  const toggle = () => page.locator('.agent-grid-toggle').click();
  const pick = async (name) => { await toggle(); await grid.getByRole('button', { name, exact: true }).click(); };
  const checkCurrent = async (name) => {
    await page.waitForFunction((name) => document.querySelector('.sidebar-current-agent-copy strong')?.textContent === name, name);
    assert.equal(await header.textContent(), name);
  };
  const snap = async (name) => { if (screenshotDir) { await mkdir(screenshotDir, { recursive: true }); await page.screenshot({ path: join(screenshotDir, name), animations: 'disabled' }); } };
  await checkCurrent('通用助手');
  assert.equal(await page.locator('.agent-switcher').count(), 0);
  assert.equal(await page.getByText('Studio 管理', { exact: true }).count(), 0);
  assert.equal(await grid.getByRole('button').count(), 3);
  assert.equal(await page.locator('.agent-grid-toggle').innerText(), '更多');
  await snap('agent-default-three.png');
  // The default row is usable without opening More.
  await grid.getByRole('button', { name: '图片生成', exact: true }).click();
  await checkCurrent('图片生成');
  await grid.getByRole('button', { name: '通用助手', exact: true }).click();
  await checkCurrent('通用助手');
  await toggle();
  assert.equal(await grid.getByRole('button').count(), 5);
  assert.equal(await page.locator('.agent-grid-toggle').innerText(), '收起');
  await toggle();
  assert.equal(await grid.getByRole('button').count(), 3);
  await toggle();
  assert.equal(await grid.getByRole('button', { name: '数字员工', exact: true }).count(), 0);
  assert.equal(await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length), 3);
  await snap('agent-grid-light.png');
  await page.keyboard.press('Escape');
  assert.equal(await grid.getByRole('button').count(), 3);
  await checkCurrent('通用助手');
  await page.getByText('general 历史记录', { exact: true }).click();
  await page.getByText('general 之前的回答', { exact: true }).waitFor();
  await pick('通用助手');
  assert.equal(await dialog.count(), 0);
  assert(await page.getByText('general 之前的回答', { exact: true }).isVisible());
  await pick('图片生成');
  await dialog.waitFor();
  assert(await dialog.getByText(/是否离开当前的通用助手，前往图片生成/).isVisible());
  await dialog.getByRole('button', { name: '留在当前对话' }).click();
  await checkCurrent('通用助手');
  assert(await page.getByText('general 之前的回答', { exact: true }).isVisible());
  await pick('图片生成');
  await dialog.getByRole('button', { name: '离开并切换' }).click();
  await checkCurrent('图片生成');
  assert.equal(await page.getByText('general 历史记录', { exact: true }).count(), 0);
  assert(await page.getByText('image 历史记录', { exact: true }).isVisible());
  assert.equal(await page.getByText('general 之前的回答', { exact: true }).count(), 0);
  await page.getByTitle('新建对话', { exact: true }).click();
  await checkCurrent('图片生成');
  const input = page.locator('textarea');
  await input.fill('保留这段草稿');
  await pick('视频生成');
  await dialog.getByText('切换后，未发送的文字和附件将被清空。', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await input.inputValue(), '保留这段草稿');
  await pick('视频生成');
  await dialog.getByRole('button', { name: '离开并切换' }).click();
  await checkCurrent('视频生成');
  assert.equal(await input.inputValue(), '');
  await page.getByText('video 历史记录', { exact: true }).click();
  await page.getByText('video 之前的问题', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('textarea')?.disabled);
  await pick('PPT 制作');
  await dialog.getByText('当前任务会继续运行，可从历史记录返回查看。', { exact: true }).waitFor();
  await snap('agent-switch-confirm.png');
  await dialog.getByRole('button', { name: '离开并切换' }).click();
  await checkCurrent('PPT 制作');
  assert.equal(await input.isDisabled(), false);
  // Late task completion cannot write into a different Agent's view.
  taskState = 'succeeded';
  await page.waitForTimeout(1100);
  assert.equal(await page.getByText('video 之前的问题', { exact: true }).count(), 0);
  // All Agents, including the formerly optional contract Agent, open without installation.
  await pick('合同对比');
  await checkCurrent('合同对比');
  assert.equal(await dialog.count(), 0);
  await pick('图片生成');
  await page.getByTitle('新建对话', { exact: true }).click();
  await input.fill('测试图片任务');
  const submitted = page.waitForResponse((response) => response.url().endsWith('/new-chat/generations'));
  await page.getByTitle('发送', { exact: true }).click();
  await submitted;
  assert.equal(writes.find((request) => request.path === '/api/conversations').body.agentId, 'image');
  assert.equal(writes.find((request) => request.path.endsWith('/generations')).body.mediaType, 'image');
  await checkCurrent('图片生成');
  await pick('合同对比');
  await dialog.getByRole('button', { name: '离开并切换' }).click();
  await checkCurrent('合同对比');
  await page.locator('.brand-quick-action').click();
  await page.getByRole('heading', { name: '个人语音库', exact: true }).waitFor();
  await page.getByRole('heading', { name: '个人肖像库', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.language-select').selectOption('en');
  await checkCurrent('Contract comparison');
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await toggle();
  await snap('agent-grid-dark-en.png');
  await page.setViewportSize({ width: 900, height: 700 });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.equal(await page.locator('.workspace').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await snap('agent-grid-compact.png');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  assert(await header.isVisible());
  const headBox = await header.boundingBox(), expandBox = await page.locator('.sidebar-expand').boundingBox();
  assert(headBox.x >= expandBox.x + expandBox.width);
  await snap('agent-collapsed.png');
  assert.equal(writes.filter((r) => /\/install|\/promote/.test(r.path)).length, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpectedRequests, []);
  console.log('PASS: Default three Agents, More/Collapse toggle, Agent grid, same-Agent no-op, synchronized history, cancel/confirm, selected-Agent submission, draft isolation, running-task switch, digital twin shortcut, EN/dark/compact/collapsed layouts.');
} catch (error) {
  console.error({ errors, unexpectedRequests, body: await page?.locator("body").innerText() });
  throw error;
} finally {
  await browser?.close();
  await vite?.close();
  await rm(temp, { recursive: true, force: true });
}
