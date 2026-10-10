/** Browser integration with fake camera/microphone and in-memory HTTP fixtures.
 * No real user data, device capture, database, or paid model calls.
 * PLAYWRIGHT_MODULE=/path/to/playwright node packages/server/scripts/check-digital-twin-ui.mjs
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
const temp = await realpath(await mkdtemp(join(tmpdir(), "lot-twin-ui-")));
const screenshots = process.env.TWIN_SCREENSHOTS_DIR;
let vite, browser, page;
try {
  await writeFile(join(temp, "index.html"), '<div id="root"></div><script type="module" src="/main.tsx"></script>');
  await writeFile(join(temp, "main.tsx"), `import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {KnowledgePanel} from ${JSON.stringify(resolve(root, "packages/web/src/modules/knowledge/KnowledgePanel.tsx"))};
    import {InputBox} from ${JSON.stringify(resolve(root, "packages/web/src/components/InputBox.tsx"))};
    import {LanguageProvider} from ${JSON.stringify(resolve(root, "packages/web/src/i18n/index.tsx"))};
    import {setToken} from ${JSON.stringify(resolve(root, "packages/web/src/api/client.ts"))};
    import ${JSON.stringify(resolve(root, "packages/web/src/App.css"))};
    setToken('twin-test-session');
    function Fixture(){const [open,setOpen]=useState(true);return <><button onClick={()=>setOpen(true)}>Open library</button>{open && <KnowledgePanel onClose={()=>setOpen(false)}/>}<InputBox mode="video" selectedModel="doubao-seedance-2.5" models={[{id:'doubao-seedance-2.5',type:'video',provider:'test'}]} onSend={(prompt,files)=>{document.body.dataset.sent=JSON.stringify({prompt,files:files.map(f=>({slot:f.slot,mime:f.file.type,name:f.file.name}))});}}/></>}
    createRoot(document.getElementById('root')).render(<LanguageProvider><Fixture/></LanguageProvider>);`);
  vite = await createServer({ configFile: false, root: temp, esbuild: { jsx: "automatic" }, optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"] }, resolve: { alias: { react: resolve(root, "packages/web/node_modules/react"), "react-dom": resolve(root, "packages/web/node_modules/react-dom") } }, server: { host: "127.0.0.1", port: 0, fs: { allow: [root, temp] } } });
  await vite.listen();
  browser = await chromium.launch({ headless: true, channel: "chrome", args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, permissions: ["camera", "microphone"] });
  await context.addInitScript(() => {
    if (!localStorage.getItem("lot:language")) localStorage.setItem("lot:language", "zh");
    window.fixtureStreams = [];
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => { const stream = await get(constraints); window.fixtureStreams.push(stream); return stream; };
  });
  page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (dialog) => dialog.accept());
  const items = new Map(); const keys = new Map(); let seq = 0;
  await page.route("**/api/**", async (route) => {
    const req = route.request(); const url = new URL(req.url()); const path = url.pathname;
    if (!path.startsWith("/api/")) return route.continue();
    const json = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (path === "/api/public/product") return json({ globle: 1 });
    assert.equal(req.headers().authorization, "Bearer twin-test-session");
    if (path.endsWith("/collections")) return json({ data: [], nextCursor: null });
    if (path.endsWith("/storage")) return json({ storedBytes: 0 });
    if (path.endsWith("/status")) return json({ ingestionEnabled: false });
    if (path.endsWith("/items")) return json({ data: [...items.values()].map(v => v.item).filter(v => (!url.searchParams.get('tag') || v.tags.includes(url.searchParams.get('tag'))) && (!url.searchParams.get('types') || v.sourceType === url.searchParams.get('types'))), nextCursor: null });
    if (path.endsWith("/uploads")) {
      const key = req.headers()["idempotency-key"];
      if (keys.has(key)) return json({ id: keys.get(key) }, 201);
      const metadata = JSON.parse(decodeURIComponent(req.headers()["x-knowledge-metadata"]));
      assert.equal(metadata.collectionIds.length, 0);
      assert.match(metadata.tags[0], /^digital-twin:(voice|portrait)$/);
      const mime = req.headers()["content-type"]; const body = req.postDataBuffer();
      if (mime === "audio/wav") assert.equal(body.toString('ascii', 8, 12), "WAVE");
      const id = `asset-${++seq}`;
      const item = { id, title: metadata.title, mime, size: body.length, tags: metadata.tags, revisionId: `revision-${seq}`, version: 1, sourceType: mime.startsWith("audio/") ? "audio" : "image", collectionIds: [] };
      items.set(id, { item, body }); keys.set(key, id); return json({ id }, 201);
    }
    const id = path.split("/")[5];
    if (path.endsWith("/content")) { const asset = items.get(id); return route.fulfill({ contentType: asset.item.mime, body: asset.body }); }
    if (req.method() === "DELETE") { assert.equal(JSON.parse(req.postData()).version, 1); items.delete(id); return json({ ok: true }); }
    throw new Error(`Unexpected request ${req.method()} ${path}`);
  });
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}`);
  await page.getByRole("button", { name: "数字分身", exact: true }).first().click();
  await page.getByRole("heading", { name: "个人语音库" }).waitFor();
  const voice = page.locator(".twin-library").filter({ has: page.getByRole("heading", { name: "个人语音库" }) });
  const portrait = page.locator(".twin-library").filter({ has: page.getByRole("heading", { name: "个人肖像库" }) });
  await voice.getByRole("button", { name: "录制声音", exact: true }).click();
  await page.getByText("正在录音 2 / 15 秒", { exact: true }).waitFor();
  await voice.getByRole("button", { name: "结束录音" }).click();
  await voice.getByRole("button", { name: "保存到个人库" }).waitFor();
  await voice.getByLabel("素材名称").fill("我的声音");
  await voice.getByRole("button", { name: "保存到个人库" }).click();
  await voice.locator(".twin-asset").waitFor();
  await portrait.getByRole("button", { name: "本机拍照" }).click();
  await portrait.getByRole("button", { name: "拍摄照片" }).click();
  await portrait.getByLabel("素材名称").fill("我的肖像");
  await portrait.getByRole("button", { name: "保存到个人库" }).click();
  await portrait.locator(".twin-asset").waitFor();
  assert.equal(items.size, 2);
  assert(await page.evaluate(() => window.fixtureStreams.every(stream => stream.getTracks().every(track => track.readyState === "ended"))));
  // File upload follows the same private, tagged persistence path.
  const wav = [...items.values()].find(v => v.item.mime === 'audio/wav').body;
  await voice.locator('input[type="file"]').setInputFiles({ name: 'uploaded.wav', mimeType: 'audio/wav', buffer: wav });
  await voice.getByRole("button", { name: "保存到个人库" }).click();
  await page.waitForFunction(() => document.querySelectorAll('.twin-asset').length === 3);
  await portrait.locator('input[type="file"]').setInputFiles({ name: 'uploaded.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') });
  await portrait.getByRole("button", { name: "保存到个人库" }).click();
  await page.waitForFunction(() => document.querySelectorAll('.twin-asset').length === 4);
  await portrait.locator('.twin-asset').filter({ hasText: 'uploaded.png' }).getByRole('button', { name: '删除', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.twin-asset').length === 3);
  if (screenshots) { await mkdir(screenshots, { recursive: true }); await page.screenshot({ animations: 'disabled', path: join(screenshots, 'digital-twin-light.png') }); }
  // Unmounting stops a live camera rather than retaining the device.
  await portrait.getByRole("button", { name: "本机拍照" }).click();
  await portrait.getByRole("button", { name: "拍摄照片" }).waitFor();
  await page.getByRole("button", { name: "关闭知识库" }).click();
  assert(await page.evaluate(() => window.fixtureStreams.every(stream => stream.getTracks().every(track => track.readyState === "ended"))));
  await page.getByRole("button", { name: "数字分身", exact: true }).click();
  await page.locator('.twin-library').first().getByRole('button', { name: '用于视频制作', exact: true }).first().click();
  await page.getByRole('status').filter({ hasText: '已添加' }).waitFor();
  await page.locator('.twin-library').nth(1).getByRole('button', { name: '用于视频制作', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '我的肖像' }).waitFor();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.locator('.input-box > textarea').press('Enter');
  const sent = JSON.parse(await page.locator('body').getAttribute('data-sent'));
  assert.deepEqual(sent.files.map(v => v.slot), ['video_reference_image', 'video_reference_audio']);
  assert.match(sent.prompt, /@Audio1/); assert.match(sent.prompt, /@Image1/);
  // Persisted library survives remount, and permission denial is actionable.
  await page.getByRole('button', { name: 'Open library' }).click();
  await page.getByRole('button', { name: '数字分身', exact: true }).first().click();
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); }; });
  await voice.getByRole('button', { name: '录制声音', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '权限' }).waitFor();
  await page.mouse.move(5, 5);
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.waitForFunction(() => { const button = document.querySelector('.twin-capture button'); return getComputedStyle(button).backgroundColor === getComputedStyle(document.querySelector('.twin-library')).backgroundColor; });
  if (screenshots) await page.screenshot({ animations: 'disabled', path: join(screenshots, 'digital-twin-dark.png') });
  // English copy and a narrow viewport.
  await page.evaluate(() => localStorage.setItem('lot:language', 'en'));
  await page.reload();
  await page.getByRole('button', { name: 'Digital twin', exact: true }).first().click();
  await page.getByRole('heading', { name: 'Personal voice library' }).waitFor();
  await page.setViewportSize({ width: 760, height: 1000 });
  assert(await page.evaluate(() => document.querySelector('.digital-twin-panel').scrollWidth <= document.querySelector('.knowledge-main').clientWidth));
  if (screenshots) await page.screenshot({ animations: 'disabled', path: join(screenshots, 'digital-twin-en.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: capture, WAV conversion, file uploads, private metadata, preview, delete, remount, device cleanup, permission denial, video slots/prompts, dark theme and English responsive layout.');
} catch (error) { console.error(await page?.locator("body").innerText().catch(() => "No page")); throw error; } finally { await browser?.close(); await vite?.close(); await rm(temp, { recursive: true, force: true }); }
