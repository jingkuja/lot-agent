/** Real React UI with intercepted fixtures. No external requests or model calls. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { createServer } = createRequire(resolve(root, "packages/web/package.json"))("vite");
const temp = await realpath(await mkdtemp(join(tmpdir(), "lot-analysis-ui-")));
let vite, browser;
try {
  await writeFile(join(temp, "index.html"), '<div id="root"></div><script type="module" src="/main.tsx"></script>');
  await writeFile(join(temp, "main.tsx"), `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {ReferenceAnalysisPanel} from ${JSON.stringify(resolve(root, "packages/web/src/modules/marketing-video/ReferenceAnalysisPanel.tsx"))};
    import {LanguageProvider,LanguageSelect} from ${JSON.stringify(resolve(root, "packages/web/src/i18n/index.tsx"))};
    import {setToken} from ${JSON.stringify(resolve(root, "packages/web/src/api/client.ts"))};
    import ${JSON.stringify(resolve(root, "packages/web/src/App.css"))};
    import ${JSON.stringify(resolve(root, "packages/web/src/modules/marketing-video/marketing-video.css"))};
    setToken('fixture-token');function Test(){const [owner,setOwner]=useState('owner');return <div className="mv-studio"><LanguageSelect/><button onClick={()=>setOwner('other')}>Switch account</button>
    <ReferenceAnalysisPanel key={owner} ownerId={owner} canApply={true} prepareProject={async()=>({projectId:'project',projectVersion:1})} applied={async()=>{document.body.dataset.applied='true'}}/></div>}
    createRoot(document.getElementById('root')).render(<React.StrictMode><LanguageProvider><Test/></LanguageProvider></React.StrictMode>);`);
  vite = await createServer({ configFile: false, root: temp, esbuild: { jsx: "automatic" }, optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime"] },
    resolve: { alias: { react: resolve(root, "packages/web/node_modules/react"), "react-dom": resolve(root, "packages/web/node_modules/react-dom") } },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root, temp] } } });
  await vite.listen(); browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } }); const page = await context.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await context.addInitScript(() => { if (!localStorage.getItem("lot:language")) localStorage.setItem("lot:language", "zh"); });
  const id = "00000000-0000-4000-8000-000000000039";
  let value = { id, ownerId: "owner", taskId: id, revision: 1, version: 1, status: "ready", stage: "summary", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), budget: { spent: 0.12, limit: 2, reserved: 0 }, snapshot: {
    source: { platform: "bilibili", title: "产品展示样例", canonicalUrl: "https://www.bilibili.com/video/BV1234567890", durationMs: 2000 },
    frames: [{ id: "f0001", ptsMs: 0 }], frameTexts: [{ frameId: "f0001", rawText: "不包邮 99元" }],
    texts: [{ id: "t0001", rawText: "不包邮 99元", text: "不包邮 99元", frameIds: ["f0001"], firstSeenMs: 0, lastSeenMs: 500 }], observations: [],
    summary: { summary: [{ statement: "展示商品价格与配送条件", evidenceIds: ["t0001"], inference: false }], timeline: [{ startMs: 0, endMs: 500, statement: "展示价格", evidenceIds: ["f0001"], inference: false }], marketingPoints: [{ kind: "selling_point", statement: "通过价格信息吸引关注", evidenceIds: ["t0001"], inference: true }], limitations: ["NO_AUDIO_ANALYSIS", "SAMPLED_IMAGES_ONLY"] }, summaryRevision: 1,
    coverage: { sampledFrames: 1, ocrFrames: 1, visualFrames: 1, omittedOcrFrameIds: [], omittedVisualFrameIds: [], limitations: ["NO_AUDIO_ANALYSIS"] },
  } };
  let conflict = true, writes = 0, applied = 0, account = "owner";
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/public/product") return json({ globle: 1 });
    assert(path.startsWith("/api/marketing-video-analyses"), `unexpected request ${path}`);
    if (path.endsWith("/capabilities")) return json({ enabled: true, budgetCny: 2 });
    if (path.endsWith("/sessions")) return json({ data: [] });
    if (path === "/api/marketing-video-analyses") {
      if (request.method() === "POST") { const body = request.postDataJSON(); assert(body.clientRequestId && !body.ownerId); writes++; return json(value, 202); }
      return json({ data: account === "owner" ? [value] : [] });
    }
    if (path.endsWith("/text")) {
      if (conflict) { conflict = false; return json({ code: "REVISION_CONFLICT", error: "REVISION_CONFLICT" }, 409); }
      assert.equal(request.postDataJSON().expectedRevision, value.revision);
      value = structuredClone(value); value.revision++; value.snapshot.texts[0].text = request.postDataJSON().texts[0].text; delete value.snapshot.summary; value.status = "partial";
      return json(value);
    }
    if (path.endsWith("/apply-preview")) return json({ reference: value.snapshot.texts[0].text });
    if (path.endsWith("/apply")) { assert.equal(request.postDataJSON().expectedRevision, value.revision); applied++; return json({}); }
    if (path.includes("/frames/")) {
      assert.equal(request.headers().authorization, "Bearer fixture-token");
      return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="320"><rect width="600" height="320" fill="#163c55"/><text x="80" y="160" fill="white" font-size="48">PRODUCT 99</text></svg>' });
    }
    return account === "owner" ? json(value) : json({ error: "ANALYSIS_NOT_FOUND" }, 404);
  });
  await page.goto(vite.resolvedUrls.local[0]);
  await page.getByText("参考视频分析", { exact: true }).click();
  await page.getByLabel("视频链接或分享文本").fill("https://www.bilibili.com/video/BV1234567890");
  assert.equal(await page.getByRole("alert").count(), 0, "StrictMode cleanup must not surface an aborted load as an error");
  await page.getByRole("button", { name: "开始分析（调用模型）", exact: true }).click();
  await page.getByRole("heading", { name: "产品展示样例" }).waitFor(); assert.equal(writes, 1);
  await page.getByRole("button", { name: "f0001", exact: true }).first().click();
  await page.getByRole("img", { name: "证据帧 f0001" }).waitFor();
  await page.screenshot({ path: join(temp, "analysis-zh.png"), fullPage: true });
  await page.reload(); await page.getByText("参考视频分析", { exact: true }).click();
  await page.getByRole("heading", { name: "产品展示样例" }).waitFor();
  await page.getByRole("button", { name: "校对文字", exact: true }).click(); await page.getByRole("textbox", { name: "校对 t0001" }).fill("不包邮 199元");
  await page.getByRole("button", { name: "保存新修订", exact: true }).click();
  await page.getByText("分析已在其他页面更新，请重新打开后校对。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "校对 t0001" }).inputValue(), "不包邮 199元", "conflict keeps unsaved correction");
  await page.getByRole("button", { name: "保存新修订", exact: true }).click();
  await page.getByText("不包邮 199元", { exact: true }).waitFor();
  await page.getByText("机器原文", { exact: true }).click(); await page.getByText("不包邮 99元", { exact: true }).waitFor();
  await page.getByRole("button", { name: "预览选用到草稿", exact: true }).click();
  await page.getByRole("heading", { name: "将替换草稿中的参考文案" }).waitFor(); assert.equal(applied, 0);
  await page.getByRole("button", { name: "确认选用", exact: true }).click(); await page.getByText("已选用为参考文案，可继续拆解改写。", { exact: true }).waitFor(); assert.equal(applied, 1);
  await page.getByRole("combobox", { name: "Bahasa / Language / 语言" }).selectOption("en");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.getByRole("button", { name: "Preview use in draft", exact: true }).waitFor();
  assert.equal(await page.locator("body").evaluate(node => node.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(temp, "analysis-en-dark.png"), fullPage: true });
  account = "other"; await page.getByRole("button", { name: "Switch account" }).click();
  await page.getByText("Reference video analysis", { exact: true }).click();
  assert.equal(await page.getByRole("heading", { name: "产品展示样例" }).count(), 0);
  assert.equal(await page.getByText("不包邮 199元", { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(`PASS: create, refresh recovery, authenticated evidence, correction conflicts, original text, explicit apply, English/dark theme and account isolation. Screenshots: ${temp}`);
} finally { await browser?.close(); await vite?.close(); if (!process.env.KEEP_ANALYSIS_SCREENSHOTS) await rm(temp, { recursive: true, force: true }); }
