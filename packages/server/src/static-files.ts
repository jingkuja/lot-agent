import type { Context } from "hono";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { resolve } from "node:path";

/**
 * Guess a response Content-Type from a stored filename's extension. Pure
 * lookup, no I/O — used both to pick the on-disk mime and (via
 * `contentPolicy`) to decide whether it's safe to render inline.
 */
export function guessMime(name: string): string {
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".svg")) return "image/svg+xml";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".mp4")) return "video/mp4";
  if (name.endsWith(".mp3")) return "audio/mpeg";
  if (name.endsWith(".docx"))
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (name.endsWith(".html")) return "text/html; charset=utf-8";
  if (name.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

export interface ContentPolicy {
  contentType: string;
  disposition: "inline" | "attachment";
}

/**
 * Decide the response Content-Type and Content-Disposition for a given mime.
 *
 * This is the active-content isolation boundary: only a narrow whitelist of
 * passive/renderable types is allowed to render inline (in the browser, on
 * our own origin — where a stolen session token lives in localStorage).
 * Anything else, including `text/html` and `image/svg+xml` (both of which
 * can carry executable script), is forced to `application/octet-stream` +
 * `attachment` so the browser downloads it instead of executing it same
 * origin.
 */
export function contentPolicy(mime: string): ContentPolicy {
  const base = mime.split(";")[0]?.trim() ?? mime;
  const inlineWhitelisted =
    (base.startsWith("image/") && base !== "image/svg+xml") ||
    base === "application/pdf" ||
    base === "video/mp4" ||
    base === "audio/mpeg" ||
    base === "text/plain" ||
    base === "text/markdown";

  if (inlineWhitelisted) {
    return { contentType: mime, disposition: "inline" };
  }
  return { contentType: "application/octet-stream", disposition: "attachment" };
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse a single-range `Range` header (`bytes=start-end` / `bytes=start-` /
 * `bytes=-suffix`) against a known file size.
 *
 * - `null` — no Range header was sent; caller should serve the full file.
 * - `"invalid"` — header present but unparsable, or out of bounds (start >
 *   end, or start >= size); caller should respond 416. Multi-range requests
 *   (comma-separated) are also treated as `"invalid"` — we don't support
 *   multipart/byteranges responses, and refusing is simpler/safer than
 *   silently returning the whole file under a 206 status.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | "invalid" | null {
  if (header === undefined) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "invalid";

  const [, startStr, endStr] = match;
  if (startStr === "" && endStr === "") return "invalid";

  let start: number;
  let end: number;
  if (startStr === "") {
    // suffix range: last N bytes
    const suffixLength = Number(endStr);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return "invalid";
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? size - 1 : Number(endStr);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return "invalid";
  if (start < 0 || end < 0 || start > end) return "invalid";
  if (start >= size) return "invalid";

  if (end >= size) end = size - 1;

  return { start, end };
}

/**
 * Hono handler factory serving files out of `dir` with streaming bodies,
 * Range support, and the active-content isolation policy from
 * `contentPolicy`.
 */
export function staticFileHandler(dir: string) {
  return async (c: Context): Promise<Response> => {
    const filename = c.req.param("filename");
    if (!filename || filename.includes("/") || filename.includes("..")) {
      return c.text("bad request", 400);
    }

    const path = resolve(dir, filename);
    let size: number;
    try {
      const stats = await stat(path);
      if (!stats.isFile()) return c.text("not found", 404);
      size = stats.size;
    } catch {
      return c.text("not found", 404);
    }

    const mime = guessMime(filename);
    const { contentType, disposition } = contentPolicy(mime);

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
    };
    if (disposition === "attachment") {
      // filename is already validated above (no `/`, no `..`); still quote
      // it defensively since it's user/vendor-controlled content.
      const safeName = filename.replace(/"/g, "");
      headers["Content-Disposition"] = `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
    } else {
      headers["Content-Disposition"] = "inline";
    }

    const range = parseRange(c.req.header("range"), size);

    if (range === "invalid") {
      return c.body(null, 416, {
        ...headers,
        "Content-Range": `bytes */${size}`,
      });
    }

    if (range === null) {
      headers["Content-Length"] = String(size);
      const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
      return c.body(stream, 200, headers);
    }

    const { start, end } = range;
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    headers["Content-Length"] = String(end - start + 1);
    const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
    return c.body(stream, 206, headers);
  };
}
