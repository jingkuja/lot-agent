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
  });

  it("rejects with 413 before reading the body when Content-Length exceeds the precheck cap", async () => {
    const service = makeService();
    const app = appFor(service);
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-length": String(22 * 1024 * 1024) },
      body: fileBody("note.txt", "text/plain", new Uint8Array([104, 105])),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload too large" });
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
});
