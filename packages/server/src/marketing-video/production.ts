import { estimateCost } from "@lot-agent/core";
import {
  CAPTION_WORDS_CHANGED, isMarketingDurationValid, marketingCaptionErrors, marketingFrameSize, MARKETING_INPUT_VERSION, marketingJobProfile,
  marketingNativeSpeech, marketingReferenceError, marketingShotMaxSeconds, marketingVoiceover, MarketingDraftSchema, resolveMarketingSegments,
  type MarketingDraft, type MarketingNarrationClip, type MarketingProject, type MarketingSegment, type MarketingVideoProfile,
} from "@lot-agent/core/marketing-video";
import type { AgentService } from "../services/agent-service.js";
import type { BullmqJobQueue } from "../jobs/bullmq-queue.js";
import { makePricingLookup } from "../billing/pricing-lookup.js";
import { MarketingError, type PgMarketingProjectStore } from "./repository.js";
import { mediaCapabilities, SUBTITLES_UNAVAILABLE } from "./media.js";
import { marketingImageReferences, marketingSegmentPrompt } from "./prompt.js";
import { segmentRecoveryAction, UNKNOWN_SUBMISSION_MESSAGE } from "./recovery.js";
import type { FrozenNarration, MarketingNarrator } from "./narration.js";
import type { MarketingKeyArtist } from "./key-art.js";
import type { MarketingMaterials, OwnedMaterial } from "./materials.js";

export interface MarketingProductionDeps {
  service: Pick<AgentService, "db" | "jobQueue" | "usageMeter" | "modelRegistry" | "modelCatalog">;
  store: PgMarketingProjectStore;
  narrator: MarketingNarrator;
  keyArtist: Pick<MarketingKeyArtist, "frozen">;
  materials: MarketingMaterials;
  /** Clip model of new videos; a stopped job keeps the model it recorded. */
  activeProfile: MarketingVideoProfile;
}

/** The project after its job was saved and delivered, the owner's quota refusal, or the narration takes a shot
 * redo is still waiting for: they are made in the background, and the same redo is sent again once they stop. */
export type MarketingProductionResult = { project: MarketingProject | null } | { quota: { error?: string; code?: string } }
  | { narration: MarketingNarrationClip[] };

type SegmentRow = Awaited<ReturnType<PgMarketingProjectStore["segments"]>>[number];
/** Options a stopped job was submitted with; recovery never infers them from today's draft. */
interface FrozenOptions { generateAudio: boolean; localSubtitles: boolean; keyArt: boolean }
/** What a submission is checked against: the draft of a new video, or a stopped job's frozen input. */
interface JobBasis {
  draft: MarketingDraft;
  profile: MarketingVideoProfile;
  inputVersion: number;
  /** Stored clips of a stopped job; empty for a new video. */
  segments: SegmentRow[];
  frozen?: FrozenOptions;
}

const QUEUE_UNAVAILABLE = "任务已保存，队列暂不可用；请重新打开草稿继续。";
const frozenInput = (input: unknown) => input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;

/** Plans, checks, reserves and delivers paid video jobs: new videos, continued jobs and shot redos. */
export class MarketingProduction {
  constructor(private readonly deps: MarketingProductionDeps) {}

  private get queue() { return this.deps.service.jobQueue as BullmqJobQueue; }

  /** Submits a new video for the draft, or continues its stopped job with the frozen input. */
  async generate(owner: string, p: MarketingProject, request: { version: number; retry: boolean }, signal: AbortSignal): Promise<MarketingProductionResult> {
    if (p.taskId && (!request.retry || ["pending", "running", "succeeded"].includes(p.status))) {
      if (p.status === "pending") await this.queue.deliverPersisted(p.taskId, "marketing.video");
      return { project: p };
    }
    if (p.version !== request.version) throw new MarketingError("草稿已更新，请重新确认。", 409);
    if (p.taskId && !await this.queue.canResumePersisted(p.taskId)) throw new MarketingError("原任务正在收尾，请稍后继续。", 409);
    // Recovery keeps the frozen job's model and reference rules.
    const basis: JobBasis = p.taskId ? await this.stoppedJob(owner, p, p.taskId)
      : { draft: p.draft, profile: this.deps.activeProfile, inputVersion: MARKETING_INPUT_VERSION, segments: [] };
    const { draft, profile, inputVersion, segments, frozen } = basis;
    const needsSubmission = !frozen || segments.some(s => segmentRecoveryAction(s) === "submit");
    // Version 1 inputs predate reference checks.
    const referenceError = needsSubmission && inputVersion >= 2 ? marketingReferenceError(draft, profile) : "";
    if (referenceError) throw new MarketingError(referenceError);
    // New clips carry no text; their captions are burned in at composition.
    await this.checkComposition(frozen ? frozen.localSubtitles : true, draft, !!frozen);
    // A new video submits the still made for its current look, if any.
    const keyArt = frozen ? undefined : await this.deps.keyArtist.frozen(owner, p.id, draft, profile);
    const planned = this.checkedPlan(basis, !!keyArt);
    const billableSeconds = frozen ? submittedSeconds(segments) : planned.reduce((sum, s) => sum + s.durationSec, 0);
    const assets = await this.deps.materials.check(owner, draft, profile, inputVersion, needsSubmission, signal);
    // A new twin-narrated video needs a confirmed take for every shot; recovery keeps the frozen ones.
    const narration = !frozen && marketingVoiceover(p.draft) ? await this.deps.narrator.frozen(owner, p.id, p.draft, planned) : undefined;
    const quota = await this.quotaExceeded(owner, profile, billableSeconds);
    if (quota) return { quota };
    // reserve's recovery branch changes only status. Never rebuild the
    // frozen provider input, vendor IDs or segment billing identity.
    const input = frozen ? {} : newJobInput(p.draft, profile, assets, keyArt, narration);
    const taskId = await this.deps.store.reserve(owner, p.id, request.version, input, frozen ? true : request.retry);
    await this.deliver(taskId);
    return { project: await this.deps.store.get(owner, p.id) };
  }

  /** Redoes chosen shots of a stopped or finished video. The other shots keep their clips without
   * a model call or a charge; only the redone shots' seconds are billed. No shot means composing the
   * kept clips again with changed music, captions or narration. `started` begins the timing log.
   * A twin-narrated video whose changed shots need new takes starts them in the background and returns
   * `narration`: no paid request is held by the HTTP request, and the next try reuses every take. */
  async revise(owner: string, p: MarketingProject, request: { version: number; shots: number[] }, signal: AbortSignal,
    started = Date.now()): Promise<MarketingProductionResult> {
    // Stage times of this request, logged once at the end (P13: one acceptance run took 48.6 s).
    const stages: Record<string, number> = {};
    let last = started;
    const lap = (name: string) => { const now = Date.now(); stages[name] = now - last; last = now; };
    const redo = request.shots;
    if (!p.taskId || !p.revision) throw new MarketingError("当前视频不能单镜重做，请复制为新草稿。", 409);
    if (p.version !== request.version) throw new MarketingError("草稿已更新，请重新确认。", 409);
    if (!await this.queue.canResumePersisted(p.taskId)) throw new MarketingError("原任务正在收尾，请稍后继续。", 409);
    lap("queue");
    const original = await this.deps.service.db.getTask(p.taskId);
    const frozen = frozenInput(original?.input);
    if (!original || !frozen || original.user_id !== owner || original.type !== "marketing.video" || frozen.projectId !== p.id) throw new MarketingError("原任务不可恢复。", 409);
    // Kept clips come from this model, so redone shots use it too.
    const profile = marketingJobProfile(frozen);
    const localSubtitles = frozen.local_subtitles === true;
    let plan: MarketingSegment[];
    try {
      plan = resolveMarketingSegments(p.draft, profile);
      for (const slot of redo) {
        if (!plan[slot]) throw new Error("请重新选择需要重新生成的镜头。");
        marketingSegmentPrompt(p.draft, plan[slot], plan.length, frozen.generate_audio !== false, profile, localSubtitles, typeof frozen.key_art === "string");
      }
      if (localSubtitles && marketingCaptionErrors(p.draft).length) throw new Error(CAPTION_WORDS_CHANGED);
    } catch (error) { throw new MarketingError((error as Error).message); }
    const referenceError = marketingReferenceError(p.draft, profile);
    if (referenceError) throw new MarketingError(referenceError);
    lap("plan");
    const capabilities = await mediaCapabilities();
    lap("capabilities");
    if (!capabilities.composition) throw new MarketingError("视频合成工具不可用，请配置 FFmpeg 和 FFprobe。", 503);
    if (localSubtitles && p.draft.subtitles && !capabilities.subtitles) throw new MarketingError(SUBTITLES_UNAVAILABLE, 503);
    const kept = (await this.deps.store.segments(owner, p.id)).filter(s => !redo.includes(s.slot));
    await this.checkKeptClips(owner, kept, "片段素材不可用，请一并重新生成该镜头。", 409);
    await this.deps.materials.check(owner, p.draft, profile, Number(frozen.marketingInputVersion), true, signal);
    lap("materials");
    // Redone shots get the video's own key-art still, the same reference as the kept ones.
    if (typeof frozen.key_art === "string" && redo.length) {
      const still = await this.deps.service.db.getAsset(frozen.key_art);
      if (!still || still.user_id !== owner) throw new MarketingError("该视频的定妆图已不可用，请复制为新草稿后重新制作。", 409);
    }
    const quota = await this.quotaExceeded(owner, profile, redo.reduce((sum, slot) => sum + plan[slot].durationSec, 0));
    if (quota) return { quota };
    lap("quota");
    // Twin-narrated videos: a changed shot gets its new take (one speech request each); the kept
    // shots' text and voice settings are unchanged, so their takes are found as they are.
    let narration: FrozenNarration[] | undefined;
    if (frozen.narration !== undefined) {
      const { clips } = await this.deps.narrator.synthesize(owner, p.id, p.draft, plan, [], { background: true });
      lap("narration");
      if (clips.some(clip => clip.status === "running")) return { narration: clips };
      const failed = clips.find(clip => clip.status === "failed" && clip.error);
      if (failed) throw new MarketingError(failed.error!, 409);
      narration = await this.deps.narrator.frozen(owner, p.id, p.draft, plan);
    }
    const taskId = await this.deps.store.revise(owner, p.id, request.version, p.taskId, redo, narration ? { narration } : {});
    lap("save");
    await this.deliver(taskId);
    lap("deliver");
    console.log("[marketing-video] revise timing", { projectId: p.id, taskId, shots: redo.length, totalMs: Date.now() - started, stagesMs: stages });
    return { project: await this.deps.store.get(owner, p.id) };
  }

  /** The frozen input and clips of a stopped job that may continue, checked before anything is paid for. */
  private async stoppedJob(owner: string, p: MarketingProject, taskId: string): Promise<JobBasis> {
    const segments = await this.deps.store.segments(owner, p.id);
    const original = await this.deps.service.db.getTask(taskId);
    const frozen = frozenInput(original?.input);
    if (!original || !frozen || original.user_id !== owner || original.type !== "marketing.video" || frozen.projectId !== p.id
      || !["failed", "cancelled"].includes(original.status) || !segments.length) throw new MarketingError("原任务不可恢复。", 409);
    const draft = MarketingDraftSchema.parse(frozen.draft);
    let profile: MarketingVideoProfile;
    try { profile = marketingJobProfile(frozen); }
    catch (error) { throw new MarketingError((error as Error).message, 409); }
    const maxShot = marketingShotMaxSeconds(draft, profile);
    const durations = segments.map(s => Number(s.duration_sec));
    const badSegment = segments.some((s, i) => s.slot !== i || !Number.isInteger(durations[i]) || durations[i] < 4 || durations[i] > maxShot);
    const total = durations.reduce((sum, value) => sum + value, 0);
    if (segments.length > 15 || badSegment || !isMarketingDurationValid(draft.durationSec, total)) throw new MarketingError("视频分段配置不完整", 409);
    if (segments.some(s => segmentRecoveryAction(s) === "unknown")) throw new MarketingError(UNKNOWN_SUBMISSION_MESSAGE, 409);
    await this.checkKeptClips(owner, segments.filter(s => segmentRecoveryAction(s) === "reuse"), "片段素材不可用", 404);
    const inputVersion = typeof frozen.marketingInputVersion === "number" ? frozen.marketingInputVersion : 1;
    return { draft, profile, inputVersion, segments,
      frozen: { generateAudio: frozen.generate_audio !== false, localSubtitles: frozen.local_subtitles === true, keyArt: typeof frozen.key_art === "string" } };
  }

  /** A kept clip must still belong to the owner and to the segment task that made it; a clip kept
   * by a shot redo belongs to the earlier task named by `reusedFrom`. */
  private async checkKeptClips(owner: string, segments: SegmentRow[], message: string, status: 404 | 409) {
    for (const segment of segments) {
      for (const assetId of segment.output?.assetIds ?? []) {
        const asset = await this.deps.service.db.getAsset(assetId);
        if (!asset || asset.user_id !== owner || asset.task_id !== (segment.output.reusedFrom ?? segment.task_id)) throw new MarketingError(message, status);
      }
    }
  }

  /** The clips a submission will make, with every clip prompt checked against the model's limit. */
  private checkedPlan({ draft, profile, segments, frozen }: JobBasis, keyArt: boolean): MarketingSegment[] {
    try {
      if (frozen) {
        const planned = segments.map((segment, index) => ({ index, script: segment.script as string, durationSec: Number(segment.duration_sec) }));
        planned.forEach((segment, index) => {
          if (segmentRecoveryAction(segments[index]) === "submit") {
            marketingSegmentPrompt(draft, segment, segments.length, frozen.generateAudio, profile, frozen.localSubtitles, frozen.keyArt);
          }
        });
        return planned;
      }
      const planned = resolveMarketingSegments(draft, profile);
      planned.forEach(segment => marketingSegmentPrompt(draft, segment, planned.length, undefined, profile, true, keyArt));
      if (marketingCaptionErrors(draft).length) throw new Error(CAPTION_WORDS_CHANGED);
      return planned;
    } catch (error) { throw new MarketingError((error as Error).message); }
  }

  /** FFmpeg must compose here before any clip is paid for, and burn captions when the job needs them. */
  private async checkComposition(localSubtitles: boolean, draft: MarketingDraft, resumed: boolean) {
    const capabilities = await mediaCapabilities();
    if (!capabilities.composition) throw new MarketingError("视频合成工具不可用，请配置 FFmpeg 和 FFprobe。", 503);
    if (localSubtitles && draft.subtitles && !capabilities.subtitles) {
      throw new MarketingError(resumed ? SUBTITLES_UNAVAILABLE : "当前环境不支持字幕，可关闭字幕后生成。", 503);
    }
  }

  private async quotaExceeded(owner: string, profile: MarketingVideoProfile, billableSeconds: number) {
    if (billableSeconds <= 0) return null;
    const { service } = this.deps;
    const pricing = makePricingLookup((id) => service.modelRegistry.getConfig(id), service.modelCatalog, "video")(profile.modelId);
    const quota = await service.usageMeter.checkQuota(owner, pricing ? estimateCost(pricing, { outputCount: billableSeconds }) : 0);
    return quota.ok ? null : { error: quota.reason, code: quota.code };
  }

  private async deliver(taskId: string) {
    try { await this.queue.deliverPersisted(taskId, "marketing.video"); }
    catch { throw new MarketingError(QUEUE_UNAVAILABLE, 503); }
  }
}

const submittedSeconds = (segments: SegmentRow[]) =>
  segments.filter(s => segmentRecoveryAction(s) === "submit").reduce((sum, s) => sum + Number(s.duration_sec), 0);

/** Provider input of a new video, frozen with the job: the chosen images in submission order, then
 * the key-art still, so the numbers in the clip prompts never move. */
export function newJobInput(draft: MarketingDraft, profile: MarketingVideoProfile, assets: Record<string, OwnedMaterial>,
  keyArt?: { id: string; url: string }, narration?: FrozenNarration[]) {
  const { width, height } = marketingFrameSize(draft);
  const references = marketingImageReferences(draft).flatMap(({ assetId }) => assets[assetId] ? [assets[assetId].url] : []);
  return { marketingInputVersion: MARKETING_INPUT_VERSION, modelId: profile.modelId, quality: draft.quality, resolution: draft.quality, ratio: draft.ratio,
    size: `${width}x${height}`,
    input_reference: [...references, ...(keyArt ? [keyArt.url] : [])],
    ...(keyArt ? { key_art: keyArt.id } : {}),
    reference_video: assets.video ? [assets.video.url] : undefined,
    generate_audio: marketingNativeSpeech(draft),
    reference_audio: marketingNativeSpeech(draft) && assets.voice ? [assets.voice.url] : undefined,
    ...(narration ? { narration } : {}), local_subtitles: true,
    requireUserModelKey: process.env.DEBUG !== "1" };
}
