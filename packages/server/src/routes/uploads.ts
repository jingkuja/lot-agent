import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import type { AgentService } from "../services/agent-service.js";
import { attachmentKind } from "../services/attachment-extractor.js";
import { signPrivateMaterial } from "../generation/private-materials.js";
import { meteredUpload, uploadFileName, UploadTooLargeError } from "../util/metered-upload.js";

type Variables = { userId: string };

const ALLOWED = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "video/mp4", "video/webm", "video/quicktime",
  "audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg", "audio/mp4",
  "text/plain", "text/markdown", "text/csv", "application/json",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const MAX_IMAGE = 150 * 1024 * 1024;
const MAX_DOC = 150 * 1024 * 1024;
const MAX_MEDIA = 150 * 1024 * 1024;
// `parseBody` buffers the whole multipart body into memory before we ever
// see a per-file size — a Content-Length precheck rejects oversized requests
// before that read happens. 151MB leaves ~1MB of multipart boundary/header
// overhead above the largest allowed file (MAX_DOC/MAX_MEDIA, 150MB).
// A raw upload (the file bytes as the body) is streamed to storage instead.
const MAX_UPLOAD_BODY_BYTES = 151 * 1024 * 1024;

export function createUploadRoutes(service: AgentService) {
  const app = new Hono<{ Variables: Variables }>();

  /**
   * Multipart (`file`, optional `purpose`) is kept for older clients and is read whole.
   * The web client sends the file bytes as the body, with its type as Content-Type, its
   * URI-encoded name in `X-File-Name` and `?purpose=`; that body is streamed to disk.
   */
  app.post("/", async (c) => {
    const userId = c.get("userId");
    // Header-only precheck — missing/unparseable Content-Length falls through
    // to the per-file size checks below, which still apply after parseBody.
    const contentLength = Number(c.req.header("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BODY_BYTES) {
      return c.json({ error: "请求体过大 (payload too large)" }, 413);
    }
    const contentType = c.req.header("content-type") ?? "";
    const multipart = /^multipart\/form-data/i.test(contentType);
    let file: File | undefined;
    let name: string; let mime: string; let purpose: unknown; let declared: number | undefined;
    if (multipart) {
      const body = await c.req.parseBody();
      if (!(body["file"] instanceof File)) return c.json({ error: "file is required" }, 400);
      file = body["file"];
      name = file.name; mime = file.type || "application/octet-stream"; purpose = body["purpose"]; declared = file.size;
    } else {
      if (!c.req.raw.body) return c.json({ error: "file is required" }, 400);
      name = uploadFileName(c.req.header("x-file-name"));
      mime = contentType.split(";")[0].trim().toLowerCase() || "application/octet-stream";
      purpose = c.req.query("purpose");
      declared = Number.isFinite(contentLength) ? contentLength : undefined;
    }
    const isMedia = mime.startsWith("video/") || mime.startsWith("audio/");
    const isAllowed = ALLOWED.has(mime) || mime.startsWith("text/") || isMedia;
    if (!isAllowed) {
      return c.json({ error: `unsupported type: ${mime}` }, 400);
    }
    const kind = attachmentKind(mime);
    const [max, tooLarge] = isMedia ? [MAX_MEDIA, "media too large (max 150MB)"] : kind === "image" ? [MAX_IMAGE, "image too large (max 150MB)"]
      : [MAX_DOC, "document too large (max 150MB)"];
    if (declared !== undefined && declared > max) return c.json({ error: tooLarge }, 400);

    const ext = extname(name) || "";
    const id = randomUUID();
    const key = `${id}${ext}`;
    const isPrivate = purpose === "marketing-video";
    // Fail before writing material when the temporary-link key is unavailable.
    const privateAsset = { id, user_id: userId, type: "upload", storage_key: key, url: service.uploadStorage.getUrl(key), is_private: isPrivate };
    let accessUrl: string;
    try { accessUrl = signPrivateMaterial(privateAsset); }
    catch { return c.json({ error: "素材访问服务未配置，请联系管理员。" }, 503); }
    let url: string; let size: number;
    if (file) {
      ({ url } = await service.uploadStorage.put({ key, body: Buffer.from(await file.arrayBuffer()), contentType: mime }));
      size = file.size;
    } else {
      const upload = meteredUpload(c.req.raw.body!, max);
      try { ({ url } = await service.uploadStorage.putStream(key, upload.stream, mime, declared)); }
      catch (error) {
        // A cut-off or oversized body leaves a partial file; it never gets an asset row.
        await service.uploadStorage.delete(key).catch(() => {});
        if (error instanceof UploadTooLargeError) return c.json({ error: tooLarge }, 400);
        throw error;
      }
      size = upload.state.size;
      if (!size) { await service.uploadStorage.delete(key).catch(() => {}); return c.json({ error: "file is required" }, 400); }
    }

    await service.db.createAsset({
      id, taskId: null, userId, type: "upload",
      storageKey: key, url, mime, sizeBytes: size, originalName: name, isPrivate,
    });

    c.header("Cache-Control", "no-store");
    return c.json({ assetId: id, filename: name, mime, size, url: isPrivate ? accessUrl : url, kind });
  });

  return app;
}
