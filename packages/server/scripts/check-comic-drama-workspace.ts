/** Isolated workspace verification using real routes and PostgreSQL, with optional W5 Redis and a fake image gateway. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { Pool } from "pg";
import { COMIC_DRAMA_API_ROOT, COMIC_MEDIA_PATH, type ComicDramaContent, type ComicDramaDetail } from "@lot-agent/core/comic-drama";
import { createComicDramaRoutes } from "../src/comic-drama/routes.js";
import { PgComicDramaRepository } from "../src/comic-drama/repository.js";
import { PgComicDictionary } from "../src/comic-drama/dictionary.js";
import { PgComicLibrary } from "../src/comic-drama/library-repository.js";
import { ComicMediaLibrary } from "../src/comic-drama/media-library.js";
import { createComicLibraryRoutes } from "../src/comic-drama/library-routes.js";
import { comicFixturePng, verifyComicLibrary } from "./fixtures/check-comic-drama-library.js";
import { verifyComicCast } from "./fixtures/check-comic-drama-cast.js";
import { mountComicGenerationFixture, verifyComicGeneration } from "./fixtures/check-comic-drama-generation.js";
import { verifyComicVideo, w6Kling } from "./fixtures/check-comic-drama-video.js";
import { migrations } from "../src/db/migrations/index.js";
import { runMigrations } from "../src/db/migration-runner.js";

const database = process.env.COMIC_DRAMA_TEST_DATABASE_URL;
if (!database) throw new Error("Use a disposable local COMIC_DRAMA_TEST_DATABASE_URL");
const url = new URL(database);
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && /^\/comic_drama_test_[a-z0-9_]+$/.test(url.pathname));
const pool = new Pool({ connectionString: database });
const app = new Hono<{ Variables: { userId: string } }>();
const owner = randomUUID(), other = randomUUID();
const model = "grok-imagine-video-1.5";
const fields = { title: "雨夜便利店", styleKey: "thick_painting", aspectRatio: "9:16", videoModel: model };
let enabled = true;
app.get("/api/public/product", c => c.json({ globle: 1, comicDramaEnabled: enabled }));
app.use(`${COMIC_DRAMA_API_ROOT}/*`, async (c, next) => {
  if (!enabled) return c.notFound();
  const token = c.req.header("Authorization");
  if (!["Bearer fixture-one", "Bearer fixture-two"].includes(token ?? "")) return c.json({ code: "UNAUTHORIZED" }, 401);
  c.set("userId", token === "Bearer fixture-one" ? owner : other);
  await next();
});
const seriesRepo = new PgComicDramaRepository(pool);
app.route(COMIC_DRAMA_API_ROOT, createComicDramaRoutes(seriesRepo, async (user, id) => user === owner && [model, w6Kling].includes(id)));
const fixtureMediaDir = await mkdtemp(join(tmpdir(), "lot-comic-library-"));
const library = new PgComicLibrary(pool);
let clockOffset = 0;
const files = new ComicMediaLibrary(fixtureMediaDir, library, {
  masterKey: "cd".repeat(32), now: () => Date.now() + clockOffset, publicBaseUrl: "https://comic-fixture.invalid",
});
app.route(COMIC_DRAMA_API_ROOT, createComicLibraryRoutes(library, new PgComicDictionary(pool), files));
app.route(COMIC_MEDIA_PATH.slice(0, -1), files.publicRoutes({
  resolve: async token => token === "fixture-one" ? { userId: owner } : token === "fixture-two" ? { userId: other } : null,
}));
const fixtureUser = { id: owner, name: "Comic fixture" };
app.get("/api/auth/me", c => c.json(fixtureUser));
app.get("/api/auth/mode", c => c.json({ debug: true, user: fixtureUser }));
app.get("/api/models", c => c.json({ llm: [], image: [], video: [model, w6Kling].map(id => ({ id, name: id })) }));
app.get("/api/agents", c => c.json([{ id: "general", name: "通用助手", type: "general", installed: true }]));
app.get("/api/conversations", c => c.json({ items: [], nextCursor: null }));
app.get("/api/conversations/projects", c => c.json([]));
app.get("/api/usage/balance", c => c.json({ balance: 0 }));
app.get("/api/digital-employee/today", c => c.json({ employee: { name: "Fixture" }, items: [], running: [] }));

const req = (path: string, method = "GET", body?: unknown, account = "fixture-one") => app.request(
  COMIC_DRAMA_API_ROOT + "/series" + path, { method, headers: { Authorization: `Bearer ${account}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) },
);
async function json<T>(path: string, method = "GET", body?: unknown, status = 200): Promise<T> {
  const response = await req(path, method, body);
  const data = await response.json();
  assert.equal(response.status, status, `${method} ${path} ${JSON.stringify(data)}`);
  return data as T;
}

let generation: Awaited<ReturnType<typeof mountComicGenerationFixture>> | undefined;
try {
  const count = await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'");
  assert.equal(count.rows[0].n, 0, "Test database must be empty");
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await runMigrations(pool, migrations.filter(migration => migration.version < 32));
  await pool.query("INSERT INTO schema_migrations(version,name) VALUES (32,'comic-drama')");
  await pool.query("CREATE TABLE public.cd_series (legacy_draft text); INSERT INTO public.cd_series VALUES ('retained')");
  await runMigrations(pool, migrations);
  await runMigrations(pool, migrations);
  assert.equal((await pool.query("SELECT legacy_draft FROM public.cd_series")).rows[0].legacy_draft, "retained");
  await pool.query("INSERT INTO users(id,name) VALUES ($1,'Owner one'),($2,'Owner two')", [owner, other]);
  const redisUrl = process.env.COMIC_DRAMA_TEST_REDIS_URL;
  if (redisUrl) {
    generation = await mountComicGenerationFixture({
      app, database: url, redisUrl, pool, library, series: seriesRepo, media: files, mediaRoot: fixtureMediaDir,
      receiptPath: join(fixtureMediaDir, "receipts"), owner,
    });
  }
  assert.equal((await req("", "GET", undefined, "bad")).status, 401);
  assert.equal((await req("", "POST", { ...fields, ownerId: other })).status, 400);
  assert.equal((await req("", "POST", fields, "fixture-two")).status, 400);
  const { series } = await json<ComicDramaDetail>("", "POST", fields, 201);
  const path = "/" + series.id;
  assert.deepEqual(await json("/current"), { seriesId: series.id });
  const separate = await req("", "POST", { ...fields, videoModel: null }, "fixture-two");
  assert.equal(separate.status, 201);
  const otherSeries = (await separate.json() as ComicDramaDetail).series;
  assert.equal((await req(path, "GET", undefined, "fixture-two")).status, 404);
  assert.equal((await req("/current", "PUT", { seriesId: series.id }, "fixture-two")).status, 404);
  await assert.rejects(pool.query("UPDATE lot_comic_drama.cd_user_state SET current_series_id=$1 WHERE owner_id=$2", [series.id, other]), { code: "23503" });
  const one = await json<ComicDramaContent>(path + "/clips", "POST", { expectedRevision: 1 }, 201);
  const two = await json<ComicDramaContent>(path + "/clips", "POST", { expectedRevision: one.seriesRevision }, 201);
  const [clip1, clip2] = two.clips;
  const clipPath = path + "/clips/" + clip1.id;
  const patch = (scene: string) => req(clipPath, "PATCH", { expectedRevision: 1, draft: { ...clip1.draft, scene } });
  const writes = await Promise.all([patch("甲"), patch("乙")]);
  assert.deepEqual(writes.map(result => result.status).sort(), [200, 409]);
  assert.deepEqual(await writes.find(result => result.status === 409)?.json(), { code: "REVISION_CONFLICT", currentRevision: 2 });
  const live = await json<ComicDramaDetail>(path);
  assert.equal((await req(clipPath, "PATCH", { expectedRevision: 2, draft: clip1.draft }, "fixture-two")).status, 404);
  assert.equal((await req(path + "/clips/order", "PUT", { expectedRevision: live.series.revision, clipIds: [clip1.id, otherSeries.id] })).status, 400);
  const sorted = await json<ComicDramaContent>(path + "/clips/order", "PUT", { expectedRevision: live.series.revision, clipIds: [clip2.id, clip1.id] });
  assert.deepEqual(sorted.clips.map(clip => [clip.id, clip.ordinal, clip.revision]), [[clip2.id, 1, 1], [clip1.id, 2, 2]]);
  const script = await json<ComicDramaContent>(path + "/script", "PUT", { expectedRevision: sorted.seriesRevision, content: "柜台遇见一个人。" });
  assert.equal(script.script?.version, 1);
  const duplicate = await json<ComicDramaDetail>(path + "/copy", "POST", {}, 201);
  assert.equal(duplicate.script?.content, script.script?.content);
  assert.deepEqual(duplicate.clips.map(clip => clip.draft), script.clips.map(clip => clip.draft));
  assert.ok(duplicate.clips.every(clip => !script.clips.some(original => original.id === clip.id)));
  const sequel = await json<ComicDramaDetail>(path + "/sequel", "POST", {}, 201);
  assert.equal(sequel.series.parentId, series.id);
  assert.equal(sequel.series.episodeNo, 2);
  assert.deepEqual(sequel.clips, []);
  assert.deepEqual(await json("/current"), { seriesId: sequel.series.id });
  await json("/" + sequel.series.id + "/archive", "POST", { expectedRevision: sequel.series.revision });
  assert.deepEqual(await json("/current"), { seriesId: null });
  assert.equal((await req("/current", "PUT", { seriesId: sequel.series.id })).status, 404);
  const history = await json<{ entries: Array<{ id: string }> }>("?query=" + encodeURIComponent(fields.title));
  assert.deepEqual(new Set(history.entries.map(entry => entry.id)), new Set([series.id, duplicate.series.id]));
  assert.equal((await req("/" + duplicate.series.id, "DELETE", { expectedRevision: duplicate.series.revision })).status, 200);
  assert.equal((await req("/" + duplicate.series.id)).status, 404);
  console.log("PASS W2 PG/HTTP: migrations, auth, model eligibility, owner isolation, concurrent CAS, order, script, copy, sequel, archive, delete");

  await verifyComicLibrary(app, ms => { clockOffset += ms; });
  await verifyComicCast(app);
  if (generation) await verifyComicGeneration(app, pool, generation);
  const videoEpisode = generation ? await verifyComicVideo(app, pool, generation.video) : null;

  if (process.argv.includes("--ui")) {
    const project = fileURLToPath(new URL("../../../packages/web", import.meta.url));
    const require = createRequire(import.meta.url);
    const { chromium, _electron } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
    const dist = join(project, "dist");
    const html = await readFile(join(dist, "index.html"), "utf8");
    const browserApp = new Hono();
    browserApp.route("/", app);
    browserApp.get("/api/*", c => c.notFound());
    browserApp.get("/assets/*", serveStatic({ root: dist }));
    browserApp.get("*", c => c.html(html));
    const server = serve({ fetch: browserApp.fetch, hostname: "127.0.0.1", port: 0 });
    try {
      await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const base = "http://127.0.0.1:" + address.port;
      const browser = await chromium.launch({ channel: "chrome", headless: true });
      try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const errors: string[] = [];
        await context.addInitScript(() => {
          localStorage.setItem("lot_token", "fixture-one");
          if (!localStorage.getItem("lot:language")) localStorage.setItem("lot:language", "zh");
        });
        const page = await context.newPage();
        page.setDefaultTimeout(12_000);
        page.on("pageerror", (error: Error) => { errors.push(error.message); console.error(error); });
        await page.goto(base + "/assistant");
        const comicTab = page.getByRole("tab", { name: "漫剧工厂", exact: true });
        await comicTab.click().catch(async (error: unknown) => {
          console.error("comic tab unavailable", { url: page.url(), body: (await page.locator("body").innerText()).slice(0, 600) });
          throw error;
        });
        await page.getByRole("button", { name: /新建剧集/ }).first().click();
        await page.getByLabel("剧集名称").fill("W2 浏览器剧集");
        await page.getByRole("button", { name: "创建并打开" }).click();
        await page.getByRole("heading", { name: "W2 浏览器剧集" }).waitFor();
        for (const scene of ["雨夜进店", "柜台相遇"]) {
          await page.getByRole("button", { name: /添加分镜/ }).click();
          await page.getByLabel("场景", { exact: true }).fill(scene);
          await page.getByRole("button", { name: /添加镜头/ }).click();
          await page.getByLabel("镜头描述").fill(scene + "的镜头");
          await page.getByRole("status").filter({ hasText: "已保存" }).waitFor();
        }
        const deepLink = page.url();
        await page.getByRole("button", { name: "上移", exact: true }).click();
        await page.locator(".comic-cut").first().getByText("柜台相遇").waitFor();
        await page.getByRole("button", { name: /剧本/ }).click();
        await page.getByLabel("剧本正文").fill("雨夜的便利店仍在营业。");
        await page.getByRole("button", { name: "历史剧集", exact: true }).click();
        await page.getByRole("textbox", { name: "搜索剧集" }).fill("雨夜便利店");
        await page.getByRole("button", { name: "搜索", exact: true }).click();
        await page.getByRole("button", { name: /雨夜便利店/ }).first().click();
        await page.getByRole("heading", { name: "雨夜便利店", exact: true }).waitFor();
        await page.reload();
        await page.getByRole("heading", { name: "雨夜便利店", exact: true }).waitFor();
        await page.goto(deepLink);
        await page.locator(".comic-cut").first().getByText("柜台相遇").waitFor();
        await page.getByRole("button", { name: /剧本/ }).click();
        assert.equal(await page.getByLabel("剧本正文").inputValue(), "雨夜的便利店仍在营业。");
        await page.getByRole("navigation", { name: "制作步骤" }).getByRole("button", { name: /分镜/ }).click();
        const secondWindow = await context.newPage();
        await secondWindow.goto(deepLink);
        await secondWindow.getByLabel("场景", { exact: true }).fill("另一窗口版本");
        await secondWindow.getByRole("status").filter({ hasText: "已保存" }).waitFor();
        await page.getByLabel("场景", { exact: true }).fill("本地冲突版本");
        await page.getByRole("button", { name: "对比最新版本" }).click();
        await page.getByText("另一窗口版本", { exact: false }).last().waitFor();
        assert.equal(await page.getByLabel("场景", { exact: true }).inputValue(), "本地冲突版本");
        await page.getByRole("button", { name: "使用本地改动重新保存" }).click();
        await page.getByRole("status").filter({ hasText: "已保存" }).waitFor();
        await secondWindow.close();
        await page.reload();
        assert.equal(await page.getByLabel("场景", { exact: true }).inputValue(), "本地冲突版本");
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (process.env.COMIC_DRAMA_SCREENSHOT) await page.screenshot({ path: process.env.COMIC_DRAMA_SCREENSHOT, fullPage: true });

        await page.setViewportSize({ width: 1440, height: 900 });
        await page.getByRole("button", { name: "设置", exact: true }).click();
        await page.getByRole("button", { name: /添加字典条目/ }).click();
        await page.getByLabel("英文键").fill("rain_hood");
        await page.getByLabel("中文名称").fill("雨帽");
        await page.getByLabel("英文名称").fill("Rain hood");
        await page.getByLabel("印尼语名称").fill("Topi hujan");
        await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
        await page.getByText("雨帽", { exact: true }).waitFor();
        await page.getByRole("button", { name: "角色素材库", exact: true }).click();
        await page.getByRole("button", { name: /新建角色/ }).click();
        await page.getByLabel("角色名称").fill("W3 角色");
        await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
        await page.getByRole("heading", { name: "W3 角色" }).waitFor();
        await page.getByRole("button", { name: /新增套装/ }).click();
        await page.getByLabel("套装名称").fill("雨衣");
        await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
        const fixtureImage = { name: "fixture.png", mimeType: "image/png", buffer: await comicFixturePng() };
        await page.getByRole("button", { name: /上传角色图片/ }).click();
        await page.getByLabel("造型槽位").selectOption("rain_hood");
        await page.getByLabel("选择文件").setInputFiles(fixtureImage);
        await page.getByRole("dialog").getByRole("button", { name: "上传", exact: true }).click();
        await page.getByRole("img", { name: "雨帽" }).waitFor();
        await page.waitForFunction(() => Array.from(document.images).some(img => img.alt === "雨帽" && img.naturalWidth === 480));
        await page.getByRole("button", { name: "素材库", exact: true }).click();
        await page.getByRole("button", { name: /上传素材/ }).click();
        await page.getByLabel("素材名称").fill("W3 夜景");
        await page.getByLabel("分类", { exact: true }).selectOption("dusk");
        await page.getByLabel("选择文件").setInputFiles(fixtureImage);
        await page.getByRole("dialog").getByRole("button", { name: "上传", exact: true }).click();
        await page.getByRole("img", { name: "W3 夜景" }).waitFor();
        const card = page.locator(".comic-library-card").filter({ hasText: "W3 夜景" });
        await card.getByRole("button", { name: "替换文件" }).click();
        await page.getByLabel("选择文件").setInputFiles({ ...fixtureImage, buffer: await comicFixturePng("#6f473d") });
        await page.getByRole("dialog").getByRole("button", { name: "上传", exact: true }).click();
        await card.getByText(/版本 2/).waitFor();
        await card.getByRole("button", { name: "版本历史" }).click();
        await page.getByRole("dialog").getByRole("img", { name: "版本 1" }).waitFor();
        await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
        assert.ok(await page.evaluate(() => {
          const main = document.querySelector(".comic-workspace")!;
          return main.scrollWidth <= main.clientWidth + 1;
        }));
        if (process.env.COMIC_LIBRARY_SCREENSHOT) await page.screenshot({ path: process.env.COMIC_LIBRARY_SCREENSHOT, fullPage: true });
        await page.goto(deepLink);
        console.log("PASS W3 Web: custom dictionary, character and outfit, custom slot upload, thumbnail, material replacement and version history");

        await page.setViewportSize({ width: 1440, height: 900 });
        const steps = page.getByRole("navigation", { name: "制作步骤" });
        await steps.getByRole("button", { name: /选角/ }).click();
        await page.getByRole("button", { name: /选择角色/ }).click();
        await page.getByLabel("角色名称").selectOption({ label: "W3 角色" });
        await page.getByLabel("造型套装").selectOption({ label: "雨衣" });
        await page.getByRole("button", { name: "锁定造型" }).click();
        const castCard = page.locator(".comic-cast-card").filter({ hasText: "W3 角色" });
        await castCard.getByText(/版本 1/).waitFor();
        await steps.getByRole("button", { name: /分镜/ }).click();
        await page.getByLabel("添加出镜角色").selectOption({ label: "W3 角色" });
        await page.getByRole("status").filter({ hasText: "已保存" }).waitFor();

        await page.getByRole("button", { name: "历史剧集", exact: true }).click();
        const episodeRow = page.locator(".comic-history-list article").filter({ hasText: "W2 浏览器剧集" });
        await episodeRow.getByRole("button", { name: "续写下一集" }).click();
        assert.equal(await page.getByRole("checkbox", { name: "沿用上一集的角色与画风" }).isChecked(), true);
        await page.getByRole("button", { name: "创建并打开", exact: true }).click();
        await page.getByRole("heading", { name: "W2 浏览器剧集 #2", exact: true }).waitFor();
        await steps.getByRole("button", { name: /选角/ }).click();
        await castCard.getByText(/版本 1/).waitFor();
        const sequelLink = page.url();
        await page.getByRole("button", { name: "角色素材库", exact: true }).click();
        await page.getByRole("button", { name: "W3 角色", exact: true }).click();
        await page.getByRole("button", { name: /上传角色图片/ }).click();
        await page.getByLabel("造型槽位").selectOption("rain_hood");
        await page.getByLabel("选择文件").setInputFiles({ ...fixtureImage, buffer: await comicFixturePng("#8a4747") });
        await page.getByRole("dialog").getByRole("button", { name: "上传", exact: true }).click();
        await page.locator(".comic-library-card").getByText(/版本 2/).waitFor();
        await page.goto(sequelLink);
        await steps.getByRole("button", { name: /选角/ }).click();
        await castCard.getByText("角色库有更新", { exact: true }).waitFor();
        await castCard.getByText(/版本 1/).waitFor();
        await castCard.getByRole("button", { name: "同步最新造型" }).click();
        await castCard.getByText(/版本 2/).waitFor();
        await page.goto(deepLink);
        await steps.getByRole("button", { name: /选角/ }).click();
        await castCard.getByText(/版本 1/).waitFor();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
        assert.ok(await page.evaluate(() => {
          const main = document.querySelector(".comic-workspace")!;
          return main.scrollWidth <= main.clientWidth + 1;
        }));
        if (process.env.COMIC_CAST_SCREENSHOT) {
          await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>(".comic-cast-card img")).some(img => img.naturalWidth > 0));
          await page.screenshot({ path: process.env.COMIC_CAST_SCREENSHOT });
        }
        console.log("PASS W4 Web: cast, storyboard binding, locked sequel, library update and episode-scoped sync");

        if (generation) {
          await page.setViewportSize({ width: 1440, height: 900 });
          await steps.getByRole("button", { name: /生成/ }).click();
          const original = generation.counts.submits;
          await page.getByRole("button", { name: "预览首帧费用", exact: true }).click();
          const fee = page.getByRole("dialog", { name: "生成费用预览" });
          await fee.getByText("预估合计").waitFor();
          await fee.getByText(/参考图版本 · V1/).waitFor();
          await page.setViewportSize({ width: 390, height: 844 });
          await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
          assert.ok(await fee.evaluate((element: HTMLElement) => element.getBoundingClientRect().width < innerWidth));
          if (process.env.COMIC_GENERATION_SCREENSHOT) await page.screenshot({ path: process.env.COMIC_GENERATION_SCREENSHOT });
          await fee.getByRole("button", { name: "取消", exact: true }).click();
          await fee.waitFor({ state: "hidden" });
          assert.equal(generation.counts.submits, original);

          await page.setViewportSize({ width: 1440, height: 900 });
          for (const box of await page.getByRole("checkbox", { name: /^选择分镜/ }).all()) await box.check();
          await page.getByRole("button", { name: "预览批量费用（2）", exact: true }).click();
          await fee.getByText("fixture-image", { exact: false }).nth(1).waitFor();
          await fee.getByRole("button", { name: "确认费用并生成" }).evaluate((button: HTMLElement) => { button.click(); button.click(); });
          const batch = page.locator(".comic-edit-card").filter({ has: page.getByRole("heading", { name: "批量生成进度" }) });
          await batch.getByText("图片已入库", { exact: true }).nth(1).waitFor();
          assert.equal(generation.counts.submits, original + 2);
          await page.getByRole("img", { name: "首帧图片" }).waitFor();
          await page.getByRole("button", { name: "确认此首帧" }).click();
          await page.getByText("已确认首帧", { exact: true }).waitFor();
          await page.reload();
          await steps.getByRole("button", { name: /生成/ }).click();
          await page.getByText("已确认首帧", { exact: true }).waitFor();

          await page.getByRole("button", { name: "角色素材库", exact: true }).click();
          await page.getByRole("button", { name: "W3 角色", exact: true }).click();
          await page.getByRole("button", { name: "表情", exact: true }).click();
          await page.getByRole("button", { name: "生成表情", exact: true }).click();
          const expressionPicker = page.getByRole("dialog", { name: "生成表情", exact: true });
          await expressionPicker.getByRole("combobox").selectOption("smile");
          await expressionPicker.getByRole("button", { name: "预览费用", exact: true }).click();
          await fee.getByRole("button", { name: "确认费用并生成" }).click();
          await page.getByRole("img", { name: "微笑" }).waitFor();
          assert.equal(generation.counts.submits, original + 3);
          await page.goto(deepLink);
          console.log("PASS W5 Web: cancel zero submits, batch pricing, double click, private previews, durable approval and generated expression");
        }

        if (generation && videoEpisode) {
          await page.getByRole("button", { name: "历史成片", exact: true }).click();
          await page.getByRole("heading", { name: "历史成片", exact: true }).waitFor();
          await page.locator('input[name="seriesQuery"]').fill("W6 video fixture");
          await page.locator('select[name="adopted"]').selectOption("true");
          await Promise.all([
            page.waitForResponse((response: { url(): string; ok(): boolean }) => response.ok() && /\/comic-drama\/videos\?.*adopted=true/.test(response.url())),
            page.getByRole("button", { name: "筛选", exact: true }).click(),
          ]);
          const adopted = page.locator(".comic-video-card").filter({ hasText: "W6 video fixture · 版本 1 · 已采用" });
          await adopted.getByText("W6 video fixture · 版本 1 · 已采用").waitFor();
          const open = adopted.getByRole("button", { name: "打开对应分镜" });
          await open.click();
          await page.waitForURL("**/series/" + videoEpisode);
          await page.getByRole("button", { name: "用已确认首帧", exact: true }).waitFor();
          await page.getByLabel("为已采用的分镜生成新版").check();
          const beforeVideo = generation.video.submitted.length;
          const previewVideo = page.getByRole("button", { name: "预览视频费用", exact: true });
          const fee = page.getByRole("dialog", { name: "生成费用预览" });
          await previewVideo.click();
          await fee.getByText(/4 秒视频/).waitFor();
          await fee.getByRole("button", { name: "取消", exact: true }).click();
          assert.equal(generation.video.submitted.length, beforeVideo);
          await previewVideo.click();
          await fee.getByRole("button", { name: "确认费用并生成", exact: true }).click();
          const newest = page.locator(".comic-video-card").filter({ hasText: "版本 2" });
          await newest.getByText("视频已入库", { exact: true }).waitFor();
          await newest.getByRole("button", { name: "采用此版本", exact: true }).click();
          await newest.getByText("版本 2 · 已采用", { exact: true }).waitFor();
          assert.equal(generation.video.submitted.length, beforeVideo + 1);
          await newest.locator("video").evaluate((player: HTMLVideoElement) => { player.preload = "metadata"; player.load(); });
          await page.waitForFunction(() => Array.from(document.querySelectorAll("video")).some(player => player.videoWidth === 320 && player.duration === 4));
          await newest.getByRole("button", { name: "截帧另存", exact: true }).click();
          const frame = page.getByRole("dialog", { name: "截帧另存", exact: true });
          await frame.getByLabel("素材名称").fill("W6 界面截帧");
          await frame.getByRole("button", { name: "保存", exact: true }).click();
          await newest.getByText("已保存截帧", { exact: true }).waitFor();
          await page.setViewportSize({ width: 390, height: 844 });
          await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
          if (process.env.COMIC_VIDEO_SCREENSHOT) await page.screenshot({ path: process.env.COMIC_VIDEO_SCREENSHOT, fullPage: true });
          await page.goto(deepLink);
          await page.setViewportSize({ width: 1440, height: 900 });
          console.log("PASS W6 Web: adopted filter, reopen clip, video quote cancel, regeneration, playback, adoption and frame save");
        }

        const desktopBinary = process.env.COMIC_DRAMA_ELECTRON_PATH;
        if (desktopBinary) {
          const profile = await mkdtemp(join(tmpdir(), "comic-drama-desktop-"));
          try {
            const desktop = await _electron.launch({
              executablePath: desktopBinary,
              args: [fileURLToPath(new URL("../../desktop", import.meta.url)), `--user-data-dir=${profile}`, `--server-url=${base}`],
              env: { ...process.env, LOT_DESKTOP_DEV: "0" },
            });
            try {
              const desktopPage = await desktop.firstWindow();
              await desktop.context().route("**/api/comic-drama/**", (route: {
                continue(params: { headers: Record<string, string> }): Promise<void>;
                request(): { headers(): Record<string, string> };
              }) => route.continue({ headers: { ...route.request().headers(), authorization: "Bearer fixture-one" } }));
              await desktopPage.waitForURL(/http:\/\/127\.0\.0\.1:\d+/);
              await desktop.context().addInitScript(() => localStorage.setItem("lot:language", "zh"));
              await desktopPage.goto(new URL(new URL(deepLink).pathname, desktopPage.url()).href);
              await desktopPage.getByRole("heading", { name: "W2 浏览器剧集" }).waitFor();
              assert.ok(await desktopPage.evaluate(() => Boolean((window as unknown as { lotDesktop?: unknown }).lotDesktop)));
              assert.equal(await desktopPage.getByLabel("场景", { exact: true }).inputValue(), "本地冲突版本");
              await desktopPage.getByRole("navigation", { name: "制作步骤" }).getByRole("button", { name: /选角/ }).click();
              const desktopCast = desktopPage.locator(".comic-cast-card").filter({ hasText: "W3 角色" });
              await desktopCast.getByText(/版本 1/).waitFor();
              await desktopCast.getByText("角色库有更新", { exact: true }).waitFor();
              if (generation) {
                await desktopPage.getByRole("navigation", { name: "制作步骤" }).getByRole("button", { name: /生成/ }).click();
                await desktopPage.getByText("已确认首帧", { exact: true }).waitFor();
                await desktopPage.waitForFunction(() => Array.from(document.images).some(img => img.alt === "首帧图片" && img.naturalWidth === 480));
                console.log("PASS W5 Electron: signed generated first frame and persisted approval");
              }
              if (videoEpisode) {
                await desktopPage.getByRole("button", { name: "历史成片", exact: true }).click();
                const video = desktopPage.locator(".comic-video-card").filter({ hasText: "W6 video fixture · 版本 2 · 已采用" }).locator("video");
                await video.evaluate((player: HTMLVideoElement) => { player.preload = "metadata"; player.load(); });
                await desktopPage.waitForFunction(() => Array.from(document.querySelectorAll("video")).some(player => player.videoWidth === 320));
                console.log("PASS W6 Electron: history and signed video playback");
              }
              await desktopPage.getByRole("button", { name: "素材库", exact: true }).click();
              await desktopPage.waitForFunction(() => Array.from(document.images).some(img => img.alt === "W3 夜景" && img.naturalWidth === 480));
              console.log("PASS W2–W4 Electron: preload, deep link, locked cast snapshot and signed media preview through loopback");
            } finally { await desktop.close(); }
          } finally { await rm(profile, { recursive: true, force: true }); }
        }
        for (const [locale, label, casting, generate, firstFrame] of [
          ["en", "Scene", "Add a character to the clip", "Generate", "Generate first frames"],
          ["id", "Adegan", "Tambahkan karakter ke klip", "Buat", "Buat bingkai awal"],
        ]) {
          await page.evaluate((next: string) => localStorage.setItem("lot:language", next), locale);
          await page.reload();
          await page.getByLabel(label, { exact: true }).waitFor();
          await page.getByLabel(casting, { exact: true }).waitFor();
          if (generation) {
            await page.locator(".comic-steps").getByRole("button", { name: new RegExp(generate) }).click();
            await page.getByRole("heading", { name: firstFrame, exact: true }).waitFor();
          }
        }
        await page.evaluate(() => localStorage.setItem("lot:language", "zh"));
        enabled = false;
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(deepLink);
        await page.waitForURL("**/assistant");
        await page.getByRole("tab", { name: "漫剧工厂", exact: true }).click();
        await page.getByText("即将开放", { exact: true }).waitFor();
        assert.deepEqual(errors, []);
        console.log("PASS W2 Web: entry, create, two clips, reorder, save, switch, reload, two-window conflict recovery, mobile and flag-off");
      } finally { await browser.close(); }
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }
} finally {
  await generation?.close();
  await pool.end();
  await rm(fixtureMediaDir, { recursive: true, force: true });
}
