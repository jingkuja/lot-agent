import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createAssetRoutes } from "./assets.js";

const upload = {
  id: "3b259ffd-e551-4a1d-9467-fd795256432a",
  user_id: "u1",
  task_id: null,
  type: "upload",
  storage_key: "stored.pdf",
  original_name: "方案.pdf",
  url: "/static/uploads/stored.pdf",
  mime: "application/pdf",
  size_bytes: 2048,
  width: null,
  height: null,
  duration_sec: null,
  created_at: "2026-08-18T00:00:00.000Z",
};

function makeApp(overrides: Record<string, unknown> = {}) {
  const service = {
    uploadStorage: { delete: vi.fn(async () => {}) },
    db: {
      listUserUploads: vi.fn(async () => [upload]),
      getAsset: vi.fn(async () => upload),
      deleteUserUpload: vi.fn(async () => upload),
    },
    ...overrides,
  } as any;
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
  app.route("/", createAssetRoutes(service));
  return { app, service };
}

describe("file links", () => {
  const document = { user_id: "u1", storage_key: "d.docx", is_private: true };
  const post = (app: Hono<any>, urls: unknown) => app.request("/links", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ urls }),
  });

  function linkApp(row: unknown, uploadRow: unknown = null) {
    const { app, service } = makeApp();
    service.db.getGeneratedByStorageKey = vi.fn(async () => row);
    service.db.getUploadByStorageKey = vi.fn(async () => uploadRow);
    return { app, service };
  }

  it("signs the owner's private document and leaves its stored URL out of it", async () => {
    vi.stubEnv("SECRET_MASTER_KEY", "11".repeat(32));
    try {
      const { app } = linkApp(document);
      const { links } = await (await post(app, ["/static/documents/d.docx"])).json() as { links: Record<string, string> };
      expect(links["/static/documents/d.docx"]).toMatch(/^\/static\/documents\/d\.docx\?material_token=/);
    } finally { vi.unstubAllEnvs(); }
  });

  it("signs a slide preview by its deck", async () => {
    vi.stubEnv("SECRET_MASTER_KEY", "11".repeat(32));
    try {
      const { app, service } = linkApp(document);
      await post(app, ["/static/documents/d-slide-3.png"]);
      expect(service.db.getGeneratedByStorageKey).toHaveBeenCalledWith("d.pptx");
    } finally { vi.unstubAllEnvs(); }
  });

  it("signs a private upload the same way", async () => {
    vi.stubEnv("SECRET_MASTER_KEY", "11".repeat(32));
    try {
      const { app } = linkApp(null, { ...upload, is_private: true });
      const { links } = await (await post(app, [upload.url])).json() as { links: Record<string, string> };
      expect(links[upload.url]).toContain("material_token=");
    } finally { vi.unstubAllEnvs(); }
  });

  it("returns public files and other accounts' files unchanged", async () => {
    vi.stubEnv("SECRET_MASTER_KEY", "11".repeat(32));
    try {
      for (const row of [{ ...document, is_private: false }, { ...document, user_id: "u2" }, null]) {
        const { app } = linkApp(row);
        const { links } = await (await post(app, ["/static/documents/d.docx"])).json() as { links: Record<string, string> };
        expect(links["/static/documents/d.docx"]).toBe("/static/documents/d.docx");
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it("ignores anything that is not a local file path", async () => {
    const { app, service } = linkApp(document);
    const { links } = await (await post(app, ["https://evil.example/x"])).json() as { links: Record<string, string> };
    expect(links["https://evil.example/x"]).toBe("https://evil.example/x");
    expect(service.db.getGeneratedByStorageKey).not.toHaveBeenCalled();
  });

  it.each([[null], ["/static/documents/d.docx"], [[1]], [Array(101).fill("/x")]])("rejects %j", async (urls) => {
    const { app } = linkApp(document);
    expect((await post(app, urls)).status).toBe(400);
  });
});

describe("asset file management", () => {
  it("renews a private preview only for its owner and does not modify its stored URL", async () => {
    vi.stubEnv("SECRET_MASTER_KEY", "11".repeat(32));
    try {
      const { app, service } = makeApp();
      const privateAsset = { ...upload, is_private: true };
      service.db.getAsset.mockResolvedValue(privateAsset);
      const response = await app.request(`/${upload.id}`);
      expect(response.status).toBe(200);
      expect((await response.json() as { url: string }).url).toContain("material_token=");
      expect(privateAsset.url).toBe(upload.url);
      service.db.getAsset.mockResolvedValue({ ...privateAsset, user_id: "u2" });
      expect((await app.request(`/${upload.id}`)).status).toBe(404);
    } finally { vi.unstubAllEnvs(); }
  });
  it("lists only the current user's uploads as safe public metadata", async () => {
    const { app, service } = makeApp();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{
      id: upload.id,
      filename: "方案.pdf",
      mime: "application/pdf",
      size: 2048,
      url: "/static/uploads/stored.pdf",
      createdAt: "2026-08-18T00:00:00.000Z",
    }] });
    expect(service.db.listUserUploads).toHaveBeenCalledWith("u1");
  });

  it("deletes the stored object and its row for an owned upload", async () => {
    const { app, service } = makeApp();
    const res = await app.request(`/${upload.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(service.uploadStorage.delete).toHaveBeenCalledWith("stored.pdf");
    expect(service.db.deleteUserUpload).toHaveBeenCalledWith(upload.id, "u1");
  });

  it("does not reveal or delete another user's upload", async () => {
    const foreign = { ...upload, user_id: "u2" };
    const { app, service } = makeApp({
      uploadStorage: { delete: vi.fn(async () => {}) },
      db: {
        listUserUploads: vi.fn(async () => []),
        getAsset: vi.fn(async () => foreign),
        deleteUserUpload: vi.fn(),
      },
    });
    const res = await app.request(`/${upload.id}`, { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(service.uploadStorage.delete).not.toHaveBeenCalled();
    expect(service.db.deleteUserUpload).not.toHaveBeenCalled();
  });
});
