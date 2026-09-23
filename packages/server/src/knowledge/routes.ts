import { parseKnowledgeRetrievalRequest } from "@lot-agent/core";
import { resolveKnowledgeScope } from "./scope.js";
import type { KnowledgeRetriever } from "./retrieval.js";
import { KnowledgeJobs } from "./ingestion/jobs.js";
import { knowledgeQueueConfig } from "./ingestion/config.js";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import {
  KnowledgeCollectionInputSchema, KnowledgeCollectionUpdateSchema, KnowledgeItemInputSchema,
  KnowledgeUploadMetadataSchema, KnowledgeDeleteSchema, KnowledgeUuidSchema, KnowledgeItemUpdateSchema,
  type PrivateKnowledgeStorage,
} from "@lot-agent/core";
import { parseRange } from "../static-files.js";
import { KnowledgeError } from "./errors.js";
import { knowledgeContentPolicy } from "./content-policy.js";
import { KNOWLEDGE_MIME_LIMITS } from "./private-storage.js";
import type { KnowledgeRepository, KnowledgeCursor, KnowledgeFile } from "./repository.js";

type Env = { Variables: { userId: string } };
const invalid = () => new KnowledgeError("INVALID_REQUEST", 400, "请求参数无效");
const uuid = (value: string) => KnowledgeUuidSchema.parse(value);
const key = (c: Context) => {
  const value = c.req.header("Idempotency-Key");
  if (!value || value.length > 128 || !/^[\x21-\x7e]+$/.test(value)) throw invalid();
  return value;
};

function errorHandler(app: Hono<Env>) {
  app.onError((error, c) => {
    const requestId = randomUUID();
    if (error instanceof KnowledgeError) return c.json({ error: { code: error.code, message: error.message, retryable: error.retryable }, request_id: requestId }, error.status);
    if (error.name === "ZodError" || error instanceof SyntaxError) return c.json({ error: { code: "INVALID_REQUEST", message: "请求参数无效", retryable: false }, request_id: requestId }, 400);
    // Do not expose DB/vendor errors, original text, session tokens or storage keys.
    return c.json({ error: { code: "KNOWLEDGE_UNAVAILABLE", message: "知识服务暂不可用", retryable: true }, request_id: requestId }, 503);
  });
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); c.header("Referrer-Policy", "no-referrer"); await next(); });
}

function pagination(c: Context): { limit: number; cursor?: KnowledgeCursor } {
  const rawLimit = c.req.query("limit"); const limit = rawLimit === undefined ? 30 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
  const raw = c.req.query("cursor");
  if (!raw) return { limit };
  if (raw.length > 500) throw invalid();
  const cursor = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  if (!cursor || typeof cursor.createdAt !== "string" || !Number.isFinite(Date.parse(cursor.createdAt))) throw invalid();
  uuid(cursor.id);
  return { limit, cursor: { id: cursor.id, createdAt: cursor.createdAt } };
}
const encodePage = (page: { data: unknown[]; nextCursor: KnowledgeCursor | null }) => ({
  data: page.data, nextCursor: page.nextCursor ? Buffer.from(JSON.stringify(page.nextCursor)).toString("base64url") : null,
});

/** Limit JSON before buffering; uploads use a separate stream with MIME-specific caps. */
async function jsonBody(c: Context): Promise<unknown> {
  const body = c.req.raw.body;
  if (!body) throw invalid();
  const reader = body.getReader(); const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) { await reader.cancel(); throw new KnowledgeError("PAYLOAD_TOO_LARGE", 413, "请求正文过大"); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

async function content(c: Context, storage: PrivateKnowledgeStorage, file: KnowledgeFile): Promise<Response> {
  const size = await storage.size(file.key);
  if (size !== file.size) throw new KnowledgeError("KNOWLEDGE_UNAVAILABLE", 503, "原件校验失败");
  const range = parseRange(c.req.header("Range"), size);
  if (range === "invalid") return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}`, "Cache-Control": "no-store" } });
  const policy = knowledgeContentPolicy(file.mime);
  const headers: Record<string, string> = {
    "Content-Type": policy.contentType, "Content-Disposition": `${policy.disposition}; filename*=UTF-8''${encodeURIComponent(file.title)}`,
    "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Accept-Ranges": "bytes",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Content-Length": String(range ? range.end - range.start + 1 : size),
  };
  if (range) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
  if (c.req.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
  const stream = storage.open(file.key, range ?? undefined) as Readable;
  return new Response(Readable.toWeb(stream) as ReadableStream, { status: range ? 206 : 200, headers });
}

/** Mount ONLY below existing session auth. No caller-controlled owner field is accepted. */
export function createKnowledgeManageRoutes(repository: KnowledgeRepository, storage: PrivateKnowledgeStorage, retriever?: KnowledgeRetriever) {
  const app = new Hono<Env>(); errorHandler(app);
  app.use("*", async (c, next) => { if (!c.get("userId")) throw new KnowledgeError("UNAUTHORIZED", 401, "请先登录"); await next(); });
  app.get("/status", (c) => c.json({ ingestionEnabled: process.env.KNOWLEDGE_INGESTION_ENABLED === "1" }));
  app.post("/retrieval", async (c) => {
    if (!retriever) throw new KnowledgeError("KNOWLEDGE_UNAVAILABLE", 503, "本地检索尚未启用");
    const input = parseKnowledgeRetrievalRequest(await jsonBody(c));
    input.collectionIds.forEach(uuid);
    const scope = await resolveKnowledgeScope({ kind: "internal", userId: c.get("userId"), collectionIds: input.collectionIds }, input.collectionIds, "retrieval:read", (owner, ids) => repository.findOwnedCollections(owner, ids));
    return c.json(await retriever.retrieve(scope, input));
  });
  app.get("/collections", async (c) => { const p = pagination(c); return c.json(encodePage(await repository.listCollections(c.get("userId"), p.limit, p.cursor))); });
  app.post("/collections", async (c) => {
    const idempotencyKey = key(c);
    return c.json(await repository.createCollection(c.get("userId"), KnowledgeCollectionInputSchema.parse(await jsonBody(c)), idempotencyKey), 201);
  });
  app.patch("/collections/:id", async (c) => c.json(await repository.updateCollection(c.get("userId"), uuid(c.req.param("id")), KnowledgeCollectionUpdateSchema.parse(await jsonBody(c)))));
  app.delete("/collections/:id", async (c) => c.json(await repository.deleteCollection(c.get("userId"), uuid(c.req.param("id")), KnowledgeDeleteSchema.parse(await jsonBody(c)).version)));
  app.patch("/items/:id", async (c) => c.json(await repository.updateItem(c.get("userId"), uuid(c.req.param("id")), KnowledgeItemUpdateSchema.parse(await jsonBody(c)))));
  app.get("/items", async (c) => {
    const p = pagination(c); const collectionId = c.req.query("collectionId");
    return c.json(encodePage(await repository.listItems(c.get("userId"), p.limit, p.cursor, collectionId ? uuid(collectionId) : undefined)));
  });
  app.post("/items", async (c) => {
    const idempotencyKey = key(c);
    return c.json(await repository.createItem(c.get("userId"), KnowledgeItemInputSchema.parse(await jsonBody(c)), idempotencyKey), 201);
  });
  app.get("/items/:id", async (c) => c.json(await repository.getItem(c.get("userId"), uuid(c.req.param("id")))));
  app.delete("/items/:id", async (c) => c.json(await repository.deleteItem(c.get("userId"), uuid(c.req.param("id")), KnowledgeDeleteSchema.parse(await jsonBody(c)).version)));
  app.put("/collections/:collectionId/items/:itemId", async (c) => {
    await repository.changeMembership(c.get("userId"), uuid(c.req.param("itemId")), uuid(c.req.param("collectionId")), true); return c.body(null, 204);
  });
  app.delete("/collections/:collectionId/items/:itemId", async (c) => {
    await repository.changeMembership(c.get("userId"), uuid(c.req.param("itemId")), uuid(c.req.param("collectionId")), false); return c.body(null, 204);
  });
  // Raw bytes avoid buffering multipart bodies. Metadata is URL-encoded JSON in a bounded header.
  app.post("/uploads", async (c) => {
    const idempotencyKey = key(c);
    const raw = c.req.header("X-Knowledge-Metadata");
    if (!raw || raw.length > 16_384) throw invalid();
    let metadata: unknown;
    try { metadata = JSON.parse(decodeURIComponent(raw)); } catch { throw invalid(); }
    const input = KnowledgeUploadMetadataSchema.parse(metadata);
    const mime = (c.req.header("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
    const cap = KNOWLEDGE_MIME_LIMITS[mime];
    if (!cap) throw new KnowledgeError("UNSUPPORTED_MEDIA", 415, "不支持的文件格式");
    const size = c.req.header("Content-Length");
    if (size !== undefined && (!/^\d+$/.test(size) || Number(size) > cap)) throw new KnowledgeError("PAYLOAD_TOO_LARGE", 413, "文件过大");
    if (!c.req.raw.body) throw invalid();
    const owner = c.get("userId");
    if (input.collectionIds.length !== (await repository.findOwnedCollections(owner, input.collectionIds)).length) throw new KnowledgeError("NOT_FOUND", 404, "知识库不存在");
    const sourceType = mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : "document";
    const object = await storage.put(owner, Readable.fromWeb(c.req.raw.body as import("node:stream/web").ReadableStream), mime);
    return c.json(await repository.createItem(owner, { ...input, sourceType, mime, object }, idempotencyKey), 201);
  });
  app.get("/items/:id/revisions/:revisionId/content", async (c) => content(c, storage, await repository.getFile(c.get("userId"), uuid(c.req.param("id")), uuid(c.req.param("revisionId")))));
  app.post("/items/:id/revisions/:revisionId/preview-ticket", async (c) => {
    const token = c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "";
    const ticket = await repository.createPreviewTicket(c.get("userId"), token, uuid(c.req.param("id")), uuid(c.req.param("revisionId")));
    return c.json({ url: `/api/rag/preview/${ticket.token}`, expiresAt: ticket.expiresAt });
  });
  app.post("/items/:id/retry", async (c) => {
    if (process.env.KNOWLEDGE_INGESTION_ENABLED !== "1") throw new KnowledgeError("KNOWLEDGE_UNAVAILABLE", 503, "知识入库尚未启用");
    const { version } = KnowledgeDeleteSchema.parse(await jsonBody(c));
    return c.json(await new KnowledgeJobs(repository.pool).retry(c.get("userId"), uuid(c.req.param("id")), version, knowledgeQueueConfig().queueName), 202);
  });
  app.get("/storage", async (c) => c.json({ storedBytes: await repository.storageUsage(c.get("userId")) }));
  return app;
}

/** Capability URL: every Range rechecks persisted session, generation and item/revision visibility. */
export function createKnowledgePreviewRoutes(repository: KnowledgeRepository, storage: PrivateKnowledgeStorage) {
  const app = new Hono<Env>(); errorHandler(app);
  app.get("/:ticket", async (c) => content(c, storage, await repository.resolvePreviewTicket(c.req.param("ticket"))));
  return app;
}
