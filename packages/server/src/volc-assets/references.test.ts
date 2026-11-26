import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSeedanceReference } from "./references.js";

const asset = { id: "local-id", user_id: "owner", mime: "video/mp4", storage_key: "video.mp4",
  type: "upload", url: "/static/uploads/video.mp4", is_private: true };
const url = "https://files.example/app/static/uploads/video.mp4?material_token=old";

function setup(state = "active", owner = "owner") {
  vi.stubEnv("PUBLIC_BASE_URL", "https://files.example/app");
  vi.stubEnv("SEEDANCE_USE_ASSET_URLS", undefined);
  vi.stubEnv("SECRET_MASTER_KEY", "42".repeat(32));
  const query = vi.fn(async () => ({ rows: [{ remote_id: "asset-private", owner_id: owner, state, deleted: false }] }));
  const db = {
    pool: { query },
    getUploadByStorageKey: vi.fn(async () => ({ ...asset, user_id: owner })),
    getGeneratedByStorageKey: vi.fn(async () => ({ ...asset, type: "video", user_id: owner })),
  };
  return { query, db: db as unknown as Parameters<typeof resolveSeedanceReference>[0] };
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("Seedance asset references", () => {
  it("converts an owned upload to a ready asset ID without forwarding its download URL", async () => {
    const { db, query } = setup();
    await expect(resolveSeedanceReference(db, "owner", url)).resolves.toBe("asset://asset-private");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO volc_assets"), ["local-id", "owner"]);
  });

  it("uses signed uploads and generated output URLs with the legacy gateway switch, without Ark lookups", async () => {
    const { db, query } = setup();
    vi.stubEnv("SEEDANCE_USE_ASSET_URLS", "1");
    await expect(resolveSeedanceReference(db, "owner", url))
      .resolves.toMatch(/^https:\/\/files\.example\/app\/static\/uploads\/video\.mp4\?material_token=(?!old$)/);
    await expect(resolveSeedanceReference(db, "owner", "/static/assets/video.mp4"))
      .resolves.toMatch(/^https:\/\/files\.example\/app\/static\/assets\/video\.mp4\?material_token=/);
    await expect(resolveSeedanceReference(db, "other", url)).rejects.toThrow("素材不存在");
    await expect(resolveSeedanceReference(db, "owner", "asset://asset-private")).rejects.toThrow("请提供");
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects another owner's Agent URLs and mapped Ark IDs", async () => {
    const { db, query } = setup("active", "other");
    await expect(resolveSeedanceReference(db, "owner", url)).rejects.toThrow("素材不存在");
    expect(query).not.toHaveBeenCalled();
    await expect(resolveSeedanceReference(db, "owner", "asset://asset-private")).rejects.toThrow("素材不存在");
  });

  it("reports failed preprocessing and stops waiting when the task is cancelled", async () => {
    const failed = setup("failed");
    await expect(resolveSeedanceReference(failed.db, "owner", url)).rejects.toMatchObject({ errorCode: "MATERIAL_SYNC_FAILED" });

    const pending = setup("processing");
    const ctrl = new AbortController();
    const request = resolveSeedanceReference(pending.db, "owner", url, ctrl.signal);
    ctrl.abort();
    await expect(request).rejects.toHaveProperty("name", "AbortError");
  });
});
