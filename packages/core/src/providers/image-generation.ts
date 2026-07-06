import {
  HttpGenerationClient,
  MockGenerationClient,
  extractVendorError,
  type CreateResult,
  type PollResult,
  type ReferenceMedia,
  type VendorAdapter,
} from "./generation-common.js";

/** Image generation request. Independent from video — no duration/ratio. */
export interface ImageGenerationRequest {
  prompt: string;
  model?: string;
  size?: string;
  n?: number;
  quality?: string;
  media?: ReferenceMedia[];
}

export interface ImageGenerationProvider {
  create(req: ImageGenerationRequest): Promise<CreateResult>;
  poll(taskId: string): Promise<PollResult>;
}

export type ImageVendorAdapter = VendorAdapter<ImageGenerationRequest>;

/** tokenhub "happyhorse" async create→poll format, image endpoints. */
export class HappyhorseImageAdapter implements ImageVendorAdapter {
  // Create is plural ("/image/generations"); poll is also plural
  // ("/images/{id}"). Verified against the live tokenhub API.
  createPath(): string {
    return "/image/generations";
  }
  pollPath(taskId: string): string {
    return `/images/${taskId}`;
  }
  buildCreateBody(req: ImageGenerationRequest, model: string): unknown {
    const body: Record<string, unknown> = { model, prompt: req.prompt };
    if (req.size) body.size = req.size;
    if (req.media && req.media.length > 0) body.media = req.media;
    // `n` and `quality` are part of the request but not sent — the Happyhorse API does not accept them.
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
    // n>1 returns a `urls` array; single output keeps only `url` (compat).
    const urls = Array.isArray(meta.urls)
      ? (meta.urls.filter((u) => typeof u === "string") as string[])
      : undefined;
    const url = urls?.[0] ?? (typeof meta.url === "string" ? meta.url : undefined);
    return {
      status,
      progress: Number(j.progress ?? 0),
      url,
      ...(urls && urls.length > 0 ? { urls } : {}),
      error: typeof j.error === "string" ? j.error : vendorErr,
    };
  }
  isTerminal(status: string): "completed" | "failed" | null {
    if (status === "completed") return "completed";
    if (status === "failed") return "failed";
    return null;
  }
}

export class HttpImageGenerationProvider
  extends HttpGenerationClient<ImageGenerationRequest>
  implements ImageGenerationProvider {}

export class MockImageGenerationProvider
  extends MockGenerationClient<ImageGenerationRequest>
  implements ImageGenerationProvider
{
  constructor(durationMs?: number, now?: () => number) {
    super("image", durationMs, now);
  }
}

export const IMAGE_ADAPTERS: Record<string, () => ImageVendorAdapter> = {
  happyhorse: () => new HappyhorseImageAdapter(),
};
export function pickImageAdapter(name: string): ImageVendorAdapter {
  return (IMAGE_ADAPTERS[name] ?? IMAGE_ADAPTERS.happyhorse)();
}
