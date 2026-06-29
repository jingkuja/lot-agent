import { randomUUID } from "node:crypto";
import { placeholderSvgDataUrl } from "./placeholder.js";

export type MediaType = "image" | "video";
export interface ReferenceMedia { type: "reference_image"; url: string }
export interface GenerationRequest {
  mediaType: MediaType;
  prompt: string;
  model?: string;
  size?: string;
  n?: number;
  durationSec?: number;
  ratio?: string;
  quality?: string;
  media?: ReferenceMedia[];
}
export interface CreateResult { taskId: string; status: string; progress: number }
export interface PollResult { status: string; progress: number; url?: string; error?: string }
export interface GenerationProvider {
  create(req: GenerationRequest): Promise<CreateResult>;
  poll(taskId: string, mediaType: MediaType): Promise<PollResult>;
}
export interface VendorAdapter {
  createPath(mediaType: MediaType): string;
  pollPath(mediaType: MediaType, taskId: string): string;
  buildCreateBody(req: GenerationRequest, model: string): unknown;
  parseCreate(json: unknown): CreateResult;
  parsePoll(json: unknown): PollResult;
  isTerminal(status: string): "completed" | "failed" | null;
}

function parseSize(size?: string): [number, number] {
  const m = /^(\d+)x(\d+)$/.exec(size ?? "");
  return m ? [Number(m[1]), Number(m[2])] : [1024, 1024];
}

/** First vendor: tokenhub "happyhorse" async create→poll format. */
export class HappyhorseAdapter implements VendorAdapter {
  createPath(mediaType: MediaType): string {
    return `/${mediaType}/generation`;
  }
  pollPath(mediaType: MediaType, taskId: string): string {
    return `/${mediaType === "image" ? "images" : "videos"}/${taskId}`;
  }
  buildCreateBody(req: GenerationRequest, model: string): unknown {
    const body: Record<string, unknown> = { model, prompt: req.prompt };
    if (req.size) body.size = req.size;
    if (req.durationSec != null) body.duration = req.durationSec;
    if (req.ratio) body.ratio = req.ratio;
    if (req.media && req.media.length > 0) body.media = req.media;
    // `n` and `quality` are part of GenerationRequest but not sent — the Happyhorse API does not accept them.
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

/** Template: drives any VendorAdapter over HTTP. */
export class HttpGenerationProvider implements GenerationProvider {
  constructor(
    private opts: { baseUrl: string; apiKey: string; adapter: VendorAdapter; imageModel: string; videoModel: string }
  ) {}
  private model(mediaType: MediaType): string {
    return mediaType === "image" ? this.opts.imageModel : this.opts.videoModel;
  }
  async create(req: GenerationRequest): Promise<CreateResult> {
    const { adapter, baseUrl, apiKey } = this.opts;
    const model = req.model ?? this.model(req.mediaType);
    const res = await fetch(`${baseUrl}${adapter.createPath(req.mediaType)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(adapter.buildCreateBody(req, model)),
    });
    if (!res.ok) throw new Error(`generation create failed: ${res.status} ${await res.text()}`);
    return adapter.parseCreate(await res.json());
  }
  async poll(taskId: string, mediaType: MediaType): Promise<PollResult> {
    const { adapter, baseUrl, apiKey } = this.opts;
    const res = await fetch(`${baseUrl}${adapter.pollPath(mediaType, taskId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`generation poll failed: ${res.status} ${await res.text()}`);
    const parsed = adapter.parsePoll(await res.json());
    const term = adapter.isTerminal(parsed.status);
    return { ...parsed, status: term ?? "running" };
  }
}

const MOCK_DURATION_MS = 3500;
/** Mock: in-memory async simulation with a progress ramp (no network / cost). */
export class MockGenerationProvider implements GenerationProvider {
  private tasks = new Map<string, { createdAt: number; req: GenerationRequest }>();
  constructor(private durationMs: number = MOCK_DURATION_MS, private now: () => number = () => Date.now()) {}
  async create(req: GenerationRequest): Promise<CreateResult> {
    const taskId = `mock_${randomUUID()}`;
    this.tasks.set(taskId, { createdAt: this.now(), req });
    return { taskId, status: "queued", progress: 0 };
  }
  async poll(taskId: string, mediaType: MediaType): Promise<PollResult> {
    const t = this.tasks.get(taskId);
    if (!t) return { status: "failed", progress: 0, error: "unknown mock task" };
    const elapsed = this.now() - t.createdAt;
    const pct = this.durationMs <= 0 ? 100 : Math.min(100, Math.round((elapsed / this.durationMs) * 100));
    if (/fail/i.test(t.req.prompt) && pct >= 50) {
      return { status: "failed", progress: pct, error: "mock failure (prompt contains 'fail')" };
    }
    if (pct >= 100) {
      const [w, h] = parseSize(t.req.size);
      return { status: "completed", progress: 100, url: placeholderSvgDataUrl({ prompt: t.req.prompt, width: w, height: h, kind: mediaType }) };
    }
    return { status: "processing", progress: pct };
  }
}

export const ADAPTERS: Record<string, () => VendorAdapter> = {
  happyhorse: () => new HappyhorseAdapter(),
};
export function pickAdapter(name: string): VendorAdapter {
  return (ADAPTERS[name] ?? ADAPTERS.happyhorse)();
}
