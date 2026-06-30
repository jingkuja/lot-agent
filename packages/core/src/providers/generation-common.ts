import { randomUUID } from "node:crypto";
import { placeholderSvgDataUrl } from "./placeholder.js";

/**
 * Shared types + protocol mechanics for the **independent** image and video
 * generation providers. The public surface is split per media type
 * (`ImageGenerationProvider` / `VideoGenerationProvider`, each with its own
 * request shape and no `mediaType` parameter); this module only holds the
 * vendor-agnostic plumbing both reuse so the two can later diverge onto
 * different real vendors (通义万相 for image, 可灵 for video) without coupling.
 */

export type MediaType = "image" | "video";
export interface ReferenceMedia { type: "reference_image"; url: string }
export interface CreateResult { taskId: string; status: string; progress: number }
export interface PollResult { status: string; progress: number; url?: string; error?: string }

export function parseSize(size?: string): [number, number] {
  const m = /^(\d+)x(\d+)$/.exec(size ?? "");
  return m ? [Number(m[1]), Number(m[2])] : [1024, 1024];
}

/** Vendor adapter shape; `Req` is the media-specific request type. */
export interface VendorAdapter<Req> {
  createPath(): string;
  pollPath(taskId: string): string;
  buildCreateBody(req: Req, model: string): unknown;
  parseCreate(json: unknown): CreateResult;
  parsePoll(json: unknown): PollResult;
  isTerminal(status: string): "completed" | "failed" | null;
}

export interface HttpGenerationOpts<Req> {
  baseUrl: string;
  apiKey: string;
  adapter: VendorAdapter<Req>;
  model: string;
}

/** Drives any `VendorAdapter<Req>` over HTTP (async create→poll). */
export class HttpGenerationClient<Req extends { model?: string }> {
  constructor(protected opts: HttpGenerationOpts<Req>) {}
  async create(req: Req): Promise<CreateResult> {
    const { adapter, baseUrl, apiKey } = this.opts;
    const model = req.model ?? this.opts.model;
    const res = await fetch(`${baseUrl}${adapter.createPath()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(adapter.buildCreateBody(req, model)),
    });
    if (!res.ok) throw new Error(`generation create failed: ${res.status} ${await res.text()}`);
    return adapter.parseCreate(await res.json());
  }
  async poll(taskId: string): Promise<PollResult> {
    const { adapter, baseUrl, apiKey } = this.opts;
    const res = await fetch(`${baseUrl}${adapter.pollPath(taskId)}`, {
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
/** In-memory async simulation with a progress ramp (no network / cost). */
export class MockGenerationClient<Req extends { prompt: string; size?: string }> {
  private tasks = new Map<string, { createdAt: number; req: Req }>();
  constructor(
    private kind: MediaType,
    private durationMs: number = MOCK_DURATION_MS,
    private now: () => number = () => Date.now()
  ) {}
  async create(req: Req): Promise<CreateResult> {
    const taskId = `mock_${randomUUID()}`;
    this.tasks.set(taskId, { createdAt: this.now(), req });
    return { taskId, status: "queued", progress: 0 };
  }
  async poll(taskId: string): Promise<PollResult> {
    const t = this.tasks.get(taskId);
    if (!t) return { status: "failed", progress: 0, error: "unknown mock task" };
    const elapsed = this.now() - t.createdAt;
    const pct = this.durationMs <= 0 ? 100 : Math.min(100, Math.round((elapsed / this.durationMs) * 100));
    if (/fail/i.test(t.req.prompt) && pct >= 50) {
      return { status: "failed", progress: pct, error: "mock failure (prompt contains 'fail')" };
    }
    if (pct >= 100) {
      const [w, h] = parseSize(t.req.size);
      return { status: "completed", progress: 100, url: placeholderSvgDataUrl({ prompt: t.req.prompt, width: w, height: h, kind: this.kind }) };
    }
    return { status: "processing", progress: pct };
  }
}
