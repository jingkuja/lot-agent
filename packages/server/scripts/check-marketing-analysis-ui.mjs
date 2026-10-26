/** Real React UI with intercepted fixtures. No external requests or model calls. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { createServer } = createRequire(resolve(root, "packages/web/package.json"))("vite");
const temp = await realpath(await mkdtemp(join(tmpdir(), "lot-analysis-ui-")));
const liveSpeech = process.env.MARKETING_ANALYSIS_UI_SPEECH_RESULT
  ? JSON.parse(await readFile(process.env.MARKETING_ANALYSIS_UI_SPEECH_RESULT, "utf8")) : null;
let vite, browser, uploads = 0, uploadRequestId;
const uploadId = "00000000-0000-4000-8000-000000000045";
try {
  await writeFile(join(temp, "index.html"), '<div id="root"></div><script type="module" src="/main.tsx"></script>');
  await writeFile(join(temp, "main.tsx"), `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {ProjectStudio} from ${JSON.stringify(resolve(root, "packages/web/src/modules/marketing-video/ProjectStudio.tsx"))};
    import {LanguageProvider,LanguageSelect} from ${JSON.stringify(resolve(root, "packages/web/src/i18n/index.tsx"))};
    import {setToken} from ${JSON.stringify(resolve(root, "packages/web/src/api/client.ts"))};
    import ${JSON.stringify(resolve(root, "packages/web/src/App.css"))};
    import ${JSON.stringify(resolve(root, "packages/web/src/modules/marketing-video/marketing-video.css"))};
    setToken('fixture-token');function Test(){const [owner,setOwner]=useState('owner');return <><LanguageSelect/><button onClick={()=>setOwner('other')}>Switch account</button>
    <ProjectStudio key={owner} ownerId={owner}/></>}
    createRoot(document.getElementById('root')).render(<React.StrictMode><LanguageProvider><Test/></LanguageProvider></React.StrictMode>);`);
  vite = await createServer({ configFile: false, root: temp, esbuild: { jsx: "automatic" }, optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime"] },
    plugins: [{ name: "fixture-local-upload", configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url.startsWith("/api/marketing-video-analyses/uploads?")) return next();
        void (async () => {
          assert.equal(req.headers.authorization, "Bearer fixture-token");
          // P17: the video is the raw body, streamed by the server; the request ID is in the URL.
          assert.equal(req.headers["content-type"], "video/mp4");
          assert.equal(decodeURIComponent(req.headers["x-file-name"]), "local-reference.mp4");
          const chunks = []; for await (const chunk of req) chunks.push(chunk);
          const raw = Buffer.concat(chunks); assert.equal(raw.toString("ascii", 4, 8), "ftyp", "HTTP server receives actual MP4 bytes");
          const requestId = new URL(req.url, "http://fixture").searchParams.get("clientRequestId"); assert(requestId);
          uploads++;
          if (uploads === 1) uploadRequestId = requestId;
          assert.equal(requestId, uploadRequestId, "an explicitly retried lost upload response must reuse its request ID");
          res.statusCode = 201; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ id: uploadId, name: "local-reference.mp4" }));
        })().catch(error => { console.error(error); res.statusCode = 500; res.end(); });
      });
    } }],
    resolve: { alias: { react: resolve(root, "packages/web/node_modules/react"), "react-dom": resolve(root, "packages/web/node_modules/react-dom") } },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root, temp] } } });
  await vite.listen(); browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } }); const page = await context.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await context.addInitScript(() => { if (!localStorage.getItem("lot:language")) localStorage.setItem("lot:language", "zh"); });
  await context.addInitScript(() => {
    const original = window.fetch; let lostUpload = false;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (String(args[0]).includes("/marketing-video-analyses/uploads?") && !lostUpload) {
        lostUpload = true; await response.arrayBuffer(); throw new TypeError("fixture lost upload response");
      }
      return response;
    };
  });
  const id = "00000000-0000-4000-8000-000000000039";
  const projects = new Map(); const textOperations = new Map(); let value, projectId, account = "owner", copyCalls = 0, starts = 0, resumes = 0;
  let loseResumeResponse = false;
  const shots = [
    { script: "在明亮空间，品尝现磨咖啡。", visual: "明亮咖啡店与咖啡杯", action: "端起咖啡", camera: "中景缓缓推进" },
    { script: "找到自己喜欢的味道。", visual: "咖啡杯近景", action: "缓缓倒入咖啡", camera: "俯拍特写" },
  ];
  const create = draft => {
    const storyboard = draft.durationSec === 60 ? Array.from({ length: 5 }, (_, i) => ({ ...shots[i % 2], durationSec: 13 }))
      : shots.map(shot => ({ ...shot, durationSec: 15 }));
    return { draft: { ...draft, script: storyboard.map(s => s.script).join("\n"), storyboard, publishTitle: "转角咖啡", tags: "#咖啡" }, analysis: "场景切入，展示产品，邀请品尝。" };
  };
  await page.route("**/api/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/public/product") return json({ globle: 1 });
    if (path === "/api/marketing-videos/capabilities") return json({ composition: true, subtitles: true, knowledge: false });
    if (path === "/api/marketing-videos") return json({ data: account === "owner" ? [...projects.values()] : [] });
    if (path === "/api/marketing-videos/usage") return json({ videoBytes: 0, materialBytes: 0, narrationBytes: 0, analysisBytes: 0, analysisLimitBytes: 2 * 1024 ** 3 });
    if (path.endsWith("/text-operations")) return json({ data: textOperations.get(path.split("/").at(-2)) ?? [] });
    if (path === "/api/marketing-videos/copy") {
      copyCalls++; const body = req.postDataJSON(); assert(body.clientRequestId);
      assert(["text", "video"].includes(body.source.kind), "generation must not send the upload tab as an unsupported source kind");
      const p = projects.get(body.projectId); assert.equal(p.version, body.version);
      const result = create(body.draft); p.version++; p.draft = result.draft;
      textOperations.set(p.id, [{ id: body.clientRequestId, status: "succeeded", appliedVersion: p.version, result }]);
      // The server completed, but the browser lost its response. Polling must
      // recover the same durable result without issuing another copy POST.
      if (copyCalls === 1) return route.abort("failed");
      return json({ ...result, project: p, operation: { status: "succeeded" } });
    }
    if (path === "/api/marketing-video-analyses/uploads") {
      // CDP intentionally omits file bytes from postData; use the local HTTP
      // middleware above to verify the real multipart transfer.
      return route.continue();
    }
    if (path === "/api/marketing-video-analyses") {
      assert.equal(req.method(), "POST"); starts++;
      const body = req.postDataJSON(); projectId = body.target.projectId;
      assert(body.clientRequestId); assert.equal(body.target.locale, "zh");
      const p = projects.get(projectId); assert.equal(p.version, body.target.projectVersion);
      if (body.uploadId) { assert.equal(body.uploadId, uploadId); assert.equal(body.shareText, undefined); assert.equal(p.draft.referenceUpload.id, uploadId); assert.equal(p.draft.assets.video, undefined); }
      p.version++; p.referenceAnalysis = { id, acceptedRevision: 0, evidenceIds: [] };
      value = { id, ownerId: "owner", projectId, revision: 1, status: "queued", stage: "queued", snapshot: {
        source: { platform: body.uploadId ? "local" : "bilibili", title: body.uploadId ? "local-reference.mp4" : "咖啡参考视频" }, frames: [{ id: "f0001", ptsMs: 0 }],
        texts: [{ id: "t0001", text: "原片画面文字", firstSeenMs: 0, lastSeenMs: 500 }], frameTexts: [], observations: [],
      } };
      return json(value, 202);
    }
    if (path === `/api/marketing-video-analyses/${id}`) return json(value);
    if (path.endsWith("/frames/f0001")) {
      assert.equal(req.headers().authorization, "Bearer fixture-token");
      return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrWQAAAAASUVORK5CYII=", "base64") });
    }
    if (path.endsWith("/resume")) {
      resumes++; assert.equal(req.postDataJSON().expectedRevision, 1);
      if (value.errorCode === "SOURCE_EXPIRED") { assert.equal(req.postDataJSON().visualOnly, true); value.snapshot.speech = { status: "skipped", reason: "SOURCE_EXPIRED" }; }
      value.status = "running"; delete value.errorCode;
      if (loseResumeResponse) { loseResumeResponse = false; return route.abort("failed"); }
      return json(value);
    }
    if (path.endsWith("/cancel")) { value.status = "cancelled"; return json(value); }
    // The production step reads the draft's key-art still; none exists in this flow.
    if (/^\/api\/marketing-videos\/[a-f0-9-]+\/key-art$/.test(path) && req.method() === "GET") return json({ version: projects.get(path.split("/").at(-2))?.version ?? 0, keyArt: { status: "missing" }, error: "" });
    if (/^\/api\/marketing-videos\/[a-f0-9-]+$/.test(path)) {
      const pid = path.split("/").at(-1);
      if (req.method() === "PUT") {
        const body = req.postDataJSON(), old = projects.get(pid);
        assert.equal(body.version, old?.version ?? 0);
        const p = { ...old, id: pid, draft: body.draft, version: body.version + 1, status: "draft", assets: {} };
        if (old && (old.draft.reference !== body.draft.reference || old.draft.referenceUpload?.id !== body.draft.referenceUpload?.id || old.draft.copyMode !== body.draft.copyMode)) delete p.referenceAnalysis;
        projects.set(pid, p); return json(p);
      }
      return json(projects.get(pid));
    }
    throw new Error(`Unexpected request: ${req.method()} ${path}`);
  });
  const address = `http://127.0.0.1:${vite.httpServer.address().port}`;
  await page.goto(address);
  await page.getByRole("button", { name: "拆解爆款文案", exact: true }).click();
  const reference = page.getByRole("textbox", { name: "视频链接或参考文案", exact: true });
  const duration = page.getByRole("slider", { name: "整片时长（秒）", exact: true });
  assert.equal(await duration.inputValue(), "30");
  assert.equal(await page.getByRole("radio", { name: "粘贴链接或文案", exact: true }).isChecked(), true);
  assert.equal(await page.getByRole("button", { name: /^(15|30|45|60) 秒$/ }).count(), 0);
  const inputBounds = await reference.boundingBox();
  const optionBounds = await page.getByRole("group", { name: "参考内容类型", exact: true }).boundingBox();
  assert(optionBounds.y + optionBounds.height <= inputBounds.y, "source options belong above the input");
  assert.equal(await page.locator(".mv-creative-brief").evaluate(el => el.open), true);
  assert.equal(await page.getByRole("textbox", { name: "产品、卖点和目标顾客", exact: true }).isVisible(), true);
  await duration.focus(); await duration.press("End");
  assert.equal(await duration.inputValue(), "60");
  await reference.fill("一家明亮的咖啡店，提供现磨咖啡，欢迎品尝。https://example.com/shop");
  // A non-platform link is rewritten as copy without choosing a source type.
  await page.getByText("已识别为参考文案，AI 按其结构改写文案与分镜。", { exact: true }).waitFor();
  assert.equal(await page.getByText("参考视频分析", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "一键拆解并生成", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('textarea') && [...document.querySelectorAll('textarea')].some(t => t.value.includes('在明亮空间')));
  await page.getByRole("button", { name: "开始新视频", exact: true }).waitFor({ state: "visible" });
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === '开始新视频').disabled);
  assert.equal(copyCalls, 1); assert.equal(starts, 0);
  await page.reload();
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some(t => t.value.includes('在明亮空间')));
  assert.equal(copyCalls, 1, "refresh after a lost copy response must reuse the paid result");
  await page.getByRole("button", { name: /1\s*确定文案/ }).click();
  await page.getByText("0–13s · 13 秒", { exact: true }).waitFor();
  await page.getByText("52–65s · 13 秒", { exact: true }).waitFor();
  await page.getByText("数字分身将在每个镜头出镜，保持人物形象一致。", { exact: true }).waitFor();
  assert.equal(await page.getByText("中景缓缓推进", { exact: true }).count(), 3);
  assert.equal(await duration.inputValue(), "60");
  await page.getByText("5 个分镜 · 共 65 秒", { exact: true }).waitFor();
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByText("目标 60 秒，分镜共 65 秒，分 5 段生成。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "确认分镜并生成视频", exact: true }).isEnabled(), true);
  await page.getByRole("button", { name: "开始新视频", exact: true }).click();
  await page.getByRole("button", { name: "拆解爆款文案", exact: true }).click();
  await reference.fill("https://www.bilibili.com/video/BV1234567890");
  await page.getByText("已识别为视频链接，AI 读取视频画面、字幕和台词，生成文案与分镜。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "一键拆解并生成", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).waitFor();
  assert.equal(starts, 1);
  await page.reload();
  await page.getByRole("button", { name: "取消", exact: true }).waitFor();
  assert.equal(starts, 1, "refresh must not start another paid analysis");
  // A running analysis locks only its own draft: another draft can be started, and opening this
  // one again shows the same analysis without starting another.
  assert.equal(await reference.isDisabled(), true);
  await page.locator(".mv-library > summary").click();
  const analysisDraft = await page.locator(".mv-draft-item > button[aria-pressed]").evaluateAll(buttons => buttons.findIndex(b => b.getAttribute("aria-pressed") === "true"));
  assert(analysisDraft >= 0);
  await page.getByRole("button", { name: "开始新视频", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".mv-draft-item > button[aria-pressed=true]"));
  assert.equal(await page.getByRole("textbox", { name: "产品、卖点和目标顾客", exact: true }).isDisabled(), false);
  assert.equal(await page.getByRole("button", { name: "取消", exact: true }).count(), 0);
  await page.locator(".mv-draft-item > button[aria-pressed]").nth(analysisDraft).click();
  await page.getByRole("button", { name: "取消", exact: true }).waitFor();
  assert.equal(await reference.isDisabled(), true);
  assert.equal(starts, 1, "switching drafts must not start another paid analysis");
  await page.locator(".mv-library > summary").click();
  Object.assign(value, { status: "partial", stage: "frames", errorCode: "ANALYSIS_IMAGE_BUDGET_EXHAUSTED" });
  await page.getByText("画面处理已暂停，点击继续生成将复用已有资料。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "继续生成", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).waitFor();
  assert.equal(resumes, 1); assert.equal(starts, 1);
  // The video evidence is complete, but the final copy model failed. The
  // primary action must continue this exact job, also after refreshing.
  value.snapshot.summary = { summary: [], marketingPoints: [], timeline: [], limitations: [] };
  value.snapshot.summaryRevision = 1;
  Object.assign(value, { status: "partial", stage: "summary", errorCode: "MODEL_INVALID_JSON" });
  await page.getByRole("button", { name: "继续生成", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "一键拆解并生成", exact: true }).count(), 0);
  await page.reload();
  await page.getByText("视频拆解结果已保存，文案和分镜尚未完成。继续生成会复用已有拆解结果。", { exact: true }).waitFor();
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.getByRole("combobox", { name: "Bahasa / Language / 语言" }).selectOption("en");
  await page.getByText("Video analysis is saved, but the copy and storyboard are unfinished. Resume generation to reuse the saved analysis.", { exact: true }).waitFor();
  assert.equal(await page.locator(".ma-panel > .mv-soft").innerText(), "Continue creation");
  assert.equal(starts, 1); assert.equal(resumes, 1);
  await page.getByRole("combobox", { name: "Bahasa / Language / 语言" }).selectOption("zh");
  loseResumeResponse = true;
  await page.getByRole("button", { name: "继续生成", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).waitFor();
  assert.equal(resumes, 2); assert.equal(starts, 1, "resuming copy must not create another analysis");
  assert.equal(await page.getByRole("button", { name: "一键拆解并生成", exact: true }).count(), 0);
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  const generated = create(projects.get(projectId).draft);
  Object.assign(projects.get(projectId), { draft: generated.draft, version: projects.get(projectId).version + 1, referenceAnalysis: { id, acceptedRevision: 1, evidenceIds: ["f0001"] } });
  Object.assign(value, { status: "ready", stage: "copy", applied: true }); value.snapshot.creation = generated;
  value.snapshot.speech = { status: "skipped", reason: "ASR_MODEL_UNAVAILABLE" };
  value.snapshot.coverage = { sampledFrames: 1, ocrFrames: 1, visualFrames: 1, omittedOcrFrameIds: ["f0001"], omittedVisualFrameIds: [], limitations: ["OCR_INCOMPLETE"] };
  value.snapshot.summary = { summary: [{ statement: "展示咖啡", inference: false, evidenceIds: ["f0001"] }], marketingPoints: [{ kind: "hook", statement: "场景切入", inference: true, evidenceIds: ["f0001"] }], timeline: [{ startMs: 0, endMs: 500, statement: "展示产品", inference: false, evidenceIds: ["f0001"] }], limitations: ["OCR_INCOMPLETE"] };
  await page.getByRole("textbox", { name: "视频口播文案", exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some(t => t.value.startsWith('在明亮空间')));
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === '一键拆解并生成').disabled);
  assert.equal(copyCalls, 1); assert.equal(starts, 1); assert.equal(resumes, 2);
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("button", { name: "选择数字分身素材", exact: true }).waitFor();
  await page.getByRole("button", { name: "上一步", exact: true }).click();
  assert.equal(await page.getByRole("radio").count(), 2);
  assert(!/预算|已记录费用|选用预览|生成当前修订摘要/.test(await page.locator("body").innerText()));
  await page.getByText("当前账号未提供 qwen-audio-3.1-asr-flash 模型，已跳过视频语音转写，继续分析画面和文字。", { exact: true }).waitFor();
  assert.equal(await page.locator(".ma-panel > details.mv-script-review").evaluate(el => el.open), false);
  await page.getByText("部分画面文字识别失败，摘要可能遗漏内容。", { exact: true }).waitFor();
  assert.equal(await page.getByText("未识别画面文字的采样帧 (1)：f0001 · 0.0s", { exact: true }).isVisible(), true);
  await page.getByText("查看参考资料", { exact: true }).click();
  await page.getByText("画面文字", { exact: true }).click();
  await page.getByText("t0001 · 0.0s–0.5s · 原片画面文字", { exact: true }).waitFor();
  await page.getByText("参考画面", { exact: true }).click(); await page.getByRole("button", { name: "0.0s", exact: true }).click();
  await page.locator("img.ma-frame").waitFor();
  await page.reload();
  await page.getByText("中景缓缓推进", { exact: true }).waitFor();
  assert.equal(starts, 1); assert.equal(copyCalls, 1);
  // Upstream exhaustion is actionable, while unknown submissions are not replayed.
  Object.assign(value, { status: "partial", applied: false, errorCode: "MODEL_QUOTA" });
  await page.reload(); await page.getByText("上游余额不足，请充值后继续。", { exact: true }).waitFor();
  assert.equal(resumes, 2); await page.getByRole("button", { name: "继续生成", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).waitFor(); assert.equal(resumes, 3);
  await page.getByRole("button", { name: "取消", exact: true }).click(); await page.getByText("已取消", { exact: true }).waitFor();
  Object.assign(value, { status: "needs_review", errorCode: "REQUEST_UNKNOWN" });
  await page.reload(); await page.getByText("模型响应中断，已有分析已保存。为避免重复收费，需核实本次请求后继续。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "继续生成", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "一键拆解并生成", exact: true }).count(), 0, "unknown requests must not offer a new paid analysis");
  Object.assign(value, { status: "partial", errorCode: "MODEL_USAGE_UNKNOWN" }); await page.reload();
  await page.getByText("模型响应中断，已有分析已保存。为避免重复收费，需核实本次请求后继续。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "继续生成", exact: true }).count(), 0);
  Object.assign(value, { status: "partial", errorCode: "SOURCE_EXPIRED" }); delete value.snapshot.speech;
  await page.reload();
  await page.getByText("原视频已按保留期限清理，无法继续转写。可仅使用已保留的画面继续，或新建草稿重新取材。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "继续生成", exact: true }).count(), 0);
  await page.getByRole("button", { name: "仅使用保留的画面继续", exact: true }).click();
  await page.getByText("原视频已过期，按你的选择仅使用保留的画面和文字继续。", { exact: true }).waitFor();
  assert.equal(resumes, 4);
  value.snapshot.speech = { status: "completed", id: "a0001", model: "qwen-audio-3.1-asr-flash", text: "  " };
  Object.assign(value, { status: "ready", applied: true, errorCode: undefined }); await page.reload();
  await page.getByText("转写未识别到语音内容，不代表原视频没有声音。", { exact: true }).waitFor();
  assert.equal(await page.locator(".ma-panel > details.mv-script-review").evaluate(el => el.open), false);
  assert(!(await page.locator("body").innerText()).includes("可见文字和语音转写生成"));
  value.snapshot.speech = liveSpeech ?? { status: "completed", id: "a0001", model: "qwen-audio-3.1-asr-flash", text: "测试录音设备，进入网站。" };
  Object.assign(value, { status: "ready", applied: true, errorCode: undefined }); await page.reload();
  await page.getByText("中景缓缓推进", { exact: true }).waitFor();
  await page.getByText("已完成，但参考证据存在缺口", { exact: true }).waitFor();
  await page.getByText("查看参考资料", { exact: true }).click();
  await page.getByText("视频语音转写", { exact: true }).click();
  await page.getByText(value.snapshot.speech.text, { exact: true }).waitFor();
  assert(!(await page.locator("body").innerText()).includes("原始声音未转录"));
  await page.getByText("部分画面文字识别失败，摘要可能遗漏内容。", { exact: true }).waitFor();
  await page.getByText("原片证据时间线", { exact: true }).click();
  const screenshots = process.env.MARKETING_ANALYSIS_UI_SCREENSHOTS;
  if (screenshots) {
    const { mkdir } = await import("node:fs/promises"); await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "creation-light.png"), fullPage: true });

  }
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.getByText("已完成，但参考证据存在缺口", { exact: true }).waitFor();
  if (screenshots) await page.screenshot({ path: join(screenshots, "creation-dark.png"), fullPage: true });
  await page.getByRole("combobox", { name: "Bahasa / Language / 语言" }).selectOption("en");
  await page.getByRole("textbox", { name: "Video link or reference copy", exact: true }).waitFor();
  await page.getByText("Completed with gaps in reference evidence", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText("Completed with gaps in reference evidence", { exact: true }).scrollIntoViewIfNeeded();
  if (screenshots) await page.screenshot({ path: join(screenshots, "creation-mobile-en.png"), fullPage: false });
  assert.equal(await page.locator(".mv-studio").count(), 1);
  await page.getByText("Video speech transcript", { exact: true }).waitFor();
  value.snapshot.speech = { status: "skipped", reason: "ASR_MODEL_UNAVAILABLE" }; await page.reload();
  await page.getByText("qwen-audio-3.1-asr-flash is unavailable for this account. Speech transcription was skipped; image and text analysis will continue.", { exact: true }).waitFor();
  value.snapshot.speech = { status: "skipped", reason: "NO_AUDIO_TRACK" }; await page.reload();
  await page.getByText("The downloaded file has no usable audio track. This does not confirm whether the original video has sound; transcription was skipped.", { exact: true }).waitFor();
  value.snapshot.speech = { status: "completed", id: "a0001", model: "qwen-audio-3.1-asr-flash", text: "" }; await page.reload();
  await page.getByText("No speech was recognized in the transcription. This does not mean the original video has no sound.", { exact: true }).waitFor();
  await page.getByText("Some OCR failed; the summary may omit content.", { exact: true }).waitFor();
  // A real short MP4 exercises browser duration decoding, multipart bytes,
  // explicit retry after response loss, draft persistence and source cleanup.
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByRole("combobox", { name: "Bahasa / Language / 语言" }).selectOption("zh");
  await page.getByRole("button", { name: "开始新视频", exact: true }).click();
  await page.getByRole("button", { name: "拆解爆款文案", exact: true }).click();
  await page.getByRole("radio", { name: "上传本地爆款视频", exact: true }).check();
  assert.equal(await page.getByRole("button", { name: "一键拆解并生成", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "智能生成文案", exact: true }).click();
  await page.getByRole("textbox", { name: "产品、卖点和目标顾客", exact: true }).fill("介绍一家本地咖啡店");
  await page.getByRole("button", { name: "生成文案和分镜", exact: true }).click();
  await page.getByRole("textbox", { name: "视频口播文案", exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll("textarea")].some(input => input.value.startsWith("在明亮空间")));
  assert.equal(copyCalls, 2);
  await page.getByRole("button", { name: "开始新视频", exact: true }).click();
  await page.getByRole("button", { name: "拆解爆款文案", exact: true }).click();
  await page.getByRole("radio", { name: "上传本地爆款视频", exact: true }).check();
  const localVideo = join(temp, "local-reference.mp4");
  execFileSync(process.env.MARKETING_FFMPEG_PATH || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", localVideo]);
  const localInput = page.getByLabel("选择本地视频文件", { exact: true });
  await localInput.setInputFiles({ name: "bad.txt", mimeType: "text/plain", buffer: Buffer.from("not video") });
  await page.locator(".mv-error").filter({ hasText: "本地爆款视频支持 MP4" }).waitFor(); assert.equal(uploads, 0);
  await localInput.setInputFiles(localVideo);
  await page.getByText("处理未完成，已有结果已保留，请稍后继续。", { exact: true }).waitFor();
  assert.equal(uploads, 1);
  await localInput.setInputFiles(localVideo);
  await page.locator(".mv-local-reference").getByText("local-reference.mp4", { exact: true }).waitFor();
  await page.waitForFunction(() => !document.body.innerText.includes("保存中"));
  assert.equal(uploads, 2);
  await page.reload();
  await page.locator(".mv-local-reference").getByText("local-reference.mp4", { exact: true }).waitFor();
  assert.equal(await page.getByRole("radio", { name: "上传本地爆款视频", exact: true }).isChecked(), true);
  assert.equal(uploads, 2); assert.equal(starts, 1);
  await page.getByRole("combobox", { name: "Bahasa / Language / 语言" }).selectOption("en");
  await page.getByRole("radio", { name: "Upload a local reference video", exact: true }).waitFor();
  await page.getByText("Local reference videos support MP4, MOV, WebM, up to 100 MB, 180 seconds and 1080p.", { exact: true }).waitFor();
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  if (screenshots) await page.screenshot({ path: join(screenshots, "local-reference-dark-en.png"), fullPage: true });
  await page.getByRole("combobox", { name: "Bahasa / Language / 语言" }).selectOption("zh");
  await page.getByRole("button", { name: "一键拆解并生成", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).waitFor(); assert.equal(starts, 2);
  await page.reload(); await page.getByRole("button", { name: "取消", exact: true }).waitFor(); assert.equal(starts, 2);
  await page.getByRole("button", { name: "取消", exact: true }).click(); await page.getByText("已取消", { exact: true }).waitFor();
  const sourceSaved = page.waitForResponse(response => response.url().endsWith(`/api/marketing-videos/${projectId}`)
    && response.request().method() === "PUT" && response.request().postDataJSON().draft.reference === "改为手动参考文字");
  await page.getByRole("radio", { name: "粘贴链接或文案", exact: true }).check();
  await reference.fill("改为手动参考文字");
  await page.getByText("已取消", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(await page.getByText("查看参考资料", { exact: true }).count(), 0);
  await sourceSaved;
  assert.equal(projects.get(projectId).draft.referenceUpload, undefined);
  assert.equal(projects.get(projectId).referenceAnalysis, undefined);
  await page.getByRole("combobox", { name: "Bahasa / Language / 语言" }).selectOption("en");
  account = "other"; await page.getByRole("button", { name: "Switch account", exact: true }).click();
  await page.waitForFunction(() => !document.body.innerText.includes('咖啡参考视频'));
  assert.equal(await page.getByText("View source material", { exact: true }).count(), 0);
  assert.equal(await page.locator("img.ma-frame").count(), 0);
  assert.deepEqual(errors, []);
  console.log("Marketing automatic creation UI passed: text/link/local upload, actual MP4 bytes, upload retry and refresh, switching drafts during an analysis, source cleanup, complete shots, private evidence, quota/cancel, explicit source-expiry recovery, account isolation, English and dark theme");
} finally { await browser?.close(); await vite?.close(); await rm(temp, { recursive: true, force: true }); }
