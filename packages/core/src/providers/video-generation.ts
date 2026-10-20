import {
  HttpGenerationClient,
  MockGenerationClient,
  extractVendorError,
  type CreateResult,
  type PollResult,
  type ReferenceInput,
  type ReferenceMedia,
  type VendorAdapter,
} from "./generation-common.js";

/** Video generation request. Independent from image — carries duration/ratio. */
export interface VideoGenerationRequest {
  prompt: string;
  model?: string;
  size?: string;
  /** Explicit output tier, forwarded as TokenHub metadata for generation and billing. */
  resolution?: string;
  durationSec?: number;
  ratio?: string;
  quality?: string;
  /** Whether the generated video should contain audio. Reference audio always enables this. */
  generate_audio?: boolean;
  /** Reference images for the OpenAI-compatible `/videos` endpoint. */
  input_reference?: ReferenceInput;
  /** Reference videos for the OpenAI-compatible `/videos` endpoint. */
  reference_video?: ReferenceInput;
  /** Reference audio URLs, or prepared Kling voice IDs, for `/videos`. */
  reference_audio?: ReferenceInput;
  first_frame?: string;
  last_frame?: string;
  media?: ReferenceMedia[];
}

export interface VideoGenerationProvider {
  create(req: VideoGenerationRequest): Promise<CreateResult>;
  poll(taskId: string): Promise<PollResult>;
}

export type VideoVendorAdapter = VendorAdapter<VideoGenerationRequest>;

/** Seedance requires these when a reference video is present. */
export const SEEDANCE_REFERENCE_VIDEO_DURATION = -1;
export const SEEDANCE_REFERENCE_VIDEO_RATIO = "adaptive";

export function isSeedanceModel(model: string): boolean {
  return model.toLowerCase().includes("seedance");
}

/** xAI Grok Imagine 1.5, shown as spacebunny. The gateway adapts the shared `/videos` request. */
export const GROK_VIDEO_MODEL = "grok-imagine-video-1.5";
/** Reference images or a reference video limit Grok output to 720p. */
export const GROK_REFERENCE_MAX_EDGE = 720;
export const GROK_MAX_REFERENCE_VIDEOS = 1;
export const GROK_MAX_REFERENCE_AUDIOS = 3;
/** Grok fails reference-video requests longer than 8 seconds. */
export const GROK_REFERENCE_VIDEO_MAX_SECONDS = 8;

export function isGrokVideoModel(model: string | null | undefined): boolean {
  return (model ?? "").trim().toLowerCase() === GROK_VIDEO_MODEL;
}

/** Short edge of a tier such as `720p`, `2k`, `4k` or a `WxH` size. */
export function videoTierEdge(value: string | null | undefined): number | undefined {
  const text = (value ?? "").trim().toLowerCase();
  const size = /^(\d+)x(\d+)$/.exec(text);
  if (size) return Math.min(Number(size[1]), Number(size[2]));
  const tier = /^(\d+)p$/.exec(text);
  if (tier) return Number(tier[1]);
  return text === "2k" ? 1440 : text === "4k" ? 2160 : undefined;
}

export interface GrokVideoInputSummary {
  images: number;
  videos: number;
  audios: number;
  firstFrame: boolean;
  lastFrame: boolean;
  /** Requested tiers / sizes; the largest short edge is checked. */
  resolutions: (string | undefined)[];
  durationSec?: number;
}

/** A reference video replaces every other reference, and references cap output at 720p. */
export function grokVideoInputIssue(input: GrokVideoInputSummary): string | undefined {
  if (input.videos > GROK_MAX_REFERENCE_VIDEOS) return "spacebunny 模型最多添加 1 段参考视频";
  if (input.audios > GROK_MAX_REFERENCE_AUDIOS) return "spacebunny 模型最多添加 3 段参考音频";
  if (input.videos && (input.images || input.audios || input.firstFrame || input.lastFrame)) {
    return "spacebunny 模型使用参考视频时不会使用参考图、首尾帧和参考音频，请移除后再生成";
  }
  if (input.videos && input.durationSec != null && input.durationSec > GROK_REFERENCE_VIDEO_MAX_SECONDS) {
    return "spacebunny 模型使用参考视频时单次最长 8 秒，请缩短视频时长";
  }
  const edge = Math.max(0, ...input.resolutions.map((value) => videoTierEdge(value) ?? 0));
  if ((input.images || input.videos) && edge > GROK_REFERENCE_MAX_EDGE) {
    return "spacebunny 模型使用参考图或参考视频时最高支持 720p，请调低清晰度";
  }
  return undefined;
}

function hasReferenceVideo(value: ReferenceInput | undefined): boolean {
  if (value == null) return false;
  return Array.isArray(value) ? value.length > 0 : value.length > 0;
}

function hasReferenceAudio(value: ReferenceInput | undefined): boolean {
  if (value == null) return false;
  return Array.isArray(value) ? value.length > 0 : value.trim().length > 0;
}

function resolveGenerateAudio(req: VideoGenerationRequest): boolean {
  return hasReferenceAudio(req.reference_audio) || req.generate_audio === true;
}

/** Seedance + 参考视频：时长/比例必须跟参考视频走，不能由调用方指定。 */
export function usesSeedanceReferenceVideoAdaptive(
  model: string,
  referenceVideo: ReferenceInput | undefined
): boolean {
  return isSeedanceModel(model) && hasReferenceVideo(referenceVideo);
}

/** Kling's gateway rejects reference_audio even when its value is a voice ID. */
function applyAudioReference(body: Record<string, unknown>, req: VideoGenerationRequest, model: string): void {
  if (!hasReferenceAudio(req.reference_audio)) return;
  if (!/kling/i.test(model)) {
    body.reference_audio = req.reference_audio;
    return;
  }
  const voices = typeof req.reference_audio === "string" ? [req.reference_audio] : req.reference_audio!;
  if (voices.length > 2 || voices.some((id) => !id.trim() || /[:/\\]/.test(id))) {
    throw new Error("Kling 参考声音必须先创建音色并取得 voice_id。");
  }
  const metadata = (body.metadata ?? {}) as Record<string, unknown>;
  body.metadata = { ...metadata, ...(voices.length === 1 ? { voice_id: voices[0] } : { voice_ids: voices }) };
}

/** tokenhub "happyhorse" async create→poll format, video endpoints. */
export class HappyhorseVideoAdapter implements VideoVendorAdapter {
  // Create is plural ("/video/generations"); poll is also plural
  // ("/videos/{id}"). Verified against the live tokenhub API.
  createPath(): string {
    return "/video/generations";
  }
  pollPath(taskId: string): string {
    return `/videos/${taskId}`;
  }
  buildCreateBody(req: VideoGenerationRequest, model: string): unknown {
    const body: Record<string, unknown> = { model, prompt: req.prompt };
    body.generate_audio = resolveGenerateAudio(req);
    // TokenHub reads resolution from metadata, not a top-level resolution or quality.
    if (req.resolution) body.metadata = { resolution: req.resolution };
    if (req.size) body.size = req.size;
    if (req.durationSec != null) body.duration = req.durationSec;
    if (req.ratio) body.ratio = req.ratio;
    if (req.input_reference) body.input_reference = req.input_reference;
    if (req.reference_video) body.reference_video = req.reference_video;
    applyAudioReference(body, req, model);
    if (req.first_frame) body.first_frame = req.first_frame;
    if (req.last_frame) body.last_frame = req.last_frame;
    if (req.media && req.media.length > 0) body.media = req.media;
    // `quality` is part of the request but not sent — the Happyhorse API does not accept it.
    return body;
  }
  parseCreate(json: unknown): CreateResult {
    const j = (json ?? {}) as Record<string, unknown>;
    return {
      taskId: String(j.task_id ?? j.id ?? ""),
      status: String(j.status ?? "queued"),
      progress: Number(j.progress ?? 0),
    };
  }
  parsePoll(json: unknown): PollResult {
    const j = (json ?? {}) as Record<string, unknown>;
    const meta = (j.metadata ?? {}) as Record<string, unknown>;
    const status = String(j.status ?? "");
    const vendorErr = extractVendorError(j);
    // A statusless body is a vendor error envelope (HTTP 200 with { code,
    // message }) — surface it as a failure with the real message rather than an
    // empty status that would be read as "still running".
    if (!status) {
      return { status: "failed", progress: 0, failureUnconfirmed: true, error: vendorErr ?? "generation poll returned no status" };
    }
    return {
      status,
      progress: Number(j.progress ?? 0),
      url: typeof meta.url === "string" ? meta.url : undefined,
      error: vendorErr,
    };
  }
  isTerminal(status: string): "completed" | "failed" | null {
    if (status === "completed") return "completed";
    if (status === "failed") return "failed";
    return null;
  }
}

/**
 * tokenhub OpenAI-compatible video format: `POST /videos` create, `GET
 * /videos/{id}` poll. The create body uses `seconds` (a string) + `size` where
 * happyhorse used `duration`; `ratio` remains a tokenhub extension and must be
 * explicit for providers such as Kling when a feature video is referenced.
 * Seedance with a reference video instead sends `duration: -1` and
 * `ratio: "adaptive"`. The async task
 * envelope (`id` with a legacy `task_id` alias, status/progress, and
 * `metadata.url` on completion) and error handling are identical, so only the
 * create path + body diverge — everything else is reused.
 */
export class OpenaiVideoAdapter extends HappyhorseVideoAdapter {
  override createPath(): string {
    return "/videos";
  }
  override buildCreateBody(req: VideoGenerationRequest, model: string): unknown {
    const body: Record<string, unknown> = { model, prompt: req.prompt };
    body.generate_audio = resolveGenerateAudio(req);
    // TokenHub reads resolution from metadata, not a top-level resolution or quality.
    if (req.resolution) body.metadata = { resolution: req.resolution };
    if (usesSeedanceReferenceVideoAdaptive(model, req.reference_video)) {
      // Seedance rejects a caller-chosen duration/ratio when a reference
      // video is present — the output must match the reference clip.
      body.duration = SEEDANCE_REFERENCE_VIDEO_DURATION;
      body.ratio = SEEDANCE_REFERENCE_VIDEO_RATIO;
    } else if (req.durationSec != null) {
      body.seconds = String(req.durationSec);
    }
    if (!usesSeedanceReferenceVideoAdaptive(model, req.reference_video) && req.ratio) {
      body.ratio = req.ratio;
    }
    if (req.size) body.size = req.size;
    if (req.quality) body.quality = req.quality;
    // The OpenAI-compatible endpoint uses dedicated reference fields instead
    // of Happyhorse's `media` array. Keep the value shape (string|string[]) so
    // callers can send up to the vendor-supported number of references.
    if (req.input_reference) {
      body.input_reference = req.input_reference;
    } else {
      // Backwards compatibility for jobs created before the dedicated fields
      // were introduced.
      const refs = req.media?.filter((m) => m.type === "reference_image").map((m) => m.url) ?? [];
      if (refs.length) body.input_reference = refs.length === 1 ? refs[0] : refs;
    }
    if (req.reference_video) body.reference_video = req.reference_video;
    applyAudioReference(body, req, model);
    if (req.first_frame) body.first_frame = req.first_frame;
    if (req.last_frame) body.last_frame = req.last_frame;
    return body;
  }
  override parseCreate(json: unknown): CreateResult {
    const j = (json ?? {}) as Record<string, unknown>;
    return {
      // OpenAI Videos uses `id`; New API also returns the historical
      // `task_id` alias. Prefer the standard field while accepting both so the
      // same client works across gateway versions.
      taskId: typeof j.id === "string" ? j.id : typeof j.task_id === "string" ? j.task_id : "",
      status: String(j.status ?? "queued"),
      progress: Number(j.progress ?? 0),
    };
  }
}

export class HttpVideoGenerationProvider
  extends HttpGenerationClient<VideoGenerationRequest>
  implements VideoGenerationProvider {}

export class MockVideoGenerationProvider
  extends MockGenerationClient<VideoGenerationRequest>
  implements VideoGenerationProvider
{
  constructor(durationMs?: number, now?: () => number) {
    super("video", durationMs, now);
  }
}

export const VIDEO_ADAPTERS: Record<string, () => VideoVendorAdapter> = {
  happyhorse: () => new HappyhorseVideoAdapter(),
  "openai-video": () => new OpenaiVideoAdapter(),
};
export function pickVideoAdapter(name: string): VideoVendorAdapter {
  return (VIDEO_ADAPTERS[name] ?? VIDEO_ADAPTERS.happyhorse)();
}
