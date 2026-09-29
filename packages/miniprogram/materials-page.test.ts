import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ listUploads: vi.fn(), deleteUpload: vi.fn() }));
vi.mock("./miniprogram/services/api", () => ({ api, absoluteMedia: (url: string) => `https://example.com${url}` }));
let owner = "u1";
vi.mock("./miniprogram/services/session", () => ({ getUser: () => ({ id: owner }) }));
let page: any;
const image = { id: "img", filename: "照片.png", mime: "image/png", url: "/photo.png" };
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); owner = "u1";
  vi.stubGlobal("getApp", () => ({ ensureSession: async () => true }));
  vi.stubGlobal("wx", { showModal: vi.fn(({ success }) => success({ confirm: true })), showToast: vi.fn(), previewImage: vi.fn(), stopPullDownRefresh: vi.fn() });
  vi.stubGlobal("Page", (definition: any) => { page = { ...definition, data: structuredClone(definition.data), setData(patch: any) { Object.assign(this.data, patch); } }; });
  api.listUploads.mockResolvedValue({ data: [image, { id: "doc", mime: "application/pdf" }] });
  api.deleteUpload.mockResolvedValue({ ok: true });
  await import("./miniprogram/pages/materials/index");
});
afterEach(() => vi.unstubAllGlobals());
it("shows only uploaded images and previews them", async () => {
  await page.reload();
  expect(page.data.items).toEqual([{ ...image, url: "https://example.com/photo.png" }]);
  page.preview({ currentTarget: { dataset: { id: "img" } } });
  expect(wx.previewImage).toHaveBeenCalledWith({ current: "https://example.com/photo.png", urls: ["https://example.com/photo.png"] });
});
it("deletes a confirmed image and removes it from the list", async () => {
  await page.reload(); await page.remove({ currentTarget: { dataset: { id: "img" } } });
  expect(api.deleteUpload).toHaveBeenCalledWith("img"); expect(page.data.items).toEqual([]);
});
it("does not delete when confirmation is cancelled", async () => {
  vi.mocked(wx.showModal).mockImplementation(({ success }: any) => success({ confirm: false }));
  await page.reload(); await page.remove({ currentTarget: { dataset: { id: "img" } } });
  expect(api.deleteUpload).not.toHaveBeenCalled(); expect(page.data.items).toHaveLength(1);
});
it("retains the image and releases controls after deletion fails", async () => {
  api.deleteUpload.mockRejectedValue(new Error("network"));
  await page.reload(); await page.remove({ currentTarget: { dataset: { id: "img" } } });
  expect(page.data.items).toHaveLength(1); expect(page.data.deletingId).toBe("");
  expect(wx.showToast).toHaveBeenCalledWith({ title: "删除失败，请重试", icon: "none" });
});
it("shows a retry state after loading fails", async () => {
  api.listUploads.mockRejectedValue(new Error("network"));
  await page.reload(); expect(page.data.error).toBeTruthy(); expect(page.data.loading).toBe(false);
});
it("ignores a response from a previous account", async () => {
  let resolve!: (value: unknown) => void;
  api.listUploads.mockImplementation(() => new Promise(r => { resolve = r; }));
  const loading = page.reload(); await Promise.resolve(); owner = "u2";
  resolve({ data: [image] }); await loading;
  expect(page.data.items).toEqual([]);
});
