import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createUploadRoutes } from "./uploads.js";

function makeService() {
  const created: any[] = [];
  return {
    created,
    uploadStorage: {
      put: vi.fn(async () => ({ url: "" })),
      getUrl: (k: string) => `/static/uploads/${k}`,
      get: vi.fn(),
      delete: vi.fn(),
    },
    db: { createAsset: vi.fn(async (a: any) => { created.push(a); }) },
  } as any;
}

function appFor(service: any) {
  const wrap = new Hono();
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
    const json = await res.json();
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
    const json = await res.json();
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
});
