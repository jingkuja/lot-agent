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

/**
 * Pull a human-readable error out of a vendor error envelope. tokenhub reports
 * failures as HTTP 200 with `{ code, message, data:null }` and no `status`
 * field; `message` is itself often a JSON-stringified nested error. Digs through
 * up to a few nested `error.message` / `message` layers to the innermost text,
 * falling back to `code`. Returns undefined for a normal (non-error) response.
 */
export function extractVendorError(j: Record<string, unknown>, privateValues: string[] = []): string | undefined {
  const nested = (j.error ?? {}) as Record<string, unknown>;
  let msg =
    (typeof j.message === "string" && j.message) ||
    (typeof nested.message === "string" && nested.message) ||
    undefined;
  if (typeof msg === "string") {
    // `message` is frequently a JSON string wrapping the real error — unwrap it.
    let cur = msg;
    for (let i = 0; i < 5; i++) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(cur) as Record<string, unknown>;
      } catch {
        break; // not JSON — `cur` is the leaf message
      }
      const inner = (parsed.error ?? {}) as Record<string, unknown>;
      const next =
        (typeof inner.message === "string" && inner.message) ||
        (typeof parsed.message === "string" && parsed.message) ||
        undefined;
      if (!next) break;
      cur = next;
    }
    msg = cur.trim();
  }
  const code = typeof j.code === "string" ? j.code : undefined;
  return safeErrorMessage(msg || code, privateValues);
}

/** Vendor errors may echo request material. Keep a bounded diagnostic, never a
 * response envelope, credential, URL, or an exact prompt supplied on create. */
function safeErrorMessage(message: string | undefined, privateValues: string[] = []): string | undefined {
  if (!message?.trim()) return undefined;
  let value = message.trim();
  if (/^[{\[]/.test(value) || /["']?(?:prompt|input_reference|reference_audio|reference_video)["']?\s*[:=]/i.test(value)) {
    return "供应商返回了包含私有内容的错误响应。";
  }
  for (const privateValue of privateValues.filter(Boolean).sort((a, b) => b.length - a.length)) value = value.split(privateValue).join("[内容已隐藏]");
  return value
    .replace(/(?:https?:\/\/|data:)[^\s<>"']+/gi, "[链接已隐藏]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [已隐藏]")
    .replace(/\b(?:material_token|api_key|authorization|token)\s*[:=]\s*[^\s,;]+/gi, "[凭证已隐藏]")
    .slice(0, 512);
}

function requestPrivateValues(body: unknown): string[] {
  const values: string[] = [];
  const visit = (value: unknown, privateField = false) => {
    if (typeof value === "string") { if (privateField) values.push(value); return; }
    if (Array.isArray(value)) { value.forEach(item => visit(item, privateField)); return; }
    if (value && typeof value === "object") {
      for (const [name, item] of Object.entries(value)) visit(item, privateField || /^(prompt|input_reference|reference_video|reference_audio|first_frame|last_frame|url)$/.test(name));
    }
  };
  visit(body);
  return values;
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

/**
 * Turn a non-2xx generation response into an Error carrying the cleanest message
 * available. tokenhub returns a structured error envelope even on 5xx (e.g. a
 * 500 whose body is `{ code:"fail_to_fetch_task", message:"…未订购…资费包" }`), so
 * dig the human-readable vendor message out of it instead of dumping raw JSON.
 */
async function responseError(res: { status: number; text(): Promise<string> }, ctx: string, privateValues: string[]): Promise<Error> {
  const body = await res.text();
  let vendorMsg: string | undefined;
  try {
    vendorMsg = extractVendorError(JSON.parse(body) as Record<string, unknown>, privateValues);
  } catch {
    // A non-JSON body can contain private material or an HTML error page.
  }
  return new Error(vendorMsg ?? `${ctx}: HTTP ${res.status}`);
}

/**
 * Build a create-failure Error with a safe vendor diagnostic. A create only succeeds when
 * the response yields a task id; every other outcome (non-2xx, non-JSON body, or
 * a 2xx envelope with no adapter-recognized task id) routes here.
 */
function createFailError(status: number, bodyText: string, privateValues: string[]): Error {
  let vendorMsg: string | undefined;
  try {
    vendorMsg = extractVendorError(JSON.parse(bodyText) as Record<string, unknown>, privateValues);
  } catch {
    // The HTTP status remains useful without exposing an unstructured body.
  }
  const lead = vendorMsg ?? (status >= 400 ? `请求失败 (HTTP ${status})` : "未返回任务ID");
  return new Error(lead);
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
  private async request(url: string, init: RequestInit, retries: number): Promise<Response> {
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        if (attempt >= retries) throw e;
      }
    }
  }

  async create(req: Req): Promise<CreateResult> {
    const { adapter, baseUrl, apiKey } = this.opts;
    const model = req.model ?? this.opts.model;
    const url = `${baseUrl}${adapter.createPath()}`;
    const body = adapter.buildCreateBody(req, model);
    const privateValues = [apiKey, ...requestPrivateValues(body)];
    console.log("[generation.create] request", { method: "POST" });
    const res = await this.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    }, 0);
    // Read once for parsing. Request/response bodies never enter logs or errors.
    const bodyText = await res.text();
    console.log("[generation.create] response", { status: res.status });
    if (!res.ok) throw createFailError(res.status, bodyText, privateValues);
    let json: unknown;
    try {
      json = JSON.parse(bodyText);
    } catch {
      throw createFailError(res.status, bodyText, privateValues);
    }
    const created = adapter.parseCreate(json);
    // Success REQUIRES a vendor task id. A 200 with an error envelope (or any body
    // lacking the task id required by its adapter) has nothing to poll, so fail
    // immediately instead of polling an empty id until the max-wait timeout.
    if (!created.taskId) throw createFailError(res.status, bodyText, privateValues);
    return created;
  }
  async poll(taskId: string): Promise<PollResult> {
    const { adapter, baseUrl, apiKey } = this.opts;
    const res = await this.request(`${baseUrl}${adapter.pollPath(taskId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    }, 1);
    if (!res.ok) throw await responseError(res, "generation poll failed", [apiKey]);
    const result = adapter.parsePoll(await res.json());
    const parsed = result.error ? { ...result, error: safeErrorMessage(result.error, [apiKey]) } : result;
    const term = adapter.isTerminal(parsed.status);
    if (term) return { ...parsed, status: term };
    // A missing status is a malformed/error response the adapter couldn't
    // classify (e.g. a vendor error envelope served with HTTP 200) — treat it as
    // a failure so the caller stops polling, instead of optimistically coercing
    // it to "running", which would loop until the job's max-wait timeout.
    if (!parsed.status) {
      return { ...parsed, status: "failed", failureUnconfirmed: true, error: parsed.error ?? "generation poll returned no status" };
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
