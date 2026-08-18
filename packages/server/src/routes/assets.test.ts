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
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
  app.route("/", createAssetRoutes(service));
  return { app, service };
}

describe("asset file management", () => {
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
