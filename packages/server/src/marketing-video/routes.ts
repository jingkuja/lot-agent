import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { PgMarketingTextOperations } from "./operations.js";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { marketingVideoProfile, marketingVoiceover, type MarketingDraft, type MarketingProject, MarketingDraftSchema, MarketingSourceSchema,
  marketingSourceKind, resolveMarketingSegments } from "@lot-agent/core/marketing-video";
import type { AgentService } from "../services/agent-service.js";
import type { BullmqJobQueue } from "../jobs/bullmq-queue.js";
import { KnowledgeError } from "../knowledge/errors.js";
import { MarketingError, PgMarketingProjectStore } from "./repository.js";
import { mediaCapabilities } from "./media.js";
import { archiveMarketingVideo } from "./archive.js";
import { MarketingTextError } from "./text.js";
export { REVIEW_INSTRUCTION } from "./compliance.js";
import { AnalysisStorage, analysisOwnerLimit } from "../marketing-analysis/storage.js";
import { signPrivateMaterial } from "../generation/private-materials.js";
import { activeMarketingVideoProfile } from "./model.js";
import { MarketingNarrator } from "./narration.js";
import { MarketingKeyArtist } from "./key-art.js";
import { MarketingMaterials } from "./materials.js";
import { MarketingProduction } from "./production.js";
import { MarketingWriting, type MarketingLocale } from "./writing.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const isLocale = (value: unknown): value is MarketingLocale => value === "zh" || value === "en" || value === "id";
const materialsKey = (draft: MarketingDraft) => JSON.stringify([draft.assets, draft.referenceUpload?.id ?? null]);

/** Key-art stills use the owner's own model key, like every other marketing model call. */
export function marketingKeyArtist(service: AgentService, dataRoot: string) {
  return new MarketingKeyArtist(service.db.pool, dataRoot, {
    provider: async (owner, model) => {
      const apiKey = await service.db.getUserApiKey(owner, service.managedKeysEnabled);
      if (!apiKey) throw new MarketingError("模型账号不可用，请重新登录后再生成定妆图。", 409);
      return service.providerFactory.image(model, apiKey);
    },
    getAsset: id => service.db.getAsset(id), createAsset: asset => service.db.createAsset(asset),
    storage: service.uploadStorage, sign: asset => signPrivateMaterial(asset),
  });
}

export function createMarketingVideoRoutes(service: AgentService, dataRoot: string, store = new PgMarketingProjectStore(service.db.pool), operations = new PgMarketingTextOperations(service.db.pool),
  narrator = new MarketingNarrator(service.db.pool, dataRoot), keyArtist = marketingKeyArtist(service, dataRoot)) {
  // New clips use the configured model; recovery uses each job's recorded model.
  const activeProfile = activeMarketingVideoProfile();
  const analysisStorage = new AnalysisStorage(resolve(dataRoot, "marketing-analysis"));
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", bodyLimit({ maxSize: 128 * 1024, onError: (c) => c.json({ error: "请求正文过大" }, 413) }));
  app.use("*", async (c, next) => {
    if (!c.get("userId")) return c.json({ error: "请先登录" }, 401);
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof MarketingTextError) {
      console.warn("[marketing-video] text request failed", { code: error.code, operation: c.req.path.split("/").at(-1) });
      return c.json({ error: error.message, code: error.code }, error.status);
    }
    if (error instanceof MarketingError || error instanceof KnowledgeError) return c.json({ error: error.message }, error.status);
    // Do not log the raw exception: model/SQL errors can contain user content.
    console.error("[marketing-video] request failed", { method: c.req.method, errorType: error.name });
    return c.json({ error: "操作失败，请稍后重试。" }, 500);
  });
  const materials = new MarketingMaterials(service.db, dataRoot);
  const production = new MarketingProduction({ service, store, narrator, keyArtist, materials, activeProfile });
  const writing = new MarketingWriting({ service, store, operations, activeProfile });
  const queue = () => service.jobQueue as BullmqJobQueue;
  const requireProject = async (owner: string, id: string) => {
    const p = await store.get(owner, id); if (!p) throw new MarketingError("草稿不存在", 404); return p;
  };
  app.get("/capabilities", async (c) => c.json({ ...(await mediaCapabilities()), knowledge: process.env.KNOWLEDGE_MANAGEMENT_ENABLED === "1", narration: narrator.available, model: activeProfile }));
  app.get("/usage", async (c) => {
    const owner = c.get("userId");
    const [drafts, narrationBytes, analysisBytes] = await Promise.all([store.usage(owner), narrator.ownerBytes(owner), analysisStorage.ownerBytes(owner)]);
    return c.json({ ...drafts, narrationBytes, analysisBytes, analysisLimitBytes: analysisOwnerLimit() });
  });
  app.get("/", async (c) => c.json(await store.page(c.get("userId"), { limit: Number(c.req.query("limit") ?? 20) || 20, cursor: c.req.query("cursor"), query: c.req.query("q") })));
  app.post("/copy", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = MarketingDraftSchema.safeParse(body?.draft);
    if (!parsed.success || !isLocale(body?.locale)) throw new MarketingError("创作参数无效。");
    const draft = parsed.data;
    if (draft.copyMode === "rewrite" ? !draft.reference.trim() : !draft.topic.trim()) throw new MarketingError("请填写创作主题或参考内容。");
    const source = MarketingSourceSchema.safeParse(body.source ?? { kind: marketingSourceKind(draft.reference) });
    if (!source.success) throw new MarketingError("创作参数无效。");
    if (draft.copyMode === "rewrite" && (draft.referenceUpload || source.data.kind === "video" || marketingSourceKind(draft.reference) === "video")) {
      return c.json({ error: "视频链接需先完成爆款视频分析。", code: "VIDEO_ANALYSIS_REQUIRED" }, 400);
    }
    if (!uuid.test(body.clientRequestId ?? "") || !uuid.test(body.projectId ?? "") || !Number.isInteger(body.version)) throw new MarketingError("创作参数无效。");
    return c.json(await writing.copy(c.get("userId"), body.projectId,
      { clientRequestId: body.clientRequestId, version: body.version, locale: body.locale, draft, source: source.data }));
  });
  const validateId: MiddlewareHandler = async (c, next) => {
    if (!uuid.test(c.req.param("id") ?? "")) return c.json({ error: "草稿不存在" }, 404);
    await next();
  };
  app.use("/:id", validateId);
  app.use("/:id/*", validateId);
  app.get("/:id", async (c) => {
    const p = await requireProject(c.get("userId"), c.req.param("id"));
    return c.json({ ...p, assets: await materials.owned(c.get("userId"), p.draft, { allowMissing: true, historicalDraft: p.draft, preview: true }) });
  });
  // Polled every few seconds while a video is being made; the full project is read once on open.
  app.get("/:id/status", async (c) => {
    const state = await store.taskState(c.get("userId"), c.req.param("id"));
    if (!state) throw new MarketingError("草稿不存在", 404);
    return c.json(state);
  });
  app.get("/:id/text-operations", async c => {
    const owner = c.get("userId"); const id = c.req.param("id");
    await requireProject(owner, id);
    return c.json({ data: await operations.list(owner, id) });
  });
  app.post("/:id/text-operations/:operationId/recover", async c => {
    const owner = c.get("userId"); const projectId = c.req.param("id");
    const operationId = c.req.param("operationId");
    if (!uuid.test(operationId)) throw new MarketingError("创作记录不存在。", 404);
    await requireProject(owner, projectId);
    const operation = await operations.recover(owner, projectId, operationId);
    return c.json({ operation, project: await requireProject(owner, projectId) });
  });
  app.post("/:id/text-operations/:operationId/release", async c => {
    const owner = c.get("userId"); const projectId = c.req.param("id");
    const operationId = c.req.param("operationId");
    if (!uuid.test(operationId)) throw new MarketingError("创作记录不存在。", 404);
    await requireProject(owner, projectId);
    const operation = await operations.release(owner, projectId, operationId);
    return c.json({ operation, project: await requireProject(owner, projectId) });
  });
  // Explicit user consent replaces the support-only exit for clips with an unknown
  // submission outcome. The following /generate retry resubmits only those clips.
  app.post("/:id/unknown-segments/release", async c => {
    const owner = c.get("userId"); const p = await requireProject(owner, c.req.param("id"));
    if (!p.taskId) throw new MarketingError("没有结果未知的片段。", 409);
    if (!await queue().canResumePersisted(p.taskId)) throw new MarketingError("原任务正在收尾，请稍后继续。", 409);
    const released = await store.releaseUnknownSegments(owner, p.id);
    return c.json({ released, project: await requireProject(owner, p.id) });
  });
  app.put("/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = MarketingDraftSchema.safeParse(body?.draft);
    if (!parsed.success || !Number.isInteger(body?.version) || body.version < 0) throw new MarketingError("草稿参数无效");
    // Deleted input material must not prevent editing a finished video's title.
    const old = await store.get(c.get("userId"), c.req.param("id"));
    // Autosave mostly resends the materials checked when they were added; check only a change.
    if (!old || materialsKey(old.draft) !== materialsKey(parsed.data)) {
      await materials.owned(c.get("userId"), parsed.data, { allowMissing: !!old?.taskId, historicalDraft: old?.draft });
    }
    return c.json(await store.save(c.get("userId"), c.req.param("id"), body.version, parsed.data));
  });
  // Earlier copy and storyboard versions (assessment M04); restoring one is free.
  app.get("/:id/snapshots", async (c) => {
    const owner = c.get("userId"); const p = await requireProject(owner, c.req.param("id"));
    return c.json({ data: await store.snapshots(owner, p.id) });
  });
  app.post("/:id/snapshots/:snapshotId/restore", async (c) => {
    const owner = c.get("userId"); const p = await requireProject(owner, c.req.param("id"));
    const snapshotId = c.req.param("snapshotId");
    if (!uuid.test(snapshotId)) throw new MarketingError("历史版本不存在，请刷新后重试。", 404);
    const body = await c.req.json().catch(() => null);
    if (!Number.isInteger(body?.version) || body.version < 1) throw new MarketingError("草稿参数无效");
    return c.json(await store.restoreSnapshot(owner, p.id, body.version, snapshotId));
  });
  app.delete("/:id", async (c) => {
    const owner = c.get("userId"); const p = await requireProject(owner, c.req.param("id"));
    // A cancelled job may still be queued or finishing in BullMQ.
    if (p.status === "cancelled" && p.taskId && !await queue().canResumePersisted(p.taskId)) throw new MarketingError("原任务正在收尾，请稍后再删除。", 409);
    const removed = await store.remove(owner, p.id);
    // Rows are gone; a file that fails to delete is only orphaned bytes, never a visible draft.
    const folder = resolve(dataRoot, "assets");
    const uploads = resolve(dataRoot, "uploads");
    const results = await Promise.allSettled([
      ...removed.files.map(async key => { const path = resolve(folder, key); if (path.startsWith(folder + sep)) await rm(path, { force: true }); }),
      ...removed.keyArtFiles.map(async key => { const path = resolve(uploads, key); if (path.startsWith(uploads + sep)) await rm(path, { force: true }); }),
      narrator.removeFiles(p.id),
      // The media worker's cleanup retries analysis folders that remain.
      ...removed.removedAnalyses.map(analysisId => analysisStorage.remove(owner, analysisId)),
    ]);
    const failed = results.filter(result => result.status === "rejected").length;
    if (failed) console.warn("[marketing-video] draft files not removed", { projectId: p.id, failed });
    return c.json({ ok: true, removedBytes: removed.removedBytes, keptAnalyses: removed.keptAnalyses });
  });
  app.post("/:id/storyboard", async (c) => {
    const owner = c.get("userId");
    const p = await requireProject(owner, c.req.param("id"));
    const body = await c.req.json().catch(() => null);
    if (!body || !Number.isInteger(body.version) || !isLocale(body.locale)
      || typeof body.instruction !== "string" || body.instruction.length > 1000
      || (body.index !== undefined && (!Number.isInteger(body.index) || body.index < 0 ))) throw new MarketingError("分镜修改参数无效。");
    if (!uuid.test(body.clientRequestId ?? "")) throw new MarketingError("分镜修改参数无效。");
    return c.json(await writing.storyboard(owner, p,
      { clientRequestId: body.clientRequestId, version: body.version, locale: body.locale, instruction: body.instruction, index: body.index }));
  });
  app.post("/:id/review", async (c) => {
    const owner = c.get("userId"); const p = await requireProject(owner, c.req.param("id"));
    if (!p.draft.script.trim()) throw new MarketingError("请先填写或生成视频文案。");
    const body = await c.req.json().catch(() => null);
    if (body?.locale !== undefined && !isLocale(body.locale)) throw new MarketingError("检查语言无效。");
    if (!uuid.test(body?.clientRequestId ?? "") || !Number.isInteger(body?.version)) throw new MarketingError("检查参数无效。");
    return c.json(await writing.review(owner, p.id, { clientRequestId: body.clientRequestId, version: body.version, locale: body.locale ?? "zh" }));
  });
  app.post("/:id/publication", async (c) => {
    const owner = c.get("userId"); const p = await requireProject(owner, c.req.param("id"));
    const body = await c.req.json().catch(() => null);
    if (!isLocale(body?.locale) || typeof body?.fillMissing !== "boolean" || !p.draft.script.trim()
      || !uuid.test(body?.clientRequestId ?? "") || !Number.isInteger(body?.version)) throw new MarketingError("生成参数无效");
    return c.json(await writing.publication(owner, p.id,
      { clientRequestId: body.clientRequestId, version: body.version, locale: body.locale, fillMissing: body.fillMissing }));
  });
  // Twin narration of the saved draft, shot by shot. Takes are paid speech requests made
  // before any clip; /generate freezes them. A stopped video's shots keep its clip model's limits.
  const narrationPlan = (p: MarketingProject) => {
    if (!marketingVoiceover(p.draft)) throw new MarketingError("当前草稿未选择数字分身旁白。");
    try { return resolveMarketingSegments(p.draft, (p.revision && marketingVideoProfile(p.revision.modelId)) || activeProfile); }
    catch (error) { throw new MarketingError((error as Error).message); }
  };
  app.get("/:id/narration", async (c) => {
    const owner = c.get("userId"); const p = await requireProject(owner, c.req.param("id"));
    return c.json({ version: p.version, clips: await narrator.status(owner, p.id, p.draft, narrationPlan(p)) });
  });
  app.post("/:id/narration", async (c) => {
    const owner = c.get("userId"); const p = await requireProject(owner, c.req.param("id"));
    const body = await c.req.json().catch(() => null);
    const slots: unknown = body?.slots ?? [];
    if (!Number.isInteger(body?.version) || !Array.isArray(slots) || slots.length > 15 || !slots.every(slot => Number.isInteger(slot))) throw new MarketingError("配音参数无效。");
    if (p.version !== body.version) throw new MarketingError("草稿已更新，请重新确认。", 409);
    return c.json({ version: p.version, ...await narrator.synthesize(owner, p.id, p.draft, narrationPlan(p), slots as number[]) });
  });
  app.get("/:id/narration/:slot", async (c) => {
    const slot = Number(c.req.param("slot"));
    if (!Number.isInteger(slot) || slot < 0 || slot > 14) throw new MarketingError("该镜配音尚未生成。", 404);
    const owner = c.get("userId"); const p = await requireProject(owner, c.req.param("id"));
    const audio = await narrator.audio(owner, p.id, p.draft, narrationPlan(p), slot);
    return c.body(new Uint8Array(audio), 200, { "Content-Type": "audio/wav", "Content-Disposition": "inline" });
  });
  // A still of the presenter in the main setting, made before any clip and submitted with
  // every clip and shot redo of the video. One paid image request each, never resent.
  app.get("/:id/key-art", async (c) => {
    const owner = c.get("userId"); const p = await requireProject(owner, c.req.param("id"));
    return c.json({ version: p.version, keyArt: await keyArtist.status(owner, p.id, p.draft) });
  });
  app.post("/:id/key-art", async (c) => {
    const owner = c.get("userId"); const p = await requireProject(owner, c.req.param("id"));
    const body = await c.req.json().catch(() => null);
    if (!Number.isInteger(body?.version) || typeof (body?.redo ?? false) !== "boolean") throw new MarketingError("定妆图参数无效。");
    if (p.version !== body.version) throw new MarketingError("草稿已更新，请重新确认。", 409);
    if (p.taskId) throw new MarketingError("视频已提交制作，定妆图不会再改变；如需新的定妆图请复制为新草稿。", 409);
    await materials.owned(owner, p.draft);
    return c.json({ version: p.version, ...await keyArtist.generate(owner, p.id, p.draft, activeProfile, body.redo === true) });
  });
  app.post("/:id/generate", async (c) => {
    const owner = c.get("userId");
    const p = await requireProject(owner, c.req.param("id"));
    const body = await c.req.json().catch(() => null);
    if (!Number.isInteger(body?.version) || typeof body?.retry !== "boolean") throw new MarketingError("生成参数无效");
    const result = await production.generate(owner, p, { version: body.version, retry: body.retry }, c.req.raw.signal);
    if ("narration" in result) throw new MarketingError("请先生成全部分镜的数字分身配音并试听。", 409);
    return "quota" in result ? c.json(result.quota, 402) : c.json(result.project, 202);
  });
  // Redo chosen shots of a stopped or finished video. The other shots keep their clips
  // without a model call or a charge; only the redone shots' seconds are billed.
  app.post("/:id/revise", async (c) => {
    const owner = c.get("userId");
    const started = Date.now();
    const p = await requireProject(owner, c.req.param("id"));
    const body = await c.req.json().catch(() => null);
    // No shot means composing the kept clips again with changed music, captions or narration.
    const shots: unknown[] = Array.isArray(body?.shots) ? body.shots : [];
    // Shots whose failed narration take the user chose to make again.
    const narrationRedo: unknown[] = body?.narrationRedo ?? [];
    const slots = (list: unknown[]) => Array.isArray(list) && list.length <= 15 && list.every(Number.isInteger) && new Set(list).size === list.length;
    if (!Number.isInteger(body?.version) || !Array.isArray(body?.shots) || !slots(shots) || !slots(narrationRedo)) {
      throw new MarketingError("重新生成参数无效");
    }
    const request = { version: body.version, shots: shots as number[], narrationRedo: narrationRedo as number[] };
    const result = await production.revise(owner, p, request, c.req.raw.signal, started);
    if ("narration" in result) return c.json({ narrationPending: true, clips: result.narration }, 202);
    return "quota" in result ? c.json(result.quota, 402) : c.json(result.project, 202);
  });
  app.post("/:id/archive", async (c) => {
    if (process.env.KNOWLEDGE_MANAGEMENT_ENABLED !== "1") throw new MarketingError("知识库尚未启用。", 503);
    return c.json(await archiveMarketingVideo(store, c.get("userId"), c.req.param("id"), dataRoot));
  });
  return app;
}
