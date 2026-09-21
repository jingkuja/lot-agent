import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ sharedImage: vi.fn(), imageShareStatus: vi.fn(), createImageShare: vi.fn(), revokeImageShare: vi.fn() }));
vi.mock("./miniprogram/services/api", () => ({ api, absoluteMedia: (url: string) => `https://media.example.com${url}` }));
let page: any;
let app: any;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  app = { ensureSession: vi.fn().mockResolvedValue(true), globalData: {} };
  vi.stubGlobal("getApp", () => app);
  vi.stubGlobal("wx", { hideShareMenu: vi.fn(), showShareMenu: vi.fn(), showToast: vi.fn() });
  vi.stubGlobal("Page", (definition: any) => {
    page = { ...definition, data: { ...definition.data }, setData(update: any) { Object.assign(this.data, update); } };
  });
  await import("./miniprogram/pages/preview/index");
});
afterEach(() => vi.unstubAllGlobals());

describe("shared work landing", () => {
  it("opens the selected image without login or private conversation APIs", async () => {
    api.sharedImage.mockResolvedValue({ title: "作品", url: "/static/assets/work.png", mime: "image/png" });
    page.onLoad({ share: "a".repeat(48), src: "https://untrusted.example/image.png" });
    await page.onShow();
    expect(app.ensureSession).not.toHaveBeenCalled();
    expect(page.data.src).toBe("https://media.example.com/static/assets/work.png");
    expect(page.onShareAppMessage().path).toBe(`/pages/preview/index?share=${"a".repeat(48)}`);
    expect(api.createImageShare).not.toHaveBeenCalled();
  });

  it("clears a previously viewed image and disables resharing after revocation", async () => {
    api.sharedImage.mockResolvedValueOnce({ title: "作品", url: "/static/assets/work.png" });
    page.onLoad({ share: "a".repeat(48) });
    await page.onShow();
    api.sharedImage.mockRejectedValueOnce(new Error("作品不存在或分享已撤销"));
    await page.onShow();
    expect(page.data).toMatchObject({ src: "", shareToken: "", error: "作品不存在或分享已撤销", loading: false });
  });

  it("does not publish an owner's image merely by opening the preview", async () => {
    api.imageShareStatus.mockResolvedValue({ token: null });
    page.onLoad({ src: encodeURIComponent("https://media.example.com/static/assets/own.png") });
    await page.onShow();
    expect(api.createImageShare).not.toHaveBeenCalled();
    api.createImageShare.mockResolvedValue({ token: "b".repeat(48), title: "图片" });
    await page.prepareShare();
    expect(page.data.shareToken).toBe("b".repeat(48));
    expect(page.onShareAppMessage().path).toContain("?share=");
    expect(page.onShareAppMessage().path).not.toContain("src=");
  });
});
