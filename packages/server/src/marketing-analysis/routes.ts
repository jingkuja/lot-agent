import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ANALYSIS_LIMITS, AnalysisPlatformSchema, CreateAnalysisSchema, EditAnalysisTextSchema } from "@lot-agent/core/marketing-analysis";
import type { AgentService } from "../services/agent-service.js";
import { analysisConfig, type AnalysisConfig } from "./config.js";
import { PgAnalysisStore } from "./repository.js";
import { AnalysisStorage } from "./storage.js";
import { AnalysisError } from "./errors.js";
import { analysisUserKey } from "./runtime.js";
import { readAnalysisFile } from "./private-files.js";
import { validateCookieFile } from "./download.js";
import { applyAnalysis } from "./apply.js";
import { storeAnalysisUpload } from "./uploads.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const revision = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
export function createAnalysisRoutes(service: Pick<AgentService, "db" | "tokenhub">, root: string, deps: {
  store?: PgAnalysisStore; storage?: AnalysisStorage; config?: AnalysisConfig; authorize?: (owner: string, signal?: AbortSignal) => Promise<unknown>;
} = {}) {
  const config = deps.config ?? analysisConfig();
  const storage = deps.storage ?? new AnalysisStorage(root);
  const store = deps.store ?? new PgAnalysisStore(service.db.pool, undefined, (owner, pending, global) => storage.assertCapacity(owner, pending, global));
  const authorize = deps.authorize ?? ((owner, signal) => analysisUserKey(service.db, service.tokenhub, owner, signal));
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => bodyLimit({ maxSize: c.req.method === "POST" && c.req.path.endsWith("/uploads") ? ANALYSIS_LIMITS.downloadBytes + 1024 * 1024 : 800 * 1024,
    onError: c => c.json({ error: "ANALYSIS_REQUEST_LIMIT", code: "ANALYSIS_REQUEST_LIMIT" }, 413) })(c, next));
  app.use("*", async (c, next) => {
    if (!c.get("userId")) return c.json({ error: "Unauthorized" }, 401);
    c.header("Cache-Control", "private, no-store"); c.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  app.onError((error, c) => {
    const known = error instanceof AnalysisError;
    return c.json({ error: known ? error.code : "ANALYSIS_FAILED", code: known ? error.code : "ANALYSIS_FAILED" }, known ? error.status : 500);
  });
  app.get("/capabilities", c => c.json({ enabled: config.enabled, durationMs: 180000, platforms: ["douyin", "xiaohongshu", "bilibili"] }));
  app.use("*", async (_c, next) => { if (!config.enabled) throw new AnalysisError("ANALYSIS_DISABLED", 503); await next(); });
  app.post("/uploads", async c => {
    const body = await c.req.parseBody();
    if (!(body.file instanceof File) || typeof body.clientRequestId !== "string" || !uuid.test(body.clientRequestId)) throw new AnalysisError("INVALID_SOURCE");
    if (!body.file.size || body.file.size > ANALYSIS_LIMITS.downloadBytes) throw new AnalysisError("UPLOAD_LIMIT", 413);
    return c.json(await storeAnalysisUpload({ pool: store.pool, storage, owner: c.get("userId"), id: body.clientRequestId,
      name: body.file.name, mime: body.file.type, bytes: Buffer.from(await body.file.arrayBuffer()), signal: c.req.raw.signal }), 201);
  });
  app.get("/sessions", async c => c.json({ data: (await store.pool.query("SELECT platform,updated_at FROM marketing_analysis_sessions WHERE user_id=$1", [c.get("userId")])).rows }));
  app.put("/sessions/:platform", async c => {
    const platform = AnalysisPlatformSchema.safeParse(c.req.param("platform")); const body = await c.req.json().catch(() => null);
    if (!platform.success || typeof body?.cookies !== "string") throw new AnalysisError("INVALID_COOKIES");
    if (!store.secrets.enabled) throw new AnalysisError("ANALYSIS_CONFIG_REQUIRED", 503);
    const cookies = validateCookieFile(body.cookies, { platform: platform.data });
    await store.pool.query(`INSERT INTO marketing_analysis_sessions(user_id,platform,encrypted_cookies) VALUES($1,$2,$3)
      ON CONFLICT(user_id,platform) DO UPDATE SET encrypted_cookies=excluded.encrypted_cookies,updated_at=now()`, [c.get("userId"), platform.data, store.secrets.seal(cookies)]);
    return c.json({ ok: true });
  });
  app.delete("/sessions/:platform", async c => {
    const platform = AnalysisPlatformSchema.safeParse(c.req.param("platform"));
    if (!platform.success) throw new AnalysisError("INVALID_COOKIES");
    await store.pool.query("DELETE FROM marketing_analysis_sessions WHERE user_id=$1 AND platform=$2", [c.get("userId"), platform.data]);
    return c.json({ ok: true });
  });
  app.get("/", async c => {
    const offset = Number(c.req.query("offset") ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new AnalysisError("INVALID_PAGE");
    return c.json({ data: await store.list(c.get("userId"), offset) });
  });
  app.post("/", async c => {
    const input = CreateAnalysisSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new AnalysisError("INVALID_SOURCE");
    await authorize(c.get("userId"), c.req.raw.signal);
    return c.json(await store.create(c.get("userId"), input.data, config), 202);
  });
  app.use("/:id/*", async (c, next) => { if (!uuid.test(c.req.param("id") ?? "")) throw new AnalysisError("ANALYSIS_NOT_FOUND", 404); await next(); });
  app.use("/:id", async (c, next) => { if (!uuid.test(c.req.param("id") ?? "")) throw new AnalysisError("ANALYSIS_NOT_FOUND", 404); await next(); });
  app.get("/:id", async c => {
    const value = await store.get(c.get("userId"), c.req.param("id"));
    if (!value) throw new AnalysisError("ANALYSIS_NOT_FOUND", 404);
    return c.json(value);
  });
  app.get("/:id/frames/:frameId", async c => {
    const value = await store.get(c.get("userId"), c.req.param("id"));
    const frame = value?.snapshot.frames.find(f => f.id === c.req.param("frameId"));
    if (!value || !frame) throw new AnalysisError("EVIDENCE_NOT_FOUND", 404);
    const bytes = await readAnalysisFile(await storage.directory(c.get("userId"), value.id), frame.objectKey, 4 * 1024 * 1024);
    c.header("Content-Type", "image/jpeg");
    return c.body(new Uint8Array(bytes));
  });
  app.post("/:id/cancel", async c => c.json(await store.cancel(c.get("userId"), c.req.param("id"))));
  for (const operation of ["resume", "summarize"] as const) app.post(`/:id/${operation}`, async c => {
    const body = await c.req.json().catch(() => null);
    if (!revision(body?.expectedRevision)) throw new AnalysisError("REVISION_CONFLICT", 409);
    if (body.visualOnly !== undefined && (typeof body.visualOnly !== "boolean" || operation !== "resume")) throw new AnalysisError("INVALID_SOURCE");
    await authorize(c.get("userId"), c.req.raw.signal);
    return c.json(await store.resume(c.get("userId"), c.req.param("id"), body.expectedRevision, operation === "summarize", body.visualOnly === true), 202);
  });
  app.patch("/:id/text", async c => {
    const body = EditAnalysisTextSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new AnalysisError("INVALID_TEXT_REFERENCE");
    return c.json(await store.edit(c.get("userId"), c.req.param("id"), body.data.expectedRevision, body.data.texts));
  });
  for (const operation of ["apply-preview", "apply"] as const) app.post(`/:id/${operation}`, async c => {
    const body = await c.req.json().catch(() => null);
    if (!body || !revision(body.expectedRevision) || !revision(body.projectVersion) || !uuid.test(body.projectId ?? "")
      || !Array.isArray(body.evidenceIds) || body.evidenceIds.some((id: unknown) => typeof id !== "string")) throw new AnalysisError("INVALID_EVIDENCE_REFERENCE");
    return c.json(await applyAnalysis(store, c.get("userId"), c.req.param("id"), body, operation === "apply"));
  });
  app.delete("/:id", async c => {
    await store.remove(c.get("userId"), c.req.param("id"));
    await storage.remove(c.get("userId"), c.req.param("id"));
    return c.json({ ok: true });
  });
  return app;
}
