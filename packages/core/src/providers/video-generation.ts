import {
  HttpGenerationClient,
  MockGenerationClient,
  type CreateResult,
  type PollResult,
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
  media?: ReferenceMedia[];
}

export interface VideoGenerationProvider {
  create(req: VideoGenerationRequest): Promise<CreateResult>;
  poll(taskId: string): Promise<PollResult>;
}

export type VideoVendorAdapter = VendorAdapter<VideoGenerationRequest>;

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
    return {
      status: String(j.status ?? ""),
      progress: Number(j.progress ?? 0),
      url: typeof meta.url === "string" ? meta.url : undefined,
      error: typeof j.error === "string" ? j.error : undefined,
    };
  }
  isTerminal(status: string): "completed" | "failed" | null {
    if (status === "completed") return "completed";
    if (status === "failed") return "failed";
    return null;
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
};
export function pickVideoAdapter(name: string): VideoVendorAdapter {
  return (VIDEO_ADAPTERS[name] ?? VIDEO_ADAPTERS.happyhorse)();
}
