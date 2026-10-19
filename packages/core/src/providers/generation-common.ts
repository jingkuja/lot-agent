import { ProviderError, type ProviderPhase } from "./provider-error.js";
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
export interface ReferenceMedia {
  type: "reference_image" | "reference_video" | "reference_audio";
  url: string;
}

/** A vendor reference may be a URL or provider asset ID, singly or as a list. */
export type ReferenceInput = string | string[];
export interface CreateResult { taskId: string; status: string; progress: number }
export interface PollResult {
  status: string;
  progress: number;
  /** First (or only) artifact URL — compat position for single-output callers. */
  url?: string;
  /** All artifact URLs when the request produced multiple (image `n > 1`). */
  urls?: string[];
  error?: string;
  /** A lookup error is not proof that a paid vendor task actually failed. */
  failureUnconfirmed?: boolean;
}

export function parseSize(size?: string): [number, number] {
  const m = /^(\d+)[x*](\d+)$/.exec(size ?? "");
  return m ? [Number(m[1]), Number(m[2])] : [1024, 1024];
}

// Volcengine Ark rejects references showing real people until the account
// completes real-person verification; tokenhub may mask the code prefix.
const REAL_PERSON_REJECTION = /\.PrivacyInformation\b|may contain (?:a )?real person/i;

/** Classify a real-person rejection at any envelope depth without copying its text. */
export function isRealPersonRejection(body: unknown): boolean {
  try { return REAL_PERSON_REJECTION.test(typeof body === "string" ? body : JSON.stringify(body) ?? ""); }
  catch { return false; }
}

/** Detect an error envelope without copying any free-form vendor text. */
export function extractVendorError(j: Record<string, unknown>, phase: ProviderPhase = "poll"): string | undefined {
  if (j.error || j.message || (j.code && j.code !== 0)) {
    return new ProviderError("generation", phase, isRealPersonRejection(j) ? "REAL_PERSON_REJECTED" : "TASK_FAILED").message;
  }
  return undefined;
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
  /** Per-request timeout. Default: 2 minutes. */
  timeoutMs?: number;
}

/** Default per-request timeout for generation HTTP calls (2 minutes). */
const DEFAULT_TIMEOUT_MS = 120_000;

// Errors raised while resolving or connecting, before the request is written.
// Resets, socket closes and timeouts are excluded: the vendor may have
// accepted the POST, so callers must keep treating them as unknown.
const CONNECT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"]);
/** True only when fetch failed to connect (including every address of a multi-address lookup). */
export function failedBeforeSend(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown; errors?: { code?: unknown }[] } } | undefined)?.cause;
  if (!(error instanceof TypeError) || !cause || !CONNECT_CODES.has(String(cause.code))) return false;
  return !Array.isArray(cause.errors) || cause.errors.every(item => CONNECT_CODES.has(String(item?.code)));
}

/** Drives any `VendorAdapter<Req>` over HTTP (async create→poll). */
export class HttpGenerationClient<Req extends { model?: string }> {
  constructor(protected opts: HttpGenerationOpts<Req>) {}

  /**
   * fetch with a per-request timeout (AbortSignal), retrying only the network
   * layer. `retries` is the number of *extra* attempts (poll passes 1 because a
   * poll is an idempotent read; create passes 0 because it isn't). HTTP error
   * responses are returned as-is for the caller to classify — only a thrown
   * fetch (network failure / timeout) is retried.
   */
  private async request(url: string, init: RequestInit, retries: number, phase: ProviderPhase): Promise<Response> {
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        if (attempt >= retries) throw new ProviderError("generation", phase, phase === "create" && failedBeforeSend(e) ? "CONNECT_ERROR" : "TRANSPORT_ERROR");
      }
    }
  }

  async create(req: Req): Promise<CreateResult> {
    const { adapter, baseUrl, apiKey } = this.opts;
    const model = req.model ?? this.opts.model;
    const url = `${baseUrl}${adapter.createPath()}`;
    const body = adapter.buildCreateBody(req, model);
    console.log("[generation.create] request", { method: "POST" });
    const res = await this.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    }, 0, "create");
    console.log("[generation.create] response", { status: res.status });
    const text = await res.text();
    const realPerson = isRealPersonRejection(text);
    let json: Record<string, unknown>;
    try { json = JSON.parse(text); }
    catch { throw new ProviderError("generation", "create", realPerson ? "REAL_PERSON_REJECTED" : res.ok ? "INVALID_RESPONSE" : "HTTP_ERROR", { httpStatus: res.status }); }
    const details = { httpStatus: res.status, requestId: json?.request_id, privateValues: [apiKey] };
    if (!res.ok) throw new ProviderError("generation", "create", realPerson ? "REAL_PERSON_REJECTED" : "HTTP_ERROR", details);
    let created: CreateResult;
    try { created = adapter.parseCreate(json); }
    catch { throw new ProviderError("generation", "create", "INVALID_RESPONSE", details); }
    if (!created.taskId) throw new ProviderError("generation", "create", realPerson ? "REAL_PERSON_REJECTED" : "INVALID_RESPONSE", details);
    return created;
  }
  async poll(taskId: string): Promise<PollResult> {
    const { adapter, baseUrl, apiKey } = this.opts;
    const res = await this.request(`${baseUrl}${adapter.pollPath(taskId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    }, 1, "poll");
    let json: Record<string, unknown>;
    try {
      const value: unknown = await res.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      json = value as Record<string, unknown>;
    }
    catch { throw new ProviderError("generation", "poll", res.ok ? "INVALID_RESPONSE" : "HTTP_ERROR", { httpStatus: res.status }); }
    const details = { httpStatus: res.status, requestId: json?.request_id, privateValues: [apiKey] };
    // The vendor explicitly rejected the input, so the failure is confirmed.
    const realPersonFailure = (): PollResult =>
      ({ status: "failed", progress: 0, error: new ProviderError("generation", "poll", "REAL_PERSON_REJECTED", details).message });
    if (!res.ok) {
      if (isRealPersonRejection(json)) return realPersonFailure();
      throw new ProviderError("generation", "poll", "HTTP_ERROR", details);
    }
    let result: PollResult;
    try { result = adapter.parsePoll(json); }
    catch { throw new ProviderError("generation", "poll", "INVALID_RESPONSE", details); }
    if ((result.error || adapter.isTerminal(result.status) === "failed") && isRealPersonRejection(json)) return realPersonFailure();
    const parsed = { ...result, ...(result.error || adapter.isTerminal(result.status) === "failed"
      ? { error: new ProviderError("generation", "poll", result.failureUnconfirmed ? "INVALID_RESPONSE" : "TASK_FAILED", details).message } : {}) };
    const term = adapter.isTerminal(parsed.status);
    if (term) return { ...parsed, status: term };
    // A missing status is a malformed/error response the adapter couldn't
    // classify (e.g. a vendor error envelope served with HTTP 200) — treat it as
    // a failure so the caller stops polling, instead of optimistically coercing
    // it to "running", which would loop until the job's max-wait timeout.
    if (!parsed.status) {
      return { ...parsed, status: "failed", failureUnconfirmed: true, error: new ProviderError("generation", "poll", "INVALID_RESPONSE", details).message };
    }
    return { ...parsed, status: "running" };
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
      const url = placeholderSvgDataUrl({ prompt: t.req.prompt, width: w, height: h, kind: this.kind });
      return { status: "completed", progress: 100, url, urls: [url] };
    }
    return { status: "processing", progress: pct };
  }
}
