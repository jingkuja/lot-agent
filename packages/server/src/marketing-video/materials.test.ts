import { describe, expect, it, vi } from "vitest";
import { GROK_MARKETING_PROFILE, MarketingDraftSchema } from "@lot-agent/core/marketing-video";
import { inspectMedia } from "./media.js";
import { MarketingMaterials } from "./materials.js";

vi.mock("./media.js", () => ({ inspectMedia: vi.fn(), ownedAssetPath: vi.fn(async () => "/data/file") }));
vi.mock("./image-size.js", () => ({ readImageInfo: vi.fn(async () => ({ mime: "image/png", width: 800, height: 800 })) }));

const portrait = "11111111-1111-4111-8111-111111111111", music = "22222222-2222-4222-8222-222222222222", voice = "33333333-3333-4333-8333-333333333333";
const assets: Record<string, Record<string, unknown>> = {
  [portrait]: { id: portrait, user_id: "owner", type: "upload", is_private: true, url: "/static/uploads/p.png", mime: "image/png", size_bytes: 1024, original_name: "p.png" },
  [music]: { id: music, user_id: "owner", type: "upload", is_private: true, url: "/static/uploads/m.mp3", mime: "audio/mpeg", size_bytes: 1024, original_name: "m.mp3" },
  [voice]: { id: voice, user_id: "owner", type: "upload", is_private: true, url: "/static/uploads/v.wav", mime: "audio/wav", size_bytes: 1024, original_name: "v.wav" },
};
function materials() {
  const db = { pool: { query: vi.fn() }, getAsset: vi.fn(async (id: string) => assets[id] ? { ...assets[id] } : null), protectMarketingUpload: vi.fn() };
  return { db, materials: new MarketingMaterials(db as never, "/data") };
}
const signal = new AbortController().signal;

describe("draft materials", () => {
  it("keeps a file an earlier version accepted readable, but refuses it for a new draft", async () => {
    const { materials: m } = materials();
    const draft = MarketingDraftSchema.parse({ assets: { portrait: [portrait] } });
    assets[portrait].size_bytes = 30 * 1024 * 1024;
    try {
      await expect(m.owned("owner", draft)).rejects.toMatchObject({ message: "素材格式或大小不支持" });
      const owned = await m.owned("owner", draft, { historicalDraft: draft });
      expect(owned[portrait]).toMatchObject({ issue: "unsupported", name: "p.png" });
      expect(owned.portrait).toBe(owned[portrait]);
    } finally { assets[portrait].size_bytes = 1024; }
  });
  it("never shows another owner's file and skips deleted ones only when asked", async () => {
    const { materials: m } = materials();
    await expect(m.owned("intruder", MarketingDraftSchema.parse({ assets: { music } }))).rejects.toMatchObject({ status: 404 });
    const missing = MarketingDraftSchema.parse({ assets: { music: "44444444-4444-4444-8444-444444444444" } });
    await expect(m.owned("owner", missing)).rejects.toMatchObject({ status: 404 });
    expect(await m.owned("owner", missing, { allowMissing: true })).toEqual({});
  });
  it("names the file that fails: music without sound, or a voice sample of the wrong length", async () => {
    const { materials: m } = materials();
    vi.mocked(inspectMedia).mockResolvedValueOnce({ audio: false, video: false, duration: 30 } as never);
    const check = (assets: object, extra: object = {}) =>
      m.check("owner", MarketingDraftSchema.parse({ assets, ...extra }), GROK_MARKETING_PROFILE, 4, true, signal);
    await expect(check({ music })).rejects.toMatchObject({ message: "背景音乐不含音轨" });
    vi.mocked(inspectMedia).mockResolvedValueOnce({ audio: true, video: false, duration: 20 } as never);
    await expect(check({ voice })).rejects.toMatchObject({ message: "声音样例时长需为 2–15 秒" });
    // Twin narration ignores the voice sample, so it is not inspected.
    vi.mocked(inspectMedia).mockClear();
    await check({ voice }, { narration: {} });
    expect(inspectMedia).not.toHaveBeenCalled();
  });
});
