import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  guessMime,
  contentPolicy,
  parseRange,
  staticFileHandler,
} from "./static-files.js";

describe("guessMime", () => {
  it("maps known extensions", () => {
    expect(guessMime("a.png")).toBe("image/png");
    expect(guessMime("a.jpg")).toBe("image/jpeg");
    expect(guessMime("a.jpeg")).toBe("image/jpeg");
    expect(guessMime("a.svg")).toBe("image/svg+xml");
    expect(guessMime("a.webp")).toBe("image/webp");
    expect(guessMime("a.gif")).toBe("image/gif");
    expect(guessMime("a.mp4")).toBe("video/mp4");
    expect(guessMime("a.mp3")).toBe("audio/mpeg");
    expect(guessMime("a.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    expect(guessMime("a.pdf")).toBe("application/pdf");
    expect(guessMime("a.md")).toBe("text/markdown; charset=utf-8");
    expect(guessMime("a.html")).toBe("text/html; charset=utf-8");
    expect(guessMime("a.txt")).toBe("text/plain; charset=utf-8");
  });

  it("falls back to octet-stream for unknown extensions", () => {
    expect(guessMime("a.bin")).toBe("application/octet-stream");
    expect(guessMime("noext")).toBe("application/octet-stream");
  });
});

describe("contentPolicy", () => {
  it("forces html to attachment + octet-stream (active content isolation)", () => {
    expect(contentPolicy("text/html; charset=utf-8")).toEqual({
      contentType: "application/octet-stream",
      disposition: "attachment",
    });
    expect(contentPolicy("text/html")).toEqual({
      contentType: "application/octet-stream",
      disposition: "attachment",
    });
  });

  it("forces svg to attachment + octet-stream (svg can carry script)", () => {
    expect(contentPolicy("image/svg+xml")).toEqual({
      contentType: "application/octet-stream",
      disposition: "attachment",
    });
  });

  it("allows other image/* types inline", () => {
    expect(contentPolicy("image/png")).toEqual({
      contentType: "image/png",
      disposition: "inline",
    });
    expect(contentPolicy("image/jpeg")).toEqual({
      contentType: "image/jpeg",
      disposition: "inline",
    });
  });

  it("allows pdf, mp4, mpeg audio inline", () => {
    expect(contentPolicy("application/pdf")).toEqual({
      contentType: "application/pdf",
      disposition: "inline",
    });
    expect(contentPolicy("video/mp4")).toEqual({
      contentType: "video/mp4",
      disposition: "inline",
    });
    expect(contentPolicy("audio/mpeg")).toEqual({
      contentType: "audio/mpeg",
      disposition: "inline",
    });
  });

  it("allows text/plain and text/markdown inline, including charset suffix", () => {
    expect(contentPolicy("text/plain; charset=utf-8")).toEqual({
      contentType: "text/plain; charset=utf-8",
      disposition: "inline",
    });
    expect(contentPolicy("text/markdown; charset=utf-8")).toEqual({
      contentType: "text/markdown; charset=utf-8",
      disposition: "inline",
    });
    expect(contentPolicy("text/plain")).toEqual({
      contentType: "text/plain",
      disposition: "inline",
    });
  });

  it("forces docx and unknown types to attachment + octet-stream", () => {
    expect(
      contentPolicy(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      )
    ).toEqual({ contentType: "application/octet-stream", disposition: "attachment" });
    expect(contentPolicy("application/octet-stream")).toEqual({
      contentType: "application/octet-stream",
      disposition: "attachment",
    });
    expect(contentPolicy("application/x-weird")).toEqual({
      contentType: "application/octet-stream",
      disposition: "attachment",
    });
  });
});

describe("parseRange", () => {
  const size = 1000;

  it("returns null when no Range header", () => {
    expect(parseRange(undefined, size)).toBeNull();
  });

  it("parses bytes=start-end", () => {
    expect(parseRange("bytes=0-99", size)).toEqual({ start: 0, end: 99 });
  });

  it("parses bytes=start-", () => {
    expect(parseRange("bytes=100-", size)).toEqual({ start: 100, end: 999 });
  });

  it("parses bytes=-suffix", () => {
    expect(parseRange("bytes=-100", size)).toEqual({ start: 900, end: 999 });
  });

  it("returns invalid when start > end", () => {
    expect(parseRange("bytes=500-100", size)).toBe("invalid");
  });

  it("returns invalid when start >= size", () => {
    expect(parseRange("bytes=1000-1050", size)).toBe("invalid");
  });

  it("returns invalid on garbage syntax", () => {
    expect(parseRange("bytes=abc-def", size)).toBe("invalid");
    expect(parseRange("nonsense", size)).toBe("invalid");
    expect(parseRange("bytes=", size)).toBe("invalid");
  });
});

describe("staticFileHandler", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "static-files-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function appFor(targetDir: string) {
    const app = new Hono();
    app.get("/:filename", (c) => staticFileHandler(targetDir)(c));
    return app;
  }

  it("serves a full file with 200 and correct headers for an inline-whitelisted type", async () => {
    const bytes = Buffer.from("hello png bytes");
    await writeFile(join(dir, "a.png"), bytes);
    const app = appFor(dir);
    const res = await app.request("/a.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("content-length")).toBe(String(bytes.length));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(bytes)).toBe(true);
  });

  it("serves html as attachment + octet-stream (active content isolation)", async () => {
    const bytes = Buffer.from("<script>alert(document.cookie)</script>");
    await writeFile(join(dir, "evil.html"), bytes);
    const app = appFor(dir);
    const res = await app.request("/evil.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain("evil.html");
  });

  it("serves a valid byte range with 206", async () => {
    const bytes = Buffer.from("0123456789abcdefghij");
    await writeFile(join(dir, "range.txt"), bytes);
    const app = appFor(dir);
    const res = await app.request("/range.txt", { headers: { Range: "bytes=2-5" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 2-5/${bytes.length}`);
    expect(res.headers.get("content-length")).toBe("4");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.toString()).toBe("2345");
  });

  it("returns 416 for an out-of-range Range header", async () => {
    const bytes = Buffer.from("short");
    await writeFile(join(dir, "s.txt"), bytes);
    const app = appFor(dir);
    const res = await app.request("/s.txt", { headers: { Range: "bytes=1000-2000" } });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${bytes.length}`);
  });

  it("returns 404 for missing file", async () => {
    const app = appFor(dir);
    const res = await app.request("/nope.png");
    expect(res.status).toBe(404);
  });

  it("returns 400 for path traversal attempts", async () => {
    const app = appFor(dir);
    const res1 = await app.request("/..%2Fsecret");
    expect(res1.status).toBe(400);
  });
});
