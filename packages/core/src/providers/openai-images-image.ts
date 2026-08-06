import { randomUUID } from "node:crypto";
import type { CreateResult, PollResult } from "./generation-common.js";
import type { ImageGenerationProvider, ImageGenerationRequest } from "./image-generation.js";

/**
 * Turn Tokenhub's synchronous Images API response into sources understood by
 * the generation worker. `url` values are downloaded as-is; `b64_json` values
 * become data URLs, which the worker already decodes and stores locally.
 */
export function extractImageUrls(response: unknown): string[] {
  if (!response || typeof response !== "object") return [];
  const data = (response as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const urls: string[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const { url, b64_json: b64Json } = item as { url?: unknown; b64_json?: unknown };
    if (typeof url === "string" && url.trim()) {
      urls.push(url.trim());
      continue;
    }
    if (typeof b64Json === "string" && b64Json.trim()) {
      const value = b64Json.trim();
      // `b64_json` is raw Base64 in the Images API. Accept a pre-wrapped data
      // URL too, making this tolerant of compatible gateways that return one.
      urls.push(value.startsWith("data:") ? value : `data:image/png;base64,${value}`);
    }
  }
  return urls;
}

export interface OpenAIImagesImageOpts {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Tokenhub generates its highest standard image resolution with a 1024px
 * longest edge. Keep the requested aspect ratio, but downscale stale clients'
 * former 2048px+ presets before the request leaves the server. */
export function normalizeImageSize(size?: string): string {
  const matched = /^(\d+)x(\d+)$/.exec(size ?? "");
  if (!matched) return "1024x1024";
  const width = Number(matched[1]);
  const height = Number(matched[2]);
  const longest = Math.max(width, height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return "1024x1024";
  }
  if (longest <= 1024) return `${width}x${height}`;
  const scale = 1024 / longest;
  return `${Math.max(1, Math.round(width * scale))}x${Math.max(1, Math.round(height * scale))}`;
}

/**
 * Synchronous provider for Tokenhub's OpenAI-compatible Images API. Text-only
 * requests use `/images/generations`; requests with reference images use
 * `/images/edits`. It adapts the completed response to the worker's existing
 * create/poll contract using an in-memory synthetic task id.
 */
export class OpenAIImagesImageProvider implements ImageGenerationProvider {
  private results = new Map<string, string[]>();
  constructor(private opts: OpenAIImagesImageOpts) {}

  async create(req: ImageGenerationRequest): Promise<CreateResult> {
    const model = req.model ?? this.opts.model;
    const hasReferences = Boolean(req.media?.length);
    if (hasReferences && req.media!.length !== 1) {
      throw new Error("image editing supports exactly one reference image");
    }
    const body: Record<string, unknown> = hasReferences
      ? {
          model,
          // Tokenhub's edit endpoint accepts one Base64 data URL in the
          // singular `image` field (not OpenAI's usual `images` objects).
          image: req.media![0].url,
          prompt: req.prompt,
        }
      : { model, prompt: req.prompt };
    body.size = normalizeImageSize(req.size);
    if (req.n != null) body.n = req.n;
    if (req.quality) body.quality = req.quality;

    const endpoint = hasReferences ? "/images/edits" : "/images/generations";
    const res = await fetch(`${this.opts.baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`image generation failed: ${res.status} ${text}`);

    let response: unknown;
    try {
      response = JSON.parse(text);
    } catch {
      throw new Error("image generation failed: response is not JSON");
    }
    const urls = extractImageUrls(response);
    if (!urls.length) throw new Error("image generation failed: no image url or b64_json in response");

    const taskId = `images_${randomUUID()}`;
    this.results.set(taskId, urls);
    return { taskId, status: "completed", progress: 100 };
  }

  async poll(taskId: string): Promise<PollResult> {
    const urls = this.results.get(taskId);
    if (!urls?.length) return { status: "failed", progress: 0, error: "unknown task" };
    return { status: "completed", progress: 100, url: urls[0], urls };
  }
}
