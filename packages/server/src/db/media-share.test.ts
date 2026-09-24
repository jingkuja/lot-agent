import { describe, it, expect, vi } from "vitest";
import { DB } from "./database.js";
describe("shared media selectors", () => {
  it("keeps ownership mandatory for image and video management and allows only safe image types or MP4", async () => {
    const db = Object.create(DB.prototype) as DB;
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    Object.assign(db, { pool: { query } });
    await db.getOwnedImageShare("video.mp4", "owner");
    await db.createImageShare("video.mp4", "owner", "token", "title");
    for (const [sql, params] of query.mock.calls) {
      expect(sql).toContain("storage_key = $1 AND user_id = $2");
      expect(sql).toContain("OR (type = 'video' AND mime = 'video/mp4'))");
      expect(params.slice(0, 2)).toEqual(["video.mp4", "owner"]);
    }
    await db.getSharedImage("token");
    expect(query.mock.lastCall?.[0]).toContain("share_token = $1");
    expect(query.mock.lastCall?.[1]).toEqual(["token"]);
  });
});
