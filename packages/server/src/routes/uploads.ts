import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import type { AgentService } from "../services/agent-service.js";
import { attachmentKind } from "../services/attachment-extractor.js";

type Variables = { userId: string };

const ALLOWED = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "text/plain", "text/markdown", "text/csv", "application/json",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_DOC = 20 * 1024 * 1024;

export function createUploadRoutes(service: AgentService) {
  const app = new Hono<{ Variables: Variables }>();

  app.post("/", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.parseBody();
    const file = body["file"];
    if (!(file instanceof File)) {
      return c.json({ error: "file is required" }, 400);
    }
    const mime = file.type || "application/octet-stream";
    const isAllowed = ALLOWED.has(mime) || mime.startsWith("text/");
    if (!isAllowed) {
      return c.json({ error: `unsupported type: ${mime}` }, 400);
    }
    const kind = attachmentKind(mime);
    const size = file.size;
    if (kind === "image" && size > MAX_IMAGE) {
      return c.json({ error: "image too large (max 10MB)" }, 400);
    }
    if (kind === "doc" && size > MAX_DOC) {
      return c.json({ error: "document too large (max 20MB)" }, 400);
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const ext = extname(file.name) || "";
    const id = randomUUID();
    const key = `${id}${ext}`;
    const { url } = await service.uploadStorage.put({
      key, body: buf, contentType: mime,
    });

    await service.db.createAsset({
      id, taskId: null, userId, type: "upload",
      storageKey: key, url, mime, sizeBytes: size,
    });

    return c.json({ assetId: id, filename: file.name, mime, size, url, kind });
  });

  return app;
}
