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

/** A vendor input may be a single URL or a list of URLs. */
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
export function extractVendorError(j: Record<string, unknown>): string | undefined {
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
  return msg || code || undefined;
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
  /** Per-request timeout. Default: 20s. */
  timeoutMs?: number;
}

/** Default per-request timeout for generation HTTP calls. */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Turn a non-2xx generation response into an Error carrying the cleanest message
 * available. tokenhub returns a structured error envelope even on 5xx (e.g. a
 * 500 whose body is `{ code:"fail_to_fetch_task", message:"…未订购…资费包" }`), so
 * dig the human-readable vendor message out of it instead of dumping raw JSON.
 */
async function responseError(res: { status: number; text(): Promise<string> }, ctx: string): Promise<Error> {
  const body = await res.text();
  let vendorMsg: string | undefined;
  try {
    vendorMsg = extractVendorError(JSON.parse(body) as Record<string, unknown>);
  } catch {
    // body wasn't JSON — fall back to the raw text below
  }
  return new Error(vendorMsg ?? `${ctx}: ${res.status} ${body}`);
}

/** Max chars of a raw vendor response body carried in a create-failure error —
 * enough to show the full returned payload on hover without an unbounded tooltip. */
const RAW_BODY_CAP = 2000;

/**
 * Build a create-failure Error that carries the **raw response body** so the UI
 * can show exactly what the vendor returned on hover. A create only succeeds when
 * the response yields a task id; every other outcome (non-2xx, non-JSON body, or
 * a 2xx envelope with no adapter-recognized task id) routes here. Leads with the
 * extracted vendor message when there is one, then appends the raw payload.
 */
function createFailError(status: number, bodyText: string): Error {
  const raw = bodyText.trim().slice(0, RAW_BODY_CAP);
  let vendorMsg: string | undefined;
  try {
    vendorMsg = extractVendorError(JSON.parse(bodyText) as Record<string, unknown>);
  } catch {
    // body wasn't JSON — the raw text is all we have to show
  }
  const lead = vendorMsg ?? (status >= 400 ? `请求失败 (HTTP ${status})` : "未返回任务ID");
  return new Error(raw ? `${lead}：${raw}` : lead);
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
    // Debug: print the exact outgoing create request (URL + body) so the vendor
    // call can be reproduced with curl. Auth header omitted on purpose.
    console.log("[generation.create] →", "POST", url, JSON.stringify(body));
    const res = await this.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    }, 0);
    // Read the body once as text so both the success path and every failure path
    // (non-2xx, non-JSON, or a 2xx envelope with no task id) can see the raw
    // payload — the create only "succeeds" when a task id comes back.
    const bodyText = await res.text();
    console.log("[generation.create] ←", res.status, bodyText);
    if (!res.ok) throw createFailError(res.status, bodyText);
    let json: unknown;
    try {
      json = JSON.parse(bodyText);
    } catch {
      // A 2xx with a non-JSON body can't carry a task id — fail with the raw text.
      throw createFailError(res.status, bodyText);
    }
    const created = adapter.parseCreate(json);
    // Success REQUIRES a vendor task id. A 200 with an error envelope (or any body
    // lacking the task id required by its adapter) has nothing to poll, so fail
    // immediately — carrying the raw response so the UI shows what came back on
    // hover — instead of returning an empty id the job runner would poll
    // (`/videos/`) until the max-wait timeout.
    if (!created.taskId) throw createFailError(res.status, bodyText);
    return created;
  }
  async poll(taskId: string): Promise<PollResult> {
    const { adapter, baseUrl, apiKey } = this.opts;
    const res = await this.request(`${baseUrl}${adapter.pollPath(taskId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    }, 1);
    if (!res.ok) throw await responseError(res, "generation poll failed");
    const parsed = adapter.parsePoll(await res.json());
    const term = adapter.isTerminal(parsed.status);
    if (term) return { ...parsed, status: term };
    // A missing status is a malformed/error response the adapter couldn't
    // classify (e.g. a vendor error envelope served with HTTP 200) — treat it as
    // a failure so the caller stops polling, instead of optimistically coercing
    // it to "running", which would loop until the job's max-wait timeout.
    if (!parsed.status) {
      return { ...parsed, status: "failed", error: parsed.error ?? "generation poll returned no status" };
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
