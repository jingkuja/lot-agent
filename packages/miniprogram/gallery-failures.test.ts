import { beforeEach, afterEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ listImageConversations: vi.fn(), getConversation: vi.fn(), getTask: vi.fn(), deleteConversation: vi.fn() }));
vi.mock("./miniprogram/services/api", () => ({ api, absoluteMedia: (url: string) => url || "" }));
let page: any;
let saved: Record<string, any>;
beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks(); saved = {};
  vi.stubGlobal("getApp", () => ({ ensureSession: async () => true, globalData: { user: { id: "u1" } } }));
  vi.stubGlobal("wx", { getStorageSync: (key: string) => saved[key], setStorageSync: (key: string, value: unknown) => { saved[key] = structuredClone(value); }, switchTab: vi.fn(), showToast: vi.fn(), showModal: vi.fn(({ success }) => success({ confirm: true })) });
  vi.stubGlobal("Page", (def: any) => { page = { ...def, data: structuredClone(def.data), setData(patch: any) { Object.assign(this.data, patch); } }; });
  api.listImageConversations.mockResolvedValue({ items: [], nextCursor: null });
  api.getConversation.mockResolvedValue({ messages: [] });
  api.deleteConversation.mockResolvedValue({ ok: true });
  await import("./miniprogram/pages/gallery/index");
});
afterEach(() => vi.unstubAllGlobals());
it.each(["image", "video"] as const)("shows, restores and deletes a failed %s submission with no preview", async (mediaType) => {
  const { beginAttempt, updateAttempt, listAttempts, takeRetry } = await import("./miniprogram/services/creation-attempts");
  const attempt = beginAttempt(mediaType, { prompt: "图", script: "分镜", ratio: "16:9", refs: ["/static/uploads/ref.png"] });
  updateAttempt(attempt, { status: "failed", conversationId: "c1" });
  page.data.mediaType = mediaType;
  await page.reload();
  expect(page.data.items).toEqual([expect.objectContaining({ id: "c1", failed: true, generating: false, preview: "" })]);
  await page.open({ currentTarget: { dataset: { id: "c1", src: "", title: "图" } } });
  expect(wx.switchTab).toHaveBeenCalledWith({ url: mediaType === "image" ? "/pages/studio/index" : "/pages/video/index" });
  expect(takeRetry(mediaType)?.draft).toEqual(attempt.draft);
  await page.remove({ currentTarget: { dataset: { id: "c1" } } });
  expect(api.deleteConversation).toHaveBeenCalledWith("c1");
  expect(listAttempts()).toEqual([]); expect(page.data.empty).toBe(true);
});
it("reconciles a late queued task before offering paid retry", async () => {
  const { beginAttempt, updateAttempt, takeRetry } = await import("./miniprogram/services/creation-attempts");
  const attempt = beginAttempt("image", { prompt: "图" }); updateAttempt(attempt, { status: "failed", conversationId: "c1" });
  await page.reload();
  api.getConversation.mockResolvedValue({ messages: [{ role: "assistant", metadata: { kind: "generation", mediaType: "image", taskId: "t1" } }] });
  api.getTask.mockResolvedValue({ status: "running" });
  await page.open({ currentTarget: { dataset: { id: "c1", src: "" } } });
  expect(wx.switchTab).not.toHaveBeenCalled(); expect(takeRetry("image")).toBeNull();
  expect(page.data.items[0].generating).toBe(true);
});
it("keeps failures visible offline and preserves them when deletion fails", async () => {
  const { beginAttempt, updateAttempt, listAttempts } = await import("./miniprogram/services/creation-attempts");
  const attempt = beginAttempt("image", { prompt: "图" }); updateAttempt(attempt, { status: "failed", conversationId: "c1" });
  api.listImageConversations.mockRejectedValue(new Error("offline"));
  await page.reload(); expect(page.data.items[0].failed).toBe(true);
  api.deleteConversation.mockRejectedValue({ status: 500 });
  await page.remove({ currentTarget: { dataset: { id: "c1" } } });
  expect(listAttempts()).toHaveLength(1); expect(page.data.items).toHaveLength(1);
});
it("updates a queued video to a failed, retryable work", async () => {
  const { beginAttempt, updateAttempt } = await import("./miniprogram/services/creation-attempts");
  const attempt = beginAttempt("video", { script: "镜头" }); updateAttempt(attempt, { status: "pending", conversationId: "c1", taskId: "t1" });
  page.data.mediaType = "video";
  api.getTask.mockResolvedValue({ status: "failed" });
  await page.tickAttempts();
  expect(page.data.items[0]).toMatchObject({ failed: true, generating: false });
});
