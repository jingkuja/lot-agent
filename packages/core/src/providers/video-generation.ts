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
  durationSec?: number;
  ratio?: string;
  quality?: string;
  /** Reference images for the OpenAI-compatible `/videos` endpoint. */
  input_reference?: ReferenceInput;
  /** Reference videos for the OpenAI-compatible `/videos` endpoint. */
  reference_video?: ReferenceInput;
  /** Reference audio for the OpenAI-compatible `/videos` endpoint. */
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

function hasReferenceVideo(value: ReferenceInput | undefined): boolean {
  if (value == null) return false;
  return Array.isArray(value) ? value.length > 0 : value.length > 0;
}

/** Seedance + 参考视频：时长/比例必须跟参考视频走，不能由调用方指定。 */
export function usesSeedanceReferenceVideoAdaptive(
  model: string,
  referenceVideo: ReferenceInput | undefined
): boolean {
  return isSeedanceModel(model) && hasReferenceVideo(referenceVideo);
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
    if (req.size) body.size = req.size;
    if (req.durationSec != null) body.duration = req.durationSec;
    if (req.ratio) body.ratio = req.ratio;
    if (req.input_reference) body.input_reference = req.input_reference;
    if (req.reference_video) body.reference_video = req.reference_video;
    if (req.reference_audio) body.reference_audio = req.reference_audio;
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
      return { status: "failed", progress: 0, error: vendorErr ?? "generation poll returned no status" };
    }
    return {
      status,
      progress: Number(j.progress ?? 0),
      url: typeof meta.url === "string" ? meta.url : undefined,
      error: typeof j.error === "string" ? j.error : vendorErr,
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
 * happyhorse used `duration` + `ratio`, except Seedance with a reference video
 * which must send `duration: -1` and `ratio: "adaptive"`. The async task
 * envelope (task_id/status/progress, `metadata.url` on completion) and error
 * handling are identical, so only the create path + body diverge — everything
 * else is reused.
 */
export class OpenaiVideoAdapter extends HappyhorseVideoAdapter {
  override createPath(): string {
    return "/videos";
  }
  override buildCreateBody(req: VideoGenerationRequest, model: string): unknown {
    const body: Record<string, unknown> = { model, prompt: req.prompt };
    if (usesSeedanceReferenceVideoAdaptive(model, req.reference_video)) {
      // Seedance rejects a caller-chosen duration/ratio when a reference
      // video is present — the output must match the reference clip.
      body.duration = SEEDANCE_REFERENCE_VIDEO_DURATION;
      body.ratio = SEEDANCE_REFERENCE_VIDEO_RATIO;
    } else if (req.durationSec != null) {
      body.seconds = String(req.durationSec);
    }
    if (req.size) body.size = req.size;
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
    if (req.reference_audio) body.reference_audio = req.reference_audio;
    if (req.first_frame) body.first_frame = req.first_frame;
    if (req.last_frame) body.last_frame = req.last_frame;
    return body;
  }
  override parseCreate(json: unknown): CreateResult {
    const j = (json ?? {}) as Record<string, unknown>;
    return {
      // `/v1/videos` only accepts `task_id` as the pollable task identifier.
      // An id-only response is a malformed create result, not a success.
      taskId: typeof j.task_id === "string" ? j.task_id : "",
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
