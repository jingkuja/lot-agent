import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createUploadRoutes } from "./uploads.js";

function makeService() {
  const created: any[] = [];
  const service: any = {
    created,
    uploadStorage: {
      put: vi.fn(async () => ({ url: "" })),
      // Reads the stream as a real store would; `stored` keeps what arrived.
      stored: [] as Buffer[],
      putStream: vi.fn(async function (this: void, key: string, body: AsyncIterable<Buffer>) {
        const parts: Buffer[] = []; for await (const part of body) parts.push(part);
        service.uploadStorage.stored.push(Buffer.concat(parts));
        return { url: `/static/uploads/${key}` };
      }),
      getUrl: (k: string) => `/static/uploads/${k}`,
      get: vi.fn(),
      delete: vi.fn(async () => {}),
    },
    db: { createAsset: vi.fn(async (a: any) => { created.push(a); }) },
  };
  return service;
}

function appFor(service: any) {
  const wrap = new Hono<{ Variables: { userId: string } }>();
  wrap.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
  wrap.route("/", createUploadRoutes(service));
  return wrap;
}

function fileBody(name: string, type: string, bytes: Uint8Array) {
  const fd = new FormData();
  fd.append("file", new File([bytes], name, { type }));
  return fd;
}

describe("POST /uploads", () => {
  it("marks marketing inputs private at creation, returns only an expiring preview URL and persists the stable URL", async () => {
    vi.stubEnv("SECRET_MASTER_KEY", "11".repeat(32));
    try {
      const service = makeService();
      service.uploadStorage.put.mockImplementation(async ({ key }: { key: string }) => ({ url: `/static/uploads/${key}` }));
      const body = fileBody("portrait.png", "image/png", new Uint8Array([1]));
      body.append("purpose", "marketing-video");
      const response = await appFor(service).request("/", { method: "POST", body });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await response.json() as { url: string }).url).toContain("material_token=");
      expect(service.created[0].isPrivate).toBe(true);
      expect(service.created[0].url).not.toContain("?");
    } finally { vi.unstubAllEnvs(); }
  });

  it("refuses private marketing uploads before writing when signing is unavailable", async () => {
    vi.stubEnv("SECRET_MASTER_KEY", "");
    try {
      const service = makeService();
      const body = fileBody("voice.wav", "audio/wav", new Uint8Array([1]));
      body.append("purpose", "marketing-video");
      expect((await appFor(service).request("/", { method: "POST", body })).status).toBe(503);
      expect(service.uploadStorage.put).not.toHaveBeenCalled();
      expect(service.db.createAsset).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
  it("rejects disallowed mime", async () => {
    const service = makeService();
    const app = appFor(service);
    const res = await app.request("/", { method: "POST", body: fileBody("a.exe", "application/x-msdownload", new Uint8Array([1])) });
    expect(res.status).toBe(400);
  });

  it("stores allowed file and returns ref", async () => {
    const service = makeService();
    const app = appFor(service);
    const res = await app.request("/", { method: "POST", body: fileBody("note.txt", "text/plain", new Uint8Array([104, 105])) });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json).toMatchObject({ filename: "note.txt", mime: "text/plain", size: 2, kind: "doc" });
    expect(json.assetId).toBeTruthy();
    expect(service.created.length).toBe(1);
    expect(service.created[0].originalName).toBe("note.txt");
  });

  it("rejects with 413 before reading the body when Content-Length exceeds the precheck cap", async () => {
    const service = makeService();
    const app = appFor(service);
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-length": String(152 * 1024 * 1024) },
      body: fileBody("note.txt", "text/plain", new Uint8Array([104, 105])),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("payload too large") });
    // Rejected before parseBody ever ran, so no asset was created.
    expect(service.created.length).toBe(0);
  });

  it("passes the precheck for a small request (no explicit oversized Content-Length)", async () => {
    const service = makeService();
    const app = appFor(service);
    const res = await app.request("/", { method: "POST", body: fileBody("note.txt", "text/plain", new Uint8Array([104, 105])) });
    expect(res.status).toBe(200);
  });

  it("accepts a pptx template upload as doc", async () => {
    const service = makeService();
    const app = appFor(service);
    const res = await app.request("/", {
      method: "POST",
      body: fileBody(
        "tpl.pptx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        new Uint8Array([80, 75])
      ),
    });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.kind).toBe("doc");
  });

  it("accepts video and audio reference uploads", async () => {
    const service = makeService();
    const app = appFor(service);
    const video = await app.request("/", { method: "POST", body: fileBody("ref.mp4", "video/mp4", new Uint8Array([0, 1])) });
    const audio = await app.request("/", { method: "POST", body: fileBody("ref.mp3", "audio/mpeg", new Uint8Array([0, 1])) });
    expect(video.status).toBe(200);
    expect(audio.status).toBe(200);
  });

  it("streams a raw upload to storage with its name, type and purpose from the headers", async () => {
    vi.stubEnv("SECRET_MASTER_KEY", "11".repeat(32));
    try {
      const service = makeService();
      const res = await appFor(service).request("/?purpose=marketing-video", { method: "POST",
        headers: { "content-type": "video/mp4", "x-file-name": encodeURIComponent("探店 01.mp4") }, body: new Uint8Array([0, 0, 0, 24, 102, 116]) });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ filename: "探店 01.mp4", mime: "video/mp4", size: 6, kind: "doc", url: expect.stringContaining("material_token=") });
      expect(service.uploadStorage.put).not.toHaveBeenCalled();
      expect(service.uploadStorage.stored[0]).toEqual(Buffer.from([0, 0, 0, 24, 102, 116]));
      expect(service.created[0]).toMatchObject({ sizeBytes: 6, originalName: "探店 01.mp4", isPrivate: true, mime: "video/mp4" });
    } finally { vi.unstubAllEnvs(); }
  });

  it("stops a raw upload past the size limit while streaming and removes the partial file", async () => {
    const service = makeService();
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    // No Content-Length: only the streaming cap can stop it.
    const body = new ReadableStream<Uint8Array>({ pull(controller) { if (sent++ < 160) controller.enqueue(chunk); else controller.close(); } });
    const res = await appFor(service).request("/", { method: "POST", headers: { "content-type": "audio/wav" }, body, duplex: "half" } as RequestInit);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "media too large (max 150MB)" });
    expect(sent).toBeLessThan(160);
    expect(service.uploadStorage.delete).toHaveBeenCalledOnce();
    expect(service.created).toEqual([]);
  });
});
