/** Real React UI with intercepted fixtures. No external requests or model calls. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { createServer } = createRequire(resolve(root, "packages/web/package.json"))("vite");
const temp = await realpath(await mkdtemp(join(tmpdir(), "lot-analysis-ui-")));
const liveSpeech = process.env.MARKETING_ANALYSIS_UI_SPEECH_RESULT
  ? JSON.parse(await readFile(process.env.MARKETING_ANALYSIS_UI_SPEECH_RESULT, "utf8")) : null;
let vite, browser;
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
    resolve: { alias: { react: resolve(root, "packages/web/node_modules/react"), "react-dom": resolve(root, "packages/web/node_modules/react-dom") } },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root, temp] } } });
  await vite.listen(); browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } }); const page = await context.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await context.addInitScript(() => { if (!localStorage.getItem("lot:language")) localStorage.setItem("lot:language", "zh"); });
  const id = "00000000-0000-4000-8000-000000000039";
  const projects = new Map(); const textOperations = new Map(); let value, projectId, account = "owner", copyCalls = 0, starts = 0, resumes = 0;
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
    if (path === "/api/marketing-videos/capabilities") return json({ composition: true, knowledge: false });
    if (path === "/api/marketing-videos") return json({ data: account === "owner" ? [...projects.values()] : [] });
    if (path.endsWith("/text-operations")) return json({ data: textOperations.get(path.split("/").at(-2)) ?? [] });
    if (path === "/api/marketing-videos/copy") {
      copyCalls++; const body = req.postDataJSON(); assert(body.clientRequestId);
      const p = projects.get(body.projectId); assert.equal(p.version, body.version);
      const result = create(body.draft); p.version++; p.draft = result.draft;
      textOperations.set(p.id, [{ id: body.clientRequestId, status: "succeeded", appliedVersion: p.version, result }]);
      // The server completed, but the browser lost its response. Polling must
      // recover the same durable result without issuing another copy POST.
      if (copyCalls === 1) return route.abort("failed");
      return json({ ...result, project: p, operation: { status: "succeeded" } });
    }
    if (path === "/api/marketing-video-analyses") {
      assert.equal(req.method(), "POST"); starts++;
      const body = req.postDataJSON(); projectId = body.target.projectId;
      assert(body.clientRequestId); assert.equal(body.target.locale, "zh");
      const p = projects.get(projectId); assert.equal(p.version, body.target.projectVersion);
      p.version++; p.referenceAnalysis = { id, acceptedRevision: 0, evidenceIds: [] };
      value = { id, ownerId: "owner", projectId, revision: 1, status: "queued", stage: "queued", snapshot: {
        source: { platform: "bilibili", title: "咖啡参考视频" }, frames: [{ id: "f0001", ptsMs: 0 }],
        texts: [{ id: "t0001", text: "原片画面文字", firstSeenMs: 0, lastSeenMs: 500 }], frameTexts: [], observations: [],
      } };
      return json(value, 202);
    }
    if (path === `/api/marketing-video-analyses/${id}`) return json(value);
    if (path.endsWith("/frames/f0001")) {
      assert.equal(req.headers().authorization, "Bearer fixture-token");
      return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrWQAAAAASUVORK5CYII=", "base64") });
    }
    if (path.endsWith("/resume")) { resumes++; assert.equal(req.postDataJSON().expectedRevision, 1); value.status = "running"; delete value.errorCode; return json(value); }
    if (path.endsWith("/cancel")) { value.status = "cancelled"; return json(value); }
    if (/^\/api\/marketing-videos\/[a-f0-9-]+$/.test(path)) {
      const pid = path.split("/").at(-1);
      if (req.method() === "PUT") {
        const body = req.postDataJSON(), old = projects.get(pid);
        assert.equal(body.version, old?.version ?? 0);
        const p = { ...old, id: pid, draft: body.draft, version: body.version + 1, status: "draft", assets: {} };
        if (old && old.draft.reference !== body.draft.reference) delete p.referenceAnalysis;
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
  assert.equal(await page.getByRole("checkbox", { name: "视频链接", exact: true }).isChecked(), true);
  assert.equal(await page.getByRole("button", { name: /^(15|30|45|60) 秒$/ }).count(), 0);
  const inputBounds = await reference.boundingBox();
  const optionBounds = await page.getByRole("group", { name: "参考内容类型", exact: true }).boundingBox();
  assert(optionBounds.y + optionBounds.height <= inputBounds.y, "source checkboxes belong above the input");
  assert.equal(await page.locator(".mv-creative-brief").evaluate(el => el.open), true);
  assert.equal(await page.getByRole("textbox", { name: "产品、卖点和目标顾客", exact: true }).isVisible(), true);
  await page.getByRole("checkbox", { name: "文字文案", exact: true }).check();
  assert.equal(await page.getByRole("checkbox", { name: "视频链接", exact: true }).isChecked(), false);
  await duration.focus(); await duration.press("End");
  assert.equal(await duration.inputValue(), "60");
  await reference.fill("一家明亮的咖啡店，提供现磨咖啡，欢迎品尝。https://example.com/shop");
  assert.equal(await page.getByText("参考视频分析", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "一键拆解并生成", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('textarea') && [...document.querySelectorAll('textarea')].some(t => t.value.includes('在明亮空间')));
  await page.getByRole("button", { name: "开始新视频", exact: true }).waitFor({ state: "visible" });
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === '开始新视频').disabled);
  assert.equal(copyCalls, 1); assert.equal(starts, 0);
  await page.reload();
  await page.getByText("保存的创作记录", { exact: true }).waitFor();
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
  await page.getByRole("button", { name: "一键拆解并生成", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).waitFor();
  assert.equal(starts, 1);
  await page.reload();
  await page.getByRole("button", { name: "取消", exact: true }).waitFor();
  assert.equal(starts, 1, "refresh must not start another paid analysis");
  Object.assign(value, { status: "partial", stage: "frames", errorCode: "ANALYSIS_IMAGE_BUDGET_EXHAUSTED" });
  await page.getByText("画面处理已暂停，点击继续生成将复用已有资料。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "继续生成", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).waitFor();
  assert.equal(resumes, 1); assert.equal(starts, 1);
  const generated = create(projects.get(projectId).draft);
  Object.assign(projects.get(projectId), { draft: generated.draft, version: projects.get(projectId).version + 1, referenceAnalysis: { id, acceptedRevision: 1, evidenceIds: ["f0001"] } });
  Object.assign(value, { status: "ready", stage: "copy", applied: true }); value.snapshot.creation = generated;
  value.snapshot.speech = { status: "skipped", reason: "ASR_MODEL_UNAVAILABLE" };
  value.snapshot.coverage = { sampledFrames: 1, ocrFrames: 1, visualFrames: 1, omittedOcrFrameIds: ["f0001"], omittedVisualFrameIds: [], limitations: ["OCR_INCOMPLETE"] };
  value.snapshot.summary = { summary: [{ statement: "展示咖啡", inference: false, evidenceIds: ["f0001"] }], marketingPoints: [{ kind: "hook", statement: "场景切入", inference: true, evidenceIds: ["f0001"] }], timeline: [{ startMs: 0, endMs: 500, statement: "展示产品", inference: false, evidenceIds: ["f0001"] }], limitations: ["OCR_INCOMPLETE"] };
  await page.getByRole("textbox", { name: "视频口播文案", exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some(t => t.value.startsWith('在明亮空间')));
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === '一键拆解并生成').disabled);
  assert.equal(copyCalls, 1); assert.equal(starts, 1); assert.equal(resumes, 1);
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("button", { name: "数字人", exact: true }).waitFor();
  await page.getByRole("button", { name: "上一步", exact: true }).click();
  assert.equal(await page.getByRole("checkbox").count(), 2);
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
  assert.equal(resumes, 1); await page.getByRole("button", { name: "继续生成", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).waitFor(); assert.equal(resumes, 2);
  await page.getByRole("button", { name: "取消", exact: true }).click(); await page.getByText("已取消", { exact: true }).waitFor();
  Object.assign(value, { status: "needs_review", errorCode: "REQUEST_UNKNOWN" });
  await page.reload(); await page.getByText("模型响应中断，已有分析已保存。为避免重复收费，需核实本次请求后继续。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "继续生成", exact: true }).count(), 0);
  Object.assign(value, { status: "partial", errorCode: "MODEL_USAGE_UNKNOWN" }); await page.reload();
  await page.getByText("模型响应中断，已有分析已保存。为避免重复收费，需核实本次请求后继续。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "继续生成", exact: true }).count(), 0);
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
  account = "other"; await page.getByRole("button", { name: "Switch account", exact: true }).click();
  await page.waitForFunction(() => !document.body.innerText.includes('咖啡参考视频'));
  assert.equal(await page.getByText("View source material", { exact: true }).count(), 0);
  assert.equal(await page.locator("img.ma-frame").count(), 0);
  assert.deepEqual(errors, []);
  console.log("Marketing automatic creation UI passed: text/video, complete shots, refresh, private evidence, quota/cancel, account isolation, English and dark theme");
} finally { await browser?.close(); await vite?.close(); await rm(temp, { recursive: true, force: true }); }
