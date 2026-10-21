import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { PgMarketingTextOperations, type TextOperation } from "./operations.js";
import { MarketingSourceSchema, marketingSourceKind } from "@lot-agent/core/marketing-video";
import { creationPrompt, publicationPrompt, storyboardPrompt } from "./creation.js";
import { invalidTextResult, parseOperationResult, parseTextResult } from "./text-result.js";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { estimateCost } from "@lot-agent/core";
import { isMarketingDurationValid, MARKETING_INPUT_VERSION, marketingJobProfile, marketingReferenceError, marketingShotMaxSeconds, capMarketingStoryboard, marketingAssetIds, marketingReferenceImageIssue, MarketingDraftSchema, resolveMarketingSegments, planMarketingSegments, type MarketingDraft, type MarketingVideoProfile } from "@lot-agent/core/marketing-video";
import type { AgentService } from "../services/agent-service.js";
import { BullmqJobQueue } from "../jobs/bullmq-queue.js";
import { makePricingLookup } from "../billing/pricing-lookup.js";
import { KnowledgeError } from "../knowledge/errors.js";
import { MarketingError, PgMarketingProjectStore, reviewText } from "./repository.js";
import { inspectMedia, mediaCapabilities, ownedAssetPath } from "./media.js";
import { readImageInfo } from "./image-size.js";
import { archiveMarketingVideo } from "./archive.js";
import { MarketingTextError } from "./text.js";
import { marketingImageReferences, marketingSegmentPrompt } from "./prompt.js";
import { REVIEW_INSTRUCTION } from "./compliance.js";
export { REVIEW_INSTRUCTION } from "./compliance.js";
import { ownedAnalysisUpload } from "../marketing-analysis/uploads.js";
import { AnalysisError } from "../marketing-analysis/errors.js";
import { AnalysisStorage, analysisOwnerLimit } from "../marketing-analysis/storage.js";
import { signPrivateMaterial } from "../generation/private-materials.js";
import { segmentRecoveryAction, UNKNOWN_SUBMISSION_MESSAGE } from "./recovery.js";
import { activeMarketingVideoProfile } from "./model.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function createMarketingVideoRoutes(service: AgentService, dataRoot: string, store = new PgMarketingProjectStore(service.db.pool), operations = new PgMarketingTextOperations(service.db.pool)) {
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
  async function ownedAssets(owner: string, draft: MarketingDraft, allowMissing = false, historicalDraft?: MarketingDraft, preview = false) {
    const result: Record<string, { id: string; url: string; name: string; mime: string; issue?: "unsupported" }> = {};
    if (draft.referenceUpload && draft.referenceUpload.id !== historicalDraft?.referenceUpload?.id) {
      try { await ownedAnalysisUpload(service.db.pool, owner, draft.referenceUpload.id); }
      catch (error) {
        if (error instanceof AnalysisError) throw new MarketingError(error.code === "UPLOAD_EXPIRED" ? "本地视频已过期，请重新上传。" : "本地视频不存在，请重新上传。", error.status === 404 ? 404 : 409);
        throw error;
      }
    }
    for (const [slot, value] of Object.entries(draft.assets)) {
      for (const id of marketingAssetIds(value)) {
        const asset = await service.db.getAsset(id);
        if (asset && asset.user_id !== owner) throw new MarketingError("素材不存在", 404);
        if (!asset) {
          if (allowMissing) continue;
          throw new MarketingError("素材不存在", 404);
        }
        const allowed = slot === "video" ? ["video/mp4", "video/quicktime"]
          : ["voice", "music"].includes(slot) ? ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4"] : ["image/jpeg", "image/png", "image/webp"];
        const unsupported = !allowed.includes(asset.mime) || Number(asset.size_bytes) > (slot === "video" ? 150 : slot === "music" ? 30 : slot === "voice" ? 15 : 20) * 1024 * 1024;
        if (unsupported && !marketingAssetIds(historicalDraft?.assets[slot as keyof MarketingDraft["assets"]]).includes(id)) throw new MarketingError("素材格式或大小不支持");
        if (asset.type === "upload" && !asset.is_private) {
          await service.db.protectMarketingUpload(id, owner);
          asset.is_private = true;
        }
        result[id] = { id, url: preview ? signPrivateMaterial(asset) : asset.url, name: asset.original_name || slot, mime: asset.mime, ...(unsupported ? { issue: "unsupported" as const } : {}) };
        result[slot] ??= result[id];
      }
    }
    return result;
  }
  /** Material checks before any clip is paid for: owned and supported files, the real
   * format of submitted images, reference video limits and voice / music samples. */
  async function checkMaterials(owner: string, draft: MarketingDraft, profile: MarketingVideoProfile, inputVersion: number, needsSubmission: boolean, signal: AbortSignal) {
    const assets = await ownedAssets(owner, draft, !needsSubmission, needsSubmission ? undefined : draft);
    // The stored MIME is the client's claim and the draft may predate the active
    // model, so check each submitted image's real format and size against it here.
    if (needsSubmission && inputVersion >= 2) {
      for (const { assetId } of marketingImageReferences(draft)) {
        const asset = (await service.db.getAsset(assetId))!;
        const info = await readImageInfo(await ownedAssetPath(dataRoot, asset));
        const issue = marketingReferenceImageIssue(profile, { mime: info?.mime ?? "", size: Number(asset.size_bytes), width: info?.width ?? 0, height: info?.height ?? 0 });
        if (issue) throw new MarketingError(issue);
      }
    }
    if (needsSubmission && assets.video) {
      const video = (await service.db.getAsset(assets.video.id))!;
      const info = await inspectMedia(await ownedAssetPath(dataRoot, video), signal);
      if (!info.video) throw new MarketingError("参考视频无法读取画面，请重新上传。");
      const limits = profile.referenceVideo;
      if (limits && (info.duration < limits.minSeconds || info.duration > limits.maxSeconds || !Number.isFinite(info.fps) || info.fps < limits.minFps || info.fps > limits.maxFps
        || Math.min(info.width, info.height) < limits.minEdge || Math.max(info.width, info.height) > limits.maxEdge || info.width * info.height > limits.maxPixels
        || info.width / info.height < limits.minAspect || info.width / info.height > limits.maxAspect)) {
        throw new MarketingError(`参考视频需为 ${limits.minSeconds}–${limits.maxSeconds} 秒、${limits.minFps}–${limits.maxFps} fps，宽高各 ${limits.minEdge}–${limits.maxEdge} 像素，总像素不超过 ${limits.maxPixels}，宽高比 ${limits.minAspect}–${limits.maxAspect}。`);
      }
    }
    if (assets.voice || assets.music) {
      for (const slot of ["voice", "music"] as const) {
        if (!assets[slot] || (slot === "voice" && (!needsSubmission || draft.assets.video))) continue;
        const asset = (await service.db.getAsset(assets[slot].id))!;
        const info = await inspectMedia(await ownedAssetPath(dataRoot, asset), signal);
        if (!info.audio || (slot === "voice" && (info.duration < 2 || info.duration > 15))) throw new MarketingError("声音样例时长需为 2–15 秒");
      }
    }
    return assets;
  }
  async function quotaExceeded(owner: string, profile: MarketingVideoProfile, billableSeconds: number) {
    if (billableSeconds <= 0) return null;
    const pricing = makePricingLookup((id) => service.modelRegistry.getConfig(id), service.modelCatalog, "video")(profile.modelId);
    const quota = await service.usageMeter.checkQuota(owner, pricing ? estimateCost(pricing, { outputCount: billableSeconds }) : 0);
    return quota.ok ? null : { error: quota.reason, code: quota.code };
  }
  const requireProject = async (owner: string, id: string) => {
    const p = await store.get(owner, id); if (!p) throw new MarketingError("草稿不存在", 404); return p;
  };
  const replay = (operation: TextOperation) => {
    if (operation.result) return operation.result;
    throw new MarketingError(["failed", "cancelled"].includes(operation.status) ? "本次创作未完成，已有调用记录已保存；如需重新付费创作，请发起新请求。" : "已有创作请求正在处理或结果待核实，请查看页面底部的处理结果。", 409);
  };
  app.get("/capabilities", async (c) => c.json({ ...(await mediaCapabilities()), knowledge: process.env.KNOWLEDGE_MANAGEMENT_ENABLED === "1", model: activeProfile }));
  app.get("/usage", async (c) => {
    const owner = c.get("userId");
    const [drafts, analysisBytes] = await Promise.all([store.usage(owner), analysisStorage.ownerBytes(owner)]);
    return c.json({ ...drafts, analysisBytes, analysisLimitBytes: analysisOwnerLimit() });
  });
  app.get("/", async (c) => c.json(await store.page(c.get("userId"), { limit: Number(c.req.query("limit") ?? 20) || 20, cursor: c.req.query("cursor"), query: c.req.query("q") })));
  app.post("/copy", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = MarketingDraftSchema.safeParse(body?.draft);
    if (!parsed.success || !["zh", "en", "id"].includes(body?.locale)) throw new MarketingError("创作参数无效。");
    const draft = parsed.data;
    if (draft.copyMode === "rewrite" ? !draft.reference.trim() : !draft.topic.trim()) throw new MarketingError("请填写创作主题或参考内容。");
    const source = MarketingSourceSchema.safeParse(body.source ?? { kind: marketingSourceKind(draft.reference) });
    if (!source.success) throw new MarketingError("创作参数无效。");
    if (draft.copyMode === "rewrite" && (draft.referenceUpload || source.data.kind === "video" || marketingSourceKind(draft.reference) === "video")) {
      return c.json({ error: "视频链接需先完成参考视频分析。", code: "VIDEO_ANALYSIS_REQUIRED" }, 400);
    }
    if (!uuid.test(body.clientRequestId ?? "") || !uuid.test(body.projectId ?? "") || !Number.isInteger(body.version)) throw new MarketingError("创作参数无效。");
    const owner = c.get("userId");
    const reserved = await operations.begin(owner, body.clientRequestId, body.projectId, body.version, "copy",
      { draft, locale: body.locale, source: source.data, version: body.version }, draft);
    if (!reserved.fresh) return c.json({ ...replay(reserved.operation), operation: reserved.operation, project: await requireProject(owner, body.projectId) });
    try {
      const prompt = creationPrompt(reserved.draft, body.locale);
      // Not tied to the browser connection: a refresh or closed tab must not turn
      // a paid request into an unknown one. The 300 s request deadline still applies,
      // and the saved result is applied here and shown by the operation records.
      const raw = await service.marketingText(prompt.system, prompt.input, owner, undefined,
        { upstreamBilling: true, onReceipt: receipt => operations.receipt(owner, body.clientRequestId, receipt) });
      const result = parseTextResult("copy", raw, reserved.draft);
      const operation = await operations.finish(owner, body.clientRequestId, result);
      return c.json({ ...result, operation, project: await requireProject(owner, body.projectId) });
    } catch (error) { await operations.fail(owner, body.clientRequestId, true, invalidTextResult(error)); throw error; }
  });
  const validateId: MiddlewareHandler = async (c, next) => {
    if (!uuid.test(c.req.param("id") ?? "")) return c.json({ error: "草稿不存在" }, 404);
    await next();
  };
  app.use("/:id", validateId);
  app.use("/:id/*", validateId);
  app.get("/:id", async (c) => {
    const p = await requireProject(c.get("userId"), c.req.param("id"));
    return c.json({ ...p, assets: await ownedAssets(c.get("userId"), p.draft, true, p.draft, true) });
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
    if (!await (service.jobQueue as BullmqJobQueue).canResumePersisted(p.taskId)) throw new MarketingError("原任务正在收尾，请稍后继续。", 409);
    const released = await store.releaseUnknownSegments(owner, p.id);
    return c.json({ released, project: await requireProject(owner, p.id) });
  });
  app.put("/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = MarketingDraftSchema.safeParse(body?.draft);
    if (!parsed.success || !Number.isInteger(body?.version) || body.version < 0) throw new MarketingError("草稿参数无效");
    // Deleted input material must not prevent editing a finished video's title.
    const old = await store.get(c.get("userId"), c.req.param("id"));
    await ownedAssets(c.get("userId"), parsed.data, !!old?.taskId, old?.draft);
    return c.json(await store.save(c.get("userId"), c.req.param("id"), body.version, parsed.data));
  });
  app.delete("/:id", async (c) => {
    const owner = c.get("userId"); const p = await requireProject(owner, c.req.param("id"));
    // A cancelled job may still be queued or finishing in BullMQ.
    if (p.status === "cancelled" && p.taskId && !await (service.jobQueue as BullmqJobQueue).canResumePersisted(p.taskId)) throw new MarketingError("原任务正在收尾，请稍后再删除。", 409);
    const removed = await store.remove(owner, p.id);
    // Rows are gone; a file that fails to delete is only orphaned bytes, never a visible draft.
    const folder = resolve(dataRoot, "assets");
    const results = await Promise.allSettled([
      ...removed.files.map(async key => { const path = resolve(folder, key); if (path.startsWith(folder + sep)) await rm(path, { force: true }); }),
      // The media worker's cleanup retries analysis folders that remain.
      ...removed.removedAnalyses.map(analysisId => analysisStorage.remove(owner, analysisId)),
    ]);
    const failed = results.filter(result => result.status === "rejected").length;
    if (failed) console.warn("[marketing-video] draft files not removed", { projectId: p.id, failed });
    return c.json({ ok: true, removedBytes: removed.removedBytes, keptAnalyses: removed.keptAnalyses });
  });
  app.post("/:id/storyboard", async (c) => {
    const owner = c.get("userId");
    let p = await requireProject(owner, c.req.param("id"));
    const body = await c.req.json().catch(() => null);
    if (!body || !Number.isInteger(body.version) || !["zh", "en", "id"].includes(body.locale)
      || typeof body.instruction !== "string" || body.instruction.length > 1000
      || (body.index !== undefined && (!Number.isInteger(body.index) || body.index < 0 ))) throw new MarketingError("分镜修改参数无效。");
    if (!uuid.test(body.clientRequestId ?? "")) throw new MarketingError("分镜修改参数无效。");
    const reserved = await operations.begin(owner, body.clientRequestId, p.id, body.version, "storyboard",
      { version: body.version, locale: body.locale, instruction: body.instruction, index: body.index });
    if (!reserved.fresh) { replay(reserved.operation); return c.json({ ...p, operation: reserved.operation }); }
    p = { ...p, draft: reserved.draft, version: body.version };
    let started = false;
    try {
      if (body.index !== undefined && body.index >= p.draft.storyboard.length) throw new MarketingError("分镜修改参数无效。");
      let initial;
      try { initial = p.draft.storyboard.length ? capMarketingStoryboard(p.draft.storyboard, p.draft, activeProfile) : planMarketingSegments(p.draft.script, p.draft.durationSec, marketingShotMaxSeconds(p.draft, activeProfile)).map(part => ({ durationSec: part.durationSec, script: part.script, visual: "", action: "", camera: "" })); }
      catch (error) { throw new MarketingError((error as Error).message); }
      const prompt = storyboardPrompt(p.draft, body.locale, initial, body.instruction, body.index);
      started = true;
      // Same as /copy: finish and record the paid result even if the browser disconnects.
      const raw = await service.marketingText(prompt.system, prompt.input, owner, undefined,
        { upstreamBilling: true, onReceipt: receipt => operations.receipt(owner, body.clientRequestId, receipt) });
      const result = parseTextResult("storyboard", raw, p.draft, body.index);
      const operation = await operations.finish(owner, body.clientRequestId, result);
      return c.json({ ...await requireProject(owner, p.id), operation });
    } catch (error) { await operations.fail(owner, body.clientRequestId, started, invalidTextResult(error)); throw error; }
  });
  // Review and publication use the same request records as /copy: one model call
  // per clientRequestId, the receipt is saved before the result is applied, and a
  // repeated or lost request replays the saved outcome instead of paying again.
  const recordedText = async (owner: string, projectId: string, body: { clientRequestId: string; version: number }, kind: "review" | "publication",
    input: { version: number; locale: "zh" | "en" | "id"; fillMissing?: boolean }, prompt: (draft: MarketingDraft) => { system: string; input: string }) => {
    const reserved = await operations.begin(owner, body.clientRequestId, projectId, body.version, kind, input);
    let operation = reserved.operation;
    if (reserved.fresh) {
      try {
        const request = prompt(reserved.draft);
        const raw = await service.marketingText(request.system, request.input, owner, undefined, { onReceipt: receipt => operations.receipt(owner, body.clientRequestId, receipt) });
        operation = await operations.finish(owner, body.clientRequestId, parseOperationResult(kind, raw, reserved.draft, input));
      } catch (error) { await operations.fail(owner, body.clientRequestId, true, invalidTextResult(error)); throw error; }
    } else replay(operation);
    if (operation.status === "conflict") throw new MarketingError(kind === "review" ? "文案已更新，请重新检查。" : "草稿已更新，请重新生成标题和标签。", 409);
    return { ...await requireProject(owner, projectId), operation };
  };
  app.post("/:id/review", async (c) => {
    const owner = c.get("userId"); const p = await requireProject(owner, c.req.param("id"));
    if (!p.draft.script.trim()) throw new MarketingError("请先填写或生成视频文案。");
    const body = await c.req.json().catch(() => null);
    if (body?.locale !== undefined && !["zh", "en", "id"].includes(body.locale)) throw new MarketingError("检查语言无效。");
    if (!uuid.test(body?.clientRequestId ?? "") || !Number.isInteger(body?.version)) throw new MarketingError("检查参数无效。");
    const locale = (body.locale ?? "zh") as "zh" | "en" | "id";
    return c.json(await recordedText(owner, p.id, body, "review", { version: body.version, locale },
      draft => ({ system: `${REVIEW_INSTRUCTION}\nWrite reasons and suggested replacements in ${locale}. Keep excerpts exactly as supplied.`, input: reviewText(draft) })));
  });
  app.post("/:id/publication", async (c) => {
    const owner = c.get("userId"); const p = await requireProject(owner, c.req.param("id"));
    const body = await c.req.json().catch(() => null);
    if (!["zh", "en", "id"].includes(body?.locale) || typeof body?.fillMissing !== "boolean" || !p.draft.script.trim()
      || !uuid.test(body?.clientRequestId ?? "") || !Number.isInteger(body?.version)) throw new MarketingError("生成参数无效");
    return c.json(await recordedText(owner, p.id, body, "publication", { version: body.version, locale: body.locale, fillMissing: body.fillMissing },
      draft => publicationPrompt(draft.script, body.locale)));
  });
  app.post("/:id/generate", async (c) => {
    const owner = c.get("userId");
    const p = await requireProject(owner, c.req.param("id"));
    const body = await c.req.json().catch(() => null);
    if (!Number.isInteger(body?.version) || typeof body?.retry !== "boolean") throw new MarketingError("生成参数无效");
    if (p.taskId && (!body.retry || ["pending", "running", "succeeded"].includes(p.status))) {
      if (p.status === "pending") await (service.jobQueue as BullmqJobQueue).deliverPersisted(p.taskId, "marketing.video");
      return c.json(p, 202);
    }
    if (p.version !== body.version) throw new MarketingError("草稿已更新，请重新确认。", 409);
    if (p.taskId && !await (service.jobQueue as BullmqJobQueue).canResumePersisted(p.taskId)) throw new MarketingError("原任务正在收尾，请稍后继续。", 409);
    let draft = p.draft;
    let originalAudio: boolean | undefined;
    // Recovery keeps the frozen job's model and reference rules.
    let inputVersion = MARKETING_INPUT_VERSION;
    let profile = activeProfile;
    const segments = p.taskId ? await store.segments(owner, p.id) : [];
    if (p.taskId) {
      const original = await service.db.getTask(p.taskId);
      const frozen = original?.input && typeof original.input === "object" && !Array.isArray(original.input) ? original.input as Record<string, unknown> : undefined;
      if (!original || !frozen || original.user_id !== owner || original.type !== "marketing.video" || frozen.projectId !== p.id
        || !["failed", "cancelled"].includes(original.status) || !segments.length) throw new MarketingError("原任务不可恢复。", 409);
      draft = MarketingDraftSchema.parse(frozen.draft);
      originalAudio = frozen.generate_audio !== false;
      inputVersion = typeof frozen.marketingInputVersion === "number" ? frozen.marketingInputVersion : 1;
      try { profile = marketingJobProfile(frozen); }
      catch (error) { throw new MarketingError((error as Error).message, 409); }
      if (segments.length > 15 || segments.some((s, i) => s.slot !== i || !Number.isInteger(Number(s.duration_sec)) || Number(s.duration_sec) < 4 || Number(s.duration_sec) > marketingShotMaxSeconds(draft, profile))
        || !isMarketingDurationValid(draft.durationSec, segments.reduce((sum, s) => sum + Number(s.duration_sec), 0))) throw new MarketingError("视频分段配置不完整", 409);
      if (segments.some(s => segmentRecoveryAction(s) === "unknown")) throw new MarketingError(UNKNOWN_SUBMISSION_MESSAGE, 409);
      for (const segment of segments.filter(s => segmentRecoveryAction(s) === "reuse")) {
        for (const assetId of segment.output.assetIds) {
          const asset = await service.db.getAsset(assetId);
          // A clip kept by a shot redo belongs to the earlier segment task that made it.
          if (!asset || asset.user_id !== owner || asset.task_id !== (segment.output.reusedFrom ?? segment.task_id)) throw new MarketingError("片段素材不可用", 404);
        }
      }
    }
    const needsSubmission = !p.taskId || segments.some(s => segmentRecoveryAction(s) === "submit");
    if (needsSubmission) {
      // Version 1 inputs predate reference checks.
      const referenceError = inputVersion >= 2 ? marketingReferenceError(draft, profile) : "";
      if (referenceError) throw new MarketingError(referenceError);
    }
    const capabilities = await mediaCapabilities();
    if (!capabilities.composition) throw new MarketingError("视频合成工具不可用，请配置 FFmpeg 和 FFprobe。", 503);
    let planned;
    try {
      planned = p.taskId ? segments.map((segment, index) => ({ index, script: segment.script, durationSec: Number(segment.duration_sec) })) : resolveMarketingSegments(draft, profile);
      if (!p.taskId) planned.forEach(segment => marketingSegmentPrompt(draft, segment, planned.length, undefined, profile));
      else segments.forEach((segment, index) => {
        if (segmentRecoveryAction(segment) === "submit") marketingSegmentPrompt(draft, { index, script: segment.script, durationSec: Number(segment.duration_sec) }, segments.length, originalAudio, profile);
      });
    }
    catch (error) { throw new MarketingError((error as Error).message); }
    const billableSeconds = p.taskId ? segments.filter(s => segmentRecoveryAction(s) === "submit").reduce((sum, s) => sum + Number(s.duration_sec), 0) : planned.reduce((sum, s) => sum + s.durationSec, 0);
    const assets = await checkMaterials(owner, draft, profile, inputVersion, needsSubmission, c.req.raw.signal);
    const exceeded = await quotaExceeded(owner, profile, billableSeconds);
    if (exceeded) return c.json(exceeded, 402);
    if (p.taskId) {
      // reserve's recovery branch changes only status. Never rebuild the
      // frozen provider input, vendor IDs or segment billing identity.
      const taskId = await store.reserve(owner, p.id, body.version, {}, true);
      try { await (service.jobQueue as BullmqJobQueue).deliverPersisted(taskId, "marketing.video"); }
      catch { throw new MarketingError("任务已保存，队列暂不可用；请重新打开草稿继续。", 503); }
      return c.json(await store.get(owner, p.id), 202);
    }
    const edge = p.draft.quality === "1080p" ? 1080 : 720;
    const [w, h] = p.draft.ratio.split(":").map(Number);
    const input = { marketingInputVersion: MARKETING_INPUT_VERSION, modelId: profile.modelId, quality: p.draft.quality, resolution: p.draft.quality, ratio: p.draft.ratio,
      size: `${Math.round(edge * w / Math.min(w, h) / 8) * 8}x${Math.round(edge * h / Math.min(w, h) / 8) * 8}`,
      input_reference: marketingImageReferences(p.draft).flatMap(({ assetId }) => assets[assetId] ? [assets[assetId].url] : []),
      reference_video: assets.video ? [assets.video.url] : undefined,
      generate_audio: !p.draft.assets.video,
      reference_audio: !p.draft.assets.video && assets.voice ? [assets.voice.url] : undefined,
      requireUserModelKey: process.env.DEBUG !== "1" };
    const taskId = await store.reserve(owner, p.id, body.version, input, body.retry);
    try { await (service.jobQueue as BullmqJobQueue).deliverPersisted(taskId, "marketing.video"); }
    catch { throw new MarketingError("任务已保存，队列暂不可用；请重新打开草稿继续。", 503); }
    return c.json(await store.get(owner, p.id), 202);
  });
  // Redo chosen shots of a stopped or finished video. The other shots keep their clips
  // without a model call or a charge; only the redone shots' seconds are billed.
  app.post("/:id/revise", async (c) => {
    const owner = c.get("userId");
    const p = await requireProject(owner, c.req.param("id"));
    const body = await c.req.json().catch(() => null);
    const shots: unknown[] = Array.isArray(body?.shots) ? body.shots : [];
    if (!Number.isInteger(body?.version) || !shots.length || shots.length > 15 || !shots.every(Number.isInteger) || new Set(shots).size !== shots.length) throw new MarketingError("重新生成参数无效");
    const redo = shots as number[];
    if (!p.taskId || !p.revision) throw new MarketingError("当前视频不能单镜重做，请复制为新草稿。", 409);
    if (p.version !== body.version) throw new MarketingError("草稿已更新，请重新确认。", 409);
    if (!await (service.jobQueue as BullmqJobQueue).canResumePersisted(p.taskId)) throw new MarketingError("原任务正在收尾，请稍后继续。", 409);
    const original = await service.db.getTask(p.taskId);
    const frozen = original?.input && typeof original.input === "object" && !Array.isArray(original.input) ? original.input as Record<string, unknown> : undefined;
    if (!original || !frozen || original.user_id !== owner || original.type !== "marketing.video" || frozen.projectId !== p.id) throw new MarketingError("原任务不可恢复。", 409);
    // Kept clips come from this model, so redone shots use it too.
    const profile = marketingJobProfile(frozen);
    let plan;
    try {
      plan = resolveMarketingSegments(p.draft, profile);
      for (const slot of redo) {
        if (!plan[slot]) throw new Error("请重新选择需要重新生成的镜头。");
        marketingSegmentPrompt(p.draft, plan[slot], plan.length, frozen.generate_audio !== false, profile);
      }
    } catch (error) { throw new MarketingError((error as Error).message); }
    const referenceError = marketingReferenceError(p.draft, profile);
    if (referenceError) throw new MarketingError(referenceError);
    if (!(await mediaCapabilities()).composition) throw new MarketingError("视频合成工具不可用，请配置 FFmpeg 和 FFprobe。", 503);
    for (const segment of (await store.segments(owner, p.id)).filter(s => !redo.includes(s.slot))) {
      for (const assetId of segment.output?.assetIds ?? []) {
        const asset = await service.db.getAsset(assetId);
        if (!asset || asset.user_id !== owner || asset.task_id !== (segment.output.reusedFrom ?? segment.task_id)) throw new MarketingError("片段素材不可用，请一并重新生成该镜头。", 409);
      }
    }
    await checkMaterials(owner, p.draft, profile, Number(frozen.marketingInputVersion), true, c.req.raw.signal);
    const exceeded = await quotaExceeded(owner, profile, redo.reduce((sum, slot) => sum + plan[slot].durationSec, 0));
    if (exceeded) return c.json(exceeded, 402);
    const taskId = await store.revise(owner, p.id, body.version, p.taskId, redo);
    try { await (service.jobQueue as BullmqJobQueue).deliverPersisted(taskId, "marketing.video"); }
    catch { throw new MarketingError("任务已保存，队列暂不可用；请重新打开草稿继续。", 503); }
    return c.json(await store.get(owner, p.id), 202);
  });
  app.post("/:id/archive", async (c) => {
    if (process.env.KNOWLEDGE_MANAGEMENT_ENABLED !== "1") throw new MarketingError("知识库尚未启用。", 503);
    return c.json(await archiveMarketingVideo(store, c.get("userId"), c.req.param("id"), dataRoot));
  });
  return app;
}
