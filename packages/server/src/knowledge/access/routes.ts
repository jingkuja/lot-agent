import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { KnowledgeProfileRequestSchema, KnowledgeUuidSchema, parseKnowledgeRetrievalRequest, type PrivateKnowledgeStorage } from "@lot-agent/core";
import { KnowledgeKeys } from "./keys.js";
import type { KnowledgeLimiter } from "./limiter.js";
import type { KnowledgeRetriever } from "../retrieval.js";
import { KnowledgeFacts } from "../profile/repository.js";
import { KnowledgeError } from "../errors.js";
import { content, errorHandler, jsonBody } from "../routes.js";

type Caller = Awaited<ReturnType<KnowledgeKeys["authenticate"]>>;
type Env = { Variables: { userId: string; caller: Caller; deadline: AbortSignal } };
const missing = () => new KnowledgeError("NOT_FOUND", 404, "资料不存在或不可见");

/** Independent bearer-key authentication. Never accepts a user/session identity from input. */
export function createKnowledgeAccessRoutes(keys: KnowledgeKeys, retriever: KnowledgeRetriever, storage: PrivateKnowledgeStorage, limiter: KnowledgeLimiter) {
  const app = new Hono<Env>();
  errorHandler(app);
  app.use("*", async (c, next) => {
    const caller = await keys.authenticate((c.req.header("Authorization") ?? "").replace(/^Bearer /, ""));
    c.set("caller", caller);
    const release = await limiter.enter(caller.keyId);
    let released = false;
    const finish = async () => { if (!released) { released = true; await release(); } };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    c.set("deadline", AbortSignal.any([controller.signal, c.req.raw.signal]));
    try {
      await Promise.race([next(), new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new KnowledgeError("REQUEST_TIMEOUT", 504, "请求超时", true)), { once: true });
      })]);
      await keys.caller(caller.userId, caller.keyId, caller.version);
      await keys.touch(caller.keyId);
      // Hold the concurrency slot through streaming and release on disconnect/error.
      const reader = c.res.body?.getReader();
      if (!reader) { clearTimeout(timer); await finish(); return; }
      const cleanup = async () => { clearTimeout(timer); await finish(); };
      const body = new ReadableStream<Uint8Array>({
        async pull(out) {
          try {
            if (controller.signal.aborted) throw new Error("REQUEST_TIMEOUT");
            const result = await reader.read();
            if (result.done) { out.close(); await cleanup(); } else out.enqueue(result.value);
          } catch (error) { out.error(error); await reader.cancel().catch(() => {}); await cleanup(); }
        },
        async cancel(reason) { await reader.cancel(reason); await cleanup(); },
      });
      controller.signal.addEventListener("abort", () => { void reader.cancel().finally(cleanup).catch(() => {}); }, { once: true });
      c.res = new Response(body, { status: c.res.status, headers: c.res.headers });
    } catch (error) { clearTimeout(timer); await finish(); throw error; }
  });
  const scope = (caller: Caller, permission: "retrieval:read" | "profile:read" | "assets:read", ids = [...caller.collectionIds]) => keys.scope(caller, ids, permission, caller.version);
  app.get("/collections", async (c) => {
    const auth = await scope(c.get("caller"), "retrieval:read");
    const limit = Number(c.req.query("limit") ?? 30);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new KnowledgeError("INVALID_REQUEST", 400, "分页参数无效");
    const cursor = c.req.query("cursor"); if (cursor) KnowledgeUuidSchema.parse(cursor);
    const rows = (await keys.pool.query(`SELECT id,name,description FROM rag_collections WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`, [auth.ownerId, auth.collectionIds, cursor ?? null, limit + 1])).rows;
    await keys.authorize(auth);
    return c.json({ data: rows.slice(0, limit), next_cursor: rows.length > limit ? rows[limit - 1].id : null, request_id: randomUUID() });
  });
  app.post("/retrieval", async (c) => {
    const input = parseKnowledgeRetrievalRequest(await jsonBody(c));
    input.collectionIds.forEach((id) => KnowledgeUuidSchema.parse(id));
    const auth = await scope(c.get("caller"), "retrieval:read", input.collectionIds);
    const result = await retriever.retrieve(auth, input, c.get("deadline"));
    await keys.authorize(auth, input);
    return c.json({ request_id: result.requestId, mode_used: result.modeUsed, degraded: result.degraded, warnings: result.warnings,
      results: result.results.map((e) => ({ item_id: e.itemId, revision_id: e.revisionId, chunk_id: e.chunkId, collection_ids: e.collectionIds,
        title: e.title, content: e.content, source_type: e.sourceType, origin: e.origin, score: e.score, ...(e.citation ? { citation: e.citation } : {}) })) });
  });
  const item = async (caller: Caller, id: string, permission: "retrieval:read" | "assets:read") => {
    KnowledgeUuidSchema.parse(id);
    const auth = await scope(caller, permission);
    const row = (await keys.pool.query(`SELECT i.id,i.title,i.source_type,i.active_revision_id AS revision_id FROM rag_items i
      WHERE i.owner_id=$1 AND i.id=$2 AND i.deleted_at IS NULL AND i.source_type<>'profile_fact'
      AND EXISTS(SELECT 1 FROM rag_collection_items ci JOIN rag_collections co ON co.owner_id=ci.owner_id AND co.id=ci.collection_id WHERE ci.owner_id=i.owner_id AND ci.item_id=i.id AND co.deleted_at IS NULL AND ci.collection_id=ANY($3::uuid[]))`, [auth.ownerId, id, auth.collectionIds])).rows[0];
    if (!row) throw missing();
    await keys.authorize(auth);
    return { auth, row };
  };
  app.get("/items/:id", async (c) => {
    const { row } = await item(c.get("caller"), c.req.param("id"), "retrieval:read");
    return c.json({ ...row, request_id: randomUUID() });
  });
  app.on(["GET", "HEAD"], "/assets/:id/content", async (c) => {
    const { auth, row } = await item(c.get("caller"), c.req.param("id"), "assets:read");
    if (!row.revision_id) throw missing();
    const file = await keys.repo.getFile(auth.ownerId, row.id, row.revision_id);
    await keys.authorize(auth);
    return content(c, storage, file);
  });
  app.get("/profile", async (c) => {
    const input = KnowledgeProfileRequestSchema.parse((c.req.query("keys") ?? "").split(","));
    const auth = await scope(c.get("caller"), "profile:read");
    const data = await new KnowledgeFacts(keys.pool).exact(auth, input);
    await keys.authorize(auth);
    return c.json({ data, request_id: randomUUID() });
  });
  return app;
}
