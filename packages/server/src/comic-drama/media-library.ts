import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { Hono } from "hono";
import { COMIC_MEDIA_PATH, type ComicLibraryRepository, type ComicMaterialKind, type ComicMediaLinks, type StoredComicMedia } from "@lot-agent/core/comic-drama";
import { createUploadAccessGuard, privateFilesEnabled, signPrivateMaterial, type PrivateMaterialOptions } from "../generation/private-materials.js";
import { inspectMedia } from "../marketing-video/media.js";
import { staticFileHandler } from "../static-files.js";
import { meteredUpload, UploadTooLargeError } from "../util/metered-upload.js";
import { ComicLibraryError, libraryMissing } from "./library-db.js";

const imageFormats: Record<string, string> = { jpeg: "jpg", png: "png", webp: "webp" };
const allowedMime = new Map([["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"], ["audio/wav", "wav"], ["audio/mpeg", "mp3"]]);
const MiB = 1024 * 1024;

function limits(kind: ComicMaterialKind | "character", mime: string) {
  const image = mime.startsWith("image/");
  const ext = allowedMime.get(mime);
  if (!ext || (kind !== "other" && image !== !["music", "sound"].includes(kind))) throw new ComicLibraryError("UNSUPPORTED_MEDIA", 415);
  return { ext, maxBytes: MiB * (image ? 20 : kind === "sound" ? 15 : 30), maxMs: kind === "sound" ? 30_000 : 300_000 };
}

async function probe(path: string, thumb: string, ext: string, maxMs: number, signal: AbortSignal) {
  if (ext === "mp3" || ext === "wav") {
    const info = await inspectMedia(path, signal);
    if (info.format !== ext || !info.audio || info.video) throw new ComicLibraryError("UNSUPPORTED_MEDIA", 415);
    if (info.duration * 1000 > maxMs) throw new ComicLibraryError("MEDIA_TOO_LONG", 400);
    return { width: null, height: null, durationMs: Math.max(1, Math.round(info.duration * 1000)) };
  }
  const decoder = sharp(path, { limitInputPixels: 40_000_000, failOn: "warning" });
  const info = await decoder.metadata();
  if (imageFormats[info.format ?? ""] !== ext || !info.width || !info.height || (info.pages ?? 1) > 1) {
    throw new ComicLibraryError("UNSUPPORTED_MEDIA", 415);
  }
  signal.throwIfAborted();
  await decoder.autoOrient().resize(480, 480, { fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toFile(thumb);
  const swapsAxes = (info.orientation ?? 1) >= 5;
  return { width: swapsAxes ? info.height : info.width, height: swapsAxes ? info.width : info.height, durationMs: null };
}

export class ComicMediaLibrary {
  constructor(
    private readonly root: string,
    private readonly repo: Pick<ComicLibraryRepository, "media" | "file">,
    private readonly signing: PrivateMaterialOptions = {},
  ) {}

  async upload<T>(request: Request, owner: string, kind: ComicMaterialKind | "character", persist: (media: StoredComicMedia) => Promise<T>) {
    if (!privateFilesEnabled(this.signing)) throw new ComicLibraryError("MEDIA_UNAVAILABLE", 503);
    const typedMime = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    const mime = typedMime === "audio/x-wav" ? "audio/wav" : typedMime ?? "";
    const { ext, maxBytes, maxMs } = limits(kind, mime);
    if (!request.body) throw new ComicLibraryError("FILE_REQUIRED", 400);
    if (Number(request.headers.get("content-length")) > maxBytes) throw new ComicLibraryError("MEDIA_TOO_LARGE", 413);
    const id = randomUUID();
    const storageKey = `${id}.${ext}`;
    const thumbnailKey = mime.startsWith("image/") ? `${id}-thumb.webp` : null;
    // Validate the key before writing; never publish a file we cannot sign.
    this.sign(owner, id, storageKey);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temp = await mkdtemp(join(this.root, ".upload-"));
    const original = join(temp, storageKey);
    const thumb = join(temp, "preview.webp");
    const placed: string[] = [];
    let writingRows = false;
    try {
      const upload = meteredUpload(request.body as unknown as AsyncIterable<Uint8Array>, maxBytes);
      await pipeline(upload.stream, createWriteStream(original, { flags: "wx", mode: 0o600 }), { signal: request.signal });
      if (!upload.state.size) throw new ComicLibraryError("FILE_REQUIRED", 400);
      const dimensions = await probe(original, thumb, ext, maxMs, request.signal).catch(error => {
        if (error instanceof ComicLibraryError || request.signal.aborted) throw error;
        throw new ComicLibraryError("UNSUPPORTED_MEDIA", 415);
      });
      request.signal.throwIfAborted();
      for (const [from, key] of [[original, storageKey], [thumb, thumbnailKey]] as const) {
        if (!key) continue;
        const target = join(this.root, key);
        await rename(from, target);
        placed.push(target);
      }
      request.signal.throwIfAborted();
      writingRows = true;
      return await persist({ id, owner, storageKey, thumbnailKey, mime, sizeBytes: upload.state.size, hasThumbnail: !!thumbnailKey, ...dimensions });
    } catch (error) {
      // On a lost commit response, keep bytes until ownership can be verified.
      const safeToRemove = !writingRows || await this.repo.media(owner, id).then(media => !media, () => false);
      if (safeToRemove) await Promise.allSettled(placed.map(path => rm(path, { force: true })));
      if (error instanceof UploadTooLargeError) throw new ComicLibraryError("MEDIA_TOO_LARGE", 413);
      throw error;
    } finally {
      await rm(temp, { recursive: true, force: true }).catch(() => {});
    }
  }

  private sign(owner: string, id: string, key: string) {
    try {
      return signPrivateMaterial({ id, user_id: owner, storage_key: key, url: "", type: "upload", is_private: true },
        { ...this.signing, publicBaseUrl: "", materialPath: COMIC_MEDIA_PATH });
    } catch { throw new ComicLibraryError("MEDIA_UNAVAILABLE", 503); }
  }

  async links(owner: string, id: string): Promise<ComicMediaLinks> {
    const media = await this.repo.media(owner, id);
    if (!media) libraryMissing();
    return { url: this.sign(owner, id, media.storageKey), thumbnailUrl: media.thumbnailKey ? this.sign(owner, id, media.thumbnailKey) : null };
  }

  publicRoutes(sessions: Parameters<typeof createUploadAccessGuard>[1]) {
    const app = new Hono();
    const guard = createUploadAccessGuard({
      getUploadByStorageKey: async key => {
        if (!/^[0-9a-f-]{36}(?:-thumb)?\.(?:jpg|png|webp|mp3|wav)$/.test(key)) return null;
        const row = await this.repo.file(key);
        return row ? { id: row.id, user_id: row.owner, storage_key: key, url: "", type: "upload", is_private: true } : null;
      },
    }, sessions, this.signing);
    app.use("*", async (c, next) => {
      c.header("Referrer-Policy", "no-referrer");
      await next();
    });
    app.get("/:filename", staticFileHandler(this.root, { authorize: guard }));
    return app;
  }
}
