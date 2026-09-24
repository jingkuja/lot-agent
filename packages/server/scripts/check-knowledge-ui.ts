/** Real browser + authenticated management HTTP + local PG, with deterministic embedding only.
 * No existing user data, credentials, containers, or model quota are used.
 * Set PLAYWRIGHT_MODULE to a locally installed playwright package directory. */
import "../src/load-env.js";
import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph } from "docx";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile, realpath, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { DB } from "../src/db/database.js";
import { SessionStore } from "../src/auth/session-store.js";
import { createAuthMiddleware } from "../src/auth/middleware.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { LocalKnowledgeStorage } from "../src/knowledge/private-storage.js";
import { createKnowledgeManageRoutes, createKnowledgePreviewRoutes } from "../src/knowledge/routes.js";
import { KnowledgeRetriever } from "../src/knowledge/retrieval.js";
import { KnowledgeJobs } from "../src/knowledge/ingestion/jobs.js";
import { indexProfile } from "../src/knowledge/ingestion/profile.js";
import { indexArtifact } from "../src/knowledge/ingestion/indexer.js";
import { parseIsolated } from "../src/knowledge/ingestion/parser-process.js";
import { KnowledgeMaterials } from "../src/knowledge/materials.js";
import { runMigrations } from "../src/db/migration-runner.js";
import { migrations } from "../src/db/migrations/index.js";
if (!process.argv.includes("--local") || !["localhost", "127.0.0.1", "::1"].includes(process.env.PG_HOST ?? "localhost")) throw new Error("Requires --local and local PostgreSQL");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const requireWeb = createRequire(resolve(root, "packages/web/package.json"));
const { createServer } = requireWeb("vite");
const { chromium, _electron } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const temp = await realpath(await mkdtemp(join(tmpdir(), "lot-knowledge-ui-"))); const owner = randomUUID(); const queue = `ui-${owner}`;
process.env.KNOWLEDGE_INGESTION_ENABLED = "1"; process.env.KNOWLEDGE_QUEUE = queue;
const db = new DB({ host: process.env.PG_HOST, port: Number(process.env.PG_PORT ?? 5432), user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE });
const repo = new KnowledgeRepository(db.pool, queue); const storage = new LocalKnowledgeStorage(resolve(temp, "knowledge")); const sessions = new SessionStore(db);
const profile = indexProfile("https://ui-fixture.invalid/v1");
const embed = async () => ({ tokens: 8, vector: Array.from({ length: 1024 }, (_, n) => n ? 0 : 1) });
let apiServer: ReturnType<typeof serve> | undefined; let vite: any; let browser: any; let desktop: any; let session: string | undefined;
try {
  await runMigrations(db.pool, migrations); await db.pool.query("INSERT INTO users(id,name) VALUES($1,'UI fixture')", [owner]); session = await sessions.createSession(owner);
  const app = new Hono(); app.route("/api/rag/preview", createKnowledgePreviewRoutes(repo, storage));
  app.use("/api/*", createAuthMiddleware(sessions));
  app.route("/api/rag/manage", createKnowledgeManageRoutes(repo, storage, new KnowledgeRetriever(db.pool, profile, () => embed), new KnowledgeMaterials(repo, storage, temp)));
  app.get("/api/tasks/:id", async (c) => { const row = (await db.pool.query("SELECT progress,stage,error FROM tasks WHERE id=$1 AND user_id=$2", [c.req.param("id"), owner])).rows[0]; return c.json(row ?? {}, row ? 200 : 404); });
  apiServer = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }); await new Promise<void>((r) => apiServer!.once("listening", r));
  const address = apiServer.address(); if (!address || typeof address === "string") throw new Error("No API address");
  await writeFile(join(temp, "index.html"), '<div id="root"></div><script type="module" src="/main.tsx"></script>');
  await writeFile(join(temp, "main.tsx"), `import React from "react"; import {createRoot} from "react-dom/client"; import {KnowledgePanel} from ${JSON.stringify(resolve(root, "packages/web/src/modules/knowledge/KnowledgePanel.tsx"))}; import ${JSON.stringify(resolve(root, "packages/web/src/App.css"))}; createRoot(document.getElementById('root')).render(<KnowledgePanel onClose={()=>{}} onUse={file=>document.body.dataset.usedFile=file.name}/>);`);
  await writeFile(join(temp, "sources.html"), '<div id="root"></div><script type="module" src="/sources.tsx"></script>');
  await writeFile(join(temp, "sources.tsx"), `import React from "react"; import {createRoot} from "react-dom/client"; import {KnowledgeSources} from ${JSON.stringify(resolve(root, "packages/web/src/modules/knowledge/KnowledgeSources.tsx"))}; createRoot(document.getElementById('root')).render(<KnowledgeSources sources={window.sourceEvidence}/>);`);
  vite = await createServer({ configFile: false, root: temp, esbuild: { jsx: "automatic", jsxImportSource: "react" }, optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"] }, resolve: { alias: { react: resolve(root, "packages/web/node_modules/react"), "react-dom": resolve(root, "packages/web/node_modules/react-dom") } }, server: { host: "127.0.0.1", port: 0, fs: { allow: [root, temp] }, proxy: { "/api": `http://127.0.0.1:${address.port}` } } }); await vite.listen();
  const port = vite.httpServer.address().port;
  let context: any; let page: any;
  if (process.argv.includes("--electron")) {
    if (!process.env.ELECTRON_PATH) throw new Error("ELECTRON_PATH is required");
    const entry = resolve(temp, "desktop.cjs");
    await writeFile(entry, `const {app}=require('electron'); app.setPath('userData', ${JSON.stringify(resolve(temp, "desktop-profile"))}); import(${JSON.stringify(resolve(root, "packages/desktop/dist/main/index.js"))});`);
    desktop = await _electron.launch({ executablePath: process.env.ELECTRON_PATH, args: [entry], env: { ...process.env, LOT_DESKTOP_DEV: "1", LOT_DEV_SERVER_URL: `http://127.0.0.1:${port}` } });
    context = desktop.context(); page = await desktop.firstWindow();
    await page.evaluate((token: string) => (window as any).lotDesktop.setToken(token), session);
    await page.waitForFunction((token: string) => (window as any).lotDesktop.getToken() === token, session);
  } else {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
    context = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
    await context.addInitScript((token: string) => localStorage.setItem("lot_token", token), session); page = await context.newPage();
  }
   page.setDefaultTimeout(15000); page.on("console", (m: any) => { if (m.type() === "error") console.error(m.text()); }); const errors: string[] = []; page.on("pageerror", (e: Error) => { errors.push(e.message); console.error(e.message); });
  await page.goto(`http://127.0.0.1:${port}`); await page.getByRole("heading", { name: "本地知识库", exact: true }).waitFor();
  // Twenty entries, including one unsupported file: partial failure must preserve all successes.
  const files = Array.from({ length: 15 }, (_, n) => ({ name: `验收-${n}.txt`, mimeType: "text/plain", buffer: Buffer.from(`资料${n}：设备 AB-123 支持离线使用。`) }));
  const doc = new PDFDocument(); const pdfChunks: Buffer[] = []; const pdf = new Promise<Buffer>((resolve) => { doc.on("data", (b) => pdfChunks.push(b)); doc.on("end", () => resolve(Buffer.concat(pdfChunks))); }); doc.text("PDF fixture"); doc.end();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const wav = Buffer.alloc(16044); wav.write("RIFF"); wav.writeUInt32LE(16036, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(16000, 40);
  files.push({ name: "验收.pdf", mimeType: "application/pdf", buffer: await pdf }, { name: "验收.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("DOCX fixture")] }] })) }, { name: "验收.png", mimeType: "image/png", buffer: png }, { name: "验收.wav", mimeType: "audio/wav", buffer: wav });
  await page.getByLabel("选择文件，或拖放到这里").setInputFiles([...files, { name: "失败.exe", mimeType: "application/octet-stream", buffer: Buffer.from("invalid") }]);
  await page.getByLabel("创建新知识库并导入").check(); await page.getByLabel("知识库名称", { exact: true }).fill("界面验收库");
  await page.getByRole("button", { name: "创建并导入", exact: true }).click();
  await page.getByText("批次已处理。已保存文件的后台处理会继续，可关闭面板。", { exact: true }).waitFor();
  assert.equal((await repo.listItems(owner, 100)).data.length, 19);
  assert.equal(await page.getByRole("button", { name: "仅重试上传失败项", exact: true }).count(), 1);
  const collection = (await repo.listCollections(owner)).data[0];
  // Compile parser workers are real; vector values are deterministic and never billed.
  const jobs = new KnowledgeJobs(db.pool); const item = (await repo.listItems(owner)).data.find((i) => i.title === "验收-0.txt")!;
  const parsed = await parseIsolated(resolve(root, "packages/server/dist/workers/knowledge-parser.js"), { mime: "text/plain", bytes: files[0].buffer });
  await indexArtifact(jobs, (await jobs.claim(item.taskId!, queue))!, profile, parsed, embed);
  const evidence = (await new KnowledgeRetriever(db.pool, profile, () => embed).retrieve({ ownerId: owner, callerKind: "internal", permission: "retrieval:read", collectionIds: [collection.id] }, { query: "AB-123", collectionIds: [collection.id], mode: "keyword", topK: 5, allowDegraded: false, sourceTypes: ["document"], tags: [] })).results;
  assert.equal(evidence.length, 1);
  let sourcePage: any;
  if (desktop) {
    const opened = desktop.waitForEvent("window", { timeout: 15000 });
    await desktop.evaluate(({ BrowserWindow }: any) => { void new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }).loadURL("about:blank"); });
    sourcePage = await opened;
  } else sourcePage = await context.newPage();
  sourcePage.setDefaultTimeout(15000);
  await sourcePage.addInitScript((token: string) => localStorage.setItem("lot_token", token), session);
  await sourcePage.addInitScript((sources: unknown) => { (window as any).sourceEvidence = sources; }, evidence);
  await sourcePage.goto(`http://127.0.0.1:${port}/sources.html`);
  await sourcePage.getByText(/知识库出处（/).click(); await sourcePage.getByRole("button", { name: /验收-0.txt/ }).click();
  await sourcePage.getByRole("button", { name: "收起出处" }).waitFor(); assert.match(await sourcePage.locator("pre").innerText(), /AB-123/);

  await page.getByLabel("方式", { exact: true }).selectOption("keyword"); await page.getByPlaceholder("输入问题或关键词").fill("AB-123"); await page.getByRole("button", { name: "检索", exact: true }).click();
  await page.getByRole("button", { name: "查看出处", exact: true }).click(); await page.locator(".knowledge-source mark").waitFor();
  assert.match(await page.locator(".knowledge-source").innerText(), /AB-123/);
  await page.screenshot({ path: resolve(temp, "desktop-light.png"), fullPage: true });
  // Library metadata, optimistic editing and item versions are actual HTTP calls.
  await page.getByRole("button", { name: "编辑知识库", exact: true }).click(); await page.getByLabel("库名称", { exact: true }).fill("验收库已改名"); await page.getByRole("button", { name: "保存库信息", exact: true }).click();
  await page.getByRole("heading", { name: "验收库已改名", exact: true }).waitFor();
  assert.equal((await repo.listCollections(owner)).data[0].name, "验收库已改名");
  // Duplicate selection doesn't create another logical item.
  await page.getByLabel("选择文件，或拖放到这里").setInputFiles([files[0]]); await page.getByRole("button", { name: "保存资料", exact: true }).click(); await page.getByRole("button", { name: "使用已有资料", exact: true }).click();
  assert.equal((await repo.listItems(owner, 100)).data.length, 19);
  await page.getByRole("button", { name: "个人信息", exact: true }).click();
  await page.getByLabel("字段名称", { exact: true }).fill("display_name"); await page.getByLabel("内容", { exact: true }).fill("验收用户"); await page.getByRole("button", { name: "确认保存", exact: true }).click();
  await page.getByRole("button", { name: "编辑 / 停用", exact: true }).waitFor();
  await page.getByRole("button", { name: "编辑 / 停用", exact: true }).click(); await page.getByLabel("内容", { exact: true }).fill("纠正后的名称"); await page.getByRole("button", { name: "确认保存", exact: true }).click(); await page.getByText(/纠正后的名称.*生效中/).waitFor();
  await mkdir(resolve(temp, "assets")); await writeFile(resolve(temp, "assets/legacy.png"), png);
  await db.pool.query("INSERT INTO assets(id,user_id,type,storage_key,url,mime,size_bytes,original_name) VALUES($1,$2,'image','legacy.png','/static/assets/legacy.png','image/png',$3,'旧素材验收.png')", [randomUUID(), owner, png.length]);
  await page.getByRole("button", { name: "个人素材", exact: true }).click();
  const legacy = page.locator("article").filter({ hasText: "旧素材验收.png" }).first();
  await legacy.getByRole("button", { name: "用于当前对话", exact: true }).click();
  await page.waitForFunction(() => document.body.dataset.usedFile === "旧素材验收.png");
  assert.equal((await repo.listItems(owner, 100)).data.some((i) => i.title === "旧素材验收.png"), false);
  await legacy.getByRole("button", { name: "保存个人素材", exact: true }).click(); await legacy.getByRole("button", { name: "预览私有副本", exact: true }).click();
  await page.locator(".knowledge-preview img").waitFor(); await page.waitForFunction(() => { const img = document.querySelector<HTMLImageElement>(".knowledge-preview img"); return img?.complete && img.naturalWidth > 0; });
  await page.getByRole("button", { name: "收起", exact: true }).click();
  const audioItem = page.locator("article").filter({ hasText: "验收.wav" }).first(); await audioItem.getByRole("button", { name: "预览", exact: true }).click();
  await page.waitForFunction(() => (document.querySelector<HTMLAudioElement>(".knowledge-preview audio")?.readyState ?? 0) >= 1);
  await page.locator(".knowledge-preview audio").evaluate(async (audio: HTMLAudioElement) => { audio.muted = true; await audio.play(); audio.pause(); audio.currentTime = 0.4; });
  await page.waitForFunction(() => (document.querySelector<HTMLAudioElement>(".knowledge-preview audio")?.currentTime ?? 0) >= 0.35);
  await page.getByRole("button", { name: "收起", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => document.documentElement.dataset.theme = "dark");
  await page.getByRole("button", { name: "全部资料 / 搜索", exact: true }).click(); await page.getByLabel("方式", { exact: true }).selectOption("keyword"); await page.getByPlaceholder("输入问题或关键词").fill("AB-123"); await page.getByRole("button", { name: "检索", exact: true }).click(); await page.getByRole("button", { name: "查看出处", exact: true }).click(); await page.locator(".knowledge-source mark").waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(temp, "mobile-dark.png"), fullPage: true });
  assert.equal(errors.length, 0, errors.join("\n"));
  const removed = await repo.getItem(owner, item.id); await repo.deleteItem(owner, item.id, removed.version);
  await page.locator(".knowledge-source").waitFor({ state: "detached", timeout: 12000 });
  await sourcePage.getByRole("button", { name: /验收-0.txt/ }).click(); await sourcePage.getByRole("alert").waitFor();
  assert.equal(await sourcePage.locator("pre").count(), 0); await sourcePage.close();

  await page.getByRole("button", { name: "外部接入", exact: true }).click();
  await page.getByLabel("应用名称", { exact: true }).fill("S3 UI client");
  await page.getByRole("group", { name: "授权知识库（1–10 个）" }).getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "创建密钥", exact: true }).click();
  const secretField = page.getByRole("textbox", { name: "新密钥", exact: true });
  await secretField.waitFor(); assert.match(await secretField.inputValue(), /^lotk_/);
  await page.getByRole("button", { name: "已保存，关闭", exact: true }).click();
  assert.equal(await secretField.count(), 0);
  await page.screenshot({ path: resolve(temp, "integrations-mobile-dark.png"), fullPage: true });
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "轮换", exact: true }).click(); await secretField.waitFor();
  await page.getByRole("button", { name: "已保存，关闭", exact: true }).click();
  await page.getByRole("button", { name: "撤销", exact: true }).click(); await page.getByText(/已撤销/).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log(JSON.stringify({ tests: ["chat source open/revocation", "key create/one-time secret/rotate/revoke", "20 mixed files partial failure", "material reuse without archive", "private archive image preview", "private audio playback/seek", "create/import", "duplicate reuse", "collection edit", "real parser citation", "confirmed fact correction", "mobile dark search", "revoked citation eviction"], artifacts: temp, runtime: desktop ? "Electron actual main/preload" : "Chrome", embedding: "deterministic fixture; no model bill", collectionId: collection.id }));
} finally {
  await desktop?.close(); await browser?.close(); await vite?.close(); if (apiServer) await new Promise<void>((r) => apiServer!.close(() => r()));
  if (session) await sessions.revoke(session);
  await db.pool.query("DELETE FROM assets WHERE user_id=$1", [owner]); await db.pool.query("DELETE FROM tasks WHERE user_id=$1", [owner]); await db.pool.query("DELETE FROM users WHERE id=$1", [owner]);
  await db.pool.query("DELETE FROM rag_index_spaces WHERE profile_id=$1", [profile.id]); await db.pool.query("DELETE FROM rag_index_profiles WHERE id=$1", [profile.id]);
  await db.close(); await rm(resolve(temp, "knowledge"), { recursive: true, force: true }); await rm(resolve(temp, "desktop-profile"), { recursive: true, force: true });
}
