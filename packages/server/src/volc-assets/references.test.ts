import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveVolcReference } from "./references.js";

const asset = { id: "local-id", user_id: "owner", mime: "video/mp4", storage_key: "video.mp4", type: "upload" };
const url = "https://files.example/app/static/uploads/video.mp4?material_token=old";

function setup(state = "active", owner = "owner") {
  vi.stubEnv("PUBLIC_BASE_URL", "https://files.example/app");
  const query = vi.fn(async () => ({ rows: [{ remote_id: "asset-private", owner_id: owner, state, deleted: false }] }));
  const db = {
    pool: { query },
    getUploadByStorageKey: vi.fn(async () => ({ ...asset, user_id: owner })),
    getGeneratedByStorageKey: vi.fn(),
  };
  return { query, db: db as unknown as Parameters<typeof resolveVolcReference>[0] };
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("Seedance asset references", () => {
  it("converts an owned upload to a ready asset ID without forwarding its download URL", async () => {
    const { db, query } = setup();
    await expect(resolveVolcReference(db, "owner", url)).resolves.toBe("asset://asset-private");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO volc_assets"), ["local-id", "owner"]);
  });

  it("rejects another owner's Agent URLs and mapped Ark IDs", async () => {
    const { db, query } = setup("active", "other");
    await expect(resolveVolcReference(db, "owner", url)).rejects.toThrow("素材不存在");
    expect(query).not.toHaveBeenCalled();
    await expect(resolveVolcReference(db, "owner", "asset://asset-private")).rejects.toThrow("素材不存在");
  });

  it("reports failed preprocessing and stops waiting when the task is cancelled", async () => {
    const failed = setup("failed");
    await expect(resolveVolcReference(failed.db, "owner", url)).rejects.toMatchObject({ errorCode: "MATERIAL_SYNC_FAILED" });

    const pending = setup("processing");
    const ctrl = new AbortController();
    const request = resolveVolcReference(pending.db, "owner", url, ctrl.signal);
    ctrl.abort();
    await expect(request).rejects.toHaveProperty("name", "AbortError");
  });
});
