/** Real Workspace UI with in-memory API fixtures; no user data or model calls.
 * PLAYWRIGHT_MODULE=/path/to/playwright node packages/server/scripts/check-marketing-video-ui.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, readFile, rm, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const { planMarketingSegments, storyboardScript, marketingReviewText, KLING_MARKETING_PROFILE } = await import(new URL("../../../packages/core/dist/marketing-video/index.js", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { createServer } = createRequire(resolve(root, "packages/web/package.json"))("vite");
const temp = await realpath(await mkdtemp(join(tmpdir(), "lot-marketing-video-")));
let vite, browser, page;
const errors = [], writes = [], unexpectedRequests = [], materialRefreshes = [];
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
  // Paid and destructive actions confirm in the app's own dialog, never a native one.
  const nativeDialogs = [];
  page.on("dialog", dialog => { nativeDialogs.push(dialog.message()); void dialog.dismiss(); });
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
  let taskState = 'running', sequence = 0, statusPolls = 0, keyArtPolls = 0;
  let apiUnavailable = true;
  let failNextReview = false, failNextStoryboard = false, failNextCopyUnknown = false;
  let holdNextSave = false, releaseSave, holdNextCopy = false, releaseCopy;
  // Whether this host can burn captions in; every new video's captions are burned in locally.
  let subtitleSupport = true;
  const savedDraft = (has) => page.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes('/api/marketing-videos/') && (response.request().postData() ?? '').includes(has));
  const projects = new Map();
  const textOperations = new Map(), uploadedAssets = new Map();
  // The mocked AI picks shorter shots than the manual split, so a narration take can outgrow its shot.
  const aiPlan = (text, duration) => planMarketingSegments(text, duration, 12);
  const script = '欢迎来到转角咖啡店。我们用现磨咖啡迎接每一位客人，明亮的空间适合休息和聊天。你可以选择喜欢的位置，点上一杯手冲咖啡，慢慢享受今天的时光。欢迎来店里坐一坐，发现属于你的咖啡时刻。';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const wav = Buffer.alloc(44 + 16000 * 3 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  const library = [
    { id: 'portrait', title: '我的肖像', mime: 'image/png', sourceType: 'image', tags: ['digital-twin:portrait'], size: png.length },
    { id: 'voice', title: '我的声音', mime: 'audio/wav', sourceType: 'audio', tags: ['digital-twin:voice'], size: wav.length },
    { id: '00000000-0000-4000-8000-0000000000aa', title: '已复刻的声音', mime: 'audio/wav', sourceType: 'audio', tags: ['digital-twin:voice'], size: wav.length },
  ];
  // Twin narration takes by draft and shot text; the first shot's take is longer than its shot.
  const narrationTakes = new Map();
  // Takes a shot redo started in the background; the next narration read finishes them, like a slow speech request.
  const backgroundTakes = new Set();
  // Takes whose next background synthesis fails, and the failed ones with the reason the server records.
  const failingTakes = new Set(), failedTakes = new Map();
  const keyArts = new Map();
  const narrationClips = (p) => p.draft.storyboard.map((shot, slot) => backgroundTakes.has(`${p.id}:${shot.script}`) ? { slot, status: 'running' }
    : failedTakes.has(`${p.id}:${shot.script}`) ? { slot, status: 'failed', error: failedTakes.get(`${p.id}:${shot.script}`) }
    : narrationTakes.has(`${p.id}:${shot.script}`) ? { slot, status: 'succeeded', durationMs: narrationTakes.get(`${p.id}:${shot.script}`) } : { slot, status: 'missing' });
  const generated = new Map();
  const resultAssets = [{ url: '/static/fixture.mp4', mime: 'video/mp4' }];
  // Local checks of the made video (no model): a black stretch at the start of shot 2.
  const burnedCaptions = [{ shot: 0, start: 0.2, end: 2.4, text: '欢迎光临' }, { shot: 0, start: 2.4, end: 4.8, text: '一起喝杯咖啡' }];
  const quality = { checked: true, durationSec: 60.02, expectedSec: 60, subtitles: 'model', speech: true, issues: [{ kind: 'black', shot: 1, start: 15, end: 15.8 }] };
  // Like the server, full project reads and saves of a made video offer single shot redo; every fixture clip can be kept.
  const withRevision = (p) => p.rendered && p.status === 'succeeded'
    ? { ...p, revision: { draft: p.rendered, modelId: KLING_MARKETING_PROFILE.modelId, reusable: p.rendered.storyboard.map(() => true), clips: p.rendered.storyboard.map((_, index) => `/static/assets/clip-${index}.mp4`), composition: p.composition ?? { narration: false, localSubtitles: false } } } : p;
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    // Simulate older responses omitting optional/new empty fields, including copy and publication.
    const json = (data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data, (key, value) => key === 'storyboard' && Array.isArray(value) && !value.length ? undefined : value) });
    if (request.method() !== 'GET') writes.push({ path, body: request.headers()["content-type"]?.includes("application/json") ? request.postDataJSON() : null });
    if (path === '/api/public/product') return json({ globle: 1 });
    if (path === '/api/marketing-video-analyses/capabilities') return json({ enabled: false });
    if (apiUnavailable && path.startsWith('/api/marketing-videos')) return route.fulfill({ status: 404, contentType: 'text/plain', body: '404 Not Found' });
    // The UI follows the server's clip profile. This fixture keeps Kling's clip limits under a
    // neutral ID with no image dimension limits, so the 1×1 fixture images pass upload checks.
    if (path === '/api/marketing-videos/capabilities') return json({ composition: true, subtitles: subtitleSupport, knowledge: true, narration: true, model: { ...KLING_MARKETING_PROFILE, modelId: 'fixture-video', referenceImage: { formats: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 20 * 1024 * 1024 } } });
    if (path === '/api/marketing-videos/usage') return json({ videoBytes: 50 * 1024 * 1024, materialBytes: 1024 * 1024, narrationBytes: 2 * 1024 * 1024, analysisBytes: 0, analysisLimitBytes: 2 * 1024 ** 3 });
    if (request.method() === 'DELETE' && /^\/api\/marketing-videos\/[0-9a-f-]{36}$/.test(path)) { projects.delete(path.split('/')[3]); return json({ ok: true, removedBytes: 3 * 1024 * 1024, keptAnalyses: 1 }); }
    if (path === '/api/marketing-videos') {
      const query = new URL(request.url()).searchParams.get('q') ?? '';
      return json({ data: [...projects.values()].filter(p => !query || [p.draft.topic, p.draft.publishTitle, p.draft.script].some(text => text?.includes(query))) });
    }
    if (path.endsWith('/text-operations')) return json({ data: textOperations.get(path.split('/')[3]) ?? [] });
    if (path.endsWith('/release') && path.includes('/text-operations/')) {
      const [, , , projectId, , operationId] = path.split('/'), operation = textOperations.get(projectId).find(item => item.id === operationId);
      operation.status = 'released'; return json({ project: projects.get(projectId), operation });
    }
    if (path.endsWith('/recover') && path.includes('/text-operations/')) {
      const projectId = path.split('/')[3], p = projects.get(projectId), operation = textOperations.get(projectId)[0];
      p.version++; p.draft = operation.result.draft; operation.status = 'succeeded'; operation.appliedVersion = p.version;
      return json({ project: p, operation });
    }
    if (path === '/api/marketing-videos/copy') {
      const body = request.postDataJSON(), p = projects.get(body.projectId);
      assert(p); assert.equal(body.version, p.version);
      if (failNextCopyUnknown) {
        // The model call ended without a clear result: the server keeps it as unknown.
        failNextCopyUnknown = false; textOperations.set(body.projectId, [{ id: body.clientRequestId, kind: 'copy', status: 'unknown' }]);
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'MARKETING_MODEL_UNAVAILABLE', error: '文案模型暂时无法完成请求，请稍后重试。' }) });
      }
      if (holdNextCopy) { holdNextCopy = false; await new Promise(resolve => { releaseCopy = resolve; }); }
      p.version++; p.draft = { ...body.draft, storyboardAudio: !body.draft.assets?.video, storyboard: aiPlan(script, body.draft.durationSec).map(part => ({ durationSec: part.durationSec, script: part.script, visual: '咖啡店', action: '展示咖啡', camera: '中景' })), script, publishTitle: '来发现你的下一杯咖啡', tags: '#探店 #咖啡' };
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
        projects.set(id, p); return json(withRevision(p));
      }
      const p = projects.get(id); assert(p, `project ${id} missing`);
      if (action === 'storyboard') {
        if (failNextStoryboard) { failNextStoryboard = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'AI 分镜生成失败，原分镜已保留，请重试。' }) }); }
        const body = request.postDataJSON(); assert.equal(body.version, p.version);
        const current = p.draft.storyboard.length ? p.draft.storyboard : aiPlan(p.draft.script, p.draft.durationSec).map(part => ({ durationSec: part.durationSec, script: part.script, visual: '木质吧台和咖啡产品特写', action: '自然讲述并展示咖啡', camera: '缓慢推近' }));
        const shots = current.map((shot, index) => body.instruction && (body.index === undefined || body.index === index) ? { ...shot, camera: 'AI 调整镜头' } : shot);
        p.version++; p.draft = { ...p.draft, storyboard: shots, script: storyboardScript(shots), storyboardAudio: body.index === undefined ? !p.draft.assets.video : p.draft.storyboardAudio }; p.review = null;
        return json(p);
      }
      if (['review', 'publication'].includes(action)) {
        // Recorded like copy: a request ID and the version it was made from.
        const body = request.postDataJSON();
        assert.match(body.clientRequestId, /^[0-9a-f-]{36}$/); assert.equal(body.version, p.version);
      }
      if (action === 'review') {
        if (failNextReview) { failNextReview = false; return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ code: 'MARKETING_TEXT_TRUNCATED', error: '模型输出未完成，请重试；当前文案已保留。' }) }); }
        const issues = (p.draft.storyboard ?? []).flatMap((shot, shotIndex) => ['script', 'visual', 'action', 'camera'].flatMap(key => shot[key].includes('副业必赚') ? [{
          text: '副业必赚', reason: '承诺一定获得收益，需要修改。', suggestion: '了解副业的投入与风险',
          field: `storyboard.${key}`, shotIndex, severity: 'reject', source: 'risk-table', ruleId: 'risk-2',
        }] : []));
        p.review = { verdict: issues.length ? 'reject' : 'pass', issues }; p.reviewedScript = marketingReviewText(p.draft); return json(withRevision(p));
      }
      if (action === 'publication') { p.version++; p.draft.publishTitle = '手冲咖啡与惬意时光'; p.draft.tags = '#咖啡'; p.review = null; return json(p); }
      if (action === 'narration') {
        const slot = path.split('/')[5];
        if (slot !== undefined) return route.fulfill({ contentType: 'audio/wav', body: wav });
        if (request.method() === 'POST') {
          const body = request.postDataJSON(); assert.equal(body.version, p.version);
          p.draft.storyboard.forEach((shot, i) => {
            const key = `${p.id}:${shot.script}`;
            if (!narrationTakes.has(key) || body.slots?.includes(i)) narrationTakes.set(key, i ? 2000 : shot.durationSec * 1000 + 1500);
          });
        }
        const clips = narrationClips(p);
        for (const key of backgroundTakes) {
          if (!key.startsWith(`${p.id}:`)) continue;
          backgroundTakes.delete(key);
          if (failingTakes.delete(key)) failedTakes.set(key, '配音合成失败，请稍后重新生成该镜配音。'); else narrationTakes.set(key, 2000);
        }
        return json({ version: p.version, clips, error: '' });
      }
      if (action === 'key-art') {
        // One still per draft here; the server keys it by the look and bills each request.
        // The server starts the still and answers at once; the studio polls until it is made.
        if (request.method() === 'POST') {
          const body = request.postDataJSON(); assert.equal(body.version, p.version);
          keyArts.set(p.id, { status: 'running' });
          return json({ version: p.version, keyArt: { status: 'running' } });
        }
        const keyArt = keyArts.get(p.id) ?? { status: 'missing' };
        if (keyArt.status === 'running') { keyArtPolls++; keyArts.set(p.id, { status: 'succeeded', url: `data:image/png;base64,${png.toString('base64')}` }); }
        return json({ version: p.version, keyArt });
      }
      if (action === 'unknown-segments') { delete p.unknownSegments; taskState = 'running'; return json({ released: 2, project: p }); }
      if (action === 'generate') { p.taskId = 'fixture-task'; p.status = taskState; p.progress = 35; p.stage = '片段完成 1/2'; p.rendered = structuredClone(p.draft); return json(p); }
      if (action === 'revise') {
        const body = request.postDataJSON(); assert.equal(body.version, p.version); assert(p.review?.verdict === 'pass');
        // A narrated video's changed lines get their takes in the background first; the studio sends the redo again.
        // A failed take is made again only for a shot the user named in narrationRedo.
        if (p.composition?.narration) {
          const keys = p.draft.storyboard.map(shot => `${p.id}:${shot.script}`);
          keys.forEach((key, slot) => { if (body.narrationRedo?.includes(slot) && failedTakes.delete(key)) backgroundTakes.add(key); });
          const failed = keys.find(key => failedTakes.has(key));
          if (failed) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: failedTakes.get(failed) }) });
          for (const key of keys) if (!narrationTakes.has(key)) backgroundTakes.add(key);
          if (keys.some(key => backgroundTakes.has(key))) return json({ narrationPending: true, clips: narrationClips(p) }, 202);
        }
        taskState = 'running'; p.status = taskState; p.progress = 35; p.stage = '片段完成 1/2'; p.rendered = structuredClone(p.draft); return json(p);
      }
      if (action === 'archive') { p.knowledgeItemId = 'knowledge-video'; p.knowledgeVersion = p.version; return json({ itemId: p.knowledgeItemId, version: p.version }); }
      if (p.taskId) { p.status = taskState; if (taskState === 'succeeded') p.output = { assets: resultAssets, assetIds: ['video-asset'], quality, captions: burnedCaptions }; }
      if (action === 'status') {
        statusPolls++;
        const { id: projectId, version, taskId, status, progress, stage, error, errorCode, output, unknownSegments } = p;
        return json({ id: projectId, version, taskId, status, progress, stage, error, errorCode, output, unknownSegments });
      }
      return json({ ...withRevision(p), assets: Object.fromEntries(uploadedAssets) });
    }
    if (path.startsWith('/api/assets/') && request.method() === 'GET') {
      assert.equal(request.headers()['authorization'], 'Bearer agent-navigation-test');
      const asset = uploadedAssets.get(path.split('/').at(-1));
      if (!asset) return json({ error: 'Not found' }, 404);
      materialRefreshes.push(asset.id);
      return json(asset);
    }
    if (path === '/api/uploads') {
      // P17: the file is the raw body; its type, name and purpose travel in the headers and URL.
      assert.equal(new URL(request.url()).searchParams.get('purpose'), 'marketing-video', 'Marketing uploads declare the private purpose');
      assert(request.headers()['x-file-name'], 'Raw uploads carry the file name');
      const type = request.headers()['content-type'];
      sequence++; const asset = { assetId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`, filename: 'asset', mime: type === 'audio/wav' ? 'audio/wav' : type === 'video/mp4' ? 'video/mp4' : 'image/png', url: `/static/upload-${sequence}.png`, size: 100 };
      uploadedAssets.set(asset.assetId, { id: asset.assetId, name: asset.filename, mime: asset.mime, url: asset.url }); return json(asset);
    }
    if (path.endsWith('/items')) return json({ data: library.filter((item) => item.tags.includes(new URL(request.url()).searchParams.get('tag'))), nextCursor: null });
    // Voice-clone status shown by the digital twin voice picker: not cloned yet.
    if (path.endsWith('/voice') && path.startsWith('/api/rag/manage/items/') && request.method() === 'GET') return json({ voice: path.includes('/00000000-0000-4000-8000-0000000000aa/') ? { status: 'OK', voiceId: 'fixture-voice', targetModel: 'qwen-audio-3.0-tts-plus' } : null });
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
    if (path === '/api/tasks/fixture-task/cancel') { taskState = 'cancelled'; for (const p of projects.values()) if (p.taskId === 'fixture-task') p.stage = '已请求取消'; return json({ ok: true, status: 'cancelled', cancellationRequested: true }); }
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
  // Confirms one of the app's confirmation dialogs by its title and action.
  const confirmDialog = async (title, action) => {
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    await dialog.getByRole('button', { name: action, exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  };
  // Up to six agents show without expanding; the "More" toggle exists only beyond that.
  const chooseAgent = async (name) => { const more = page.locator('.agent-grid-toggle[aria-controls]'); if (await more.count()) await more.click(); await page.locator('.agent-launcher-grid').getByRole('button', { name, exact: true }).click(); };
  await page.locator('.agent-launcher-item').nth(2).waitFor();
  // The launcher lists every agent since the sidebar rework; the marketing agent stays second.
  assert.deepEqual((await page.locator('.agent-launcher-item > span:nth-child(2)').allTextContents()).slice(0, 3), ['通用助手', '营销影像', '图片生成']);
  assert.equal(await page.locator('.agent-launcher-item > span:nth-child(2)').nth(1).textContent(), '营销影像');
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
  // Links and pasted copy are detected automatically; only local upload is a choice.
  assert.equal(await page.locator('.mv-reference-input').getByRole('checkbox').count(), 0);
  assert.equal(await page.getByRole('radio', { name: '粘贴链接或文案', exact: true }).isChecked(), true);
  await page.getByLabel('视频链接或参考文案').fill('先展示店铺环境，再讲特色，最后邀请到店。');
  await page.getByText('已识别为参考文案，AI 按其结构改写文案与分镜。', { exact: true }).waitFor();
  // A copy request without a clear model result is explained beside the buttons, and
  // one confirmed action discards it and sends the same request again.
  failNextCopyUnknown = true;
  await page.getByRole('button', { name: '一键拆解并生成', exact: true }).click();
  const unknownPanel = page.locator('.mv-dock .ma-panel');
  await unknownPanel.getByRole('alert').filter({ hasText: '上次请求没有收到明确结果' }).waitFor();
  await page.locator('.mv-dock .mv-error').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: '一键拆解并生成', exact: true }).isDisabled(), true);
  await snap('marketing-video-copy-unknown-zh-light.png');
  failNextReview = true;
  holdNextCopy = true;
  assert.equal(await unknownPanel.getByRole('button').count(), 1);
  await unknownPanel.getByRole('button', { name: '核实后重试', exact: true }).click();
  await confirmDialog('核实后重试？', '重试');
  const waitStatus = page.locator('.mv-dock .mv-wait');
  await waitStatus.getByText('正在生成文案和分镜…', { exact: true }).waitFor();
  assert.match(await waitStatus.innerText(), /已用时 0:0\d/);
  assert.match(await waitStatus.innerText(), /最长需要 5 分钟/);
  releaseCopy();
  await waitStatus.waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: '生成分镜', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: '文案与分镜检查' }).count(), 0, 'the copy check lives in the confirm step');
  const copies = writes.filter(r => r.path.endsWith('/copy'));
  assert.equal(copies.length, 2); assert.notEqual(copies[0].body.clientRequestId, copies[1].body.clientRequestId);
  assert.equal(writes.filter(r => r.path.endsWith(`/text-operations/${copies[0].body.clientRequestId}/release`)).length, 1);
  assert.equal(await page.getByLabel('视频口播文案').inputValue(), script);
  // Review exact storyboard fields, including duplicate excerpts in different
  // shots. Applying one suggestion must not alter another shot or lose timing.
  const originalShotCount = await page.locator('.mv-shot').count();
  const firstCopyShot = page.locator('.mv-shot').nth(0), secondCopyShot = page.locator('.mv-shot').nth(1);
  const confirmStep = page.getByRole('button', { name: '确认与制作', exact: false });
  const copyStep = page.getByRole('button', { name: '确定文案', exact: false });
  await confirmStep.click();
  // Step 3 shows the storyboard as an overview; the editor stays collapsed.
  await page.getByRole('heading', { name: '确认分镜', exact: true }).waitFor();
  assert.equal(await page.locator('.mv-shot-overview li').count(), originalShotCount);
  assert.equal(await page.locator('.mv-storyboard-edit').evaluate(el => el.open), false);
  await page.getByText('尚未检查，生成视频前会自动检查。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '检查当前文案', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '模型输出未完成，请重试；当前文案已保留。' }).waitFor();
  await page.getByRole('button', { name: '检查当前文案', exact: true }).click();
  await page.getByText('文案检查完成，未发现明显风险', { exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: '文案与分镜检查' }).getByRole('status').textContent(), '文案检查完成，未发现明显风险');
  assert.equal(await page.getByText('尚未检查，生成视频前会自动检查。', { exact: true }).count(), 0);
  assert.equal(await page.getByText('文案检查完成', { exact: true }).count(), 0);
  await copyStep.click();
  assert.equal(await page.getByLabel('视频口播文案').inputValue(), script);
  await firstCopyShot.getByLabel('画面内容').fill('招牌上写着副业必赚');
  await secondCopyShot.getByLabel('景别与镜头运动').fill('推进副业必赚招牌');
  const narrationBeforeReviewFix = await page.getByLabel('视频口播文案').inputValue();
  await confirmStep.click();
  await page.getByText('内容已修改，请点击“检查当前文案”重新检查。', { exact: true }).waitFor();
  assert.equal(await page.getByText('文案检查完成，未发现明显风险', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '检查当前文案', exact: true }).click();
  const firstRisk = page.locator('.mv-review-issue').filter({ hasText: '第 1 镜 · 画面内容' });
  const secondRisk = page.locator('.mv-review-issue').filter({ hasText: '第 2 镜 · 景别与镜头运动' });
  await firstRisk.getByRole('button', { name: '一键修改', exact: true }).waitFor();
  await firstRisk.scrollIntoViewIfNeeded();
  await snap('marketing-video-risk-zh-light.png');
  // The shared still is made on request, before any clip, and shown for the saved look.
  const keyArtPanel = page.getByRole('region', { name: '定妆图', exact: true });
  await keyArtPanel.getByRole('button', { name: '生成定妆图', exact: true }).click();
  // T05: made in the background; the panel follows it without a reload.
  await keyArtPanel.getByText('正在生成定妆图，可以离开页面，完成后会自动显示。', { exact: true }).waitFor();
  await keyArtPanel.getByRole('img', { name: '定妆图' }).waitFor();
  assert.equal(writes.filter(r => r.path.endsWith('/key-art')).length, 1);
  assert.equal(keyArtPolls, 1, 'the still was polled, not requested again');
  await keyArtPanel.getByRole('button', { name: '换一张', exact: true }).waitFor();
  await page.getByRole('button', { name: '确认分镜并生成视频' }).click();
  await page.locator('.mv-dock').getByRole('alert').filter({ hasText: '文案检查发现需要修改的内容' }).waitFor();
  assert.equal(writes.filter(r => r.path.endsWith('/generate')).length, 0);
  // A rejected check keeps the user on the confirm step, next to the issues.
  // A fix only replaces the text; the check stays until the user runs it again.
  const reviewsBeforeFix = writes.filter(r => r.path.endsWith('/review')).length;
  await firstRisk.getByRole('button', { name: '一键修改', exact: true }).click();
  await firstRisk.waitFor({ state: 'hidden' });
  await page.getByText('内容已修改，请点击“检查当前文案”重新检查。', { exact: true }).waitFor();
  await secondRisk.getByRole('button', { name: '自己修改', exact: true }).waitFor();
  assert.equal(await firstCopyShot.getByLabel('画面内容').inputValue(), '招牌上写着了解副业的投入与风险');
  assert.equal(await secondCopyShot.getByLabel('景别与镜头运动').inputValue(), '推进副业必赚招牌');
  assert.equal(await page.locator('.mv-shot').count(), originalShotCount);
  await secondRisk.getByRole('button', { name: '自己修改', exact: true }).click();
  await secondRisk.getByRole('textbox').fill('镜头缓慢推近咖啡杯');
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await snap('marketing-video-risk-manual-zh-dark.png');
  await secondRisk.getByRole('button', { name: '保存修改', exact: true }).click();
  await secondRisk.waitFor({ state: 'hidden' });
  assert.equal(writes.filter(r => r.path.endsWith('/review')).length, reviewsBeforeFix);
  await page.getByRole('button', { name: '检查当前文案', exact: true }).click();
  await page.getByText('文案检查完成，未发现明显风险', { exact: true }).waitFor();
  assert.equal(await secondCopyShot.getByLabel('景别与镜头运动').inputValue(), '镜头缓慢推近咖啡杯');
  await copyStep.click();
  assert.equal(await page.getByLabel('视频口播文案').inputValue(), narrationBeforeReviewFix);
  await firstCopyShot.getByLabel('分镜口播').fill('这个副业必赚。');
  await confirmStep.click();
  await page.getByRole('button', { name: '检查当前文案', exact: true }).click();
  await page.locator('.mv-review-issue').getByRole('button', { name: '一键修改', exact: true }).click();
  await page.getByText('内容已修改，请点击“检查当前文案”重新检查。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '检查当前文案', exact: true }).click();
  await page.getByText('文案检查完成，未发现明显风险', { exact: true }).waitFor();
  assert.equal(await firstCopyShot.getByLabel('分镜口播').inputValue(), '这个了解副业的投入与风险。');
  assert.equal(await page.locator('.mv-shot').count(), originalShotCount);
  await copyStep.click();
  assert((await page.getByLabel('视频口播文案').inputValue()).startsWith('这个了解副业的投入与风险。'));
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  for (const [invalidScript, reason] of [
    ['长'.repeat(180), '文案过长，请精简文案或增加视频时长。'],
    ['短', '文案过短，请补充内容。'],
  ]) {
    await page.getByLabel('视频口播文案').fill(invalidScript);
    await page.getByRole('alert').filter({ hasText: reason }).waitFor();
    await page.getByRole('button', { name: '确认与制作', exact: false }).click();
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
  await page.getByRole('button', { name: '确认与制作', exact: false }).click();
  assert.equal(await page.getByRole('button', { name: '生成分镜并预览' }).isDisabled(), false);
  await page.getByRole('button', { name: '确定文案', exact: false }).click();
  await page.getByLabel('视频口播文案').fill(script);
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '实拍对口型（待接入）' }).count(), 0);
  await page.getByRole('button', { name: '选择数字分身素材', exact: true }).click();
  const twin = page.getByRole('dialog', { name: '选择数字分身素材' });
  await twin.locator('.twin-asset').filter({ hasText: '我的肖像' }).getByRole('button', { name: '用于视频制作' }).click();
  await twin.getByRole('status').filter({ hasText: '我的肖像' }).waitFor();
  await twin.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByLabel('背景/场景补充描述').fill('木质吧台和明亮落地窗');
  await page.getByLabel('上传背景图片（选填）').setInputFiles({ name: 'store.png', mimeType: 'image/png', buffer: png });
  await page.locator('.mv-asset-preview img').nth(1).waitFor();
  const portraitInput = page.getByLabel('上传肖像图片（选填）');
  await portraitInput.setInputFiles([1, 2].map(i => ({ name: `portrait-${i}.png`, mimeType: 'image/png', buffer: png })));
  await page.waitForFunction(() => document.querySelectorAll('.mv-asset-preview img').length === 4);
  assert.equal(await portraitInput.isDisabled(), true);
  const sceneInput = page.getByLabel('上传场景图片（选填）');
  await sceneInput.setInputFiles([1, 2, 3, 4].map(i => ({ name: `scene-${i}.png`, mimeType: 'image/png', buffer: png })));
  await page.getByRole('alert').filter({ hasText: '当前视频模型的场景图片最多 3 张' }).waitFor();
  await sceneInput.setInputFiles([1, 2].map(i => ({ name: `scene-${i}.png`, mimeType: 'image/png', buffer: png })));
  await page.waitForFunction(() => document.querySelectorAll('.mv-asset-preview img').length === 6);
  assert.equal(await sceneInput.isDisabled(), true);
  assert.equal(await page.getByLabel('上传背景图片（选填）').isDisabled(), true);
  await page.getByRole('region', { name: '场景', exact: true }).getByRole('button', { name: '移除', exact: true }).last().click();
  assert.equal(await sceneInput.isDisabled(), false);
  assert.equal(await page.getByLabel('上传背景图片（选填）').isDisabled(), false);
  if (process.env.MARKETING_REFERENCE_VIDEO) {
    const videoInput = page.getByLabel('上传参考视频（选填）');
    await videoInput.setInputFiles({ name: 'reference.mp4', mimeType: 'video/mp4', buffer: await readFile(process.env.MARKETING_REFERENCE_VIDEO) });
    await page.getByRole('alert').filter({ hasText: '图片合计不能超过 3 张' }).waitFor();
    assert.equal(await videoInput.isDisabled(), true);
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '生成分镜并预览', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '从数字分身语音库选择', exact: true }).count(), 0);
    await page.getByRole('button', { name: '上一步', exact: true }).click();
    await snap('marketing-video-reference-limit.png');
    await page.getByRole('region', { name: '参考视频', exact: true }).getByRole('button', { name: '移除', exact: true }).click();
    assert.equal(await videoInput.isDisabled(), false);
    assert.equal(await page.getByRole('alert').filter({ hasText: '图片合计不能超过 3 张' }).count(), 0);
  }
  await snap('marketing-video-assets.png');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  assert.equal(await page.getByLabel('添加字幕', { exact: true }).isChecked(), true);
  assert.equal(await page.getByText('当前环境不支持字幕，可关闭字幕后生成。').count(), 0);
  assert.equal(await page.getByLabel('上传声音样例（2–15 秒）').isVisible(), true);
  const voiceModes = page.getByRole('group', { name: '配音方式', exact: true });
  assert.equal(await voiceModes.getByRole('button', { name: /^AI 配音/ }).getAttribute('aria-pressed'), 'true');
  assert.equal(await voiceModes.getByRole('button', { name: /^数字分身旁白/ }).isDisabled(), false);
  assert.equal(await voiceModes.getByRole('button').count(), 2);
  await page.getByRole('button', { name: '从数字分身语音库选择', exact: true }).click();
  const voicePicker = page.getByRole('dialog', { name: '选择数字分身音色' });
  assert.equal(await voicePicker.getByRole('heading', { name: '个人肖像库' }).count(), 0);
  await voicePicker.locator('.twin-asset').filter({ hasText: '我的声音' }).getByRole('button', { name: '用于视频制作' }).click();
  await voicePicker.getByRole('status').filter({ hasText: '我的声音' }).waitFor();
  await voicePicker.getByRole('button', { name: '完成', exact: true }).click();
  await page.locator('.mv-asset-preview audio').waitFor();
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
  assert.equal(await page.locator('.mv-shot').count(), aiPlan(script, 60).length);
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
  await page.getByText('修改分镜', { exact: true }).click();
  assert.equal(await firstShot.getByLabel('分镜口播').inputValue(), '欢迎来到转角咖啡店，一起喝杯咖啡。');
  assert.equal(await firstShot.getByLabel('景别与镜头运动').inputValue(), 'AI 调整镜头');
  await page.getByRole('heading', { name: '确认分镜', exact: true }).scrollIntoViewIfNeeded();
  await snap('marketing-video-storyboard.png');
  // Twin narration: only a cloned voice can be picked; takes are generated and fitted before any clip.
  await voiceModes.getByRole('button', { name: /^数字分身旁白/ }).click();
  assert.equal(await voiceModes.getByRole('button', { name: /^数字分身旁白/ }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByLabel('上传声音样例（2–15 秒）').count(), 0);
  await page.getByRole('alert').filter({ hasText: '请先选择数字分身旁白音色。' }).waitFor();
  await page.locator('.mv-narration-voice').getByRole('button', { name: '从数字分身语音库选择', exact: true }).click();
  const narrationPicker = page.getByRole('dialog', { name: '选择旁白音色' });
  const narrationSaved = savedDraft('已复刻的声音');
  await narrationPicker.locator('.twin-asset').filter({ hasText: '已复刻的声音' }).getByRole('button', { name: '用作旁白音色' }).click();
  assert.equal(await narrationPicker.count(), 0);
  await page.locator('.mv-narration-voice').getByText('已复刻的声音', { exact: true }).waitFor();
  const narrationPanel = page.getByRole('region', { name: '数字分身配音', exact: true });
  // Captions are burned in locally; on a host without that support the user turns them off.
  await narrationSaved;
  subtitleSupport = false;
  await page.reload(); await chooseAgent('营销影像');
  await page.getByRole('heading', { name: '确认分镜', exact: true }).waitFor();
  await page.getByRole('alert').filter({ hasText: '当前环境不支持字幕，可关闭字幕后生成。' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '确认分镜并生成视频' }).isDisabled(), true);
  await page.getByLabel('添加字幕', { exact: true }).uncheck();
  await page.getByRole('alert').filter({ hasText: '请先生成全部分镜的数字分身配音并试听。' }).waitFor();
  await narrationPanel.getByRole('button', { name: '生成配音', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '有分镜的配音长于镜头时长' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '确认分镜并生成视频' }).isDisabled(), true);
  await narrationPanel.getByRole('button', { name: '按配音调整分镜时长', exact: true }).click();
  await page.locator('.mv-generate:not([disabled])').waitFor();
  assert.equal(await narrationPanel.locator('.mv-narration-long').count(), 0);
  // Fitted shots hold their takes without spare seconds, so no shortening is offered.
  assert.equal(await narrationPanel.locator('.mv-audio-notice').count(), 0);
  await narrationPanel.getByRole('button', { name: '试听', exact: true }).first().click();
  await narrationPanel.locator('audio').waitFor();
  assert.equal(writes.filter(r => r.path.endsWith('/narration')).length, 1);
  await snap('marketing-video-narration.png');
  await voiceModes.getByRole('button', { name: /^AI 配音/ }).click();
  assert.equal(await page.getByLabel('上传声音样例（2–15 秒）').isVisible(), true);
  // AI-voice captions are burned in locally as well, so they need the same support.
  const captionsSaved = savedDraft('"subtitles":true');
  await page.getByLabel('添加字幕', { exact: true }).check();
  await page.getByRole('alert').filter({ hasText: '当前环境不支持字幕，可关闭字幕后生成。' }).waitFor();
  await captionsSaved;
  subtitleSupport = true;
  await page.reload(); await chooseAgent('营销影像');
  await page.getByRole('heading', { name: '确认分镜', exact: true }).waitFor();
  assert.equal(await page.getByLabel('添加字幕', { exact: true }).isChecked(), true);
  await page.locator('.mv-generate:not([disabled])').waitFor();
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
  taskState = 'pending'; p.stage = '等待队列处理';
  await page.locator('.mv-progress strong').filter({ hasText: '排队中' }).waitFor();
  await page.getByText('35% · 等待队列处理', { exact: true }).waitFor();
  await snap('marketing-video-queued-zh-light.png');
  await page.locator('.mv-progress').getByRole('button', { name: '取消生成', exact: true }).click();
  await snap('marketing-video-cancel-confirm-zh-light.png');
  await confirmDialog('取消视频生成？', '取消生成');
  await page.locator('.mv-progress strong').filter({ hasText: '已取消' }).waitFor();
  await page.getByText('35% · 已请求取消', { exact: true }).waitFor();
  assert.equal(writes.filter(r => r.path.endsWith('/generate')).length, 1, 'cancellation and polling do not submit again');
  taskState = 'running';
  await page.reload(); await chooseAgent('营销影像');
  taskState = 'succeeded';
  await page.locator('.mv-results video').waitFor();
  const qualityReport = page.getByRole('region', { name: '成片检查', exact: true });
  await qualityReport.getByText('第 2 镜', { exact: true }).waitFor();
  assert.match(await qualityReport.locator('.mv-quality-list').innerText(), /黑屏\s*15\.0–15\.8s/);
  await qualityReport.getByText('字幕由视频模型绘制，未自动检查，请逐句校对。', { exact: true }).waitFor();
  assert.equal(writes.filter(r => r.path.endsWith('/generate')).length, 1);
  assert.equal(await page.getByRole('button', { name: '发布到抖音', exact: true }).count(), 0);
  assert.equal(await page.getByText('抖音发布权限尚未接入，请下载视频并复制文案发布。', { exact: true }).count(), 1);
  const srt = await page.getByRole('link', { name: '下载字幕（SRT）', exact: true }).getAttribute('href');
  assert.equal(decodeURIComponent(srt.split(',').slice(1).join(',')), '1\n00:00:00,200 --> 00:00:02,400\n欢迎光临\n\n2\n00:00:02,400 --> 00:00:04,800\n一起喝杯咖啡\n');
  await page.getByLabel('视频发布标题').fill('欢迎到转角咖啡坐坐');
  await page.getByRole('button', { name: '存草稿到知识库', exact: true }).click();
  await page.getByRole('button', { name: '已存入知识库', exact: true }).waitFor();
  assert.equal(p.draft.publishTitle, '来发现你的下一杯咖啡'); // PUT replaces the fixture, not mutation.
  assert.equal(projects.get(p.id).draft.publishTitle, '欢迎到转角咖啡坐坐');
  await page.getByLabel('短视频检索标签').fill('#转角咖啡 #探店');
  await page.getByRole('button', { name: '更新知识库草稿', exact: true }).click();
  await page.getByRole('button', { name: '已存入知识库', exact: true }).waitFor();
  assert.equal(writes.filter(r => r.path.endsWith('/archive')).length, 2);
  // G04: redo a single shot in place; the other shots keep their clips.
  assert.equal(await page.locator('.mv-results .mv-shot').count(), p.draft.storyboard.length);
  assert(p.draft.storyboard.length >= 2);
  assert.equal(await firstShot.getByLabel('分镜口播').getAttribute('readonly'), null);
  assert.equal(await page.getByRole('button', { name: '选择要重新生成的镜头', exact: true }).isDisabled(), true);
  // P15: each kept clip can be watched; the video loads only once the preview is opened.
  assert.equal(await firstShot.locator('.mv-shot-clip video').count(), 0);
  await firstShot.getByText('查看本镜片段', { exact: true }).click();
  assert.equal(await firstShot.getByLabel('第 1 镜片段').getAttribute('src'), '/static/assets/clip-0.mp4');
  const secondRedo = secondShot.getByRole('checkbox', { name: /重新生成此镜/ });
  await secondShot.getByLabel('画面内容').fill('人物在窗边慢慢品尝咖啡');
  await secondShot.getByText('已修改', { exact: true }).waitFor();
  assert.equal(await secondRedo.isChecked(), true); assert.equal(await secondRedo.isDisabled(), true);
  await page.locator('.mv-results').getByRole('heading', { name: '文案与分镜检查', exact: true }).waitFor();
  await secondShot.scrollIntoViewIfNeeded(); await snap('marketing-video-shot-redo-zh-light.png');
  await page.getByRole('button', { name: '重新生成 1 个镜头并合成', exact: true }).click();
  await snap('marketing-video-shot-redo-confirm-zh-light.png');
  await confirmDialog('重新生成镜头？', '重新生成');
  await page.locator('.mv-progress strong').filter({ hasText: '正在制作完整视频' }).waitFor();
  const revisions = writes.filter(r => r.path.endsWith('/revise'));
  assert.equal(revisions.length, 1); assert.deepEqual(revisions[0].body.shots, [1]);
  assert.equal(projects.get(p.id).draft.storyboard[1].visual, '人物在窗边慢慢品尝咖啡');
  assert.equal(writes.filter(r => r.path.endsWith('/generate')).length, 1, 'a shot redo is not a new video');
  taskState = 'succeeded';
  await page.locator('.mv-results video').waitFor();
  await page.getByRole('button', { name: '选择要重新生成的镜头', exact: true }).waitFor();
  // A narrated video with local captions: changed captions and reworded lines are composed
  // again from the kept clips, without choosing a shot.
  projects.get(p.id).composition = { narration: true, localSubtitles: true };
  await page.reload(); await chooseAgent('营销影像');
  await page.locator('.mv-results video').waitFor();
  const composition = page.getByRole('group', { name: '成片设置', exact: true });
  // Locally burned captions: size, offsets and line breaks change, the words never do.
  const captionPanel = composition.getByRole('group', { name: '调整字幕', exact: true });
  await captionPanel.getByRole('group', { name: '字号', exact: true }).getByRole('button', { name: '大', exact: true }).click();
  await captionPanel.getByLabel('全片提前或延后（秒）').fill('0.2');
  await captionPanel.getByText('逐镜调整断行和时间', { exact: true }).click();
  const firstCaption = captionPanel.getByLabel('第 1 镜字幕', { exact: true });
  const autoLines = await firstCaption.inputValue();
  await firstCaption.fill(`${autoLines}多加的字`);
  await page.getByRole('alert').filter({ hasText: '字幕只能调整断行和标点；要改文字，请修改该镜口播。' }).first().waitFor();
  // The caption panel has its own compose button next to the whole-video offset.
  const captionRecompose = captionPanel.getByRole('button', { name: '重新合成成片', exact: true });
  assert.equal(await captionRecompose.isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '重新合成成片', exact: true }).last().isDisabled(), true);
  await firstCaption.fill(`${autoLines.slice(0, 2)}\n${autoLines.slice(2)}`);
  await captionPanel.getByLabel('本镜提前或延后（秒）').first().fill('-0.15');
  await captionPanel.getByRole('button', { name: '恢复自动断行', exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').filter({ hasText: '字幕只能调整断行和标点' }).count(), 0);
  await captionPanel.scrollIntoViewIfNeeded(); await snap('marketing-video-captions-zh-light.png');
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await snap('marketing-video-captions-zh-dark.png');
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await captionRecompose.click();
  await confirmDialog('重新合成成片？', '重新合成');
  await page.locator('.mv-progress strong').filter({ hasText: '正在制作完整视频' }).waitFor();
  assert.deepEqual(writes.filter(r => r.path.endsWith('/revise')).at(-1).body.shots, []);
  const captions = projects.get(p.id).draft.captions;
  assert.equal(captions.size, 'large'); assert.equal(captions.offsetSec, 0.2);
  assert.equal(captions.shots[0].script, projects.get(p.id).draft.storyboard[0].script);
  assert.equal(captions.shots[0].offsetSec, -0.15);
  assert.deepEqual(captions.shots[0].lines, `${autoLines.slice(0, 2)}\n${autoLines.slice(2)}`.split('\n').map(line => line.trim()).filter(Boolean));
  taskState = 'succeeded';
  await page.locator('.mv-results video').waitFor();
  await composition.getByRole('checkbox', { name: '添加字幕' }).uncheck();
  await page.getByRole('button', { name: '撤销修改', exact: true }).waitFor();
  await composition.scrollIntoViewIfNeeded(); await snap('marketing-video-composition-zh-light.png');
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await snap('marketing-video-composition-zh-dark.png');
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await page.getByRole('button', { name: '重新合成成片', exact: true }).click();
  await confirmDialog('重新合成成片？', '重新合成');
  await page.locator('.mv-progress strong').filter({ hasText: '正在制作完整视频' }).waitFor();
  assert.deepEqual(writes.filter(r => r.path.endsWith('/revise')).at(-1).body.shots, []);
  assert.equal(projects.get(p.id).draft.subtitles, false);
  taskState = 'succeeded';
  await page.locator('.mv-results video').waitFor();
  await firstShot.getByLabel('分镜口播').fill('欢迎来到转角咖啡，坐下慢慢喝一杯。');
  await firstShot.getByText('口播已修改，保留画面，只更新配音和字幕', { exact: true }).waitFor();
  const keptRedo = firstShot.getByRole('checkbox', { name: /重新生成此镜/ });
  assert.equal(await keptRedo.isChecked(), false); assert.equal(await keptRedo.isDisabled(), false);
  await firstShot.scrollIntoViewIfNeeded(); await snap('marketing-video-recompose-zh-light.png');
  await page.getByRole('button', { name: '重新合成成片', exact: true }).click();
  await page.getByRole('dialog', { name: '重新合成成片？', exact: true }).getByText('1 个镜头的配音需要重新合成', { exact: false }).waitFor();
  const revisesBefore = writes.filter(r => r.path.endsWith('/revise')).length;
  await confirmDialog('重新合成成片？', '重新合成');
  // T05: the reworded line's take is made in the background; the studio waits for it, then sends the same redo once more.
  await page.getByText('正在合成改动镜头的配音', { exact: false }).waitFor();
  await page.locator('.mv-progress strong').filter({ hasText: '正在制作完整视频' }).waitFor({ timeout: 20000 });
  assert.equal(writes.filter(r => r.path.endsWith('/revise')).length, revisesBefore + 2);
  assert.deepEqual(writes.filter(r => r.path.endsWith('/revise')).at(-1).body.shots, []);
  taskState = 'succeeded';
  await page.locator('.mv-results video').waitFor();
  // D09: a take still being made when the draft is opened again is followed until it stops.
  // The made video is twin-narrated from here on; its takes are loaded on the result page.
  const twinVoice = { twinItemId: '00000000-0000-4000-8000-0000000000aa', voiceName: '已复刻的声音', speed: 1, instructions: '' };
  projects.get(p.id).draft.narration = structuredClone(twinVoice); projects.get(p.id).rendered.narration = structuredClone(twinVoice);
  const takeKey = `${p.id}:${projects.get(p.id).draft.storyboard[0].script}`;
  narrationTakes.delete(takeKey); backgroundTakes.add(takeKey);
  await page.reload(); await chooseAgent('营销影像');
  await page.locator('.mv-results video').waitFor();
  await page.getByText('正在合成改动镜头的配音', { exact: true }).waitFor();
  await page.getByText('正在合成改动镜头的配音', { exact: true }).waitFor({ state: 'detached', timeout: 10000 });
  assert.equal(narrationTakes.has(takeKey), true);
  // D08: a take that failed in the background shows its reason and a button; only that take is made again.
  const failingLine = '欢迎来到转角咖啡，今天也来坐一坐。';
  failingTakes.add(`${p.id}:${failingLine}`);
  await firstShot.getByLabel('分镜口播').fill(failingLine);
  await page.getByRole('button', { name: '重新合成成片', exact: true }).click();
  await confirmDialog('重新合成成片？', '重新合成');
  const failedNotice = page.getByRole('alert').filter({ hasText: '第 1 镜配音合成失败：配音合成失败，请稍后重新生成该镜配音。' });
  await failedNotice.waitFor({ timeout: 20000 });
  const revisesBeforeRetry = writes.filter(r => r.path.endsWith('/revise')).length;
  await failedNotice.scrollIntoViewIfNeeded(); await snap('marketing-video-narration-failed-zh-light.png');
  await failedNotice.getByRole('button', { name: '重新合成配音', exact: true }).click();
  await confirmDialog('重新合成配音', '重新合成');
  await page.locator('.mv-progress strong').filter({ hasText: '正在制作完整视频' }).waitFor({ timeout: 20000 });
  // The confirmed retry names the failed shot once; the redo sent after the take is made names none.
  assert.deepEqual(writes.filter(r => r.path.endsWith('/revise')).slice(revisesBeforeRetry).map(r => r.body.narrationRedo), [[0], undefined]);
  taskState = 'succeeded';
  await page.locator('.mv-results video').waitFor();
  delete projects.get(p.id).composition;
  // Back to the AI-voiced video the copied draft below starts from.
  delete projects.get(p.id).draft.narration; delete projects.get(p.id).rendered.narration;
  await page.reload(); await chooseAgent('营销影像');
  await page.locator('.mv-results video').waitFor();
  await page.getByRole('button', { name: '复制为新草稿修改其他设置', exact: true }).click();
  await page.getByRole('button', { name: '确定文案', exact: false }).click();
  await page.getByRole('heading', { name: '确定文案', exact: true }).waitFor();
  assert.equal(await page.getByLabel('视频口播文案').inputValue(), projects.get(p.id).draft.script);
  // Missing titles and tags are filled while the video is made, not before submitting it.
  await page.getByLabel('视频发布标题').fill('');
  await page.getByLabel('短视频检索标签').fill('');
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.getByRole('button', { name: '确认与制作', exact: false }).click();
  await page.getByRole('button', { name: '从数字分身语音库选择', exact: true }).click();
  await voicePicker.locator('.twin-asset').filter({ hasText: '我的声音' }).getByRole('button', { name: '用于视频制作' }).click();
  await voicePicker.getByRole('status').filter({ hasText: '我的声音' }).waitFor();
  await voicePicker.getByRole('button', { name: '完成', exact: true }).click();
  await page.locator('.mv-asset-preview').filter({ has: page.locator('audio') }).getByRole('button', { name: '移除', exact: true }).click();
  assert.equal(await page.locator('.mv-asset-preview audio').count(), 0);
  await page.getByRole('heading', { name: '确认分镜', exact: true }).scrollIntoViewIfNeeded();
  await snap('marketing-video-dark.png');
  await page.getByRole('button', { name: '确认分镜并生成视频' }).click();
  // The copied draft has no still yet: generating without it needs a confirmation.
  await page.getByRole('dialog', { name: '未使用定妆图', exact: true }).getByText('各镜头只靠文字描述保持人物、服装和场景一致', { exact: false }).waitFor();
  await confirmDialog('未使用定妆图', '仍然生成');
  await page.getByRole('heading', { name: '生成结果', exact: true }).waitFor();
  assert.equal(writes.filter(r => r.path.endsWith('/generate')).length, 2);
  await page.waitForFunction(() => [...document.querySelectorAll('input, textarea')].some(field => field.value === '手冲咖啡与惬意时光'));
  assert.equal(await page.getByLabel('视频发布标题').inputValue(), '手冲咖啡与惬意时光');
  const secondGenerate = writes.findLastIndex(r => r.path.endsWith('/generate'));
  const filled = writes.findLastIndex(r => r.path.endsWith('/publication'));
  assert(filled > secondGenerate, 'the video is submitted before titles and tags are filled');
  assert(writes.findLastIndex(r => r.path.endsWith('/review')) > filled, 'filled titles and tags are checked');
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
  await page.getByRole('button', { name: 'Confirm & produce', exact: false }).click();
  assert.equal(await page.getByLabel('Upload voice sample (2–15 seconds)').isVisible(), true);
  await snap('marketing-video-en-compact.png');
  await page.getByRole('button', { name: 'Choose from digital twin voices', exact: true }).click();
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
  // No still and no reference image at all: the warning names the paid shot redo, and cancelling submits nothing.
  const generatesBefore = writes.filter(r => r.path.endsWith('/generate')).length;
  await page.getByRole('button', { name: 'Confirm storyboard and generate video' }).click();
  const bareDialog = page.getByRole('dialog', { name: 'No key-art still', exact: true });
  await bareDialog.getByText('no portrait, product or setting reference image', { exact: false }).waitFor();
  await bareDialog.getByText('still billed by the video model', { exact: false }).waitFor();
  await bareDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await bareDialog.waitFor({ state: 'hidden' });
  assert.equal(writes.filter(r => r.path.endsWith('/generate')).length, generatesBefore);

  await page.getByRole('button', { name: 'Write copy', exact: false }).click();
  {
    const visualField = page.locator('.mv-shot').first().getByLabel('Scene details');
    await visualField.fill('副业必赚');
    await page.getByRole('button', { name: 'Confirm & produce', exact: false }).click();
    await page.getByRole('button', { name: 'Check current copy', exact: true }).click();
    const risk = page.locator('.mv-review-issue');
    await risk.getByRole('button', { name: 'Edit manually', exact: true }).click();
    await risk.getByRole('textbox').fill('A close-up of freshly brewed coffee');
    await risk.scrollIntoViewIfNeeded();
    await snap('marketing-video-risk-en-compact-dark.png');
    await risk.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByText('Content changed. Click “Check current copy” to review it again.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Check current copy', exact: true }).click();
    await page.getByText('Copy check complete. No obvious risks found.', { exact: true }).waitFor();
    assert.equal(await visualField.inputValue(), 'A close-up of freshly brewed coffee');
    await page.getByRole('button', { name: 'Write copy', exact: false }).click();
  }
  await page.getByLabel('Spoken script').fill('word '.repeat(100));
  await page.getByRole('button', { name: 'Confirm & produce', exact: false }).click();
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
  await page.getByRole('button', { name: 'Confirm & produce', exact: false }).click();
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
  // Unknown outcomes block mutations in this project, not navigation. A local
  // receipt recovery must not generate another copy/storyboard request.
  const blockedId = '33333333-3333-4333-8333-333333333333';
  const oldVideoId = '44444444-4444-4444-8444-444444444444';
  const blocked = { ...projects.get(legacyId), id: blockedId, version: 1, draft: { ...legacyDraft, assets: {}, topic: 'Waiting receipt', publishTitle: 'Waiting receipt', storyboard: [] }, taskId: null, status: 'draft' };
  projects.set(blockedId, blocked);
  const otherDraftId = '66666666-6666-4666-8666-666666666666';
  projects.set(otherDraftId, { ...blocked, id: otherDraftId, draft: { ...blocked.draft, publishTitle: 'Other editable draft' } });
  textOperations.set(blockedId, [{ id: '55555555-5555-4555-8555-555555555555', status: 'unknown' }]);
  await page.evaluate(id => localStorage.setItem('lot:marketing-video:fixture', id), blockedId);
  await page.reload(); await chooseAgent('Marketing video');
  await page.getByRole('alert').filter({ hasText: 'The last request got no clear result' }).waitFor();
  assert.equal(await page.getByLabel('Spoken script').isDisabled(), true);
  assert(!/Operation ID|Saved creation records|Refresh creation status/.test(await page.locator('.mv-studio').innerText()), 'internal operation state stays hidden');
  assert.equal(await page.getByRole('button', { name: 'Start a new video', exact: true }).isDisabled(), false);
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await snap('marketing-video-unknown-en-dark.png');
  await page.locator('.mv-library > summary').click();
  // Space usage shows when the library opens.
  await page.getByText('Storage used 53.0 MB: videos and clips 50.0 MB · materials in use 1.0 MB · narration 2.0 MB · reference analyses 0 KB / 2.0 GB', { exact: true }).waitFor();
  await page.locator('.mv-draft-list button').filter({ hasText: 'Waiting receipt' }).click();
  await page.getByRole('alert').filter({ hasText: 'The last request got no clear result' }).waitFor();
  assert.equal(await page.getByLabel('Spoken script').isDisabled(), true, 'reopening the same project must keep its lock');
  await page.locator('.mv-draft-list button').filter({ hasText: 'Other editable draft' }).click();
  await page.getByRole('alert').filter({ hasText: 'The last request got no clear result' }).waitFor({ state: 'hidden' });
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some(input => input.rows === 6 && !input.disabled));
  await page.locator('.mv-draft-list button').filter({ hasText: 'Waiting receipt' }).click();
  await page.getByRole('alert').filter({ hasText: 'The last request got no clear result' }).waitFor();
  await page.getByRole('button', { name: 'Start a new video', exact: true }).click();
  assert.equal(await page.getByLabel('Spoken script').isDisabled(), false);
  assert.equal(await page.getByLabel('Spoken script').inputValue(), '');
  // Deleting a draft removes its generated videos and analyses; uploads stay in Personal Assets.
  await page.locator('.mv-draft-item').filter({ hasText: 'Other editable draft' }).getByRole('button', { name: 'Delete draft', exact: true }).click();
  const deleteDialog = page.getByRole('dialog', { name: 'Delete video draft', exact: true });
  assert.match(await deleteDialog.innerText(), /generated video and clips, and its reference video analysis will be permanently deleted[\s\S]*Uploaded materials remain in Personal Assets/);
  await snap('marketing-video-delete-en-dark.png');
  await confirmDialog('Delete video draft', 'Delete');
  await page.getByText('Draft deleted. 3.0 MB freed. Uploaded materials remain in Personal Assets. 1 reference analyses have model requests awaiting verification and were not deleted yet.', { exact: true }).waitFor();
  assert.equal(await page.locator('.mv-draft-item').filter({ hasText: 'Other editable draft' }).count(), 0);
  assert.equal(projects.has(otherDraftId), false, 'the DELETE request reached the API');
  if (!await page.locator('.mv-library').evaluate(element => element.open)) await page.locator('.mv-library > summary').click();
  await page.locator('.mv-draft-list button').filter({ hasText: 'Waiting receipt' }).click();
  await page.getByRole('alert').filter({ hasText: 'The last request got no clear result' }).waitFor();
  const paidBeforeRecovery = writes.filter(r => r.path.endsWith('/copy') || r.path.endsWith('/storyboard')).length;
  const operation = textOperations.get(blockedId)[0];
  operation.status = 'needs_apply'; operation.result = { draft: { ...blocked.draft, script: 'Recovered local receipt' }, analysis: 'Local recovery' };
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some(input => input.value === 'Recovered local receipt' && !input.disabled), null, { timeout: 15000 });
  assert.equal(writes.filter(r => r.path.endsWith('/recover')).length, 1);
  assert.equal(writes.filter(r => r.path.endsWith('/copy') || r.path.endsWith('/storyboard')).length, paidBeforeRecovery);
  // A confirmed retry it cannot repeat itself unlocks AI creation for this project without any model request.
  const discarded = '77777777-7777-4777-8777-777777777777';
  textOperations.set(blockedId, [{ id: discarded, status: 'unknown' }, ...textOperations.get(blockedId)]);
  await page.reload(); await chooseAgent('Marketing video');
  await page.getByRole('alert').filter({ hasText: 'The last request got no clear result' }).waitFor();
  assert.equal(await page.getByLabel('Spoken script').isDisabled(), true);
  // The one action for an unknown result: here the page cannot repeat that request, so it only unlocks.
  await page.locator('.ma-panel').getByRole('button', { name: 'Verify and retry', exact: true }).click();
  await confirmDialog('Verify and retry?', 'Retry');
  await page.getByRole('alert').filter({ hasText: 'The last request got no clear result' }).waitFor({ state: 'hidden' });
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some(input => input.rows === 6 && !input.disabled));
  assert.equal(writes.filter(r => r.path.endsWith(`/text-operations/${discarded}/release`)).length, 1);
  assert.equal(writes.filter(r => r.path.endsWith('/copy') || r.path.endsWith('/storyboard')).length, paidBeforeRecovery);
  uploadedAssets.set(oldVideoId, { id: oldVideoId, name: 'Legacy WebM', mime: 'video/webm', url: '/static/legacy.webm', issue: 'unsupported' });
  blocked.draft.assets = { video: oldVideoId }; blocked.draft.script = script;
  blocked.draft.storyboard = planMarketingSegments(script, blocked.draft.durationSec).map(part => ({ durationSec: part.durationSec, script: part.script, visual: '咖啡店', action: '自然讲述并展示咖啡', camera: '中景' }));
  blocked.draft.storyboardAudio = true;
  await page.evaluate(() => localStorage.setItem('lot:language', 'zh'));
  await page.reload(); await chooseAgent('营销影像');
  await page.getByRole('button', { name: '确定素材', exact: false }).click();
  await page.getByText('此历史素材不支持新生成，请移除或替换。', { exact: true }).waitFor();
  const audioNotice = page.locator('.mv-audio-notice');
  await audioNotice.getByText('已添加参考视频，成片不生成口播，但当前分镜按有声口播编写。建议按无声展示重新生成分镜。', { exact: true }).waitFor();
  await audioNotice.getByRole('button', { name: '保留当前分镜', exact: true }).click();
  await audioNotice.waitFor({ state: 'hidden' });
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.getByRole('region', { name: '参考视频', exact: true }).scrollIntoViewIfNeeded();
  await snap('marketing-video-legacy-webm-zh-dark.png');
  await page.getByRole('region', { name: '参考视频', exact: true }).getByRole('button', { name: '移除', exact: true }).click();
  await page.getByText('此历史素材不支持新生成，请移除或替换。', { exact: true }).waitFor({ state: 'hidden' });
  // Removing the video turns speech back on; the kept silent board is flagged and rebuilt on request.
  await audioNotice.getByText('已移除参考视频，成片会生成口播，但当前分镜按无声展示编写。建议按口播重新生成分镜。', { exact: true }).waitFor();
  await snap('marketing-video-audio-notice-zh-dark.png');
  await audioNotice.getByRole('button', { name: '按口播重新生成分镜', exact: true }).click();
  await audioNotice.waitFor({ state: 'hidden' });
  const rebuild = writes.filter(r => r.path === `/api/marketing-videos/${blockedId}/storyboard`).at(-1);
  assert.match(rebuild.body.instruction, /已移除参考视频/); assert.equal(rebuild.body.index, undefined);
  await page.evaluate(() => localStorage.setItem('lot:language', 'en'));
  taskState = 'pending';
  const queued = projects.get(p.id); queued.output = undefined; queued.stage = '队列状态待核实';
  await page.evaluate(id => localStorage.setItem('lot:marketing-video:fixture', id), p.id);
  await page.reload(); await chooseAgent('Marketing video');
  await page.locator('.mv-progress strong').filter({ hasText: 'Queued' }).waitFor();
  await page.getByText('35% · Queue status is being verified', { exact: true }).waitFor();
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await snap('marketing-video-queued-en-dark.png');
  await page.locator('.mv-progress').getByRole('button', { name: 'Cancel generation', exact: true }).click();
  await confirmDialog('Cancel video generation?', 'Cancel generation');
  await page.locator('.mv-progress strong').filter({ hasText: 'Cancelled' }).waitFor();
  await page.getByText('35% · Cancellation requested', { exact: true }).waitFor();
  await snap('marketing-video-cancelled-en-dark.png');
  // Unknown clip outcomes: no plain resume; one confirmed release, then one retry of the same job.
  taskState = 'failed'; queued.stage = '片段完成 1/2'; queued.error = '片段提交结果未知，请核实原任务；系统不会重复提交付费请求。'; queued.errorCode = 'SUBMISSION_UNKNOWN'; queued.unknownSegments = 2;
  const generatedBeforeRelease = writes.filter(r => r.path.endsWith('/generate')).length;
  await page.reload(); await chooseAgent('Marketing video');
  await page.getByRole('button', { name: 'Verify and retry', exact: true }).waitFor();
  assert.equal(await page.locator('.mv-progress').getByRole('button', { name: 'Continue creation', exact: true }).count(), 0);
  await snap('marketing-video-unknown-clips-en-dark.png');
  await page.getByRole('button', { name: 'Verify and retry', exact: true }).click();
  await confirmDialog('Verify and retry?', 'Retry');
  await page.locator('.mv-progress strong').filter({ hasText: 'Creating your video' }).waitFor();
  assert.equal(writes.filter(r => r.path.endsWith('/unknown-segments/release')).length, 1);
  const retries = writes.filter(r => r.path.endsWith('/generate')).slice(generatedBeforeRelease);
  assert.equal(retries.length, 1); assert.equal(retries[0].body.retry, true);
  apiUnavailable = true;
  await page.reload(); await chooseAgent('Marketing video');
  await page.getByRole('alert').filter({ hasText: 'This server does not support the new marketing video workflow yet.' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Create copy and storyboard', exact: true }).isDisabled(), true);
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await snap('marketing-video-unavailable-en-dark.png');
  assert(materialRefreshes.length > 0, 'Expired or failed previews reauthorize through the owned asset API');
  assert(statusPolls > 0, 'progress is polled from the task state endpoint');
  assert.deepEqual(errors, []); assert.deepEqual(unexpectedRequests, []); assert.deepEqual(nativeDialogs, []);
  console.log('PASS: legacy drafts/results without storyboard, no spurious autosave, legacy-to-storyboard editing and reload, unavailable-server guard and reconnect, generated copy preserved after review failure, three-step workflow, reference rewrite and review, avatar/background selection, optional voice library selection and removal, generation without a voice sample, visible plan errors and edit recovery, generation during pending autosave, 60s plan, editable storyboard, scoped/all AI edits, failure preservation, manual storyboard, double-click safety, reload recovery, editable publication, archive/update, single shot redo, AI-voice and narrated captions blocked until subtitles are off when local subtitles are unsupported, SRT download, adjusting caption size, offsets and line breaks (never words) and recomposing, recomposing captions and reworded narrated lines without a redone shot, following narration takes after reopening, retrying only failed narration takes after confirmation, titles filled and checked after submission, duplicated/new drafts, dark and English responsive layouts.');
} catch (error) {
  console.error({ errors, unexpectedRequests, body: await page?.locator('body').innerText() });
  throw error;
} finally {
  await browser?.close(); await vite?.close(); await rm(temp, { recursive: true, force: true });
}
