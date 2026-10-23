import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type pg from "pg";
import { Hono } from "hono";
import { CreateAnalysisSchema } from "@lot-agent/core/marketing-analysis";
import { MarketingDraftSchema } from "@lot-agent/core/marketing-video";
import { AnalysisStorage } from "./storage.js";
import { createAnalysisRoutes } from "./routes.js";
import { analysisConfig } from "./config.js";
import { copyAnalysisUpload, ownedAnalysisUpload, storeAnalysisUpload, validateAnalysisUpload } from "./uploads.js";

const bytes = Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex");
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lot-analysis-upload-")); roots.push(root);
  const storage = new AnalysisStorage(root); vi.spyOn(storage, "assertCapacity").mockResolvedValue();
  const rows = new Map<string, any>();
  const query = vi.fn(async (sql: string, values: any[] = []) => {
    if (sql.includes("INSERT INTO marketing_analysis_uploads")) {
      const [id, user_id, original_name, media_key, mime, size_bytes, source_hash] = values;
      rows.set(id, { id, user_id, original_name, media_key, mime, size_bytes, source_hash });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM marketing_analysis_uploads")) {
      const value = rows.get(values[0]);
      const result = value && (!sql.includes("user_id=$2") || value.user_id === values[1]) ? [value] : [];
      return { rows: result, rowCount: result.length };
    }
    if (sql.includes("global_count")) return { rows: [{ global_count: "0", owner_count: "0" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const pool = { query, connect: async () => ({ query, release: vi.fn() }) } as unknown as pg.Pool;
  const input = { pool, storage, owner: "owner", id: randomUUID(), name: "本地爆款.mp4", mime: "video/mp4", body: [bytes] };
  return { root, storage, rows, query, pool, input };
}

it("requires exactly one source and persists a local source independently of generation assets", () => {
  const request = { clientRequestId: randomUUID() };
  expect(CreateAnalysisSchema.safeParse(request).success).toBe(false);
  expect(CreateAnalysisSchema.safeParse({ ...request, uploadId: randomUUID(), shareText: "https://b23.tv/abc" }).success).toBe(false);
  expect(CreateAnalysisSchema.safeParse({ ...request, uploadId: randomUUID() }).success).toBe(true);
  const referenceUpload = { id: randomUUID(), name: "video.mp4" };
  const draft = MarketingDraftSchema.parse({ referenceUpload });
  expect(draft.referenceUpload).toEqual(referenceUpload);
  expect(draft.assets).toEqual({});
});

it("checks video signatures, MIME types, empty files and the upload byte bound", () => {
  expect(validateAnalysisUpload(bytes, "video/mp4")).toBe("source.mp4");
  expect(validateAnalysisUpload(bytes, "video/quicktime")).toBe("source.mp4");
  expect(validateAnalysisUpload(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0]), "video/webm")).toBe("source.webm");
  expect(() => validateAnalysisUpload(Buffer.from("#EXTM3U\nhttps://localhost/private"), "video/mp4")).toThrow("UPLOAD_FORMAT");
  expect(() => validateAnalysisUpload(bytes, "video/webm")).toThrow("UPLOAD_FORMAT");
  expect(() => validateAnalysisUpload(Buffer.alloc(0), "video/mp4")).toThrow("UPLOAD_LIMIT");
  expect(() => validateAnalysisUpload(Buffer.alloc(100 * 1024 * 1024 + 1), "video/mp4")).toThrow("UPLOAD_LIMIT");
});

it("stores private bytes idempotently and refuses another owner or changed bytes under the same id", async () => {
  const { input, storage, rows } = await fixture();
  const result = await storeAnalysisUpload(input);
  expect(result).toEqual({ id: input.id, name: "本地爆款.mp4" });
  expect(await readFile(join(await storage.uploadDirectory(input.owner, input.id), "source.mp4"))).toEqual(bytes);
  expect(await storeAnalysisUpload(input)).toEqual(result);
  // Before streaming and under the lock, for the first request only.
  expect(storage.assertCapacity).toHaveBeenCalledTimes(2);
  // Nothing staged is left behind.
  expect((await readdir(await storage.uploadDirectory(input.owner, input.id))).sort()).toEqual(["source.mp4"]);
  await expect(storeAnalysisUpload({ ...input, owner: "other" })).rejects.toThrow("REQUEST_CONFLICT");
  await expect(storeAnalysisUpload({ ...input, body: [Buffer.concat([bytes, Buffer.from([1])])] })).rejects.toThrow("REQUEST_CONFLICT");
  await expect(ownedAnalysisUpload(input.pool, "other", input.id)).rejects.toThrow("UPLOAD_NOT_FOUND");
  rows.get(input.id).expired_at = new Date();
  await expect(ownedAnalysisUpload(input.pool, input.owner, input.id)).rejects.toThrow("UPLOAD_EXPIRED");
});

it("copies owner-checked, hash-checked regular uploads into the task directory and blocks symlinks", async () => {
  const { input, storage, rows } = await fixture(); await storeAnalysisUpload(input);
  const directory = await storage.directory(input.owner, randomUUID());
  const source = { platform: "local" as const, canonicalUrl: `upload:${input.id}`, uploadId: input.id, sourceHash: rows.get(input.id).source_hash };
  const result = await copyAnalysisUpload({ ...input, source, directory });
  expect(result.mediaKey).toBe("source.mp4"); expect(await readFile(join(directory, result.mediaKey!))).toEqual(bytes);
  await expect(copyAnalysisUpload({ ...input, source, directory, owner: "other" })).rejects.toThrow("UPLOAD_NOT_FOUND");
  const uploadPath = join(await storage.uploadDirectory(input.owner, input.id), "source.mp4");
  await writeFile(uploadPath, Buffer.concat([bytes.subarray(0, -1), Buffer.from([255])]));
  await expect(copyAnalysisUpload({ ...input, source, directory })).rejects.toThrow("INVALID_PRIVATE_FILE");
  await rm(uploadPath); await symlink(join(directory, "source.mp4"), uploadPath);
  await expect(copyAnalysisUpload({ ...input, source, directory })).rejects.toThrow();
});

it("isolates upload IDs from analysis IDs so replacement and expiry cannot overwrite or remove task evidence", async () => {
  const { input, storage } = await fixture();
  const taskDirectory = await storage.directory(input.owner, input.id);
  await writeFile(join(taskDirectory, "source.mp4"), "existing analysis video");
  await writeFile(join(taskDirectory, "frame-0001.jpg"), "existing evidence");
  await storeAnalysisUpload(input);
  expect(await storage.uploadDirectory(input.owner, input.id)).not.toBe(taskDirectory);
  await storage.removeUpload(input.owner, input.id);
  expect(await readFile(join(taskDirectory, "source.mp4"), "utf8")).toBe("existing analysis video");
  expect(await readFile(join(taskDirectory, "frame-0001.jpg"), "utf8")).toBe("existing evidence");
});

it("accepts authenticated multipart uploads through the bounded analysis route and rejects invalid files", async () => {
  const { pool, storage } = await fixture();
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => { if (c.req.header("authorization") === "Bearer owner") c.set("userId", "owner"); await next(); });
  app.route("/analysis", createAnalysisRoutes({ db: { pool } } as any, storage.root, { storage, config: { ...analysisConfig(), enabled: true } }));
  const body = (value: Buffer) => { const form = new FormData(); form.append("file", new File([value], "test.mp4", { type: "video/mp4" })); form.append("clientRequestId", randomUUID()); return form; };
  const result = await app.request("/analysis/uploads", { method: "POST", headers: { authorization: "Bearer owner" }, body: body(bytes) });
  expect(result.status).toBe(201); expect(await result.json()).toEqual({ id: expect.any(String), name: "test.mp4" });
  expect((await app.request("/analysis/uploads", { method: "POST", body: body(bytes) })).status).toBe(401);
  const invalid = await app.request("/analysis/uploads", { method: "POST", headers: { authorization: "Bearer owner" }, body: body(Buffer.from("not a video")) });
  expect(invalid.status).toBe(400); expect(await invalid.json()).toEqual({ error: "UPLOAD_FORMAT", code: "UPLOAD_FORMAT" });
  expect((await app.request("/analysis/uploads", { method: "POST", headers: { authorization: "Bearer owner", "content-length": String(102 * 1024 * 1024) }, body: "oversized" })).status).toBe(413);
});

it("streams a raw upload with its name and request ID from the headers and URL", async () => {
  const { pool, storage } = await fixture();
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => { c.set("userId", "owner"); await next(); });
  app.route("/analysis", createAnalysisRoutes({ db: { pool } } as any, storage.root, { storage, config: { ...analysisConfig(), enabled: true } }));
  const id = randomUUID();
  const raw = (body: ConstructorParameters<typeof Response>[0], type = "video/mp4") => app.request(`/analysis/uploads?clientRequestId=${id}`, { method: "POST",
    headers: { "content-type": type, "x-file-name": encodeURIComponent("门店 爆款.mp4") }, body });
  const result = await raw(bytes);
  expect(result.status).toBe(201); expect(await result.json()).toEqual({ id, name: "门店 爆款.mp4" });
  expect(await readFile(join(await storage.uploadDirectory("owner", id), "source.mp4"))).toEqual(bytes);
  expect((await raw(bytes, "video/x-msvideo")).status).toBe(400);
  // Over 100 MB without a Content-Length: stopped while streaming, nothing kept.
  const other = randomUUID(); const chunk = new Uint8Array(1024 * 1024); let sent = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (sent++ < 110) controller.enqueue(chunk); else controller.close(); } });
  const large = await app.request(`/analysis/uploads?clientRequestId=${other}`, { method: "POST", headers: { "content-type": "video/mp4" }, body: stream, duplex: "half" } as RequestInit);
  expect(large.status).toBe(413);
  expect(await readdir(await storage.uploadDirectory("owner", other))).toEqual([]);
});
