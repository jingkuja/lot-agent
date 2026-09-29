import { afterEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ saveVideoPublication: vi.fn(async () => ({})) }));
vi.mock("./miniprogram/services/api", () => ({ api, absoluteMedia: (url: string) => url }));
afterEach(() => vi.unstubAllGlobals());

it.each([false, true])("reopens a video with separate copy and tags (local recovery: %s)", async (local) => {
  vi.resetModules();
  let page: any;
  vi.stubGlobal("Page", (def: any) => { page = { ...def, data: { ...def.data } }; });
  vi.stubGlobal("getApp", () => ({ globalData: { user: { id: "u1" } } }));
  vi.stubGlobal("wx", { navigateTo: vi.fn(), getStorageSync: vi.fn(() => local ? { conversationId: "c1", draft: { publishTitle: "开业", tags: "#探店" } } : undefined) });
  await import("./miniprogram/pages/gallery/index");
  page.data.mediaType = "video";
  page.data.items = [{ id: "c1", title: "自动标题", metadata: local ? {} : { videoPublication: { copy: "开业", tags: "#探店" } } }];
  page.open({ currentTarget: { dataset: { id: "c1", src: "video.mp4", title: "自动标题" } } });
  const url = vi.mocked(wx.navigateTo).mock.calls[0][0].url;
  const query = new URLSearchParams(url.split("?")[1]);
  expect(query.get("title")).toBe("开业 #探店");
  expect(query.get("copy")).toBe("开业");
  expect(query.get("tags")).toBe("#探店");
  if (local) expect(api.saveVideoPublication).toHaveBeenCalledWith("c1", { copy: "开业", tags: "#探店" });
});
